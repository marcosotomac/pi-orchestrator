import test from "node:test";
import assert from "node:assert/strict";
import {
  DEADLINE_WARNING_MS,
  engineRecordLines,
  modelLabel,
  taskDetail,
  taskRow,
} from "../src/presentation.ts";
import type { TaskView } from "../src/types.ts";

const now = Date.UTC(2026, 10, 9, 12, 0, 0);
const running = (extra: Partial<TaskView> = {}): TaskView => ({
  id: "11111111-1111-4111-8111-111111111111",
  attemptId: "22222222-2222-4222-8222-222222222222",
  title: "Revisar pagos",
  parentId: null,
  engine: "claude",
  depth: 1,
  cwd: "/repo",
  state: "running",
  createdAt: new Date(now - 60_000).toISOString(),
  runtimeSessionId: "session",
  ...extra,
});

test("a task near its deadline shows the time left before it is cut", () => {
  const far = running({
    deadlineAt: new Date(now + DEADLINE_WARNING_MS + 60_000).toISOString(),
  });
  assert.doesNotMatch(taskDetail(far, [], undefined, now).text ?? "", /plazo/);
  const near = running({ deadlineAt: new Date(now + 45_000).toISOString() });
  assert.deepEqual(taskDetail(near, [], undefined, now), {
    text: "quedan 45s de plazo",
    tone: "warning",
  });
  const bounded = running({
    deadlineAt: new Date(now + 30_000).toISOString(),
    deadlineBounded: true,
  });
  assert.match(
    taskRow(bounded, "", 140, [], undefined, now),
    /quedan 30s de plazo \(acotado al de su padre\)/,
  );
});

test("a fallback task says which engine it replaced", () => {
  assert.match(
    modelLabel(running({ engine: "codex", fallbackFrom: "claude" })),
    /^Codex · en lugar de Claude, que falló por cuota o sesión/,
  );
  assert.doesNotMatch(modelLabel(running()), /en lugar de/);
});

test("/orch engines lists each engine's recent outcomes and flags a blocked one", () => {
  const lines = engineRecordLines({
    claude: {
      tasks: 4,
      completed: 2,
      failed: 2,
      cancelled: 0,
      failures: { quota: 2 },
      medianMs: 45_000,
      medianTokens: 23_400,
      blocked: { category: "quota", at: new Date(now).toISOString() },
    },
    codex: { tasks: 1, completed: 1, failed: 0, cancelled: 0, failures: {} },
  });
  assert.deepEqual(lines, [
    "Historial reciente por motor:",
    "  Claude: 2/4 completadas · 2 fallidas (2 cuota) · mediana 45s · 23k tokens · ⚠ bloqueado: último fallo por cuota",
    "  Codex: 1/1 completadas",
  ]);
  assert.deepEqual(engineRecordLines({}), [
    "Historial por motor: aún no hay tareas terminadas.",
  ]);
});
