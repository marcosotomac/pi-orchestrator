import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities, type RuntimeContext } from "../src/types.ts";

test("a restricted task is not retried automatically after a human approved an operation; denied or unanswered requests keep the retry", async () => {
  const attempts: Record<string, number> = {};
  const run = async (ctx: RuntimeContext) => {
    attempts[ctx.prompt] = (attempts[ctx.prompt] ?? 0) + 1;
    if (attempts[ctx.prompt] === 1) {
      // e.g. an Antigravity `curl -X POST` the operator allowed, then the provider drops.
      await ctx.interact?.({
        kind: ctx.prompt === "question" ? "question" : "permission",
        title: "run command",
        detail: "{}",
        options: [{ id: "once", label: "Allow" }],
      });
      throw new Error(
        "Selected model is at capacity. Please try a different model.",
      );
    }
    return "second attempt";
  };
  // The operator's answer for the task being run; tasks run one at a time.
  let answer: { optionId: string } | undefined;
  const core = new Orchestrator({
    cwd: process.cwd(),
    retryDelayMs: 5,
    maxConcurrent: 4,
    onInteraction: async () => answer,
    adapters: { antigravity: { capabilities, run } },
  });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    for (const prompt of ["approved", "denied", "question"]) {
      answer = prompt === "denied" ? undefined : { optionId: "once" };
      const task = await core.wait(
        null,
        core.delegate(null, "antigravity", prompt, prompt).id,
      );
      if (prompt === "approved") {
        assert.equal(task.state, "failed");
        assert.equal(
          attempts.approved,
          1,
          "the approved operation could run twice: no automatic retry",
        );
        assert.equal(task.diagnostic?.category, "transient");
      } else {
        assert.equal(
          task.state,
          "completed",
          `${prompt}: no operation was granted, so the retry stays`,
        );
        assert.equal(attempts[prompt], 2);
      }
    }
  } finally {
    await core.close();
  }
});
