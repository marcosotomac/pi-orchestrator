import test from "node:test";
import assert from "node:assert/strict";
import { transitionTask } from "../src/task-state.ts";
import type { TaskState, TaskView } from "../src/types.ts";

const states: TaskState[] = [
  "queued",
  "running",
  "cancelling",
  "completed",
  "failed",
  "cancelled",
];
const allowed: Record<TaskState, TaskState[]> = {
  queued: ["running", "cancelled"],
  running: ["cancelling", "completed", "failed", "cancelled"],
  cancelling: ["cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};
test("task transitions enforce every state pair and keep invalid transitions unchanged", () => {
  for (const from of states)
    for (const to of states) {
      const task = { state: from } as TaskView;
      if (from === to || allowed[from].includes(to)) {
        transitionTask(task, to);
        assert.equal(task.state, to);
      } else {
        assert.throws(
          () => transitionTask(task, to),
          /Invalid task transition/,
        );
        assert.equal(task.state, from);
      }
    }
});
test("only failed completion checkpoints may correct a terminal state", () => {
  const task = { state: "completed" } as TaskView;
  transitionTask(task, "failed", "checkpoint-failed");
  assert.equal(task.state, "failed");
  assert.throws(() => transitionTask(task, "running", "checkpoint-failed"));
});
