import test from "node:test";
import assert from "node:assert/strict";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import { Orchestrator } from "../src/orchestrator.ts";
import { runtimeConfiguration } from "../src/configuration.ts";
import {
  capabilities,
  type RuntimeContext,
  type TaskView,
} from "../src/types.ts";

const blocked = async (ctx: RuntimeContext) => {
  await delay(60_000, undefined, { signal: ctx.signal });
  return "unreachable";
};
const create = (
  options: Partial<ConstructorParameters<typeof Orchestrator>[0]> = {},
) => {
  const core = new Orchestrator({
    cwd: process.cwd(),
    queuePolicy: "fair",
    maxConcurrent: 2,
    maxTasks: 12,
    adapters: {
      codex: { capabilities, run: blocked },
      claude: { capabilities, run: blocked },
      antigravity: { capabilities, run: blocked },
    },
    ...options,
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  return core;
};

test("fair root queue is FIFO by engine, round-robin across engines, and bounded", async () => {
  const calls: string[] = [];
  const release = new Map<string, () => void>();
  const run = async (ctx: RuntimeContext) => {
    calls.push(ctx.prompt);
    await new Promise<void>((resolve) => release.set(ctx.prompt, resolve));
    return "done";
  };
  const core = create({
    maxConcurrent: 1,
    maxQueued: 4,
    adapters: {
      codex: { capabilities, run },
      claude: { capabilities, run },
      antigravity: { capabilities, run },
    },
  });
  try {
    const tasks = [
      core.delegate(null, "codex", "codex-1", "1"),
      core.delegate(null, "codex", "codex-2", "2"),
      core.delegate(null, "codex", "codex-3", "3"),
      core.delegate(null, "claude", "claude-1", "4"),
      core.delegate(null, "antigravity", "anti-1", "5"),
    ];
    assert.equal(core.usage().queued, 4);
    assert.throws(
      () => core.delegate(null, "claude", "overflow", "6"),
      /queue limit/,
    );
    assert.equal(
      core.delegate(null, "codex", "codex-2", "2").id,
      tasks[1]!.id,
      "retry at full queue uses no slot",
    );
    for (const name of [
      "codex-1",
      "claude-1",
      "anti-1",
      "codex-2",
      "codex-3",
    ]) {
      await tick();
      assert.equal(calls.at(-1), name);
      release.get(name)!();
      const task = tasks.find((task) => task.title === name)!;
      assert.equal((await core.wait(null, task.id)).state, "completed");
    }
    assert.deepEqual(calls, [
      "codex-1",
      "claude-1",
      "anti-1",
      "codex-2",
      "codex-3",
    ]);
    assert.equal(core.usage().activeSlots, 0);
    assert.equal(core.usage().queued, 0);
  } finally {
    for (const fn of release.values()) fn();
    await core.close();
  }
});

test("queued cancellation and shutdown never launch queued adapters, and reserved child capacity avoids waiting behind roots", async () => {
  const core = create();
  try {
    const parent = core.delegate(null, "codex", "parent", "parent");
    const queued = core.delegate(null, "claude", "queued root", "queued");
    assert.equal(queued.state, "queued");
    assert.equal(core.usage().activeSlots, 1);
    assert.throws(
      () => core.delegate(queued.id, "codex", "no queued authority", "no"),
      /no longer running/,
    );
    const child = core.delegate(parent.id, "claude", "child", "child");
    assert.equal(child.state, "running");
    assert.equal(core.usage().activeSlots, 2);
    // A leaf at full capacity waits (its sibling's slot can free) and is never launched early.
    const overflow = core.delegate(parent.id, "codex", "nested overflow", "o");
    assert.equal(overflow.state, "queued");
    assert.equal(core.usage().queued, 2);
    assert.equal((await core.cancel(null, queued.id)).state, "cancelled");
    assert.equal(core.status(null, queued.id).runtimeProcess, undefined);
    assert.equal((await core.cancel(null, overflow.id)).state, "cancelled");
    assert.equal(core.status(null, overflow.id).runtimeProcess, undefined);
    assert.equal(core.usage().queued, 0);
    await core.close();
    assert.ok(core.list().every((task) => task.state === "cancelled"));
    assert.equal(core.usage().activeSlots, 0);
  } finally {
    await core.close();
  }
});

test("dispatch intent is checkpointed before queued runtime authority, and persistence failure refuses dispatch", async () => {
  let snapshots: TaskView[] = [],
    fail = false,
    starts = 0;
  const run = async (ctx: RuntimeContext) => {
    starts++;
    assert.ok(
      snapshots.some(
        (task) => task.id === ctx.task.id && task.state === "running",
      ),
    );
    return "done";
  };
  const core = create({
    maxConcurrent: 1,
    checkpoint: (tasks) => {
      if (fail) throw new Error("fixture storage");
      snapshots = tasks;
    },
    adapters: { codex: { capabilities, run } },
  });
  try {
    const first = core.delegate(null, "codex", "first", "first");
    const second = core.delegate(null, "codex", "second", "second");
    assert.ok(
      snapshots.some(
        (task) => task.id === second.id && task.state === "queued",
      ),
    );
    fail = true;
    await core.wait(null, first.id);
    await core.wait(null, second.id);
    assert.equal(starts, 1);
    assert.equal(core.usage().activeSlots, 0);
    assert.equal(core.usage().queued, 0);
    assert.ok(core.list().every((task) => task.state !== "completed"));
  } finally {
    await core.close();
  }
});

test("aggregate occupied-slot budget cancels active and queued work, refuses new tasks and reports unknown monetary cost", async () => {
  const core = create({ maxRuntimeMs: 50 });
  try {
    const parent = core.delegate(null, "codex", "parent", "parent");
    const queued = core.delegate(null, "claude", "queued", "queued");
    const child = core.delegate(parent.id, "claude", "child", "child");
    const [p, c, q] = await Promise.all([
      core.wait(null, parent.id),
      core.wait(null, child.id),
      core.wait(null, queued.id),
    ]);
    assert.ok(
      [p, c, q].every(
        (task) =>
          task.state === "cancelled" && /budget exhausted/.test(task.error!),
      ),
    );
    assert.equal(q.runtimeProcess, undefined);
    assert.throws(
      () => core.delegate(null, "codex", "refused", "refused"),
      /budget exhausted/,
    );
    const usage = core.usage();
    assert.ok(usage.exhausted);
    assert.ok(usage.runtimeMs >= 50);
    assert.equal(usage.activeSlots, 0);
    assert.equal(usage.queued, 0);
    assert.equal(usage.monetaryCost, "unavailable");
    const stopped = usage.runtimeMs;
    await delay(10);
    assert.equal(core.usage().runtimeMs, stopped);
  } finally {
    await core.close();
  }
});

test("queue and runtime configuration are explicit and fail closed", () => {
  assert.deepEqual(runtimeConfiguration({}), {});
  assert.deepEqual(
    runtimeConfiguration({
      PI_ORCHESTRATOR_QUEUE: "fair",
      PI_ORCHESTRATOR_MAX_RUNTIME_MS: "100",
      PI_ORCHESTRATOR_RESERVED_CHILD_SLOTS: "0",
    }),
    { queuePolicy: "fair", maxRuntimeMs: 100, reservedChildSlots: 0 },
  );
  assert.throws(
    () => runtimeConfiguration({ PI_ORCHESTRATOR_MAX_RUNTIME_MS: "1e6" }),
    /Invalid/,
  );
  assert.throws(
    () => runtimeConfiguration({ PI_ORCHESTRATOR_QUEUE: "anything" }),
    /Invalid/,
  );
  assert.throws(() => create({ maxRuntimeMs: 0 }), /budget/);
  assert.throws(() => create({ reservedChildSlots: 2 }), /queue limits/);
});
