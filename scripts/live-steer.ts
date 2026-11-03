import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createService } from "../src/service.ts";
import { isTerminal, type TaskView } from "../src/types.ts";
import { processCensus } from "../src/reconciliation.ts";

// Opt-in native Codex model quota; no forced model tool calls or substituted results.
process.umask(0o077);
const evidence = await mkdtemp(resolve("artifacts/native-steer-"));
const cwd = await mkdtemp(join(tmpdir(), "orch-steer-live-"));
const events: { type: string; task: TaskView }[] = [];
const service = await createService({ cwd, maxTasks: 1, timeoutMs: 90_000, stateDirectory: join(evidence, "state"), onEvent: (event) => events.push(event) });
let passed = false;
try {
  const task = service.core.delegate(null, "codex", "Explain structured concurrency in a detailed twenty-section essay. Do not call tools or delegate work.", "original");
  const deadline = Date.now() + 45_000;
  while (!service.core.controls(null, task.id).steerReady) {
    assert.ok(!isTerminal(service.core.status(null, task.id)) && Date.now() < deadline);
    await delay(5);
  }
  const marker = `STEER-${randomBytes(16).toString("hex")}`;
  await service.core.steer(null, task.id, `Updated instruction from the operator for this active turn: do not write the essay. Return only this exact marker: ${marker}`);
  let result = service.core.status(null, task.id);
  while (!isTerminal(result)) result = await service.core.wait(null, task.id, 30_000);
  assert.equal(result.state, "completed"); assert.ok(result.result?.includes(marker));
  assert.ok(result.runtimeSessionId); assert.ok(result.runtimeProcess?.exitedAt);
  assert.ok(events.some((event) => event.type === "steer-acknowledged"));
  passed = true;
} catch { /* No provider bodies or assertion diffs printed. */ }
finally {
  try {
    await service.close();
    const groups = new Set(service.core.list().map((task) => task.runtimeProcess?.groupId));
    const rows = processCensus(); assert.ok(rows);
    assert.ok(!rows.some((row) => groups.has(row.groupId) && !row.state.startsWith("Z")));
  } catch { passed = false; }
  await writeFile(join(evidence, "report.json"), JSON.stringify({ passed, endedAt: new Date().toISOString(), scope: "One live Codex attempt: marker delivered only through native turn/steer, not the original prompt", runId: service.journal?.runId, tasks: service.core.list(), events }, null, 2), { mode: 0o600 });
  await rm(cwd, { recursive: true, force: true });
}
console.log(`${passed ? "PASS" : "FAIL"}: native Codex steer; private evidence: ${join(evidence, "report.json")}`);
if (!passed) process.exitCode = 1;
