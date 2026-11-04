import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities } from "../src/types.ts";

test("repeated coordinators release queue, slots and waiters through completion, failure, abort and shutdown", async () => {
  for (let cycle = 0; cycle < 20; cycle++) {
    const run = async (ctx: import("../src/types.ts").RuntimeContext) => {
      if (ctx.prompt === "failure") throw new Error("fixture protocol failure");
      if (ctx.prompt === "block")
        await delay(60000, undefined, { signal: ctx.signal });
      return "fixture result";
    };
    const core = new Orchestrator({
      cwd: process.cwd(),
      queuePolicy: "fair",
      maxConcurrent: 4,
      maxTasks: 100,
      maxQueued: 100,
      adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
    });
    core.attachEndpoint("http://127.0.0.1:12345/mcp");
    try {
      const tasks = Array.from({ length: 100 }, (_, index) =>
        core.delegate(
          null,
          index % 2 ? "codex" : "claude",
          index % 7 === 0 ? "block" : index % 5 === 0 ? "failure" : "success",
          String(index),
        ),
      );
      await Promise.all(
        tasks
          .filter((_, index) => index % 7 === 0)
          .map((task) => core.cancel(null, task.id)),
      );
      if (cycle % 2) await core.close();
      const settled = await Promise.all(
        tasks.map((task) => core.wait(null, task.id)),
      );
      assert.ok(
        settled.every((task) =>
          ["completed", "failed", "cancelled"].includes(task.state),
        ),
      );
      assert.equal(core.usage().activeSlots, 0);
      assert.equal(core.usage().queued, 0);
      assert.equal(core.list().length, 100);
    } finally {
      await core.close();
    }
  }
});
