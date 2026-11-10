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
    assert.equal(core.usage().orchestration.boundedExpiries, 1);
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

test("with the fair queue, a leaf child waits for a slot instead of being rejected", async () => {
  const release = new Map<string, () => void>();
  const order: string[] = [];
  const child = async (ctx: RuntimeContext) => {
    order.push(ctx.prompt);
    await new Promise<void>((resolve) => release.set(ctx.prompt, resolve));
    return `${ctx.prompt} done`;
  };
  const core = make({ queuePolicy: "fair", maxConcurrent: 2, child });
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const first = core.delegate(root.id, "claude", "first", "first");
    const second = core.delegate(root.id, "claude", "second", "second");
    assert.equal(first.state, "running");
    assert.equal(second.state, "queued", "leaf queues at full capacity");
    assert.equal(core.usage().queued, 1);
    await delay(10);
    release.get("first")!();
    const done = await core.wait(root.id, second.id, 50).catch(() => null);
    assert.equal(done?.state, "running", "dispatched when a slot frees");
    release.get("second")!();
    assert.equal((await core.wait(null, second.id, 1_000)).state, "completed");
    assert.deepEqual(order, ["first", "second"]);
    const metrics = core.usage().orchestration;
    assert.equal(metrics.childQueued, 1);
    assert.equal(metrics.nestedRejected, 0);
    assert.ok(metrics.queueWaitMsMax >= 10, `waited ${metrics.queueWaitMsMax}`);
  } finally {
    for (const fn of release.values()) fn();
    await core.close();
  }
});

test("any queued child is cancelled with its parent, and middle children may queue too", async () => {
  const core = make({ queuePolicy: "fair", maxConcurrent: 3, maxDepth: 3 });
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const other = core.delegate(null, "codex", "other", "other");
    const middle = core.delegate(root.id, "claude", "middle", "middle");
    // Depth 2 of 3 can delegate, yet `other` and `middle` can free their slots.
    const sibling = core.delegate(root.id, "claude", "sibling", "sibling");
    assert.equal(sibling.state, "queued");
    const leaf = core.delegate(middle.id, "codex", "leaf", "leaf");
    assert.equal(
      leaf.state,
      "queued",
      "`other` is no ancestor of any queued task",
    );
    await core.cancel(null, root.id);
    for (const id of [sibling.id, leaf.id]) {
      assert.equal(core.status(null, id).state, "cancelled");
      assert.equal(core.status(null, id).runtimeProcess, undefined);
    }
    assert.equal(core.usage().queued, 0);
    await core.cancel(null, other.id);
    assert.equal(core.usage().orchestration.childQueued, 2);
    assert.equal(core.usage().orchestration.nestedRejected, 0);
  } finally {
    await core.close();
  }
});

test("random delegation trees always settle: queued children never deadlock", async () => {
  // Deterministic PRNG: failures are reproducible from the seed.
  let seed = Number(process.env.ORCH_TREE_SEED ?? 0x2f6b1d);
  const random = () =>
    (seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31;
  let core!: Orchestrator;
  const run = async (ctx: RuntimeContext) => {
    const ids: string[] = [];
    if (ctx.task.depth < 4)
      for (let n = Math.floor(random() * 3); n > 0; n--)
        try {
          ids.push(
            core.delegate(ctx.task.id, "claude", `c${random()}`, `k${random()}`)
              .id,
          );
        } catch (error) {
          assert.match(String(error), /Concurrency limit|no longer running/);
        }
    await delay(Math.floor(random() * 5));
    if (ids.length) await core.waitAll(ctx.task.id, ids, 5_000);
    return "ok";
  };
  core = make({
    queuePolicy: "fair",
    maxConcurrent: 3,
    maxDepth: 4,
    maxTasks: 400,
    maxQueued: 64,
    run,
    child: run,
  });
  try {
    const roots = Array.from({ length: 12 }, (_, i) =>
      core.delegate(null, "codex", `root ${i}`, `root-${i}`),
    );
    const settled = await core.waitAll(
      null,
      roots.map((root) => root.id),
      20_000,
    );
    assert.ok(settled.every((task) => task.state === "completed"));
    assert.ok(core.list().every((task) => task.state === "completed"));
    assert.equal(core.usage().queued, 0);
    assert.equal(core.usage().activeSlots, 0);
    assert.ok(
      core.usage().orchestration.childQueued > 0,
      "the queue was exercised",
    );
  } finally {
    await core.close();
  }
});

test("a child whose every occupied slot is an ancestor is rejected, not deadlocked", async () => {
  const core = make({ queuePolicy: "fair", maxConcurrent: 2, maxDepth: 3 });
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const middle = core.delegate(root.id, "claude", "middle", "middle");
    assert.throws(
      () => core.delegate(middle.id, "codex", "leaf", "leaf"),
      /no slot can free/,
    );
    assert.equal(core.usage().orchestration.nestedRejected, 1);
  } finally {
    await core.close();
  }
});

const spending = async (ctx: RuntimeContext) => {
  ctx.partial?.(`partial of ${ctx.prompt}`);
  if (ctx.prompt === "spender")
    ctx.usage?.({ inputTokens: 150, cachedInputTokens: 0, outputTokens: 10 });
  await delay(60_000, undefined, { signal: ctx.signal });
  return "unreachable";
};

test("spend enforcement 'abort' cancels running work once a cap is crossed, keeping partials", async () => {
  const core = make({
    maxTokens: 100,
    spendEnforcement: "abort",
    maxConcurrent: 3,
    run: spending,
  });
  try {
    const quiet = core.delegate(null, "codex", "quiet", "quiet");
    await delay(5);
    const spender = core.delegate(null, "codex", "spender", "spender");
    const [a, b] = await core.waitAll(null, [quiet.id, spender.id], 2_000);
    assert.deepEqual([a!.state, b!.state], ["cancelled", "cancelled"]);
    assert.match(a!.error!, /spend limit/);
    assert.match(b!.partialResult!, /partial of spender/);
    assert.throws(
      () => core.delegate(null, "codex", "more", "more"),
      /token limit/,
    );
    assert.equal(core.usage().orchestration.spendAborts, 1);
  } finally {
    await core.close();
  }
});

test("default spend enforcement only refuses new work; running work continues", async () => {
  const core = make({ maxTokens: 100, maxConcurrent: 3, run: spending });
  try {
    const spender = core.delegate(null, "codex", "spender", "spender");
    await delay(20);
    assert.equal(core.status(null, spender.id).state, "running");
    assert.throws(
      () => core.delegate(null, "codex", "more", "more"),
      /token limit/,
    );
    assert.equal(core.usage().orchestration.spendAborts, 0);
  } finally {
    await core.close();
  }
});

test("a task queued longer than maxQueueWaitMs is cancelled without ever launching", async () => {
  const launched: string[] = [];
  const core = make({
    queuePolicy: "fair",
    maxConcurrent: 2,
    maxQueueWaitMs: 50,
    run: async (ctx) => {
      launched.push(ctx.prompt);
      return blocked(ctx);
    },
  });
  try {
    core.delegate(null, "codex", "busy", "busy");
    const late = core.delegate(null, "codex", "late", "late");
    assert.equal(late.state, "queued");
    const settled = await core.wait(null, late.id, 2_000);
    assert.equal(settled.state, "cancelled");
    assert.match(settled.error!, /queue wait limit/i);
    assert.deepEqual(launched, ["busy"]);
    assert.equal(core.usage().queued, 0);
    assert.equal(core.usage().orchestration.queueExpired, 1);
    assert.throws(() => make({ maxQueueWaitMs: 0 }), /maxQueueWaitMs/);
  } finally {
    await core.close();
  }
});

test("/orch usage reports every orchestration counter", async () => {
  const { usageReport } = await import("../src/presentation.ts");
  const core = make({ queuePolicy: "fair", maxConcurrent: 2 });
  try {
    const report = usageReport(core.usage(), core.list());
    for (const label of [
      "Orquestación:",
      "subtareas en cola",
      "subtareas rechazadas",
      "caducadas en cola",
      "cortadas por el plazo del padre",
      "esperas anidadas acortadas",
      "llamadas para",
      "por lote terminado",
      "anticipados por fallo",
    ])
      assert.ok(report.includes(label), label);
  } finally {
    await core.close();
  }
});

const outOfQuota = async () => {
  throw new Error("Claude usage quota exceeded for this account");
};

test("engine fallback reruns a quota failure once on the configured engine", async () => {
  const prompts: string[] = [];
  const core = make({
    fallback: { claude: "codex" },
    retryDelayMs: 1,
    child: outOfQuota,
    run: async (ctx) => {
      prompts.push(
        `${ctx.task.engine}:${ctx.prompt}:${ctx.task.selection?.model ?? "-"}`,
      );
      return "codex answer";
    },
  });
  try {
    const task = core.delegate(null, "claude", "review", "k", undefined, {
      model: "opus",
    });
    const done = await core.wait(null, task.id, 2_000);
    assert.equal(done.state, "completed", done.error);
    assert.equal(done.engine, "codex");
    assert.equal(done.fallbackFrom, "claude");
    assert.equal(done.result, "codex answer");
    assert.deepEqual(
      prompts,
      ["codex:review:-"],
      "the Claude model is not carried over",
    );
    assert.equal(core.usage().orchestration.fallbacks, 1);
  } finally {
    await core.close();
  }
});

test("engine fallback is off by default, never for YOLO, and never twice", async () => {
  const none = make({ child: outOfQuota });
  const yolo = make({ fallback: { claude: "codex" }, child: outOfQuota });
  const loop = make({
    fallback: { claude: "codex", codex: "claude" },
    child: outOfQuota,
    run: outOfQuota,
  });
  try {
    const plain = none.delegate(null, "claude", "a", "a");
    assert.equal((await none.wait(null, plain.id, 2_000)).state, "failed");
    const risky = yolo.delegate(
      null,
      "claude",
      "b",
      "b",
      undefined,
      undefined,
      "yolo",
    );
    const settled = await yolo.wait(null, risky.id, 2_000);
    assert.equal(settled.state, "failed");
    assert.equal(settled.engine, "claude");
    const twice = loop.delegate(null, "claude", "c", "c");
    const last = await loop.wait(null, twice.id, 2_000);
    assert.equal(last.state, "failed");
    assert.equal(last.engine, "codex", "one hop only");
    assert.equal(loop.usage().orchestration.fallbacks, 1);
  } finally {
    await Promise.all([none.close(), yolo.close(), loop.close()]);
  }
});
