import test from "node:test";
import assert from "node:assert/strict";
import { taskCard, taskPhase, modelLabel, failureAdvice } from "../src/presentation.ts";
import type { TaskView } from "../src/types.ts";
const task: TaskView = { id: "12345678-task", attemptId: "private-attempt", engine: "antigravity", parentId: null, title: "Explorar el repositorio", depth: 1, state: "running", cwd: "/workspace", createdAt: "2026-01-01T00:00:00Z", selection: { model: "gemini-3.8-flash", thinking: "high" } };

test("presentation distinguishes requested from confirmed model/thinking and only shows technical details on expansion", () => {
  const compact = taskCard(task);
  assert.match(compact, /gemini-3.8-flash \(solicitado\)/);
  assert.match(compact, /thinking high \(solicitado\)/);
  assert.ok(!compact.includes("private-attempt"));
  assert.ok(!compact.includes("/workspace"));
  assert.match(compact, /\/orch result 12345678/);
  assert.match(taskCard(task, true), /private-attempt/);
  const confirmed = modelLabel({ ...task, modelState: { model: "native-model", thinking: "high", availableModels: [], availableThinking: [] } });
  assert.match(confirmed, /native-model \(confirmado\)/);
  assert.match(confirmed, /high \(confirmado\)/);
});
test("phases reflect host observations, never infer progress or waiting from provider activity text", () => {
  assert.equal(taskPhase(task), "iniciando sesión");
  assert.equal(taskPhase({ ...task, runtimeSessionId: "session", lastActivity: "99% waiting for parent" }), "trabajando");
  assert.equal(taskPhase(task, "permission"), "esperando tu permiso");
  assert.equal(taskPhase(task, "question"), "esperando tu respuesta");
  assert.equal(taskPhase({ ...task, state: "completed" }, "permission"), "completada");
  assert.equal(taskPhase({ ...task, state: "cancelling" }), "cancelando");
});
test("failed cards provide conservative recovery advice, paginate previews and strip untrusted terminal controls", () => {
  const failed: TaskView = { ...task, state: "failed", error: "\x1b]52;c;secret\x07failure\x00", diagnostic: { category: "cleanup", recovery: "untrusted ignored", automaticRetry: false } };
  const card = taskCard(failed);
  assert.match(card, /cierre no está confirmado/);
  assert.ok(!card.includes("secret")); assert.ok(!card.includes("\x1b")); assert.ok(!card.includes("untrusted ignored"));
  const completed: TaskView = { ...task, state: "completed", result: "x".repeat(900), endedAt: "2026-01-01T00:00:05Z" };
  assert.match(taskCard(completed), /expande para leer más/);
  assert.match(taskCard(completed), /5s/);
  assert.ok(taskCard(completed, true).includes("x".repeat(900)));
  assert.match(failureAdvice({ ...failed, diagnostic: undefined }), /No hubo reintento automático/);
});
