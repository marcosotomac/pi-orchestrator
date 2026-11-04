import { isTerminal, type TaskView } from "./types.ts";
import { safeText } from "./presentation.ts";

/**
 * What the coordinating model needs from a task, nothing more. The full
 * TaskView (attempt, process, cwd, model catalog…) stays in tool `details` for
 * the TUI; every field here is paid for again on each later model turn.
 */
export type ResultPolicy = "include" | "omit" | "summary";

export const AVAILABLE_NOTE = "disponible; orchestrator_status con este taskId lo devuelve";
export const DELIVERED_NOTE = "ya entregado en una llamada anterior; orchestrator_status con este taskId lo repite";

// Terminal control sequences (e.g. OSC 52 payloads) carry no meaning for the model.
const text = (value: string, policy: ResultPolicy) => policy === "include" ? safeText(value) : policy === "omit" ? DELIVERED_NOTE : AVAILABLE_NOTE;

export function modelTask(task: TaskView, policy: ResultPolicy): Record<string, unknown> {
  const model = task.modelState?.model ?? task.selection?.model;
  const thinking = task.modelState?.thinking ?? task.selection?.thinking;
  const usage = task.usage;
  return {
    id: task.id, engine: task.engine, state: task.state, title: task.title,
    ...(task.parentId ? { parentId: task.parentId } : {}),
    ...(model ? { model } : {}), ...(thinking ? { thinking } : {}),
    ...(task.permissionMode === "yolo" ? { permissionMode: "yolo" } : {}),
    ...(task.web ? { web: true } : {}),
    ...(!isTerminal(task) && task.lastActivity ? { lastActivity: task.lastActivity } : {}),
    ...(usage ? { tokens: usage.inputTokens + usage.outputTokens, ...(usage.costUsd !== undefined ? { costUsd: Number(usage.costUsd.toFixed(4)) } : {}) } : {}),
    ...(!usage && task.context ? { contextTokens: task.context.peak ?? task.context.used } : {}),
    ...(task.error ? { error: safeText(task.error).slice(0, 2_000) } : {}),
    ...(task.diagnostic ? { recovery: task.diagnostic.recovery } : {}),
    ...(task.workspace === "in-place" ? { workspace: "in-place (no git repository with a commit, or isolation disabled: changes were written directly)" } : {}),
    ...(task.changes && task.changes.state !== "none" ? { changes: {
      state: task.changes.state, files: task.changes.files, insertions: task.changes.insertions, deletions: task.changes.deletions,
      summary: safeText(task.changes.summary).slice(0, 1_500),
      ...(task.changes.state === "pending" ? { note: "Cambios aislados en un worktree, NO están en el repo del operador. Solo el operador los aplica o descarta (/orch apply ID · /orch discard ID · teclas a/x del panel). Díselo; no afirmes que ya están aplicados." } : {}),
    } } : {}),
    ...(task.result !== undefined ? { result: text(task.result, policy) } : {}),
    ...(task.partialResult !== undefined ? { partialResult: text(task.partialResult, policy) } : {}),
  };
}

/** Results reach the model once per task; later polls of the same task carry a pointer instead. */
export class DeliveryLedger {
  private delivered = new Set<string>();
  /** Policy for this response; a terminal task's text counts as delivered afterwards. */
  take(task: TaskView): ResultPolicy {
    if (this.delivered.has(task.id)) return "omit";
    if (isTerminal(task) && (task.result !== undefined || task.partialResult !== undefined)) this.delivered.add(task.id);
    return "include";
  }
  mark(id: string): void { this.delivered.add(id); }
  has(id: string): boolean { return this.delivered.has(id); }
  clear(): void { this.delivered.clear(); }
}
