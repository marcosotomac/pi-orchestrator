import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities } from "../src/types.ts";

test("native resume owns one session, issues fresh attempts, preserves lineage and never adopts archives", async () => {
  const core = new Orchestrator({ cwd: process.cwd(), maxTasks: 8, adapters: { antigravity: { capabilities: { ...capabilities, resume: true }, run: async (ctx) => {
    ctx.session(ctx.resumeSessionId ?? "native-session");
    const info = { pid: 123, groupId: 123, startedAt: new Date().toISOString(), exitedAt: new Date().toISOString() };
    ctx.process!(info);
    if (ctx.resumeSessionId) await delay(60000, undefined, { signal: ctx.signal });
    return "ready";
  } } } });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const first = core.delegate(null, "antigravity", "first", "first");
    assert.throws(() => core.resume(null, first.id, "early", "early"), /unsupported/);
    await core.wait(null, first.id);
    const next = core.resume(null, first.id, "continue", "continue");
    assert.equal(next.continuation, "native-resume");
    assert.notEqual(next.attemptId, first.attemptId);
    assert.deepEqual(next.continuationSource, { taskId: first.id, attemptId: first.attemptId });
    next.continuationSource!.taskId = "mutated";
    assert.equal(core.status(null, next.id).continuationSource!.taskId, first.id);
    assert.equal(core.resume(null, first.id, "continue", "continue").id, next.id);
    assert.throws(() => core.resume(null, first.id, "duplicate", "duplicate"), /already owned/);
    await core.cancel(null, next.id);
    assert.throws(() => core.resume(null, next.id, "cancelled", "cancelled"), /unsupported/);
    assert.throws(() => core.resume(null, "archived-id", "archive", "archive"));
  } finally { await core.close(); }
});
