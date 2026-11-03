import { performance } from "node:perf_hooks";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities, type RuntimeContext } from "../src/types.ts";

// Synthetic in-memory fixture only: no bridge listener, subprocess, persistence or model quota.
const count = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error("Expected 1–10000 fixture tasks");
const run = async (ctx: RuntimeContext) => {
  for (let i = 0; i < 4; i++) ctx.activity("fixture activity");
  await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
  throw ctx.signal.reason;
};
const core = new Orchestrator({ cwd: process.cwd(), maxTasks: count, maxConcurrent: count, adapters: { codex: { capabilities, run } } });
core.attachEndpoint("http://127.0.0.1:12345/mcp");
const list = core.list.bind(core);
let fullListCalls = 0, projectedSnapshots = 0;
core.list = () => { const tasks = list(); fullListCalls++; projectedSnapshots += tasks.length; return tasks; };
const started = performance.now();
try {
  for (let i = 0; i < count; i++) core.delegate(null, "codex", "fixture", `fixture-${i}`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await core.close();
  const elapsedMs = performance.now() - started;
  const tasks = list();
  if (tasks.length !== count || tasks.some((task) => task.state !== "cancelled")) throw new Error("Fixture lifecycle mismatch");
  console.log(JSON.stringify({ fixture: "in-memory roots, four activity events each, then shutdown", tasks: count, elapsedMs, fullListCalls, projectedSnapshots, heapUsedBytes: process.memoryUsage().heapUsed, noModelsOrNativeProcesses: true }));
} finally { await core.close(); }
