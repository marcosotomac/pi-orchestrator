import { performance } from "node:perf_hooks";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities, type RuntimeContext } from "../src/types.ts";

// Synthetic scheduling benchmark: fair queue, nested fan-out, no subprocess,
// bridge, persistence or quota. Usage: tsx scripts/benchmark-scheduling.ts [roots] [children]
const roots = Number(process.argv[2] ?? 300);
const children = Number(process.argv[3] ?? 3);
if (!Number.isInteger(roots) || roots < 1 || roots > 3_000)
  throw new Error("Expected 1–3000 roots");
let core!: Orchestrator;
let rejected = 0;
const leaf = async (ctx: RuntimeContext) => {
  ctx.activity("fixture activity");
  await new Promise<void>((resolve) => setImmediate(resolve));
  return "leaf";
};
const parent = async (ctx: RuntimeContext) => {
  const ids: string[] = [];
  for (let i = 0; i < children; i++)
    try {
      ids.push(core.delegate(ctx.task.id, "claude", `child ${i}`, `c${i}`).id);
    } catch {
      rejected++; // a refused child costs the parent model a turn in real use
    }
  if (ids.length) await core.waitAll(ctx.task.id, ids, 60_000);
  return "parent";
};
core = new Orchestrator({
  cwd: process.cwd(),
  queuePolicy: "fair",
  maxConcurrent: 8,
  maxQueued: roots * (children + 1),
  maxTasks: roots * (children + 1),
  adapters: {
    codex: { capabilities, run: parent },
    claude: { capabilities, run: leaf },
  },
});
core.attachEndpoint("http://127.0.0.1:12345/mcp");
const heapBefore = process.memoryUsage().heapUsed;
const started = performance.now();
const ids = Array.from(
  { length: roots },
  (_, i) => core.delegate(null, "codex", `root ${i}`, `r${i}`).id,
);
for (const id of ids) await core.wait(null, id, 600_000);
const elapsedMs = performance.now() - started;
const tasks = core.list();
const metrics = (core.usage() as { orchestration?: Record<string, number> })
  .orchestration;
console.log(
  JSON.stringify(
    {
      roots,
      childrenPerRoot: children,
      tasks: tasks.length,
      completed: tasks.filter((task) => task.state === "completed").length,
      rejectedChildren: rejected,
      elapsedMs: Math.round(elapsedMs),
      msPerTask: +(elapsedMs / tasks.length).toFixed(3),
      heapDeltaMb: +(
        (process.memoryUsage().heapUsed - heapBefore) /
        1_048_576
      ).toFixed(1),
      ...(metrics
        ? {
            childQueued: metrics.childQueued,
            queueWaitMsMax: metrics.queueWaitMsMax,
          }
        : {}),
    },
    null,
    2,
  ),
);
await core.close();
