import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities, type RuntimeContext } from "../src/types.ts";

const run = async (ctx: RuntimeContext) => {
  for (let i = 0; i < 4; i++) ctx.activity("fixture activity");
  await new Promise<void>((resolve) =>
    ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  throw ctx.signal.reason;
};

test("1000 in-memory tasks admit, emit activity and settle without full-list projections when persistence is disabled", async () => {
  const core = new Orchestrator({
    cwd: process.cwd(),
    maxTasks: 1001,
    maxConcurrent: 1000,
    adapters: { codex: { capabilities, run } },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  const list = core.list.bind(core);
  let projections = 0;
  core.list = () => {
    projections++;
    return list();
  };
  try {
    const tasks = Array.from({ length: 1000 }, (_, i) =>
      core.delegate(null, "codex", "fixture", String(i)),
    );
    assert.throws(
      () => core.delegate(null, "codex", "over capacity", "over"),
      /Concurrency/,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await core.cancel(null, tasks[0]!.id);
    const replacement = core.delegate(
      null,
      "codex",
      "released slot",
      "replacement",
    );
    assert.ok(replacement.id);
    await core.close();
    assert.equal(
      projections,
      0,
      "no hidden O(n) projections for no-op checkpoints or admission",
    );
    assert.equal(list().length, 1001);
    assert.ok(list().every((task) => task.state === "cancelled"));
  } finally {
    await core.close();
  }
});

test("indexed iterative cancellation handles a deep subtree without crossing to a sibling root", async () => {
  const depth = 1500;
  const core = new Orchestrator({
    cwd: process.cwd(),
    maxDepth: depth,
    maxTasks: depth + 1,
    maxConcurrent: depth + 1,
    adapters: { codex: { capabilities, run } },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const sibling = core.delegate(null, "codex", "sibling", "sibling");
    let parent = root;
    for (let i = 1; i < depth; i++)
      parent = core.delegate(parent.id, "codex", "child", `child-${i}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal((await core.cancel(null, root.id)).state, "cancelled");
    assert.equal(core.status(null, parent.id).state, "cancelled");
    assert.equal(core.status(null, sibling.id).state, "running");
    assert.equal(
      core.list().filter((task) => task.state === "cancelled").length,
      depth,
    );
  } finally {
    await core.close();
  }
});
