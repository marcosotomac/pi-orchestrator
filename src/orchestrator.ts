import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { Engine, RecoverySource, RuntimeAdapter, RuntimeControls, TaskUsage, TaskView } from "./types.ts";
import { FairQueue } from "./fair-queue.ts";
import { RuntimeBudget } from "./budget.ts";
import { InteractionBroker, type InteractionHandler } from "./interactions.ts";
import { validateSelection, type ModelSelection } from "./model-selection.ts";
import { diagnoseFailure } from "./diagnostics.ts";
import { errorText, isTerminal, RuntimeCleanupError, validatePermissionMode, type PermissionMode } from "./types.ts";

/** Journal/schema bound for a published result. */
export const MAX_RESULT = 20_000;
export const PARTIAL_NOTE = "\n\n[Resultado parcial: la tarea no terminó; este es el último texto que el runtime produjo antes de cortarse.]";
/** Soft deadline: at this fraction of the task timeout, steerable runtimes are asked to answer now. */
export const SOFT_DEADLINE = 0.85;
export const WRAP_UP_TEXT = "Time limit almost reached. Stop exploring now and give your final answer with what you already have. State clearly what you could not verify or finish.";
export const TRUNCATION_NOTE = `\n\n[Resultado truncado por el orquestador: superaba ${MAX_RESULT} caracteres; se publican los primeros. Pide al runtime un resumen o que escriba el detalle en un archivo.]`;

function validUsage(value: TaskUsage): TaskUsage | undefined {
  const count = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n < 1e12;
  if (!value || !count(value.inputTokens) || !count(value.cachedInputTokens) || !count(value.outputTokens)) return undefined;
  if (value.reasoningTokens !== undefined && !count(value.reasoningTokens)) return undefined;
  if (value.costUsd !== undefined && !(typeof value.costUsd === "number" && Number.isFinite(value.costUsd) && value.costUsd >= 0 && value.costUsd < 1e6)) return undefined;
  return { inputTokens: value.inputTokens, cachedInputTokens: Math.min(value.cachedInputTokens, value.inputTokens), outputTokens: value.outputTokens,
    ...(value.reasoningTokens !== undefined ? { reasoningTokens: value.reasoningTokens } : {}), ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}) };
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
    return { ...view, ...(view.selection ? { selection: { ...view.selection } } : {}), ...(view.modelState ? { modelState: structuredClone(view.modelState) } : {}), ...(view.diagnostic ? { diagnostic: { ...view.diagnostic } } : {}), ...(view.continuationSource ? { continuationSource: { ...view.continuationSource } } : {}), ...(view.recoverySource ? { recoverySource: { ...view.recoverySource } } : {}), ...(view.runtimeProcess ? { runtimeProcess: { ...view.runtimeProcess } } : {}), ...(view.usage ? { usage: { ...view.usage } } : {}) };
  }

  delegate(callerId: string | null, engine: Engine, prompt: string, requestKey: string, recoverySource?: RecoverySource, selection?: ModelSelection, permissionMode?: PermissionMode): TaskView {
    return this.admit(callerId, engine, prompt, requestKey, recoverySource, undefined, undefined, selection, permissionMode);
  }

  resume(callerId: string | null, sourceId: string, prompt: string, requestKey: string): TaskView {
    this.authorize(callerId, sourceId);
    if (callerId !== null) throw new Error("Only the operator may resume a native session");
    const source = this.entry(sourceId);
    if (source.view.permissionMode === "yolo") throw new Error("Native resume of YOLO sessions is unsupported; authorize a fresh task instead");
    if (source.view.state !== "completed" || source.cleanupFailed || !source.view.runtimeProcess?.exitedAt || !source.nativeSessionId || !this.options.adapters[source.view.engine]!.capabilities.resume) throw new Error("Native resume is unsupported or the source has no verified clean completion in this live coordinator");
    return this.admit(null, source.view.engine, prompt, requestKey, undefined, source.nativeSessionId, { taskId: source.view.id, attemptId: source.view.attemptId }, { ...source.view.selection, ...(source.view.modelState?.model ? { model: source.view.modelState.model } : {}), ...(source.view.modelState?.thinking ? { thinking: source.view.modelState.thinking } : {}) });
  }

  private admit(callerId: string | null, engine: Engine, prompt: string, requestKey: string, recoverySource?: RecoverySource, resumeSessionId?: string, continuationSource?: { taskId: string; attemptId: string }, requestedSelection?: ModelSelection, requestedPermissionMode?: PermissionMode): TaskView {
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
    if (this.closing) throw new Error("Orchestrator is shutting down");
    if (!this.endpoint) throw new Error("MCP bridge is not listening");
    if (!Object.hasOwn(this.options.adapters, engine) || !this.options.adapters[engine]) throw new Error("Unsupported engine");
    if (!prompt.trim() || prompt.length > 32_000) throw new Error("Prompt must contain 1–32000 characters");
    if (!requestKey.trim() || requestKey.length > 128) throw new Error("Invalid requestKey");
    const parent = callerId === null ? undefined : this.entry(callerId);
    // Native completion revokes admission before descendant cleanup can finish.
    // An already-authenticated MCP request must not create work in that interval.
    if (parent && (parent.view.state !== "running" || !this.identities.has(parent.tokenHash))) throw new Error("Caller is no longer running");
    const key = JSON.stringify([callerId, requestKey]);
    const signature = this.hash(JSON.stringify([engine, prompt, recoverySource, resumeSessionId, continuationSource, selection, permissionMode]));
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
      id: randomUUID(), title: prompt.trim().replace(/\s+/g, " ").slice(0, 160), attemptId: randomUUID(), parentId: callerId, engine, depth, selection, permissionMode,
      cwd: this.cwd, state: queued ? "queued" : "running", createdAt: new Date().toISOString(),
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
      output = await this.options.adapters[entry.view.engine]!.run({
        task: this.snapshot(entry.view), prompt, resumeSessionId: entry.resumeSessionId, signal: entry.controller.signal,
        mcp: { url: this.endpoint!, token },
        usage: (usage) => {
          if (isTerminal(entry.view) || !this.identities.has(entry.tokenHash)) return;
          const clean = validUsage(usage);
          if (!clean) return; // Malformed provider counters are ignored, never displayed.
          entry.view.usage = clean;
          // Display-only: the final settle checkpoint persists it without an fsync per update.
          this.emit("usage", entry, undefined, false);
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
          return this.identities.has(entry.tokenHash) && !entry.controller.signal.aborted ? answer : undefined;
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
          this.emit("activity", entry, entry.view.lastActivity);
        },
      });
      if (typeof output !== "string" || !output.trim()) throw new Error("Runtime returned no result");
      output = this.redact(output, token);
      // Discarding a long answer throws away every token the runtime spent on it.
      if (output.length > MAX_RESULT) output = output.slice(0, MAX_RESULT - TRUNCATION_NOTE.length) + TRUNCATION_NOTE;
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
        let partial = this.redact(entry.partial, token);
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
    return this.admit(null, source.view.engine, source.prompt, requestKey, undefined, undefined, undefined, source.view.selection, source.view.permissionMode);
  }

  controls(callerId: string | null, id: string) {
    this.authorize(callerId, id);
    const entry = this.entry(id);
    return { ...this.options.adapters[entry.view.engine]!.capabilities, steerReady: this.options.adapters[entry.view.engine]!.capabilities.steer && entry.view.state === "running" && this.identities.has(entry.tokenHash) && Boolean(entry.controls?.steer), resumeReady: entry.view.state === "completed" && !entry.cleanupFailed && Boolean(entry.nativeSessionId && entry.view.runtimeProcess?.exitedAt) && Boolean(this.options.adapters[entry.view.engine]!.capabilities.resume) && !this.sessionLeases.has(entry.nativeSessionId!) };
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

  usage() {
    return { ...this.budget.view(), tasks: this.entries.size, queued: this.queue.size, maxTasks: this.limits.maxTasks, maxConcurrent: this.limits.maxConcurrent, rootSlots: this.options.queuePolicy === "fair" ? this.rootSlots : this.limits.maxConcurrent };
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
