import type { InteractionRequest, InteractionAnswer } from "./interactions.ts";

export type Engine = "codex" | "claude" | "antigravity";
export interface RecoverySource { runId: string; taskId: string; attemptId: string }
export type PermissionMode = "restricted" | "yolo";
export function validatePermissionMode(value: unknown): PermissionMode {
  if (value === undefined || value === "restricted") return "restricted";
  if (value === "yolo") return "yolo";
  throw new Error("Invalid permission mode");
}
export type TaskState = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";

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
  error?: string;
  diagnostic?: import("./diagnostics.ts").FailureDiagnostic;
  usage?: TaskUsage;
}

export interface RuntimeControls { steer?: (text: string) => Promise<void> }

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
  } catch { return "Unknown runtime error"; }
}
