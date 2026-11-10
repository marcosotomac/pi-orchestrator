// Opt-in, quota-consuming A/B benchmark of nested orchestration with real runtimes.
// Run it on two checkouts (e.g. main and this branch) and compare the reports:
//   ORCH_BENCH_LIVE=1 npx tsx scripts/bench-nested-live.ts [parentEngine] [repetitions]
// A real parent delegates three children (one reads a missing file, so it fails),
// waits for them and reports. No supervisor model; no Pi main model.
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";
import { createService } from "../src/service.ts";
import type { Engine, TaskView } from "../src/types.ts";

if (process.env.ORCH_BENCH_LIVE !== "1")
  throw new Error(
    "Consumes real model quota with no hard monetary cap. Set ORCH_BENCH_LIVE=1 to authorize.",
  );
const parentEngine = (process.argv[2] ?? "codex") as Engine;
const childEngine: Engine = parentEngine === "codex" ? "claude" : "codex";
const repetitions = Number(process.argv[3] ?? 2);
if (!["codex", "claude"].includes(parentEngine) || !(repetitions >= 1))
  throw new Error("Usage: bench-nested-live.ts codex|claude [repetitions]");

const revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  encoding: "utf8",
}).trim();
const reportPath = join(
  process.cwd(),
  "artifacts",
  `bench-nested-${revision}-${Date.now()}.json`,
);
await mkdir(join(process.cwd(), "artifacts"), { recursive: true });
const rows: Record<string, unknown>[] = [];
const total = (tasks: TaskView[]) =>
  tasks.reduce(
    (sum, task) =>
      sum + (task.usage ? task.usage.inputTokens + task.usage.outputTokens : 0),
    0,
  );

for (let repetition = 1; repetition <= repetitions; repetition++) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-orch-bench-nested-"));
  const markers = [1, 2].map(() => `M-${randomBytes(6).toString("hex")}`);
  await writeFile(join(cwd, "a.txt"), `marker: ${markers[0]}\n`);
  await writeFile(join(cwd, "b.txt"), `marker: ${markers[1]}\n`);
  // MCP requests made by the parent (each tool call is at least one): a proxy
  // for its turns that works on revisions without orchestration counters.
  let parentRequests = 0;
  let rootId = "";
  const service = await createService({
    cwd,
    maxConcurrent: 4,
    queuePolicy: "fair",
    onBridgeAudit: (event) => {
      if (event.phase === "received" && event.callerId === rootId)
        parentRequests++;
    },
  });
  const started = performance.now();
  try {
    const prompt = [
      "Read-only orchestration benchmark. Do not modify files.",
      `Use the pi_orchestrator MCP tools to delegate THREE tasks to the ${childEngine} engine in parallel:`,
      "1) read a.txt and return its marker; 2) read b.txt and return its marker; 3) read missing.txt and return its marker.",
      "Then wait for all of them (use a single wait call with every task id if the tool accepts several).",
      "If a child fails, do not retry it. Answer with one line per task: its file, state and marker (or the failure).",
    ].join("\n");
    const root = service.core.delegate(null, parentEngine, prompt, "bench");
    rootId = root.id;
    let view = root;
    while (!["completed", "failed", "cancelled"].includes(view.state))
      view = await service.core.wait(null, root.id, 600_000);
    const tasks = service.core.list();
    const children = tasks.filter((task) => task.parentId === root.id);
    const usage = service.core.usage() as {
      orchestration?: Record<string, number>;
    };
    rows.push({
      repetition,
      state: view.state,
      elapsedMs: Math.round(performance.now() - started),
      markersFound: markers.filter((marker) => view.result?.includes(marker))
        .length,
      children: children.map((child) => child.state),
      parentTokens: total([view]),
      childTokens: total(children),
      parentRequests,
      orchestration: usage.orchestration,
      result: view.result ?? view.partialResult ?? view.error,
    });
  } finally {
    await service.close();
    await rm(cwd, { recursive: true, force: true });
  }
  await writeFile(
    reportPath,
    JSON.stringify({ revision, parentEngine, childEngine, rows }, null, 2),
    { mode: 0o600 },
  );
}
console.log(`Report: ${reportPath}`);
console.log(
  JSON.stringify(
    rows.map(({ result: _result, ...row }) => row),
    null,
    2,
  ),
);
