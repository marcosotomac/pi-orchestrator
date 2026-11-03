import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processCensus } from "../src/reconciliation.ts";
import { createService } from "../src/service.ts";
import { isTerminal, type TaskView } from "../src/types.ts";

// Explicit opt-in: consumes real Antigravity model quota. No monetary hard cap.
process.umask(0o077);
const cwd = await mkdtemp(join(tmpdir(), "orch-antigravity-live-"));
const evidence = await mkdtemp(resolve("artifacts/antigravity-live-"));
const marker = `ACP-${randomBytes(16).toString("hex")}`;
const source = `Verification: ${marker}\n`;
await writeFile(join(cwd, "challenge.txt"), source, { mode: 0o600 });
const events: { type: string; task: TaskView }[] = [];
const service = await createService({ cwd, stateDirectory: join(evidence, "state"), timeoutMs: 120_000, maxTasks: 1, onEvent: (event) => events.push(event) });
let passed = false;
try {
  let task = service.core.delegate(null, "antigravity", "Read challenge.txt in the current workspace. Return its exact Verification marker, and nothing else. Do not write files, run shell commands or delegate work.", "antigravity-live");
  while (!isTerminal(task)) task = await service.core.wait(null, task.id, 30_000);
  assert.equal(task.state, "completed"); assert.ok(task.result?.includes(marker));
  assert.ok(task.runtimeProcess?.exitedAt); assert.ok(task.runtimeSessionId);
  const history = events.filter((event) => event.task.id === task.id);
  assert.ok(history.findIndex((event) => event.type === "process-exited") < history.findIndex((event) => event.type === "settled"));
  assert.equal(await readFile(join(cwd, "challenge.txt"), "utf8"), source);
  assert.deepEqual(await readdir(cwd), ["challenge.txt"]);
  passed = true;
} catch { /* No provider body or assertion diff to console. */ }
finally {
  try {
    await service.close();
    const groups = new Set(service.core.list().map((task) => task.runtimeProcess?.groupId).filter(Boolean));
    for (let attempt = 0; ; attempt++) {
      const rows = processCensus();
      if (!rows) throw new Error("Owned-group census unavailable");
      if (!rows.some((row) => groups.has(row.groupId) && !row.state.startsWith("Z"))) break;
      if (attempt >= 40) throw new Error("Owned groups still executing");
      await delay(50);
    }
  } catch { passed = false; }
  await writeFile(join(evidence, "report.json"), JSON.stringify({ endedAt: new Date().toISOString(), passed, scope: "Real Antigravity ACP; fresh session and native file read; no nested delegation tested", runId: service.journal?.runId, tasks: service.core.list(), events }, null, 2), { mode: 0o600 });
  await rm(cwd, { recursive: true, force: true });
}
console.log(`${passed ? "PASS" : "FAIL"}: Antigravity live read; private report: ${join(evidence, "report.json")}`);
if (!passed) process.exitCode = 1;
