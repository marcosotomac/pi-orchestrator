import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createService } from "../src/service.ts";
import { isTerminal, type TaskView } from "../src/types.ts";
import { processCensus } from "../src/reconciliation.ts";

// Opt-in: two real Antigravity model turns. No archived PID adoption or synthetic history replay.
process.umask(0o077);
const evidence = await mkdtemp(resolve("artifacts/native-resume-"));
const cwd = await mkdtemp(join(tmpdir(), "orch-resume-live-"));
const events: { type: string; task: TaskView }[] = [];
const service = await createService({ cwd, maxTasks: 2, timeoutMs: 90_000, stateDirectory: join(evidence, "state"), onEvent: (event) => events.push(event) });
const settled = async (id: string) => { let task = service.core.status(null, id); while (!isTerminal(task)) task = await service.core.wait(null, id, 30_000); return task; };
let passed = false;
try {
  const marker = `RESUME-${randomBytes(16).toString("hex")}`;
  const original = service.core.delegate(null, "antigravity", `Remember this exact marker for the next message in this conversation: ${marker}. Do not use tools. Reply only READY without repeating the marker.`, "original");
  const first = await settled(original.id);
  assert.equal(first.state, "completed"); assert.ok(first.result?.includes("READY"));
  assert.ok(service.core.controls(null, first.id).resumeReady);
  const continued = service.core.resume(null, first.id, "Return only the exact marker I gave you in the previous message. Do not use tools, invent a marker or ask another agent.", "resume-once");
  const second = await settled(continued.id);
  assert.equal(second.state, "completed"); assert.ok(second.result?.includes(marker));
  assert.notEqual(second.id, first.id); assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(second.runtimeSessionId, first.runtimeSessionId);
  assert.ok(first.runtimeProcess?.exitedAt); assert.ok(second.runtimeProcess?.exitedAt);
  assert.equal(second.continuation, "native-resume");
  assert.deepEqual(second.continuationSource, { taskId: first.id, attemptId: first.attemptId });
  passed = true;
} catch { /* Preserve task evidence without provider bodies or assertion diffs. */ }
finally {
  try {
    await service.close();
    const groups = new Set(service.core.list().map((task) => task.runtimeProcess?.groupId));
    const rows = processCensus(); assert.ok(rows);
    assert.ok(!rows.some((row) => groups.has(row.groupId) && !row.state.startsWith("Z")));
  } catch { passed = false; }
  await writeFile(join(evidence, "report.json"), JSON.stringify({ passed, endedAt: new Date().toISOString(), scope: "Native ACP session/resume of a cleanly completed session owned by this live coordinator; second prompt contains no marker or replayed history", runId: service.journal?.runId, tasks: service.core.list(), events }, null, 2), { mode: 0o600 });
  await rm(cwd, { recursive: true, force: true });
}
console.log(`${passed ? "PASS" : "FAIL"}: native Antigravity resume; private evidence: ${join(evidence, "report.json")}`);
if (!passed) process.exitCode = 1;
