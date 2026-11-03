import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunStore, RunJournal } from "../src/journal.ts";
import { planRecovery } from "../src/recovery.ts";
import { createService } from "../src/service.ts";
import { capabilities, type RuntimeContext, type TaskView } from "../src/types.ts";

test("restart of an unclosed archive creates fresh root authority and durable lineage without changing the old run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orch-restart-"));
  const cwd = realpathSync(process.cwd());
  const store = new RunStore(directory);
  const old = new RunJournal(store, cwd);
  const previous: TaskView = { id: randomUUID(), attemptId: randomUUID(), parentId: null, depth: 1, cwd, engine: "codex", state: "running", createdAt: new Date().toISOString(), title: "not a recoverable prompt", runtimeProcess: { pid: 2147483000, groupId: 2147483000 }, runtimeSessionId: "archived-session" };
  old.checkpoint([previous]);
  const path = join(directory, `${old.runId}.json`), before = readFileSync(path);
  let observed: RuntimeContext | undefined;
  const run = async (context: RuntimeContext) => { observed = context; return "new result"; };
  const service = await createService({ cwd, stateDirectory: directory }, { codex: { capabilities, run } });
  try {
    assert.equal(service.core.list().length, 0);
    assert.throws(() => planRecovery(store, old.runId, previous.id, cwd, "fresh prompt", false), /aceptar explícitamente/);
    assert.throws(() => planRecovery(store, old.runId, previous.id, tmpdir(), "fresh prompt", true), /workspace actual no coincide/);
    assert.throws(() => planRecovery(store, old.runId, "short", cwd, "fresh prompt", true), /ocho caracteres/);
    assert.throws(() => planRecovery(store, old.runId, previous.id, cwd, " ", true), /instrucción nueva/);
    assert.throws(() => planRecovery(store, old.runId, randomUUID(), cwd, "fresh prompt", true), /desconocido o ambiguo/);
    const plan = planRecovery(store, old.runId.slice(0, 8), previous.id.slice(0, 8), cwd, "fresh prompt", true);
    assert.equal(service.core.list().length, 0, "planning does not execute");
    const task = service.core.delegate(null, plan.engine, plan.prompt, "restart-once", plan.recoverySource);
    const result = await service.core.wait(null, task.id);
    assert.equal(result.state, "completed"); assert.equal(result.parentId, null);
    assert.notEqual(result.id, previous.id); assert.notEqual(result.attemptId, previous.attemptId);
    assert.equal(result.runtimeProcess, undefined); assert.equal(result.runtimeSessionId, undefined);
    assert.equal(observed!.prompt, "fresh prompt"); assert.ok(observed!.mcp.token);
    assert.equal(service.core.authenticate(observed!.mcp.token), undefined, "new authority is revoked on completion");
    assert.deepEqual(result.recoverySource, { runId: old.runId, taskId: previous.id, attemptId: previous.attemptId });
    result.recoverySource!.runId = randomUUID();
    assert.equal(service.core.status(null, task.id).recoverySource!.runId, old.runId, "snapshot lineage is not mutable");
    assert.equal(service.core.delegate(null, plan.engine, plan.prompt, "restart-once", plan.recoverySource).id, task.id);
    assert.throws(() => service.core.delegate(null, plan.engine, plan.prompt, "restart-once", { ...plan.recoverySource, taskId: randomUUID() }), /different arguments/);
    await service.close();
    const record = store.read(service.journal!.runId);
    assert.ok(record.closedAt); assert.deepEqual(record.tasks[0]!.recoverySource, plan.recoverySource);
    assert.deepEqual(readFileSync(path), before, "old intent remains byte-identical, with no invented closure");
  } finally { await service.close(); rmSync(directory, { recursive: true, force: true }); }
});
