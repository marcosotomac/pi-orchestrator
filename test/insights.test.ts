import test from "node:test";
import assert from "node:assert/strict";
import { engineRecords, sumMetrics, type TaskRecord } from "../src/insights.ts";

const at = (second: number) =>
  new Date(Date.UTC(2026, 10, 9, 12, 0, second)).toISOString();
const task = (
  engine: TaskRecord["engine"],
  state: TaskRecord["state"],
  start: number,
  end: number | undefined,
  extra: Partial<TaskRecord> = {},
): TaskRecord => ({
  engine,
  state,
  createdAt: at(start),
  ...(end === undefined ? {} : { endedAt: at(end) }),
  ...extra,
});
const quota = {
  category: "quota" as const,
  recovery: "wait",
  automaticRetry: false,
};

test("engine records count outcomes, failure categories and medians of settled tasks", () => {
  const records = engineRecords([
    task("claude", "completed", 0, 10, {
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 },
    }),
    task("claude", "completed", 0, 30, {
      usage: { inputTokens: 300, cachedInputTokens: 0, outputTokens: 40 },
    }),
    task("claude", "failed", 0, 20, { diagnostic: quota }),
    task("claude", "running", 0, undefined),
    task("codex", "cancelled", 0, 5),
  ]);
  assert.deepEqual(records.claude, {
    tasks: 3,
    completed: 2,
    failed: 1,
    cancelled: 0,
    failures: { quota: 1 },
    medianMs: 20_000,
    medianTokens: 230,
  });
  assert.equal(records.codex?.cancelled, 1);
  assert.equal(records.antigravity, undefined);
});

test("an engine is blocked only while its latest outcome is a quota or auth failure", () => {
  const blocked = engineRecords([
    task("claude", "completed", 0, 10),
    task("claude", "failed", 0, 20, { diagnostic: quota }),
    task("claude", "cancelled", 0, 30), // cancellations say nothing about the engine
  ]);
  assert.deepEqual(blocked.claude?.blocked, { category: "quota", at: at(20) });
  const recovered = engineRecords([
    task("claude", "failed", 0, 10, { diagnostic: quota }),
    task("claude", "completed", 0, 20),
  ]);
  assert.equal(recovered.claude?.blocked, undefined);
  const transient = engineRecords([
    task("claude", "failed", 0, 10, {
      diagnostic: { ...quota, category: "network" },
    }),
  ]);
  assert.equal(transient.claude?.blocked, undefined);
});

test("metric sums add counters but keep the maximum wait, and accept unknown keys", () => {
  assert.deepEqual(
    sumMetrics([
      { childQueued: 1, queueWaitMsMax: 50, future: 2 },
      undefined,
      { childQueued: 2, queueWaitMsMax: 20 },
    ]),
    { childQueued: 3, queueWaitMsMax: 50, future: 2 },
  );
});

test("the journal keeps metrics per run; history sums them and old archives still read", async () => {
  const { mkdtempSync, chmodSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { RunStore, RunJournal } = await import("../src/journal.ts");
  const directory = mkdtempSync(join(tmpdir(), "insights-"));
  chmodSync(directory, 0o700);
  try {
    const store = new RunStore(directory);
    const old = new RunJournal(store, directory);
    old.checkpoint([]); // an archive from before metrics existed
    old.close();
    const run = new RunJournal(store, directory);
    run.checkpoint([], { childQueued: 2, queueWaitMsMax: 40 });
    run.close();
    const history = store.history();
    assert.equal(history.unavailable.length, 0);
    const measured = history.runs.filter((entry) => entry.metrics);
    assert.equal(measured.length, 1);
    assert.deepEqual(measured[0]!.metrics, {
      childQueued: 2,
      queueWaitMsMax: 40,
    });
    assert.deepEqual(
      history.runs.map((entry) => entry.completed + entry.failed),
      [0, 0],
    );
    assert.deepEqual(store.recentTasks(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
