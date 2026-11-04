import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities, type RuntimeContext } from "../src/types.ts";
import {
  InteractionBroker,
  type InteractionRequest,
} from "../src/interactions.ts";

const request: InteractionRequest = {
  kind: "permission",
  title: "fixture",
  detail: "operation details",
  options: [{ id: "once", label: "Approve once" }],
};

test("interactions deny without a human handler and reject forged choices or malformed requests", async () => {
  const signal = new AbortController().signal;
  assert.equal(
    await new InteractionBroker().request("task", "fixture", request, signal),
    undefined,
  );
  assert.equal(
    await new InteractionBroker(async () => ({ optionId: "forged" })).request(
      "task",
      "fixture",
      request,
      signal,
    ),
    undefined,
  );
  assert.equal(
    await new InteractionBroker(async () => ({ optionId: "once" })).request(
      "task",
      "fixture",
      { ...request, detail: "x".repeat(8001) },
      signal,
    ),
    undefined,
  );
  assert.deepEqual(
    await new InteractionBroker(async () => ({ optionId: "once" })).request(
      "task",
      "fixture",
      request,
      signal,
    ),
    { optionId: "once" },
  );
});

test("human dialogs are serialized, queue is bounded and cancellation while queued cannot skip a live dialog", async () => {
  let release!: () => void;
  const seen: string[] = [];
  const broker = new InteractionBroker(
    async (view) => {
      seen.push(view.taskId);
      if (view.taskId === "first")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { optionId: "once" };
    },
    1000,
    3,
  );
  const first = broker.request(
    "first",
    "fixture",
    request,
    new AbortController().signal,
  );
  await delay(0);
  const controller = new AbortController();
  const second = broker.request(
    "second",
    "fixture",
    request,
    controller.signal,
  );
  const third = broker.request(
    "third",
    "fixture",
    request,
    new AbortController().signal,
  );
  controller.abort();
  assert.equal(await second, undefined);
  assert.equal(
    await broker.request(
      "overflow",
      "fixture",
      request,
      new AbortController().signal,
    ),
    undefined,
  );
  assert.deepEqual(seen, ["first"]);
  release();
  assert.deepEqual(await first, { optionId: "once" });
  assert.deepEqual(await third, { optionId: "once" });
  assert.deepEqual(seen, ["first", "third"]);
});

test("native completion revokes pending dialogs and late runtime requests without storing their content", async () => {
  let context!: RuntimeContext;
  let pending!: Promise<unknown>;
  let dialogSignal: AbortSignal | undefined;
  let release!: (answer: { optionId: string }) => void;
  let calls = 0;
  const core = new Orchestrator({
    cwd: process.cwd(),
    onInteraction: async (view, signal) => {
      calls++;
      dialogSignal = signal;
      assert.ok(!view.detail.includes(context.mcp.token));
      assert.ok(view.detail.includes("[REDACTED]"));
      return await new Promise((resolve) => {
        release = resolve;
      });
    },
    adapters: {
      codex: {
        capabilities,
        run: async (ctx) => {
          context = ctx;
          pending = ctx.interact!({ ...request, detail: ctx.mcp.token });
          return "completed independently";
        },
      },
    },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const task = core.delegate(null, "codex", "fixture", "fixture");
    assert.equal((await core.wait(null, task.id)).state, "completed");
    assert.equal(await pending, undefined);
    assert.ok(dialogSignal?.aborted);
    assert.equal(calls, 1);
    release({ optionId: "once" });
    assert.equal(await context.interact!(request), undefined);
    assert.equal(calls, 1);
    assert.ok(!JSON.stringify(core.list()).includes(context.mcp.token));
  } finally {
    await core.close();
  }
});

test("expiry and abort revoke late human answers, including handlers that ignore cancellation", async () => {
  let answer!: (value: { optionId: string }) => void;
  let dialogSignal: AbortSignal | undefined;
  const broker = new InteractionBroker(async (_request, signal) => {
    dialogSignal = signal;
    return await new Promise((resolve) => {
      answer = resolve;
    });
  }, 20);
  assert.equal(
    await broker.request(
      "task",
      "fixture",
      request,
      new AbortController().signal,
    ),
    undefined,
  );
  assert.ok(dialogSignal?.aborted);
  answer({ optionId: "once" });
  const abort = new AbortController();
  abort.abort();
  assert.equal(
    await broker.request("task", "fixture", request, abort.signal),
    undefined,
  );
});
