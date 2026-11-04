import type { InteractionRequest, InteractionAnswer } from "./interactions.ts";

export type Engine = "codex" | "claude" | "antigravity";
export interface RecoverySource {
  runId: string;
  taskId: string;
  attemptId: string;
}
export type PermissionMode = "restricted" | "yolo";
export function validatePermissionMode(value: unknown): PermissionMode {
  if (value === undefined || value === "restricted") return "restricted";
  if (value === "yolo") return "yolo";
  throw new Error("Invalid permission mode");
}
/**
 * Sandbox for YOLO tasks. Default "on": writes confined to the task directory
 * (a worktree for git repos), no network. "off" restores full access and must
 * be an explicit operator choice (PI_ORCHESTRATOR_YOLO_SANDBOX=off).
 */
export function yoloSandbox(
  env: NodeJS.ProcessEnv = process.env,
): "on" | "off" {
  const value = env.PI_ORCHESTRATOR_YOLO_SANDBOX?.trim();
  if (value === undefined || value === "" || value === "on") return "on";
  if (value === "off") return "off";
  throw new Error("Invalid PI_ORCHESTRATOR_YOLO_SANDBOX (expected on or off)");
}
export type TaskState =
  | "queued"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "cancelled";

export interface RuntimeProcessInfo {
  pid: number;
  groupId?: number;
  exitedAt?: string;
  code?: number | null;
  signal?: string | null;
}

/** Provider-reported token usage for one attempt (cumulative); never Pi billing. */
export interface TaskUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens?: number;
  /** Part of inputTokens written to the prompt cache (Claude bills it above base input). */
  cacheWriteTokens?: number;
  costUsd?: number;
}

export interface TaskView {
  id: string;
  title: string;
  attemptId: string;
  parentId: string | null;
  engine: Engine;
  depth: number;
  cwd: string;
  state: TaskState;
  createdAt: string;
  endedAt?: string;
  recoverySource?: RecoverySource;
  continuation?: "native-resume";
  continuationSource?: { taskId: string; attemptId: string };
  permissionMode?: PermissionMode;
  selection?: import("./model-selection.ts").ModelSelection;
  modelState?: import("./model-selection.ts").ModelState;
  runtimeSessionId?: string;
  runtimeProcess?: RuntimeProcessInfo;
  lastActivity?: string;
  activityAt?: string;
  result?: string;
  /** Last answer text observed before a failure or cancellation; never a completion. */
  partialResult?: string;
  error?: string;
  diagnostic?: import("./diagnostics.ts").FailureDiagnostic;
  usage?: TaskUsage;
  /** Short human label (2–6 words) chosen by the delegating model; display only. */
  label?: string;
  /** The last few reported actions with their time (newest last); display only, not journaled. */
  recentActivity?: { at: string; text: string }[];
  /** Operator-granted internet access for this task (search/fetch tools); never inherited. */
  web?: boolean;
  /** Context window occupancy a runtime reports (Antigravity usage_update); not consumption. */
  /** Context occupancy the runtime reports; `peak` is the largest `used` seen (an input-token lower bound when no usage is reported). */
  context?: { used: number; size: number; peak?: number };
  /** "worktree": a YOLO root isolated in a private checkout; "in-place": not a git repo. */
  workspace?: "worktree" | "in-place";
  changes?: import("./workspace.ts").TaskChanges;
}

export interface RuntimeControls {
  steer?: (text: string) => Promise<void>;
}

export interface RuntimeContext {
  task: TaskView;
  prompt: string;
  resumeSessionId?: string;
  signal: AbortSignal;
  mcp: { url: string; token: string };
  session: (id: string) => void;
  process?: (info: RuntimeProcessInfo) => void;
  activity: (event: string) => void;
  interact?: (request: InteractionRequest) => Promise<InteractionAnswer>;
  registerControls?: (controls: RuntimeControls | undefined) => void;
  modelState?: (state: import("./model-selection.ts").ModelState) => void;
  /** Cumulative provider usage for this attempt; replaces earlier reports. */
  usage?: (usage: TaskUsage) => void;
  /** Latest answer text so far (replaces earlier reports); published only if the attempt does not complete. */
  partial?: (text: string) => void;
  /** Context window occupancy (tokens used of the window), display-only. */
  context?: (used: number, size: number) => void;
}

export interface RuntimeAdapter {
  capabilities: {
    nestedDelegation: true;
    cancel: true;
    resume: boolean;
    steer: boolean;
    interactiveQuestions: boolean;
    interactivePermissions?: boolean;
  };
  run(context: RuntimeContext): Promise<string>;
  /** Real models and thinking levels this runtime offers now (no prompt is sent). */
  catalog?(cwd: string, signal: AbortSignal): Promise<EngineCatalog>;
}

export interface EngineCatalog {
  models: {
    id: string;
    name?: string;
    efforts?: string[];
    default?: boolean;
  }[];
  thinking?: string[];
  note?: string;
}

export const capabilities: RuntimeAdapter["capabilities"] = {
  nestedDelegation: true,
  cancel: true,
  resume: false,
  steer: false,
  interactiveQuestions: false,
};

export function isTerminal(task: TaskView): boolean {
  return ["completed", "failed", "cancelled"].includes(task.state);
}

/** A settled adapter promise is not proof that its process group or private resources were cleaned. */
export class RuntimeCleanupError extends Error {
  constructor(cause?: unknown) {
    super("Runtime cleanup could not be confirmed", { cause });
    this.name = "RuntimeCleanupError";
  }
}

export function errorText(error: unknown): string {
  try {
    const text = error instanceof Error ? String(error.message) : String(error);
    return text || "Unknown runtime error";
  } catch {
    return "Unknown runtime error";
  }
}
