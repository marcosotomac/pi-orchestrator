import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { processCensus } from "../src/reconciliation.ts";
import { createService } from "../src/service.ts";
import { isTerminal, type Engine, type TaskView } from "../src/types.ts";

// Explicit opt-in: native agents use real quota. No Pi-model tool-choice claim.
process.umask(0o077);
const [parentEngine = "antigravity", childEngine = "codex"] =
  process.argv.slice(2);
const valid = (value: string): value is Engine =>
  ["antigravity", "codex", "claude"].includes(value);
if (
  !valid(parentEngine) ||
  !valid(childEngine) ||
  parentEngine === childEngine ||
  ![parentEngine, childEngine].includes("antigravity")
)
  throw new Error(
    "Expected antigravity codex|claude, or codex|claude antigravity",
  );
const cwd = await mkdtemp(join(tmpdir(), "orch-antigravity-nested-"));
const evidence = await mkdtemp(
  resolve(`artifacts/antigravity-nested-${parentEngine}-${childEngine}-`),
);
const marker = `NEST-${randomBytes(16).toString("hex")}`;
const source = `Verification: ${marker}\n`;
await writeFile(join(cwd, "challenge.txt"), source, { mode: 0o600 });
const events: { type: string; task: TaskView }[] = [];
const service = await createService({
  cwd,
  stateDirectory: join(evidence, "state"),
  timeoutMs: 180_000,
  maxTasks: 2,
  onEvent: (event) => events.push(event),
});
let passed = false;
try {
  let task = service.core.delegate(
    null,
    parentEngine,
    `Do not read files yourself. Use the pi_orchestrator MCP delegate tool to create exactly one ${childEngine} child with requestKey "native-marker". Ask the child: Read challenge.txt in the current workspace and return its exact Verification marker. Do not write files or use shell. Then use the MCP wait tool until terminal. Return the real child task ID and its exact marker. Do not use native subagents or make up IDs/results.`,
    "nested-root",
  );
  while (!isTerminal(task))
    task = await service.core.wait(null, task.id, 30_000);
  const tasks = service.core.list();
  assert.equal(tasks.length, 2);
  const child = tasks.find((entry) => entry.parentId === task.id)!;
  assert.ok(child);
  assert.equal(child.engine, childEngine);
  assert.ok(task.result?.includes(child.id));
  for (const entry of tasks) {
    assert.equal(entry.state, "completed");
    assert.ok(entry.result?.includes(marker));
    assert.ok(entry.runtimeProcess?.exitedAt);
    assert.ok(entry.runtimeSessionId);
    const history = events.filter((event) => event.task.id === entry.id);
    assert.ok(
      history.findIndex((event) => event.type === "process-exited") <
        history.findIndex((event) => event.type === "settled"),
    );
  }
  assert.equal(await readFile(join(cwd, "challenge.txt"), "utf8"), source);
  assert.deepEqual(await readdir(cwd), ["challenge.txt"]);
  passed = true;
} catch {
  /* Keep external errors and assertion diffs private. */
} finally {
  try {
    await service.close();
    const groups = new Set(
      service.core
        .list()
        .map((task) => task.runtimeProcess?.groupId)
        .filter(Boolean),
    );
    for (let attempt = 0; ; attempt++) {
      const rows = processCensus();
      if (!rows) throw new Error("Owned-group census unavailable");
      if (
        !rows.some(
          (row) => groups.has(row.groupId) && !row.state.startsWith("Z"),
        )
      )
        break;
      if (attempt >= 40) throw new Error("Owned groups still executing");
      await delay(50);
    }
  } catch {
    passed = false;
  }
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(
      {
        endedAt: new Date().toISOString(),
        passed,
        parentEngine,
        childEngine,
        scope:
          "Service API root; real native parent delegates through MCP; no main Pi model selection claim",
        runId: service.journal?.runId,
        tasks: service.core.list(),
        events,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rm(cwd, { recursive: true, force: true });
}
console.log(
  `${passed ? "PASS" : "FAIL"}: native ${parentEngine} -> ${childEngine}; private report: ${join(evidence, "report.json")}`,
);
if (!passed) process.exitCode = 1;
