import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve as resolvePath, sep } from "node:path";
import type { Engine, EngineCatalog, RecoverySource, RuntimeAdapter, RuntimeControls, TaskUsage, TaskView } from "./types.ts";
import { FairQueue } from "./fair-queue.ts";
import { RuntimeBudget } from "./budget.ts";
import { InteractionBroker, type InteractionHandler } from "./interactions.ts";
import { validateSelection, type ModelSelection } from "./model-selection.ts";
import { diagnoseFailure } from "./diagnostics.ts";
import { compactFileLinks } from "./result-links.ts";
import { applyChanges, collectChanges, discardWorkspace, isolate, type IsolatedWorkspace } from "./workspace.ts";
import { errorText, isTerminal, RuntimeCleanupError, validatePermissionMode, type PermissionMode } from "./types.ts";

/** Journal/schema bound for a published result. */
export const MAX_RESULT = 20_000;
export const PARTIAL_NOTE = "\n\n[Resultado parcial: la tarea no terminó; este es el último texto que el runtime produjo antes de cortarse.]";
/** Soft deadline: at this fraction of the task timeout, steerable runtimes are asked to answer now. */
export const SOFT_DEADLINE = 0.85;
export const ACTIVITY_PERSIST_MS = 5_000;
export const RETRY_DELAY_MS = 5_000;
export const WRAP_UP_TEXT = "Time limit almost reached. Stop exploring now and give your final answer with what you already have. State clearly what you could not verify or finish.";
export const TRUNCATION_NOTE = `\n\n[Resultado truncado por el orquestador: superaba ${MAX_RESULT} caracteres; se publican los primeros. Pide al runtime un resumen o que escriba el detalle en un archivo.]`;

function validUsage(value: TaskUsage): TaskUsage | undefined {
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n < 1e12;
  if (!value || !count(value.inputTokens) || !count(value.cachedInputTokens) || !count(value.outputTokens)) return undefined;
  if (value.reasoningTokens !== undefined && !count(value.reasoningTokens)) return undefined;
  if (value.cacheWriteTokens !== undefined && !count(value.cacheWriteTokens)) return undefined;
  if (value.costUsd !== undefined && !(typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 && value.costUsd < 1e6)) return undefined;
  return { inputTokens: value.inputTokens, cachedInputTokens: Math.min(value.cachedInputTokens, value.inputTokens), outputTokens: value.outputTokens,
    ...(value.reasoningTokens !== undefined ? { reasoningTokens: value.reasoningTokens } : {}),
    ...(value.cacheWriteTokens !== undefined ? { cacheWriteTokens: Math.min(value.cacheWriteTokens, value.inputTokens) } : {}), ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}) };
}

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
  readonly cwd: string;
  readonly limits: { maxDepth: number; maxConcurrent: number; maxTasks: number; timeoutMs: number };

  constructor(private options: OrchestratorOptions) {
    this.interactions = new InteractionBroker(options.onInteraction, options.interactionTimeoutMs);
    this.budget = new RuntimeBudget(options.maxRuntimeMs, () => {
      this.closing = true;
      for (const id of this.children.get(null) ?? []) this.abortTree(id, "Aggregate runtime budget exhausted");
    });
    this.cwd = realpathSync(options.cwd);
    if (!statSync(this.cwd).isDirectory()) throw new Error("cwd must be a directory");
    this.limits = {
      maxDepth: options.maxDepth ?? 2,
      maxConcurrent: options.maxConcurrent ?? 3,
      // Total-per-coordinator cap (runaway guard), not a live-task cap.
      maxTasks: options.maxTasks ?? 32,
      // Real coding tasks routinely exceed 3 min; a killed task wastes all its tokens.
      timeoutMs: options.timeoutMs ?? 900_000,
    };
    this.maxQueued = options.maxQueued ?? 32;
    const reserved = options.reservedChildSlots ?? (this.limits.maxConcurrent > 1 ? 1 : 0);
    if ((options.queuePolicy !== undefined && !["reject", "fair"].includes(options.queuePolicy)) || !Number.isSafeInteger(this.maxQueued) || this.maxQueued < 1 || !Number.isSafeInteger(reserved) || reserved < 0 || reserved >= this.limits.maxConcurrent) throw new Error("Invalid queue limits");
    this.rootSlots = this.limits.maxConcurrent - reserved;
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 1 || (key === "timeoutMs" && value > 2_147_483_647)) throw new Error(`Invalid limit: ${key}`);
    }
  }

  attachEndpoint(endpoint: string): void {
    if (this.endpoint) throw new Error("Endpoint already attached");
    const url = new URL(endpoint);
    if (url.hostname !== "127.0.0.1" || url.protocol !== "http:") throw new Error("Loopback HTTP required");
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
    return { ...view, ...(view.selection ? { selection: { ...view.selection } } : {}), ...(view.modelState ? { modelState: structuredClone(view.modelState) } : {}), ...(view.diagnostic ? { diagnostic: { ...view.diagnostic } } : {}), ...(view.continuationSource ? { continuationSource: { ...view.continuationSource } } : {}), ...(view.recoverySource ? { recoverySource: { ...view.recoverySource } } : {}), ...(view.runtimeProcess ? { runtimeProcess: { ...view.runtimeProcess } } : {}), ...(view.usage ? { usage: { ...view.usage } } : {}), ...(view.changes ? { changes: { ...view.changes } } : {}), ...(view.context ? { context: { ...view.context } } : {}), ...(view.recentActivity ? { recentActivity: view.recentActivity.map((step) => ({ ...step })) } : {}) };
  }

  delegate(callerId: string | null, engine: Engine, prompt: string, requestKey: string, recoverySource?: RecoverySource, selection?: ModelSelection, permissionMode?: PermissionMode, cwd?: string, web?: boolean, label?: string): TaskView {
    return this.admit(callerId, engine, prompt, requestKey, recoverySource, undefined, undefined, selection, permissionMode, cwd, web, label);
  }

  /** An operator-chosen directory: real, a directory, and inside cwd or an allowed root. */
  private placement(requested: string | undefined): string {
    if (requested === undefined) return this.cwd;
    if (typeof requested !== "string" || !requested.trim() || requested.length > 4_096) throw new Error("Invalid task cwd");
    let path: string;
    try { path = realpathSync(isAbsolute(requested) ? requested : resolvePath(this.cwd, requested)); }
    catch { throw new Error("Task cwd does not exist"); }
    if (!statSync(path).isDirectory()) throw new Error("Task cwd must be a directory");
    const roots = [this.cwd, ...(this.options.allowedRoots ?? []).map((root) => { try { return realpathSync(root); } catch { return undefined; } }).filter((root): root is string => Boolean(root))];
    if (!roots.some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep))) throw new Error("Task cwd is outside the allowed roots (Pi's cwd or PI_ORCHESTRATOR_ALLOWED_ROOTS)");
    return path;
  }

  resume(callerId: string | null, sourceId: string, prompt: string, requestKey: string): TaskView {
    this.authorize(callerId, sourceId);
    if (callerId !== null) throw new Error("Only the operator may resume a native session");
    const source = this.entry(sourceId);
    if (source.view.permissionMode === "yolo") throw new Error("Native resume of YOLO sessions is unsupported; authorize a fresh task instead");
    if (source.view.state !== "completed" || source.cleanupFailed || !source.view.runtimeProcess?.exitedAt || !source.nativeSessionId || !this.options.adapters[source.view.engine]!.capabilities.resume) throw new Error("Native resume is unsupported or the source has no verified clean completion in this live coordinator");
    const continuation = this.admit(null, source.view.engine, prompt, requestKey, undefined, source.nativeSessionId, { taskId: source.view.id, attemptId: source.view.attemptId }, { ...source.view.selection, ...(source.view.modelState?.model ? { model: source.view.modelState.model } : {}), ...(source.view.modelState?.thinking ? { thinking: source.view.modelState.thinking } : {}) }, undefined, source.view.cwd === this.cwd ? undefined : source.view.cwd);
    // Set before the queued microtask launches the runtime. A reused requestKey keeps its own baseline.
    const entry = this.entry(continuation.id);
    if (!entry.started || entry.view.state === "running") entry.usageBaseline ??= source.rawUsage ? { ...source.rawUsage } : undefined;
    return continuation;
  }

  private admit(callerId: string | null, engine: Engine, prompt: string, requestKey: string, recoverySource?: RecoverySource, resumeSessionId?: string, continuationSource?: { taskId: string; attemptId: string }, requestedSelection?: ModelSelection, requestedPermissionMode?: PermissionMode, requestedCwd?: string, web?: boolean, requestedLabel?: string): TaskView {
    const permissionMode = validatePermissionMode(requestedPermissionMode);
    if (callerId !== null && permissionMode === "yolo") throw new Error("Only the operator may authorize YOLO; nested tasks cannot escalate permissions");
    const prefix = `PI_ORCHESTRATOR_${engine.toUpperCase()}`;
    // Product default < environment < explicit request.
    const selection = validateSelection({ ...this.options.defaultSelection?.[engine], ...(process.env[`${prefix}_MODEL`] ? { model: process.env[`${prefix}_MODEL`] } : {}), ...(process.env[`${prefix}_THINKING`] ? { thinking: process.env[`${prefix}_THINKING`] } : {}), ...requestedSelection });
    if (engine === "claude" && selection.thinking && !["low", "medium", "high", "xhigh", "max"].includes(selection.thinking)) throw new Error("Unsupported Claude effort; expected low, medium, high, xhigh or max");
    if (recoverySource && (callerId !== null || Object.values(recoverySource).length !== 3 ||
        ![recoverySource.runId, recoverySource.taskId, recoverySource.attemptId].every((id) => typeof id === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(id)))) throw new Error("Invalid recovery source");
    if (this.persistenceFailure) throw this.persistenceFailure;
    this.budget.assertAvailable();
    this.assertSpendAvailable();
    if (this.closing) throw new Error("Orchestrator is shutting down");
    if (!this.endpoint) throw new Error("MCP bridge is not listening");
    if (!Object.hasOwn(this.options.adapters, engine) || !this.options.adapters[engine]) throw new Error("Unsupported engine");
    if (!prompt.trim() || prompt.length > 32_000) throw new Error("Prompt must contain 1–32000 characters");
    if (!requestKey.trim() || requestKey.length > 128) throw new Error("Invalid requestKey");
    const parent = callerId === null ? undefined : this.entry(callerId);
    // Native completion revokes admission before descendant cleanup can finish.
    // An already-authenticated MCP request must not create work in that interval.
    if (parent && (parent.view.state !== "running" || !this.identities.has(parent.tokenHash))) throw new Error("Caller is no longer running");
    // Children run where their parent runs (its worktree included); only the operator picks a directory.
    if (parent && requestedCwd !== undefined) throw new Error("Nested tasks run in their parent's directory");
    if (web !== undefined && typeof web !== "boolean") throw new Error("Invalid web flag");
    if (parent && web) throw new Error("Only the operator may grant internet access; nested tasks cannot request it");
    // Cosmetic and untrusted: one bounded line, never part of the request identity.
    const label = typeof requestedLabel === "string" ? requestedLabel.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || undefined : undefined;
    const cwd = parent ? parent.effectiveCwd ?? parent.view.cwd : this.placement(requestedCwd);
    const key = JSON.stringify([callerId, requestKey]);
    const signature = this.hash(JSON.stringify([engine, prompt, recoverySource, resumeSessionId, continuationSource, selection, permissionMode, cwd, Boolean(web)]));
    const previous = this.requests.get(key);
    if (previous) {
      if (previous.signature !== signature) throw new Error("requestKey already used with different arguments");
      const task = this.status(callerId, previous.id);
      // Observable proof of reuse; no request key or credential is added to the task event.
      this.emit("request-reused", this.entry(previous.id), undefined, false);
      return task;
    }
    if (resumeSessionId && this.sessionLeases.has(resumeSessionId)) throw new Error("Native session is already owned by a live continuation");
    const depth = parent ? parent.view.depth + 1 : 1;
    if (depth > this.limits.maxDepth) throw new Error("Delegation depth limit reached");
    if (this.entries.size >= this.limits.maxTasks) throw new Error("Total task limit reached");
    const queued = this.options.queuePolicy === "fair" && callerId === null;
    if (!queued && this.activeCount >= this.limits.maxConcurrent) throw new Error("Concurrency limit reached (parents count too; nested work cannot queue behind its waiting ancestors)");
    if (queued && this.queue.size >= this.maxQueued) throw new Error("Root queue limit reached");
    const token = randomBytes(32).toString("base64url");
    const view: TaskView = {
      id: randomUUID(), title: prompt.trim().replace(/\s+/g, " ").slice(0, 160), attemptId: randomUUID(), parentId: callerId, engine, depth, selection, permissionMode, ...(web ? { web: true } : {}), ...(label ? { label } : {}),
      cwd, state: queued ? "queued" : "running", createdAt: new Date().toISOString(),
      ...(recoverySource ? { recoverySource: { ...recoverySource } } : {}),
      ...(resumeSessionId ? { continuation: "native-resume" as const, continuationSource: { ...continuationSource! } } : {}),
    };
    // Commit intention before registering authority or scheduling any runtime execution.
    if (this.options.checkpoint && !this.checkpoint([...this.list(), this.snapshot(view)])) throw this.persistenceFailure;
    let settle!: () => void;
    const done = new Promise<void>((resolve) => { settle = resolve; });
    const entry: Entry = { view, controller: new AbortController(), done, settle, tokenHash: this.hash(token), started: !queued, resumeSessionId, prompt,
      launch: () => { void this.execute(entry, prompt, token); } };
    this.entries.set(view.id, entry);
    if (resumeSessionId) this.sessionLeases.set(resumeSessionId, view.id);
    const siblings = this.children.get(callerId) ?? new Set<string>();
    siblings.add(view.id); this.children.set(callerId, siblings);
    if (!queued) {
      this.activeCount++;
      if (callerId === null) this.activeRoots++;
      this.identities.set(entry.tokenHash, view.id);
      this.budget.setActive(this.activeCount);
    }
    this.requests.set(key, { signature, id: view.id });
    this.emit("started", entry, undefined, false);
    // Install the entry and completion promise before executing a possibly synchronous adapter.
    if (queued) { this.queue.push(engine, view.id); this.pump(); }
    else { const launch = entry.launch!; delete entry.launch; queueMicrotask(launch); }
    return this.snapshot(view);
  }

  private checkpoint(tasks?: TaskView[]): boolean {
    if (this.persistenceFailure) return false;
    if (!this.options.checkpoint) return true;
    try { this.options.checkpoint(tasks ?? this.list()); return true; }
    catch {
      // Latch first, then revoke/abort: recursive cancellation events must not retry failed I/O.
      this.persistenceFailure = new Error("Durable state write failed; new work refused and active tasks stopped. Archives may be incomplete.");
      this.closing = true;
      for (const id of this.children.get(null) ?? []) this.abortTree(id, this.persistenceFailure.message);
      try { this.options.onPersistenceError?.(this.persistenceFailure.message); } catch { /* independent observer */ }
      return false;
    }
  }

  private emit(type: string, entry: Entry, detail?: string, persist = true): void {
    if (persist) this.checkpoint();
    // Observers must never break task lifecycle or cleanup.
    try { this.options.onEvent?.({ type, task: this.snapshot(entry.view), detail }); } catch { /* observer only */ }
  }

  private async execute(entry: Entry, prompt: string, token: string): Promise<void> {
    let output: string | undefined;
    let didFail = false;
    let failure: unknown;
    const timer = setTimeout(() => {
      this.abortTree(entry.view.id, "Task deadline exceeded");
    }, this.limits.timeoutMs);
    // Killing at the deadline discards everything; a steerable runtime is first
    // asked to conclude. Best effort: failure here never affects the task.
    const soft = this.limits.timeoutMs >= 60_000 ? setTimeout(() => {
      if (entry.view.state !== "running" || entry.steering || !entry.controls?.steer || !this.identities.has(entry.tokenHash)) return;
      entry.steering = true;
      entry.controls.steer(WRAP_UP_TEXT).then(() => {
        if (entry.view.state !== "running") return;
        entry.view.lastActivity = "orchestrator: plazo casi agotado; se pidió cerrar";
        entry.view.activityAt = new Date().toISOString();
        this.emit("activity", entry, entry.view.lastActivity);
      }, () => { /* the hard deadline still applies */ }).finally(() => { entry.steering = false; });
    }, Math.floor(this.limits.timeoutMs * SOFT_DEADLINE)) : undefined;
    try {
      entry.controller.signal.throwIfAborted();
      if (this.options.isolateWrites && entry.view.permissionMode === "yolo" && entry.view.parentId === null) {
        const workspace = await isolate(entry.view.cwd);
        if (workspace) {
          entry.workspace = workspace; entry.effectiveCwd = workspace.cwd; entry.view.workspace = "worktree";
          // Cancelled while git was checking out: nothing ran, nothing to review.
          if (entry.controller.signal.aborted) entry.controller.signal.throwIfAborted();
        } else entry.view.workspace = "in-place";
        this.emit("workspace", entry);
      }
      const runOnce = () => this.options.adapters[entry.view.engine]!.run({
        task: { ...this.snapshot(entry.view), cwd: entry.effectiveCwd ?? entry.view.cwd }, prompt, resumeSessionId: entry.resumeSessionId, signal: entry.controller.signal,
        mcp: { url: this.endpoint!, token },
        usage: (usage) => {
          if (isTerminal(entry.view) || !this.identities.has(entry.tokenHash)) return;
          const raw = validUsage(usage);
          if (!raw) return; // Malformed provider counters are ignored, never displayed.
          entry.rawUsage = raw;
          const base = entry.usageBaseline;
          // Measured: a resumed thread's totals include the earlier turns; count only this task's share.
          const clean: TaskUsage = base ? {
            inputTokens: Math.max(0, raw.inputTokens - base.inputTokens), cachedInputTokens: Math.max(0, raw.cachedInputTokens - base.cachedInputTokens), outputTokens: Math.max(0, raw.outputTokens - base.outputTokens),
            ...(raw.reasoningTokens !== undefined ? { reasoningTokens: Math.max(0, raw.reasoningTokens - (base.reasoningTokens ?? 0)) } : {}),
            ...(raw.cacheWriteTokens !== undefined ? { cacheWriteTokens: Math.max(0, raw.cacheWriteTokens - (base.cacheWriteTokens ?? 0)) } : {}),
            ...(raw.costUsd !== undefined ? { costUsd: Math.max(0, raw.costUsd - (base.costUsd ?? 0)) } : {}),
          } : raw;
          if (clean.cachedInputTokens > clean.inputTokens) clean.cachedInputTokens = clean.inputTokens;
          const carry = entry.usageCarry;
          entry.view.usage = carry ? {
            inputTokens: carry.inputTokens + clean.inputTokens, cachedInputTokens: carry.cachedInputTokens + clean.cachedInputTokens, outputTokens: carry.outputTokens + clean.outputTokens,
            ...(carry.reasoningTokens !== undefined || clean.reasoningTokens !== undefined ? { reasoningTokens: (carry.reasoningTokens ?? 0) + (clean.reasoningTokens ?? 0) } : {}),
            ...(carry.cacheWriteTokens !== undefined || clean.cacheWriteTokens !== undefined ? { cacheWriteTokens: (carry.cacheWriteTokens ?? 0) + (clean.cacheWriteTokens ?? 0) } : {}),
            ...(carry.costUsd !== undefined || clean.costUsd !== undefined ? { costUsd: (carry.costUsd ?? 0) + (clean.costUsd ?? 0) } : {}),
          } : clean;
          // Display-only: the final settle checkpoint persists it without an fsync per update.
          this.emit("usage", entry, undefined, false);
        },
        context: (used, size) => {
          if (isTerminal(entry.view) || !this.identities.has(entry.tokenHash)) return;
          if (!Number.isSafeInteger(used) || !Number.isSafeInteger(size) || used < 0 || size < 1 || used > size * 4) return;
          entry.view.context = { used, size, peak: Math.max(used, entry.view.context?.peak ?? 0) };
          this.emit("context", entry, undefined, false);
        },
        partial: (text) => {
          // Memory only: no event or checkpoint per streamed fragment.
          if (isTerminal(entry.view) || !this.identities.has(entry.tokenHash) || typeof text !== "string") return;
          entry.partial = text.slice(0, MAX_RESULT + 1);
        },
        modelState: (state) => {
          if (entry.controller.signal.aborted || !this.identities.has(entry.tokenHash)) return;
          entry.view.modelState = structuredClone(state);
          this.emit("model-selected", entry);
        },
        registerControls: (controls) => {
          if (!controls || (entry.view.state === "running" && this.identities.has(entry.tokenHash))) entry.controls = controls ? { ...controls } : undefined;
        },
        interact: async (request) => {
          if (isTerminal(entry.view) || !this.identities.has(entry.tokenHash)) return undefined;
          const answer = await this.interactions.request(entry.view.id, entry.view.engine, {
            ...request, title: this.redact(request.title, token), detail: this.redact(request.detail, token),
            options: request.options.map((option) => ({ ...option, label: this.redact(option.label, token) })),
          }, entry.controller.signal);
          const granted = this.identities.has(entry.tokenHash) && !entry.controller.signal.aborted ? answer : undefined;
          // Restricted is not side-effect free when a person approves an operation (e.g. an Antigravity command).
          if (granted && request.kind === "permission") entry.humanApproved = true;
          return granted;
        },
        session: (id) => {
          if (entry.controller.signal.aborted || isTerminal(entry.view)) return;
          if (entry.resumeSessionId && id !== entry.resumeSessionId) throw new Error("Runtime resumed a different native session");
          entry.view.runtimeSessionId = this.redact(id, token).slice(0, 256);
          if (id === entry.view.runtimeSessionId) entry.nativeSessionId = id;
          this.emit("session", entry);
        },
        process: (info) => {
          if (isTerminal(entry.view)) return;
          entry.view.runtimeProcess = { ...info };
          this.emit(info.exitedAt ? "process-exited" : "process", entry);
        },
        activity: (detail) => {
          if (entry.controller.signal.aborted || isTerminal(entry.view)) return;
          entry.view.lastActivity = this.redact(detail, token).slice(0, 120);
          entry.view.activityAt = new Date().toISOString();
          const recent = entry.view.recentActivity ?? [];
          if (recent.at(-1)?.text !== entry.view.lastActivity) entry.view.recentActivity = [...recent, { at: entry.view.activityAt, text: entry.view.lastActivity }].slice(-3);
          // A durable rewrite (two fsyncs) per tool call is pure I/O (measured: 378
          // activity events in one session). Persist at most every 5 s per task;
          // the first one and the settle checkpoint are always written.
          const now = Date.now();
          const persist = entry.activityPersistedAt === undefined || now - entry.activityPersistedAt >= ACTIVITY_PERSIST_MS;
          if (persist) entry.activityPersistedAt = now;
          this.emit("activity", entry, entry.view.lastActivity, persist);
        },
      });
      for (let attempt = 1; ; attempt++) {
        try { output = await runOnce(); break; }
        catch (error) {
          if (attempt > 1 || !this.retryable(entry, error)) throw error;
          if (entry.view.usage) entry.usageCarry = { ...entry.view.usage };
          entry.view.lastActivity = `orchestrator: error transitorio (${diagnoseFailure(error).category}); reintento automático`;
          entry.view.activityAt = new Date().toISOString();
          this.emit("activity", entry, entry.view.lastActivity);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, this.options.retryDelayMs ?? RETRY_DELAY_MS);
            entry.controller.signal.addEventListener("abort", () => { clearTimeout(timer); reject(entry.controller.signal.reason); }, { once: true });
          });
        }
      }
      if (typeof output !== "string" || !output.trim()) throw new Error("Runtime returned no result");
      output = this.redact(output, token);
      // Before truncation: dead worktree links would otherwise consume the result budget.
      output = compactFileLinks(output, [entry.effectiveCwd, entry.view.cwd]);
      // Discarding a long answer throws away every token the runtime spent on it.
      if (output.length > MAX_RESULT) {
        // The full answer is kept in a private file; the published result points to it.
        const path = this.saveFullResult(entry.view.id, output);
        const note = path ? `\n\n[Resultado truncado por el orquestador: superaba ${MAX_RESULT} caracteres. Texto completo (${output.length} caracteres) en ${path}]` : TRUNCATION_NOTE;
        output = output.slice(0, MAX_RESULT - note.length) + note;
      }
    } catch (error) { didFail = true; failure = error; }
    finally {
      clearTimeout(timer); clearTimeout(soft);
      // A finished parent may not leave orphaned live work or valid delegation credentials.
      this.identities.delete(entry.tokenHash);
      this.interactions.cancelTask(entry.view.id);
      delete entry.controls;
      const children = [...(this.children.get(entry.view.id) ?? [])].map((id) => this.entry(id));
      for (const child of children) this.abortTree(child.view.id, "Parent execution ended");
      await Promise.all(children.map((child) => child.done));
      try { this.budget.assertAvailable(); } catch { /* Budget expiry aborts live work before terminal acknowledgement. */ }
      if (entry.workspace) {
        // Whatever the outcome, what was written is recorded for review, never applied here.
        try {
          const changes = await collectChanges(entry.workspace);
          if (changes.state === "none") await discardWorkspace(entry.workspace.repoRoot, entry.workspace.path, entry.workspace.patchDirectory + "/changes.patch");
          entry.view.changes = changes;
        } catch (error) {
          entry.view.changes = { state: "pending", files: 0, insertions: 0, deletions: 0, summary: "", repo: entry.workspace.repoRoot, worktree: entry.workspace.path, error: this.redact(errorText(error), token).slice(0, 500) };
        }
      }
      entry.cleanupFailed = failure instanceof RuntimeCleanupError ||
        Boolean(entry.view.runtimeProcess && !entry.view.runtimeProcess.exitedAt) ||
        children.some((child) => child.cleanupFailed);
      if (entry.cleanupFailed) {
        entry.view.state = "failed";
        entry.view.error = "Runtime cleanup could not be confirmed; no cancellation or process-group cleanup was acknowledged";
        entry.view.diagnostic = diagnoseFailure(new RuntimeCleanupError(undefined));
      } else if (entry.controller.signal.aborted) {
        entry.view.state = "cancelled";
        entry.view.error = errorText(entry.controller.signal.reason);
      } else if (didFail) {
        entry.view.state = "failed";
        entry.view.error = this.redact(errorText(failure), token).slice(0, 8_000);
        entry.view.diagnostic = diagnoseFailure(failure);
      } else {
        entry.view.state = "completed";
        entry.view.result = output!;
      }
      if (entry.view.state !== "completed" && entry.partial?.trim()) {
        let partial = compactFileLinks(this.redact(entry.partial, token), [entry.effectiveCwd, entry.view.cwd]);
        if (partial.length > MAX_RESULT - PARTIAL_NOTE.length) partial = partial.slice(0, MAX_RESULT - PARTIAL_NOTE.length - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
        entry.view.partialResult = partial + PARTIAL_NOTE;
      }
      delete entry.partial;
      entry.view.endedAt = new Date().toISOString();
      this.activeCount--;
      if (entry.view.parentId === null) this.activeRoots--;
      this.budget.setActive(this.activeCount);
      if (!this.checkpoint() && entry.view.state === "completed") {
        // Native success without a committed final checkpoint is not durable task success.
        entry.view.state = "failed";
        delete entry.view.result;
        entry.view.error = this.persistenceFailure!.message;
      }
      this.emit("settled", entry, undefined, false);
      if (!entry.cleanupFailed && entry.resumeSessionId && this.sessionLeases.get(entry.resumeSessionId) === entry.view.id) this.sessionLeases.delete(entry.resumeSessionId);
      entry.settle();
      this.pump();
    }
  }

  /** Operator-only fresh attempt of a settled root task with the same engine, prompt, selection and permission mode. */
  retry(callerId: string | null, sourceId: string, requestKey: string): TaskView {
    if (callerId !== null) throw new Error("Only the operator may retry a task");
    const source = this.entry(sourceId);
    if (source.view.parentId !== null) throw new Error("Only root tasks can be retried; retry their parent instead");
    if (!isTerminal(source.view)) throw new Error("Task is still active; cancel it before retrying");
    return this.admit(null, source.view.engine, source.prompt, requestKey, undefined, undefined, undefined, source.view.selection, source.view.permissionMode, source.view.cwd === this.cwd ? undefined : source.view.cwd, source.view.web, source.view.label);
  }

  private resultDirectory?: string;
  private saveFullResult(taskId: string, text: string): string | undefined {
    try {
      this.resultDirectory ??= mkdtempSync(join(tmpdir(), "pi-orch-results-"));
      const path = join(this.resultDirectory, `${taskId}.md`);
      writeFileSync(path, text, { mode: 0o600 });
      return path;
    } catch { return undefined; }
  }

  /** Operator only: the full prompt, kept in memory (never journaled), for the detail view. */
  promptOf(callerId: string | null, id: string): string | undefined {
    if (callerId !== null) return undefined;
    return this.entries.get(id)?.prompt;
  }

  /** One automatic retry is safe only when repeating cannot duplicate side effects. */
  private retryable(entry: Entry, error: unknown): boolean {
    if (entry.controller.signal.aborted || this.closing || error instanceof RuntimeCleanupError) return false;
    if (entry.view.permissionMode === "yolo" || entry.resumeSessionId || entry.humanApproved) return false;
    if ((this.children.get(entry.view.id)?.size ?? 0) > 0) return false; // children would be duplicated
    if (entry.view.runtimeProcess && !entry.view.runtimeProcess.exitedAt) return false;
    return diagnoseFailure(error).automaticRetry;
  }

  /** Operator only: applies a settled YOLO root's reviewed patch to the operator's tree. */
  async applyChanges(callerId: string | null, id: string): Promise<TaskView> {
    const entry = this.changesEntry(callerId, id);
    const changes = entry.view.changes!;
    if (!changes.patchPath) throw new Error("No recorded patch: inspect the worktree manually");
    await applyChanges(changes.repo!, changes.patchPath);
    await discardWorkspace(changes.repo!, changes.worktree, changes.patchPath);
    entry.view.changes = { ...changes, state: "applied", worktree: undefined, patchPath: undefined };
    this.emit("changes", entry);
    return this.snapshot(entry.view);
  }

  async discardChanges(callerId: string | null, id: string): Promise<TaskView> {
    const entry = this.changesEntry(callerId, id);
    const changes = entry.view.changes!;
    await discardWorkspace(changes.repo!, changes.worktree, changes.patchPath);
    entry.view.changes = { ...changes, state: "discarded", worktree: undefined, patchPath: undefined };
    this.emit("changes", entry);
    return this.snapshot(entry.view);
  }

  private changesEntry(callerId: string | null, id: string): Entry {
    if (callerId !== null) throw new Error("Only the operator may apply or discard task changes");
    const entry = this.entry(id);
    if (!isTerminal(entry.view)) throw new Error("Task is still active");
    if (entry.view.changes?.state !== "pending" || !entry.view.changes.repo) throw new Error("This task has no pending changes");
    return entry;
  }

  controls(callerId: string | null, id: string) {
    this.authorize(callerId, id);
    const entry = this.entry(id);
    return { ...this.options.adapters[entry.view.engine]!.capabilities, steerReady: this.options.adapters[entry.view.engine]!.capabilities.steer && entry.view.state === "running" && this.identities.has(entry.tokenHash) && Boolean(entry.controls?.steer), resumeReady: entry.view.state === "completed" && entry.view.permissionMode !== "yolo" && !entry.cleanupFailed && Boolean(entry.nativeSessionId && entry.view.runtimeProcess?.exitedAt) && Boolean(this.options.adapters[entry.view.engine]!.capabilities.resume) && !this.sessionLeases.has(entry.nativeSessionId!) };
  }

  async steer(callerId: string | null, id: string, text: string): Promise<void> {
    this.authorize(callerId, id);
    const entry = this.entry(id);
    if (typeof text !== "string" || !text.trim() || text.length > 32_000) throw new Error("Steer requires 1–32000 characters");
    if (!this.controls(callerId, id).steerReady || !entry.controls?.steer) throw new Error("Steer is unavailable for this runtime or current turn");
    if (entry.steering) throw new Error("A steer request is already pending");
    entry.steering = true;
    try {
      await entry.controls.steer(text);
      if (entry.view.state !== "running" || !this.identities.has(entry.tokenHash)) throw new Error("Steer acknowledgement arrived after the attempt was revoked; application is not confirmed");
      this.emit("steer-acknowledged", entry);
    } finally { entry.steering = false; }
  }

  /** Provider-reported spend so far: tokens from every engine, dollars only where reported (Claude). */
  spend(): { tokens: number; costUsd: number; costEngines: string[]; estimatedTokens: number; estimatedEngines: string[] } {
    let tokens = 0, costUsd = 0, estimatedTokens = 0;
    const costEngines = new Set<string>(), estimatedEngines = new Set<string>();
    for (const { view } of this.entries.values()) {
      if (!view.usage) {
        // Antigravity reports no token usage, only context occupancy. Its peak is a
        // lower bound of the input tokens billed (every model call resends at least
        // that much), so the token guard is no longer blind to those tasks.
        const peak = view.context?.peak ?? view.context?.used;
        if (peak !== undefined) { tokens += peak; estimatedTokens += peak; estimatedEngines.add(view.engine); }
        continue;
      }
      tokens += view.usage.inputTokens + view.usage.outputTokens;
      if (view.usage.costUsd !== undefined) { costUsd += view.usage.costUsd; costEngines.add(view.engine); }
    }
    return { tokens, costUsd, costEngines: [...costEngines], estimatedTokens, estimatedEngines: [...estimatedEngines] };
  }

  private assertSpendAvailable(): void {
    const { tokens, costUsd } = this.spend();
    if (this.options.maxTokens !== undefined && tokens >= this.options.maxTokens) throw new Error(`Session token limit reached (${tokens} ≥ ${this.options.maxTokens}, PI_ORCHESTRATOR_MAX_TOKENS); new work is refused`);
    if (this.options.maxCostUsd !== undefined && costUsd >= this.options.maxCostUsd) throw new Error(`Session cost limit reached ($${costUsd.toFixed(2)} ≥ $${this.options.maxCostUsd}, PI_ORCHESTRATOR_MAX_COST_USD); new work is refused`);
  }

  /** Real model listings, one short-lived probe per engine (never a prompt); failures are reported per engine. */
  async catalog(signal?: AbortSignal): Promise<Record<string, EngineCatalog | { error: string }>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Catalog probe deadline")), 60_000);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const entries = await Promise.all(Object.entries(this.options.adapters).map(async ([engine, adapter]) => {
        if (!adapter?.catalog) return [engine, { error: "listing unsupported" }] as const;
        try { return [engine, await adapter.catalog(this.cwd, controller.signal)] as const; }
        catch (error) { return [engine, { error: errorText(error).slice(0, 300) }] as const; }
      }));
      return Object.fromEntries(entries);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }

  usage() {
    return { ...this.budget.view(), spend: this.spend(), maxCostUsd: this.options.maxCostUsd, maxTokens: this.options.maxTokens, tasks: this.entries.size, queued: this.queue.size, maxTasks: this.limits.maxTasks, maxConcurrent: this.limits.maxConcurrent, rootSlots: this.options.queuePolicy === "fair" ? this.rootSlots : this.limits.maxConcurrent };
  }

  private pump(): void {
    while (!this.closing && this.activeCount < this.limits.maxConcurrent && this.activeRoots < this.rootSlots) {
      const id = this.queue.shift();
      if (!id) return;
      const entry = this.entry(id);
      if (isTerminal(entry.view)) continue;
      entry.started = true; entry.view.state = "running";
      this.activeCount++; this.activeRoots++;
      // Dispatch is a second durable barrier, before granting credentials or invoking the runtime.
      if (this.checkpoint()) this.identities.set(entry.tokenHash, id);
      this.budget.setActive(this.activeCount);
      this.emit("dispatched", entry, undefined, false);
      const launch = entry.launch!; delete entry.launch; queueMicrotask(launch);
    }
  }

  private redact(text: string, ownToken: string): string {
    return text.replaceAll(ownToken, "[REDACTED]").replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]");
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
        this.queue.remove(current); delete entry.launch;
        if (entry.resumeSessionId && this.sessionLeases.get(entry.resumeSessionId) === current) this.sessionLeases.delete(entry.resumeSessionId);
        entry.controller.abort(new Error(reason));
        entry.view.state = "cancelled"; entry.view.error = reason; entry.view.endedAt = new Date().toISOString();
        this.emit("settled", entry); entry.settle();
        continue;
      }
      if (!entry.controller.signal.aborted) {
        entry.view.state = "cancelling";
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
    return this.entry(callerId).view.engine === "antigravity" ? { defaultMs: 30_000, maxMs: 60_000 } : { defaultMs: 300_000, maxMs: 600_000 };
  }

  async wait(callerId: string | null, id: string, timeoutMs = 30_000, signal?: AbortSignal): Promise<TaskView> {
    this.authorize(callerId, id);
    const maxWait = this.waitWindow(callerId).maxMs;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxWait) throw new Error(`Wait must be 1–${maxWait} ms`);
    signal?.throwIfAborted();
    const entry = this.entry(id);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const boundary = new Promise<void>((resolve, reject) => {
      timer = setTimeout(resolve, timeoutMs);
      if (signal) {
        onAbort = () => reject(signal.reason ?? new Error("Wait aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try { await Promise.race([entry.done, boundary]); }
    finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
    return this.status(callerId, id);
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const id of this.children.get(null) ?? []) this.abortTree(id, "Pi session closed");
    await Promise.all([...this.entries.values()].map((entry) => entry.done));
    this.identities.clear();
  }
}
