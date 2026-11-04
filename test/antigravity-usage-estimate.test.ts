import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../src/orchestrator.ts";
import { RunJournal, RunStore } from "../src/journal.ts";
import { usageReport } from "../src/presentation.ts";
import { capabilities, type RuntimeContext } from "../src/types.ts";

test("Antigravity context peaks count toward the token guard and survive in the journal", async () => {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "orch-gain-")));
  const run = async (ctx: RuntimeContext) => {
    ctx.context?.(12_000, 1_048_576);
    ctx.context?.(40_000, 1_048_576);
    ctx.context?.(30_000, 1_048_576);
    return "ok";
  };
  const store = new RunStore(join(cwd, "state"));
  const journal = new RunJournal(store, cwd);
  const core = new Orchestrator({
    cwd,
    maxTokens: 50_000,
    checkpoint: (tasks) => journal.checkpoint(tasks),
    adapters: { antigravity: { capabilities, run } },
  });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const task = await core.wait(
      null,
      core.delegate(null, "antigravity", "p", "k").id,
    );
    assert.deepEqual(task.context, {
      used: 30_000,
      size: 1_048_576,
      peak: 40_000,
    });
    assert.deepEqual(core.spend(), {
      tokens: 40_000,
      costUsd: 0,
      costEngines: [],
      estimatedTokens: 40_000,
      estimatedEngines: ["antigravity"],
    });
    await core.wait(null, core.delegate(null, "antigravity", "p2", "k2").id);
    assert.throws(
      () => core.delegate(null, "antigravity", "p3", "k3"),
      /Session token limit reached \(80000 ≥ 50000/,
      "the guard is no longer blind to Antigravity",
    );
    assert.equal(
      store.read(journal.runId).tasks[0]!.context?.peak,
      40_000,
      "the peak survives in the journal",
    );
    assert.match(
      usageReport(core.usage(), core.list()),
      /≥80\.000 tokens, cota inferior/,
    );
  } finally {
    await core.close();
  }
});
