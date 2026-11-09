import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type {
  Engine,
  EngineCatalog,
  RecoverySource,
  RuntimeAdapter,
  RuntimeContext,
  RuntimeControls,
  TaskUsage,
  TaskView,
} from "./types.ts";
import { FairQueue } from "./fair-queue.ts";
import { RuntimeBudget } from "./budget.ts";
import {
  InteractionBroker,
  type InteractionHandler,
  type InteractionRequest,
} from "./interactions.ts";
import { validateSelection, type ModelSelection } from "./model-selection.ts";
import { diagnoseFailure } from "./diagnostics.ts";
import {
  applyChanges,
  collectChanges,
  discardWorkspace,
  isolate,
  type IsolatedWorkspace,
} from "./workspace.ts";
import {
  errorText,
  isTerminal,
  RuntimeCleanupError,
  validatePermissionMode,
  type PermissionMode,
} from "./types.ts";

/** Soft deadline: at this fraction of the task timeout, steerable runtimes are asked to answer now. */
export const SOFT_DEADLINE = 0.85;
export const ACTIVITY_PERSIST_MS = 5_000;
export const RETRY_DELAY_MS = 5_000;
/** After its soft deadline, a caller's wait returns this long before its hard deadline. */
export const WAIT_DEADLINE_MARGIN_MS = 5_000;
/** A deadline-bounded child settles at most this long before its parent's soft deadline. */
export const CHILD_SETTLE_MARGIN_MS = 2_000;
export const WRAP_UP_TEXT =
  "Time limit almost reached. Stop exploring now and give your final answer with what you already have. State clearly what you could not verify or finish.";
import { MAX_RESULT, partialResult, publishedResult } from "./task-output.ts";
import { assertSpendWithin, sessionSpend, type SessionSpend } from "./spend.ts";
export { MAX_RESULT, PARTIAL_NOTE, TRUNCATION_NOTE } from "./task-output.ts";

import { accumulateUsage, usageDelta, validUsage } from "./task-usage.ts";
import { transitionTask } from "./task-state.ts";

interface Entry {
  view: TaskView;
  controller: AbortController;
  done: Promise<void>;
  settle: () => void;
  tokenHash: string;
  cleanupFailed?: boolean;
  started: boolean;
  launch?: () => void;
  controls?: RuntimeControls;
  steering?: boolean;
  nativeSessionId?: string;
  resumeSessionId?: string;
  /** Kept in memory only, for an explicit operator retry of a root task. */
  prompt: string;
  /** Latest runtime answer text; published as partialResult only if the attempt does not complete. */
  partial?: string;
  activityPersistedAt?: number;
  /** Where the runtime actually runs (a YOLO root's worktree); children inherit it. */
  effectiveCwd?: string;
  workspace?: IsolatedWorkspace;
  /** Usage of earlier automatic attempts, added to the current attempt's counters. */
  usageCarry?: TaskUsage;
  /** Last raw counters from the runtime (a resumed Codex thread reports thread-wide totals). */
  rawUsage?: TaskUsage;
  /** Thread total already attributed to the source task: subtracted for a continuation. */
  usageBaseline?: TaskUsage;
  /** A human granted a runtime permission: the attempt may have had side effects, so it is never repeated automatically. */
  humanApproved?: boolean;
  /** Epoch ms of the hard deadline and of the soft (wrap-up) point of the running attempt. */
  deadlineAt?: number;
  softAt?: number;
  /** Epoch ms when the task entered a queue; cleared at dispatch. */
  queuedAt?: number;
  /** Cancels the task if it is still queued after maxQueueWaitMs. */
  queueTimer?: NodeJS.Timeout;
}

/** Counters that make scheduling decisions measurable; exposed by `usage()` and `/orch usage`. */
export interface OrchestrationMetrics {
  /** Children that expired at a deadline shortened to end by their parent's soft deadline. */
  boundedExpiries: number;
  /** Nested waits shortened so the caller regains control by its own soft deadline. */
  waitClamps: number;
  /** Leaf children that waited for a slot instead of being rejected. */
  leafQueued: number;
  /** Children refused at full capacity (non-leaf, reject policy, or no slot could free). */
  nestedRejected: number;
  /** Tasks dispatched from a queue, and their total and longest wait there. */
  queueDispatches: number;
  queueWaitMsTotal: number;
  queueWaitMsMax: number;
  /** Wait calls (each one a model turn of the caller) and the tasks they covered. */
  waitCalls: number;
  waitedTasks: number;
  /** Main-model wake-ups by the host: finished batches, and early ones for a failure. */
  batchWakes: number;
  earlyFailureWakes: number;
  /** Times running work was cancelled because a spend cap was crossed ("abort" enforcement). */
  spendAborts: number;
  /** Queued tasks cancelled by maxQueueWaitMs before launching. */
  queueExpired: number;
}

export interface OrchestratorOptions {
  cwd: string;
  adapters: Partial<Record<Engine, RuntimeAdapter>>;
  maxDepth?: number;
  maxConcurrent?: number;
  maxTasks?: number;
  timeoutMs?: number;
  onEvent?: (event: { type: string; task: TaskView; detail?: string }) => void;
  /** Synchronous durable barrier; unlike observers, failure prevents or stops work. */
  checkpoint?: (tasks: TaskView[]) => void;
  onPersistenceError?: (message: string) => void;
  onInteraction?: InteractionHandler;
  interactionTimeoutMs?: number;
  queuePolicy?: "reject" | "fair";
  maxQueued?: number;
  reservedChildSlots?: number;
  maxRuntimeMs?: number;
  /** Per-engine model/thinking used when neither the environment nor the request sets one. */
  defaultSelection?: Partial<Record<Engine, ModelSelection>>;
  /** YOLO roots run in a private git worktree; their diff waits for the operator. */
  isolateWrites?: boolean;
  /** Spend guards over provider-reported usage: once reached, new work is refused (running work continues). */
  maxCostUsd?: number;
  maxTokens?: number;
  /** "admission" (default): a reached cap refuses new work. "abort": it also cancels running work, keeping partials. */
  spendEnforcement?: "admission" | "abort";
  /** A queued task still waiting after this long is cancelled without launching. Unset: no limit. */
  maxQueueWaitMs?: number;
  /** Delay before the single automatic retry of a transient/network failure. */
  retryDelayMs?: number;
  /** Extra directories (besides cwd) an operator task may run in; subdirectories included. */
  allowedRoots?: string[];
}

/** One in-memory execution attempt per task; optional durable checkpoints do not grant recovery authority. */
export class Orchestrator {
  private entries = new Map<string, Entry>();
  private children = new Map<string | null, Set<string>>();
  private activeCount = 0;
  private interactions: InteractionBroker;
  private queue = new FairQueue();
  private activeRoots = 0;
  private budget: RuntimeBudget;
  private sessionLeases = new Map<string, string>();
  private readonly maxQueued: number;
  private readonly rootSlots: number;
  private identities = new Map<string, string>();
  private requests = new Map<string, { signature: string; id: string }>();
  private endpoint?: string;
  private closing = false;
  private persistenceFailure?: Error;
  private spendExhausted = false;
  private admitting?: string;
  private metrics: OrchestrationMetrics = {
    boundedExpiries: 0,
    waitClamps: 0,
    leafQueued: 0,
    nestedRejected: 0,
    queueDispatches: 0,
    queueWaitMsTotal: 0,
    queueWaitMsMax: 0,
    waitCalls: 0,
    waitedTasks: 0,
    batchWakes: 0,
    earlyFailureWakes: 0,
    spendAborts: 0,
    queueExpired: 0,
  };
  /** Leaf children waiting for a slot; dispatched before roots. */
  private leafQueue: string[] = [];
  readonly cwd: string;
  readonly limits: {
    maxDepth: number;
    maxConcurrent: number;
    maxTasks: number;
    timeoutMs: number;
  };

  constructor(private options: OrchestratorOptions) {
    this.interactions = new InteractionBroker(
      options.onInteraction,
      options.interactionTimeoutMs,
    );
    this.budget = new RuntimeBudget(options.maxRuntimeMs, () => {
      this.closing = true;
      for (const id of this.children.get(null) ?? [])
        this.abortTree(id, "Aggregate runtime budget exhausted");
    });
    this.cwd = realpathSync(options.cwd);
    if (!statSync(this.cwd).isDirectory())
      throw new Error("cwd must be a directory");
    this.limits = {
      maxDepth: options.maxDepth ?? 2,
      maxConcurrent: options.maxConcurrent ?? 3,
      // Total-per-coordinator cap (runaway guard), not a live-task cap.
      maxTasks: options.maxTasks ?? 32,
      // Real coding tasks routinely exceed 3 min; a killed task wastes all its tokens.
      timeoutMs: options.timeoutMs ?? 900_000,
    };
    this.maxQueued = options.maxQueued ?? 32;
    const reserved =
      options.reservedChildSlots ?? (this.limits.maxConcurrent > 1 ? 1 : 0);
    if (
      (options.queuePolicy !== undefined &&
        !["reject", "fair"].includes(options.queuePolicy)) ||
      !Number.isSafeInteger(this.maxQueued) ||
      this.maxQueued < 1 ||
      !Number.isSafeInteger(reserved) ||
      reserved < 0 ||
      reserved >= this.limits.maxConcurrent
    )
      throw new Error("Invalid queue limits");
    if (
      options.maxQueueWaitMs !== undefined &&
      (!Number.isSafeInteger(options.maxQueueWaitMs) ||
        options.maxQueueWaitMs < 1 ||
        options.maxQueueWaitMs > 2_147_483_647)
    )
      throw new Error("Invalid limit: maxQueueWaitMs");
    this.rootSlots = this.limits.maxConcurrent - reserved;
    for (const [key, value] of Object.entries(this.limits)) {
      if (
        !Number.isSafeInteger(value) ||
        value < 1 ||
        (key === "timeoutMs" && value > 2_147_483_647)
      )
        throw new Error(`Invalid limit: ${key}`);
    }
  }

  attachEndpoint(endpoint: string): void {
    if (this.endpoint) throw new Error("Endpoint already attached");
    const url = new URL(endpoint);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:")
      throw new Error("Loopback HTTP required");
    this.endpoint = endpoint;
  }

  authenticate(token: string): string | undefined {
    return this.identities.get(this.hash(token));
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Unknown task");
    return entry;
  }

  private authorize(callerId: string | null, targetId: string): void {
    if (callerId === null) return; // Only the in-process Pi host has root authority.
    let task: TaskView | undefined = this.entries.get(targetId)?.view;
    while (task) {
      if (task.id === callerId) return;
      task = task.parentId ? this.entries.get(task.parentId)?.view : undefined;
    }
    throw new Error("Task is outside caller's subtree");
  }

  list(): TaskView[] {
    return [...this.entries.values()].map(({ view }) => this.snapshot(view));
  }

  status(callerId: string | null, id: string): TaskView {
    this.authorize(callerId, id);
    return this.snapshot(this.entry(id).view);
  }

  private snapshot(view: TaskView): TaskView {
    return {
      ...view,
      ...(view.selection ? { selection: { ...view.selection } } : {}),
      ...(view.modelState
        ? { modelState: structuredClone(view.modelState) }
        : {}),
      ...(view.diagnostic ? { diagnostic: { ...view.diagnostic } } : {}),
      ...(view.continuationSource
        ? { continuationSource: { ...view.continuationSource } }
        : {}),
      ...(view.recoverySource
        ? { recoverySource: { ...view.recoverySource } }
        : {}),
      ...(view.runtimeProcess
        ? { runtimeProcess: { ...view.runtimeProcess } }
        : {}),
      ...(view.usage ? { usage: { ...view.usage } } : {}),
      ...(view.changes ? { changes: { ...view.changes } } : {}),
      ...(view.context ? { context: { ...view.context } } : {}),
      ...(view.recentActivity
        ? { recentActivity: view.recentActivity.map((step) => ({ ...step })) }
        : {}),
    };
  }

  delegate(
    callerId: string | null,
    engine: Engine,
    prompt: string,
    requestKey: string,
    recoverySource?: RecoverySource,
    selection?: ModelSelection,
    permissionMode?: PermissionMode,
    cwd?: string,
    web?: boolean,
    label?: string,
  ): TaskView {
    return this.admit(
      callerId,
      engine,
      prompt,
      requestKey,
      recoverySource,
      undefined,
      undefined,
      selection,
      permissionMode,
      cwd,
      web,
      label,
    );
  }

  /** An operator-chosen directory: real, a directory, and inside cwd or an allowed root. */
  private placement(requested: string | undefined): string {
    if (requested === undefined) return this.cwd;
    if (
      typeof requested !== "string" ||
      !requested.trim() ||
      requested.length > 4_096
    )
      throw new Error("Invalid task cwd");
    let path: string;
    try {
      path = realpathSync(
        isAbsolute(requested) ? requested : resolvePath(this.cwd, requested),
      );
    } catch {
      throw new Error("Task cwd does not exist");
    }
    if (!statSync(path).isDirectory())
      throw new Error("Task cwd must be a directory");
    const roots = [
      this.cwd,
      ...(this.options.allowedRoots ?? [])
        .map((root) => {
          try {
            return realpathSync(root);
          } catch {
            return undefined;
          }
        })
        .filter((root): root is string => Boolean(root)),
    ];
    if (
      !roots.some(
        (root) =>
          path === root ||
          path.startsWith(root.endsWith(sep) ? root : root + sep),
      )
    )
      throw new Error(
        "Task cwd is outside the allowed roots (Pi's cwd or PI_ORCHESTRATOR_ALLOWED_ROOTS)",
      );
    return path;
  }

  resume(
    callerId: string | null,
    sourceId: string,
    prompt: string,
    requestKey: string,
  ): TaskView {
    this.authorize(callerId, sourceId);
    if (callerId !== null)
      throw new Error("Only the operator may resume a native session");
    const source = this.entry(sourceId);
    if (source.view.permissionMode === "yolo")
      throw new Error(
        "Native resume of YOLO sessions is unsupported; authorize a fresh task instead",
      );
    if (
      source.view.state !== "completed" ||
      source.cleanupFailed ||
      !source.view.runtimeProcess?.exitedAt ||
      !source.nativeSessionId ||
      !this.options.adapters[source.view.engine]!.capabilities.resume
    )
      throw new Error(
        "Native resume is unsupported or the source has no verified clean completion in this live coordinator",
      );
    const continuation = this.admit(
      null,
      source.view.engine,
      prompt,
      requestKey,
      undefined,
      source.nativeSessionId,
      { taskId: source.view.id, attemptId: source.view.attemptId },
      {
        ...source.view.selection,
        ...(source.view.modelState?.model
          ? { model: source.view.modelState.model }
          : {}),
        ...(source.view.modelState?.thinking
          ? { thinking: source.view.modelState.thinking }
          : {}),
      },
      undefined,
      source.view.cwd === this.cwd ? undefined : source.view.cwd,
    );
    // Set before the queued microtask launches the runtime. A reused requestKey keeps its own baseline.
    const entry = this.entry(continuation.id);
    if (!entry.started || entry.view.state === "running")
      entry.usageBaseline ??= source.rawUsage
        ? { ...source.rawUsage }
        : undefined;
    return continuation;
  }

  private admit(
    callerId: string | null,
    engine: Engine,
    prompt: string,
    requestKey: string,
    recoverySource?: RecoverySource,
    resumeSessionId?: string,
    continuationSource?: { taskId: string; attemptId: string },
    requestedSelection?: ModelSelection,
    requestedPermissionMode?: PermissionMode,
    requestedCwd?: string,
    web?: boolean,
    requestedLabel?: string,
  ): TaskView {
    const permissionMode = validatePermissionMode(requestedPermissionMode);
    if (callerId !== null && permissionMode === "yolo")
      throw new Error(
        "Only the operator may authorize YOLO; nested tasks cannot escalate permissions",
      );
    const prefix = `PI_ORCHESTRATOR_${engine.toUpperCase()}`;
    // Product default < environment < explicit request.
    const selection = validateSelection({
      ...this.options.defaultSelection?.[engine],
      ...(process.env[`${prefix}_MODEL`]
        ? { model: process.env[`${prefix}_MODEL`] }
        : {}),
      ...(process.env[`${prefix}_THINKING`]
        ? { thinking: process.env[`${prefix}_THINKING`] }
        : {}),
      ...requestedSelection,
    });
    if (
      engine === "claude" &&
      selection.thinking &&
      !["low", "medium", "high", "xhigh", "max"].includes(selection.thinking)
    )
      throw new Error(
        "Unsupported Claude effort; expected low, medium, high, xhigh or max",
      );
    if (
      recoverySource &&
      (callerId !== null ||
        Object.values(recoverySource).length !== 3 ||
        ![
          recoverySource.runId,
          recoverySource.taskId,
          recoverySource.attemptId,
        ].every(
          (id) =>
            typeof id === "string" &&
            /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id),
        ))
    )
      throw new Error("Invalid recovery source");
    if (this.persistenceFailure) throw this.persistenceFailure;
    this.budget.assertAvailable();
    this.assertSpendAvailable();
    if (this.closing) throw new Error("Orchestrator is shutting down");
    if (!this.endpoint) throw new Error("MCP bridge is not listening");
    if (
      !Object.hasOwn(this.options.adapters, engine) ||
      !this.options.adapters[engine]
    )
      throw new Error("Unsupported engine");
    if (!prompt.trim() || prompt.length > 32_000)
      throw new Error("Prompt must contain 1–32000 characters");
    if (!requestKey.trim() || requestKey.length > 128)
      throw new Error("Invalid requestKey");
    const parent = callerId === null ? undefined : this.entry(callerId);
    // Native completion revokes admission before descendant cleanup can finish.
    // An already-authenticated MCP request must not create work in that interval.
    if (
      parent &&
      (parent.view.state !== "running" ||
        !this.identities.has(parent.tokenHash))
    )
      throw new Error("Caller is no longer running");
    // Children run where their parent runs (its worktree included); only the operator picks a directory.
    if (parent && requestedCwd !== undefined)
      throw new Error("Nested tasks run in their parent's directory");
    if (web !== undefined && typeof web !== "boolean")
      throw new Error("Invalid web flag");
    if (parent && web)
      throw new Error(
        "Only the operator may grant internet access; nested tasks cannot request it",
      );
    // Cosmetic and untrusted: one bounded line, never part of the request identity.
    const label =
      typeof requestedLabel === "string"
        ? requestedLabel
            .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 60) || undefined
        : undefined;
    const cwd = parent
      ? (parent.effectiveCwd ?? parent.view.cwd)
      : this.placement(requestedCwd);
    const key = JSON.stringify([callerId, requestKey]);
    const signature = this.hash(
      JSON.stringify([
        engine,
        prompt,
        recoverySource,
        resumeSessionId,
        continuationSource,
        selection,
        permissionMode,
        cwd,
        Boolean(web),
      ]),
    );
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.signature !== signature)
        throw new Error("requestKey already used with different arguments");
      const task = this.status(callerId, previous.id);
      // Observable proof of reuse; no request key or credential is added to the task event.
      this.emit("request-reused", this.entry(previous.id), undefined, false);
      return task;
    }
    if (resumeSessionId && this.sessionLeases.has(resumeSessionId))
      throw new Error("Native session is already owned by a live continuation");
    const depth = parent ? parent.view.depth + 1 : 1;
    if (depth > this.limits.maxDepth)
      throw new Error("Delegation depth limit reached");
    if (this.entries.size >= this.limits.maxTasks)
      throw new Error("Total task limit reached");
    const fair = this.options.queuePolicy === "fair";
    const queuedRoot = fair && callerId === null;
    let queuedLeaf = false;
    if (!queuedRoot && this.activeCount >= this.limits.maxConcurrent) {
      // A leaf cannot delegate, so it never holds a slot while waiting for another.
      // It may queue only if some occupied slot can free without depending on it.
      if (!fair || !parent || depth < this.limits.maxDepth) {
        this.metrics.nestedRejected++;
        throw new Error(
          "Concurrency limit reached (parents count too; nested work cannot queue behind its waiting ancestors)",
        );
      }
      if (!this.slotCanFree(parent.view.id)) {
        this.metrics.nestedRejected++;
        throw new Error(
          "Concurrency limit reached: every occupied slot waits on this task's ancestors, so no slot can free",
        );
      }
      if (this.leafQueue.length >= this.maxQueued)
        throw new Error("Child queue limit reached");
      queuedLeaf = true;
    }
    const queued = queuedRoot || queuedLeaf;
    if (queuedRoot && this.queue.size >= this.maxQueued)
      throw new Error("Root queue limit reached");
    const token = randomBytes(32).toString("base64url");
    const view: TaskView = {
      id: randomUUID(),
      title: prompt.trim().replace(/\s+/g, " ").slice(0, 160),
      attemptId: randomUUID(),
      parentId: callerId,
      engine,
      depth,
      selection,
      permissionMode,
      ...(web ? { web: true } : {}),
      ...(label ? { label } : {}),
      cwd,
      state: queued ? "queued" : "running",
      createdAt: new Date().toISOString(),
      ...(recoverySource ? { recoverySource: { ...recoverySource } } : {}),
      ...(resumeSessionId
        ? {
            continuation: "native-resume" as const,
            continuationSource: { ...continuationSource! },
          }
        : {}),
    };
    // Commit intention before registering authority or scheduling any runtime execution.
    if (
      this.options.checkpoint &&
      !this.checkpoint([...this.list(), this.snapshot(view)])
    )
      throw this.persistenceFailure;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const entry: Entry = {
      view,
      controller: new AbortController(),
      done,
      settle,
      tokenHash: this.hash(token),
      started: !queued,
      resumeSessionId,
      prompt,
      launch: () => {
        void this.execute(entry, prompt, token);
      },
    };
    this.entries.set(view.id, entry);
    if (resumeSessionId) this.sessionLeases.set(resumeSessionId, view.id);
    const siblings = this.children.get(callerId) ?? new Set<string>();
    siblings.add(view.id);
    this.children.set(callerId, siblings);
    if (!queued) {
      this.activeCount++;
      if (callerId === null) this.activeRoots++;
      this.identities.set(entry.tokenHash, view.id);
      this.budget.setActive(this.activeCount);
    }
    this.requests.set(key, { signature, id: view.id });
    this.emit("started", entry, undefined, false);
    // Install the entry and completion promise before executing a possibly synchronous adapter.
    if (queued) {
      entry.queuedAt = Date.now();
      if (this.options.maxQueueWaitMs !== undefined) {
        entry.queueTimer = setTimeout(() => {
          if (entry.started || isTerminal(entry.view)) return;
          this.metrics.queueExpired++;
          this.abortTree(
            entry.view.id,
            `Queue wait limit reached (${this.options.maxQueueWaitMs} ms, PI_ORCHESTRATOR_MAX_QUEUE_WAIT_MS); never launched`,
          );
        }, this.options.maxQueueWaitMs);
        entry.queueTimer.unref?.();
      }
      if (queuedLeaf) {
        this.leafQueue.push(view.id);
        this.metrics.leafQueued++;
      } else this.queue.push(engine, view.id);
      // Dispatched within its own admission, it never actually waited.
      this.admitting = view.id;
      try {
        this.pump();
      } finally {
        this.admitting = undefined;
      }
    } else {
      const launch = entry.launch!;
      delete entry.launch;
      queueMicrotask(launch);
    }
    return this.snapshot(view);
  }

  private checkpoint(tasks?: TaskView[]): boolean {
    if (this.persistenceFailure) return false;
    if (!this.options.checkpoint) return true;
    try {
      this.options.checkpoint(tasks ?? this.list());
      return true;
    } catch {
      // Latch first, then revoke/abort: recursive cancellation events must not retry failed I/O.
      this.persistenceFailure = new Error(
        "Durable state write failed; new work refused and active tasks stopped. Archives may be incomplete.",
      );
      this.closing = true;
      for (const id of this.children.get(null) ?? [])
        this.abortTree(id, this.persistenceFailure.message);
      try {
        this.options.onPersistenceError?.(this.persistenceFailure.message);
      } catch {
        /* independent observer */
      }
      return false;
    }
  }

  private emit(
    type: string,
    entry: Entry,
    detail?: string,
    persist = true,
  ): void {
    if (persist) this.checkpoint();
    // Observers must never break task lifecycle or cleanup.
    try {
      this.options.onEvent?.({ type, task: this.snapshot(entry.view), detail });
    } catch {
      /* observer only */
    }
  }

  private async execute(
    entry: Entry,
    prompt: string,
    token: string,
  ): Promise<void> {
    let output: string | undefined;
    let didFail = false;
    let failure: unknown;
    const clearDeadlines = this.armDeadlines(entry);
    try {
      entry.controller.signal.throwIfAborted();
      await this.prepareWorkspace(entry);
      output = await this.runWithRetry(entry, () =>
        this.options.adapters[entry.view.engine]!.run({
          task: {
            ...this.snapshot(entry.view),
            cwd: entry.effectiveCwd ?? entry.view.cwd,
          },
          prompt,
          resumeSessionId: entry.resumeSessionId,
          signal: entry.controller.signal,
          mcp: { url: this.endpoint!, token },
          ...this.runtimeCallbacks(entry, token),
        }),
      );
      if (typeof output !== "string" || !output.trim())
        throw new Error("Runtime returned no result");
      output = publishedResult(
        this.redact(output, token),
        [entry.effectiveCwd, entry.view.cwd],
        (text) => this.saveFullResult(entry.view.id, text),
      );
    } catch (error) {
      didFail = true;
      failure = error;
    } finally {
      clearDeadlines();
      await this.settle(entry, token, { output, didFail, failure });
    }
  }

  /**
   * Hard deadline aborts the tree. Killing at the deadline discards everything, so a
   * steerable runtime is first asked to conclude; failure there never affects the task.
   */
  private armDeadlines(entry: Entry): () => void {
    const now = Date.now();
    let timeoutMs = this.limits.timeoutMs;
    // A child must end by its parent's soft deadline: the parent then still has its
    // wrap-up window to synthesize, instead of both being killed at the hard deadline.
    const parent = entry.view.parentId
      ? this.entries.get(entry.view.parentId)
      : undefined;
    if (parent?.softAt !== undefined && parent.deadlineAt !== undefined) {
      // Leave room for the child's cleanup (SIGTERM, then SIGKILL after 1 s) so its
      // settled result is visible when the parent's wait returns at the soft point.
      const margin = Math.min(
        CHILD_SETTLE_MARGIN_MS,
        (parent.deadlineAt - parent.softAt) / 4,
      );
      const bound = Math.floor(parent.softAt - margin - now);
      if (bound < timeoutMs) timeoutMs = Math.max(0, bound);
    }
    entry.deadlineAt = now + timeoutMs;
    entry.softAt = now + Math.floor(timeoutMs * SOFT_DEADLINE);
    const bounded = timeoutMs < this.limits.timeoutMs;
    const timer = setTimeout(() => {
      if (bounded) this.metrics.boundedExpiries++;
      this.abortTree(
        entry.view.id,
        bounded
          ? "Task deadline exceeded (bounded by the parent's deadline)"
          : "Task deadline exceeded",
      );
    }, timeoutMs);
    const soft =
      timeoutMs >= 60_000
        ? setTimeout(
            () => {
              if (
                entry.view.state !== "running" ||
                entry.steering ||
                !entry.controls?.steer ||
                !this.identities.has(entry.tokenHash)
              )
                return;
              entry.steering = true;
              entry.controls
                .steer(WRAP_UP_TEXT)
                .then(
                  () => {
                    if (entry.view.state !== "running") return;
                    entry.view.lastActivity =
                      "orchestrator: plazo casi agotado; se pidió cerrar";
                    entry.view.activityAt = new Date().toISOString();
                    this.emit("activity", entry, entry.view.lastActivity);
                  },
                  () => {
                    /* the hard deadline still applies */
                  },
                )
                .finally(() => {
                  entry.steering = false;
                });
            },
            Math.floor(timeoutMs * SOFT_DEADLINE),
          )
        : undefined;
    return () => {
      clearTimeout(timer);
      clearTimeout(soft);
    };
  }

  /** YOLO roots write into a private git worktree when the operator enabled isolation. */
  private async prepareWorkspace(entry: Entry): Promise<void> {
    if (
      !this.options.isolateWrites ||
      entry.view.permissionMode !== "yolo" ||
      entry.view.parentId !== null
    )
      return;
    const workspace = await isolate(entry.view.cwd);
    if (workspace) {
      entry.workspace = workspace;
      entry.effectiveCwd = workspace.cwd;
      entry.view.workspace = "worktree";
      // Cancelled while git was checking out: nothing ran, nothing to review.
      if (entry.controller.signal.aborted)
        entry.controller.signal.throwIfAborted();
    } else entry.view.workspace = "in-place";
    this.emit("workspace", entry);
  }

  /** At most one automatic retry, only when `retryable` proves it cannot duplicate side effects. */
  private async runWithRetry(
    entry: Entry,
    runOnce: () => Promise<string>,
  ): Promise<string> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await runOnce();
      } catch (error) {
        if (attempt > 1 || !this.retryable(entry, error)) throw error;
        if (entry.view.usage) entry.usageCarry = { ...entry.view.usage };
        entry.view.lastActivity = `orchestrator: error transitorio (${diagnoseFailure(error).category}); reintento automático`;
        entry.view.activityAt = new Date().toISOString();
        this.emit("activity", entry, entry.view.lastActivity);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            resolve,
            this.options.retryDelayMs ?? RETRY_DELAY_MS,
          );
          entry.controller.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(entry.controller.signal.reason);
            },
            { once: true },
          );
        });
      }
    }
  }

  /** Adapter callbacks; each one ignores reports from a revoked or settled attempt. */
  private runtimeCallbacks(entry: Entry, token: string) {
    const live = () =>
      !isTerminal(entry.view) && this.identities.has(entry.tokenHash);
    return {
      usage: (usage: TaskUsage) => {
        if (!live()) return;
        const raw = validUsage(usage);
        if (!raw) return; // Malformed provider counters are ignored, never displayed.
        entry.rawUsage = raw;
        entry.view.usage = accumulateUsage(
          usageDelta(raw, entry.usageBaseline),
          entry.usageCarry,
        );
        // Display-only: the final settle checkpoint persists it without an fsync per update.
        this.emit("usage", entry, undefined, false);
        this.enforceSpend();
      },
      context: (used: number, size: number) => {
        if (!live()) return;
        if (
          !Number.isSafeInteger(used) ||
          !Number.isSafeInteger(size) ||
          used < 0 ||
          size < 1 ||
          used > size * 4
        )
          return;
        entry.view.context = {
          used,
          size,
          peak: Math.max(used, entry.view.context?.peak ?? 0),
        };
        this.emit("context", entry, undefined, false);
        this.enforceSpend();
      },
      partial: (text: string) => {
        // Memory only: no event or checkpoint per streamed fragment.
        if (!live() || typeof text !== "string") return;
        entry.partial = text.slice(0, MAX_RESULT + 1);
      },
      modelState: (state: NonNullable<TaskView["modelState"]>) => {
        if (
          entry.controller.signal.aborted ||
          !this.identities.has(entry.tokenHash)
        )
          return;
        entry.view.modelState = structuredClone(state);
        this.emit("model-selected", entry);
      },
      registerControls: (controls: RuntimeControls | undefined) => {
        if (
          !controls ||
          (entry.view.state === "running" &&
            this.identities.has(entry.tokenHash))
        )
          entry.controls = controls ? { ...controls } : undefined;
      },
      interact: async (request: InteractionRequest) => {
        if (!live()) return undefined;
        const answer = await this.interactions.request(
          entry.view.id,
          entry.view.engine,
          {
            ...request,
            title: this.redact(request.title, token),
            detail: this.redact(request.detail, token),
            options: request.options.map((option) => ({
              ...option,
              label: this.redact(option.label, token),
            })),
          },
          entry.controller.signal,
        );
        const granted =
          this.identities.has(entry.tokenHash) &&
          !entry.controller.signal.aborted
            ? answer
            : undefined;
        // Restricted is not side-effect free when a person approves an operation (e.g. an Antigravity command).
        if (granted && request.kind === "permission")
          entry.humanApproved = true;
        return granted;
      },
      session: (id: string) => {
        if (entry.controller.signal.aborted || isTerminal(entry.view)) return;
        if (entry.resumeSessionId && id !== entry.resumeSessionId)
          throw new Error("Runtime resumed a different native session");
        entry.view.runtimeSessionId = this.redact(id, token).slice(0, 256);
        if (id === entry.view.runtimeSessionId) entry.nativeSessionId = id;
        this.emit("session", entry);
      },
      process: (info: NonNullable<TaskView["runtimeProcess"]>) => {
        if (isTerminal(entry.view)) return;
        entry.view.runtimeProcess = { ...info };
        this.emit(info.exitedAt ? "process-exited" : "process", entry);
      },
      activity: (detail: string) => {
        if (entry.controller.signal.aborted || isTerminal(entry.view)) return;
        entry.view.lastActivity = this.redact(detail, token).slice(0, 120);
        entry.view.activityAt = new Date().toISOString();
        const recent = entry.view.recentActivity ?? [];
        if (recent.at(-1)?.text !== entry.view.lastActivity)
          entry.view.recentActivity = [
            ...recent,
            { at: entry.view.activityAt, text: entry.view.lastActivity },
          ].slice(-3);
        // A durable rewrite (two fsyncs) per tool call is pure I/O (measured: 378
        // activity events in one session). Persist at most every 5 s per task;
        // the first one and the settle checkpoint are always written.
        const now = Date.now();
        const persist =
          entry.activityPersistedAt === undefined ||
          now - entry.activityPersistedAt >= ACTIVITY_PERSIST_MS;
        if (persist) entry.activityPersistedAt = now;
        this.emit("activity", entry, entry.view.lastActivity, persist);
      },
    } satisfies Partial<RuntimeContext>;
  }

  /** Whatever the outcome, what a worktree task wrote is recorded for review, never applied here. */
  private async recordChanges(entry: Entry, token: string): Promise<void> {
    if (!entry.workspace) return;
    try {
      const changes = await collectChanges(entry.workspace);
      if (changes.state === "none")
        await discardWorkspace(
          entry.workspace.repoRoot,
          entry.workspace.path,
          entry.workspace.patchDirectory + "/changes.patch",
        );
      entry.view.changes = changes;
    } catch (error) {
      entry.view.changes = {
        state: "pending",
        files: 0,
        insertions: 0,
        deletions: 0,
        summary: "",
        repo: entry.workspace.repoRoot,
        worktree: entry.workspace.path,
        error: this.redact(errorText(error), token).slice(0, 500),
      };
    }
  }

  /** Revokes the attempt, drains its subtree, then records exactly one terminal state. */
  private async settle(
    entry: Entry,
    token: string,
    outcome: { output?: string; didFail: boolean; failure: unknown },
  ): Promise<void> {
    // A finished parent may not leave orphaned live work or valid delegation credentials.
    this.identities.delete(entry.tokenHash);
    this.interactions.cancelTask(entry.view.id);
    delete entry.controls;
    const children = [...(this.children.get(entry.view.id) ?? [])].map((id) =>
      this.entry(id),
    );
    for (const child of children)
      this.abortTree(child.view.id, "Parent execution ended");
    await Promise.all(children.map((child) => child.done));
    try {
      this.budget.assertAvailable();
    } catch {
      /* Budget expiry aborts live work before terminal acknowledgement. */
    }
    await this.recordChanges(entry, token);
    entry.cleanupFailed =
      outcome.failure instanceof RuntimeCleanupError ||
      Boolean(
        entry.view.runtimeProcess && !entry.view.runtimeProcess.exitedAt,
      ) ||
      children.some((child) => child.cleanupFailed);
    if (entry.cleanupFailed) {
      transitionTask(entry.view, "failed");
      entry.view.error =
        "Runtime cleanup could not be confirmed; no cancellation or process-group cleanup was acknowledged";
      entry.view.diagnostic = diagnoseFailure(
        new RuntimeCleanupError(undefined),
      );
    } else if (entry.controller.signal.aborted) {
      transitionTask(entry.view, "cancelled");
      entry.view.error = errorText(entry.controller.signal.reason);
    } else if (outcome.didFail) {
      transitionTask(entry.view, "failed");
      entry.view.error = this.redact(errorText(outcome.failure), token).slice(
        0,
        8_000,
      );
      entry.view.diagnostic = diagnoseFailure(outcome.failure);
    } else {
      transitionTask(entry.view, "completed");
      entry.view.result = outcome.output!;
    }
    if (entry.view.state !== "completed" && entry.partial?.trim())
      entry.view.partialResult = partialResult(
        this.redact(entry.partial, token),
        [entry.effectiveCwd, entry.view.cwd],
      );
    delete entry.partial;
    entry.view.endedAt = new Date().toISOString();
    this.activeCount--;
    if (entry.view.parentId === null) this.activeRoots--;
    this.budget.setActive(this.activeCount);
    if (!this.checkpoint() && entry.view.state === "completed") {
      // Native success without a committed final checkpoint is not durable task success.
      transitionTask(entry.view, "failed", "checkpoint-failed");
      delete entry.view.result;
      entry.view.error = this.persistenceFailure!.message;
    }
    this.emit("settled", entry, undefined, false);
    if (
      !entry.cleanupFailed &&
      entry.resumeSessionId &&
      this.sessionLeases.get(entry.resumeSessionId) === entry.view.id
    )
      this.sessionLeases.delete(entry.resumeSessionId);
    entry.settle();
    this.pump();
  }

  /** Operator-only fresh attempt of a settled root task with the same engine, prompt, selection and permission mode. */
  retry(
    callerId: string | null,
    sourceId: string,
    requestKey: string,
  ): TaskView {
    if (callerId !== null)
      throw new Error("Only the operator may retry a task");
    const source = this.entry(sourceId);
    if (source.view.parentId !== null)
      throw new Error(
        "Only root tasks can be retried; retry their parent instead",
      );
    if (!isTerminal(source.view))
      throw new Error("Task is still active; cancel it before retrying");
    return this.admit(
      null,
      source.view.engine,
      source.prompt,
      requestKey,
      undefined,
      undefined,
      undefined,
      source.view.selection,
      source.view.permissionMode,
      source.view.cwd === this.cwd ? undefined : source.view.cwd,
      source.view.web,
      source.view.label,
    );
  }

  private resultDirectory?: string;
  private saveFullResult(taskId: string, text: string): string | undefined {
    try {
      this.resultDirectory ??= mkdtempSync(join(tmpdir(), "pi-orch-results-"));
      const path = join(this.resultDirectory, `${taskId}.md`);
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  }

  /** Operator only: the full prompt, kept in memory (never journaled), for the detail view. */
  promptOf(callerId: string | null, id: string): string | undefined {
    if (callerId !== null) return undefined;
    return this.entries.get(id)?.prompt;
  }

  /** One automatic retry is safe only when repeating cannot duplicate side effects. */
  private retryable(entry: Entry, error: unknown): boolean {
    if (
      entry.controller.signal.aborted ||
      this.closing ||
      error instanceof RuntimeCleanupError
    )
      return false;
    if (
      entry.view.permissionMode === "yolo" ||
      entry.resumeSessionId ||
      entry.humanApproved
    )
      return false;
    if ((this.children.get(entry.view.id)?.size ?? 0) > 0) return false; // children would be duplicated
    if (entry.view.runtimeProcess && !entry.view.runtimeProcess.exitedAt)
      return false;
    return diagnoseFailure(error).automaticRetry;
  }

  /** Operator only: applies a settled YOLO root's reviewed patch to the operator's tree. */
  async applyChanges(callerId: string | null, id: string): Promise<TaskView> {
    const entry = this.changesEntry(callerId, id);
    const changes = entry.view.changes!;
    if (!changes.patchPath)
      throw new Error("No recorded patch: inspect the worktree manually");
    await applyChanges(changes.repo!, changes.patchPath);
    await discardWorkspace(changes.repo!, changes.worktree, changes.patchPath);
    entry.view.changes = {
      ...changes,
      state: "applied",
      worktree: undefined,
      patchPath: undefined,
    };
    this.emit("changes", entry);
    return this.snapshot(entry.view);
  }

  async discardChanges(callerId: string | null, id: string): Promise<TaskView> {
    const entry = this.changesEntry(callerId, id);
    const changes = entry.view.changes!;
    await discardWorkspace(changes.repo!, changes.worktree, changes.patchPath);
    entry.view.changes = {
      ...changes,
      state: "discarded",
      worktree: undefined,
      patchPath: undefined,
    };
    this.emit("changes", entry);
    return this.snapshot(entry.view);
  }

  private changesEntry(callerId: string | null, id: string): Entry {
    if (callerId !== null)
      throw new Error("Only the operator may apply or discard task changes");
    const entry = this.entry(id);
    if (!isTerminal(entry.view)) throw new Error("Task is still active");
    if (entry.view.changes?.state !== "pending" || !entry.view.changes.repo)
      throw new Error("This task has no pending changes");
    return entry;
  }

  controls(callerId: string | null, id: string) {
    this.authorize(callerId, id);
    const entry = this.entry(id);
    return {
      ...this.options.adapters[entry.view.engine]!.capabilities,
      steerReady:
        this.options.adapters[entry.view.engine]!.capabilities.steer &&
        entry.view.state === "running" &&
        this.identities.has(entry.tokenHash) &&
        Boolean(entry.controls?.steer),
      resumeReady:
        entry.view.state === "completed" &&
        entry.view.permissionMode !== "yolo" &&
        !entry.cleanupFailed &&
        Boolean(entry.nativeSessionId && entry.view.runtimeProcess?.exitedAt) &&
        Boolean(
          this.options.adapters[entry.view.engine]!.capabilities.resume,
        ) &&
        !this.sessionLeases.has(entry.nativeSessionId!),
    };
  }

  async steer(
    callerId: string | null,
    id: string,
    text: string,
  ): Promise<void> {
    this.authorize(callerId, id);
    const entry = this.entry(id);
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("Steer requires 1–32000 characters");
    if (!this.controls(callerId, id).steerReady || !entry.controls?.steer)
      throw new Error("Steer is unavailable for this runtime or current turn");
    if (entry.steering) throw new Error("A steer request is already pending");
    entry.steering = true;
    try {
      await entry.controls.steer(text);
      if (
        entry.view.state !== "running" ||
        !this.identities.has(entry.tokenHash)
      )
        throw new Error(
          "Steer acknowledgement arrived after the attempt was revoked; application is not confirmed",
        );
      this.emit("steer-acknowledged", entry);
    } finally {
      entry.steering = false;
    }
  }

  /** Provider-reported spend so far: tokens from every engine, dollars only where reported (Claude). */
  spend(): SessionSpend {
    return sessionSpend([...this.entries.values()].map(({ view }) => view));
  }

  private assertSpendAvailable(): void {
    assertSpendWithin(this.spend(), this.options);
  }

  /** "abort" enforcement: the first crossed cap cancels every live tree once. */
  private enforceSpend(): void {
    if (this.options.spendEnforcement !== "abort" || this.spendExhausted)
      return;
    try {
      this.assertSpendAvailable();
    } catch (error) {
      this.spendExhausted = true;
      this.metrics.spendAborts++;
      const reason = `Session spend limit reached; running work cancelled (${errorText(error)})`;
      // Deferred: never abort from inside the adapter's own callback.
      queueMicrotask(() => {
        for (const id of this.children.get(null) ?? [])
          this.abortTree(id, reason);
      });
    }
  }

  /** Real model listings, one short-lived probe per engine (never a prompt); failures are reported per engine. */
  async catalog(
    signal?: AbortSignal,
  ): Promise<Record<string, EngineCatalog | { error: string }>> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Catalog probe deadline")),
      60_000,
    );
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const entries = await Promise.all(
        Object.entries(this.options.adapters).map(async ([engine, adapter]) => {
          if (!adapter?.catalog)
            return [engine, { error: "listing unsupported" }] as const;
          try {
            return [
              engine,
              await adapter.catalog(this.cwd, controller.signal),
            ] as const;
          } catch (error) {
            return [engine, { error: errorText(error).slice(0, 300) }] as const;
          }
        }),
      );
      return Object.fromEntries(entries);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  usage() {
    return {
      ...this.budget.view(),
      spend: this.spend(),
      maxCostUsd: this.options.maxCostUsd,
      maxTokens: this.options.maxTokens,
      tasks: this.entries.size,
      queued: this.queue.size + this.leafQueue.length,
      orchestration: { ...this.metrics },
      maxTasks: this.limits.maxTasks,
      maxConcurrent: this.limits.maxConcurrent,
      rootSlots:
        this.options.queuePolicy === "fair"
          ? this.rootSlots
          : this.limits.maxConcurrent,
    };
  }

  /**
   * True when some running task is not an ancestor of any queued leaf (including
   * one about to be queued under `parentId`): its slot frees without waiting on them.
   */
  private slotCanFree(parentId: string): boolean {
    const blocked = new Set<string>();
    const climb = (id: string | null | undefined) => {
      while (id && !blocked.has(id)) {
        blocked.add(id);
        id = this.entries.get(id)?.view.parentId;
      }
    };
    climb(parentId);
    for (const id of this.leafQueue) climb(this.entries.get(id)?.view.parentId);
    for (const { view, started } of this.entries.values())
      if (started && !isTerminal(view) && !blocked.has(view.id)) return true;
    return false;
  }

  private pump(): void {
    // Leaves first: their ancestors hold slots while waiting for them.
    while (
      !this.closing &&
      this.activeCount < this.limits.maxConcurrent &&
      this.leafQueue.length
    ) {
      const entry = this.entry(this.leafQueue.shift()!);
      if (!isTerminal(entry.view)) this.dispatch(entry, false);
    }
    while (
      !this.closing &&
      this.activeCount < this.limits.maxConcurrent &&
      this.activeRoots < this.rootSlots
    ) {
      const id = this.queue.shift();
      if (!id) return;
      const entry = this.entry(id);
      if (!isTerminal(entry.view)) this.dispatch(entry, true);
    }
  }

  private dispatch(entry: Entry, root: boolean): void {
    clearTimeout(entry.queueTimer);
    entry.started = true;
    transitionTask(entry.view, "running");
    this.activeCount++;
    if (root) this.activeRoots++;
    if (entry.queuedAt !== undefined && entry.view.id !== this.admitting) {
      const waited = Date.now() - entry.queuedAt;
      this.metrics.queueDispatches++;
      this.metrics.queueWaitMsTotal += waited;
      this.metrics.queueWaitMsMax = Math.max(
        this.metrics.queueWaitMsMax,
        waited,
      );
      delete entry.queuedAt;
    }
    // Dispatch is a second durable barrier, before granting credentials or invoking the runtime.
    if (this.checkpoint()) this.identities.set(entry.tokenHash, entry.view.id);
    this.budget.setActive(this.activeCount);
    this.emit("dispatched", entry, undefined, false);
    const launch = entry.launch!;
    delete entry.launch;
    queueMicrotask(launch);
  }

  private redact(text: string, ownToken: string): string {
    return text
      .replaceAll(ownToken, "[REDACTED]")
      .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");
  }

  private abortTree(id: string, reason: string): void {
    const pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      const entry = this.entry(current);
      if (isTerminal(entry.view)) continue;
      this.identities.delete(entry.tokenHash);
      delete entry.controls;
      if (!entry.started) {
        clearTimeout(entry.queueTimer);
        this.queue.remove(current);
        this.leafQueue = this.leafQueue.filter((queued) => queued !== current);
        delete entry.launch;
        if (
          entry.resumeSessionId &&
          this.sessionLeases.get(entry.resumeSessionId) === current
        )
          this.sessionLeases.delete(entry.resumeSessionId);
        entry.controller.abort(new Error(reason));
        transitionTask(entry.view, "cancelled");
        entry.view.error = reason;
        entry.view.endedAt = new Date().toISOString();
        this.emit("settled", entry);
        entry.settle();
        continue;
      }
      if (!entry.controller.signal.aborted) {
        transitionTask(entry.view, "cancelling");
        entry.controller.abort(new Error(reason));
        this.emit("cancelling", entry);
      }
      for (const child of this.children.get(current) ?? []) pending.push(child);
    }
  }

  async cancel(callerId: string | null, id: string): Promise<TaskView> {
    this.authorize(callerId, id);
    this.abortTree(id, "Cancelled by owner");
    await this.entry(id).done;
    return this.status(callerId, id);
  }

  /**
   * Bounds of one blocking wait. Every MCP poll is a full model turn of the
   * calling worker, so Codex/Claude callers (whose MCP clients are configured with
   * 660 s tool timeouts) may wait long; Antigravity's client timeout is unverified.
   */
  waitWindow(callerId: string | null): { defaultMs: number; maxMs: number } {
    if (callerId === null) return { defaultMs: 30_000, maxMs: 600_000 };
    return this.entry(callerId).view.engine === "antigravity"
      ? { defaultMs: 30_000, maxMs: 60_000 }
      : { defaultMs: 300_000, maxMs: 600_000 };
  }

  async wait(
    callerId: string | null,
    id: string,
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<TaskView> {
    this.authorize(callerId, id);
    const maxWait = this.waitWindow(callerId).maxMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxWait)
      throw new Error(`Wait must be 1–${maxWait} ms`);
    signal?.throwIfAborted();
    const entry = this.entry(id);
    // A runtime blocked in a tool call cannot obey its wrap-up steer: return by its
    // soft deadline (or shortly before the hard one) so it can still answer.
    const caller = callerId === null ? undefined : this.entries.get(callerId);
    if (caller?.softAt !== undefined && caller.deadlineAt !== undefined) {
      const now = Date.now();
      const bound =
        now < caller.softAt
          ? caller.softAt - now
          : caller.deadlineAt - now - WAIT_DEADLINE_MARGIN_MS;
      if (bound < timeoutMs) {
        timeoutMs = Math.max(1, bound);
        this.metrics.waitClamps++;
      }
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const boundary = new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, timeoutMs);
      if (signal) {
        onAbort = () => reject(signal.reason ?? new Error("Wait aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      await Promise.race([entry.done, boundary]);
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    return this.status(callerId, id);
  }

  /** Host bookkeeping: the extension reports each time it wakes the main model. */
  noteWake(kind: "batch" | "earlyFailure"): void {
    if (kind === "batch") this.metrics.batchWakes++;
    else this.metrics.earlyFailureWakes++;
  }

  /**
   * One wait call for several tasks: sequential waits under one shared deadline, so
   * a caller pays one turn for N tasks. Settled tasks return immediately.
   */
  async waitAll(
    callerId: string | null,
    ids: string[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<TaskView[]> {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > 16)
      throw new Error("Expected 1–16 task ids");
    for (const id of unique) this.authorize(callerId, id);
    this.metrics.waitCalls++;
    this.metrics.waitedTasks += unique.length;
    const deadline = Date.now() + timeoutMs;
    const views: TaskView[] = [];
    for (const id of unique)
      views.push(
        await this.wait(
          callerId,
          id,
          Math.max(1, deadline - Date.now()),
          signal,
        ),
      );
    return views;
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const id of this.children.get(null) ?? [])
      this.abortTree(id, "Pi session closed");
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
    this.identities.clear();
  }
}
