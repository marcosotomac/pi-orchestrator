import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Orchestrator } from "../src/orchestrator.ts";
import {
  capabilities,
  type RuntimeAdapter,
  type RuntimeContext,
} from "../src/types.ts";

const adapter = (run: RuntimeAdapter["run"]): RuntimeAdapter => ({
  capabilities,
  run,
});
const blocked = async ({ signal }: RuntimeContext): Promise<string> => {
  await delay(60_000, undefined, { signal });
  return "unreachable";
};
function make(
  options: Partial<ConstructorParameters<typeof Orchestrator>[0]> & {
    run?: RuntimeAdapter["run"];
    child?: RuntimeAdapter["run"];
  } = {},
) {
  const { run = blocked, child = blocked, ...rest } = options;
  const core: Orchestrator = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: adapter(run), claude: adapter(child) },
    ...rest,
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  return core;
}

test("a late child ends by its parent's soft deadline, so the parent still synthesizes", async () => {
  let core!: Orchestrator;
  core = make({
    timeoutMs: 1_000,
    // Parent delegates late (t≈500 ms) and blocks in a long wait, as a model would.
    run: async (ctx) => {
      await delay(500, undefined, { signal: ctx.signal });
      const child = core.delegate(ctx.task.id, "claude", "child", "child");
      const settled = await core.wait(ctx.task.id, child.id, 600_000);
      return `parent saw ${settled.state}: ${settled.partialResult ?? ""}`;
    },
    child: async (ctx) => {
      ctx.partial?.("child half-done");
      await delay(60_000, undefined, { signal: ctx.signal });
      return "unreachable";
    },
  });
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const done = await core.wait(null, root.id, 5_000);
    assert.equal(done.state, "completed", done.error);
    assert.match(
      done.result!,
      /parent saw (cancelled|failed): child half-done/,
    );
    assert.equal(core.usage().orchestration.deadlineClamps, 1);
  } finally {
    await core.close();
  }
});

test("a nested wait returns by the caller's soft deadline even if the child outlives it", async () => {
  let core!: Orchestrator;
  let returnedAt = 0;
  const started = Date.now();
  core = make({
    timeoutMs: 1_000,
    run: async (ctx) => {
      const child = core.delegate(ctx.task.id, "claude", "child", "child");
      const view = await core.wait(ctx.task.id, child.id, 600_000);
      returnedAt = Date.now() - started;
      return `waited: ${view.state}`;
    },
    // Ignores abort for a while: cleanup slower than the deadline.
    child: async () => {
      await delay(1_400);
      return "too late";
    },
  });
  try {
    const root = core.delegate(null, "codex", "root", "root");
    await core.wait(null, root.id, 5_000);
    assert.ok(
      returnedAt >= 800 && returnedAt < 1_000,
      `returned at ${returnedAt} ms`,
    );
    assert.ok(core.usage().orchestration.waitClamps >= 1);
  } finally {
    await core.close();
  }
});
