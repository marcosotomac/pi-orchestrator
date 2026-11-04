import type { TaskState, TaskView } from "./types.ts";

const transitions: Record<TaskState, readonly TaskState[]> = {
  queued: ["running", "cancelled"],
  running: ["cancelling", "completed", "failed", "cancelled"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** The only post-completion correction: completion was not durably checkpointed. */
export function transitionTask(
  task: TaskView,
  next: TaskState,
  reason?: "checkpoint-failed",
): void {
  if (task.state === next) return;
  if (
    !(
      reason === "checkpoint-failed" &&
      task.state === "completed" &&
      next === "failed"
    ) &&
    !transitions[task.state].includes(next)
  ) {
    throw new Error(`Invalid task transition: ${task.state} -> ${next}`);
  }
  task.state = next;
}
