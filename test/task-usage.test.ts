import test from "node:test";
import assert from "node:assert/strict";
import { validUsage, usageDelta, accumulateUsage } from "../src/task-usage.ts";

const usage = {
  inputTokens: 100,
  cachedInputTokens: 40,
  outputTokens: 20,
  cacheWriteTokens: 10,
  reasoningTokens: 5,
  costUsd: 0.1,
};
test("usage validation rejects malformed counters and clamps cache subsets", () => {
  for (const key of Object.keys(usage)) {
    assert.equal(validUsage({ ...usage, [key]: -1 }), undefined);
    assert.equal(validUsage({ ...usage, [key]: NaN }), undefined);
  }
  assert.equal(validUsage({ ...usage, inputTokens: 1.5 }), undefined);
  assert.deepEqual(
    validUsage({ ...usage, cachedInputTokens: 200, cacheWriteTokens: 300 }),
    { ...usage, cachedInputTokens: 100, cacheWriteTokens: 100 },
  );
  const untrusted = { ...usage, extra: "untrusted" };
  assert.deepEqual(validUsage(untrusted), usage);
});
test("continuations subtract the baseline and retries add previous attempts exactly once", () => {
  const delta = usageDelta(usage, {
    inputTokens: 50,
    cachedInputTokens: 10,
    outputTokens: 5,
    cacheWriteTokens: 2,
    reasoningTokens: 1,
    costUsd: 0.05,
  });
  assert.deepEqual(delta, {
    inputTokens: 50,
    cachedInputTokens: 30,
    outputTokens: 15,
    cacheWriteTokens: 8,
    reasoningTokens: 4,
    costUsd: 0.05,
  });
  const copy = structuredClone(usage);
  assert.deepEqual(accumulateUsage(delta, usage), {
    inputTokens: 150,
    cachedInputTokens: 70,
    outputTokens: 35,
    cacheWriteTokens: 18,
    reasoningTokens: 9,
    costUsd: 0.15000000000000002,
  });
  assert.deepEqual(usage, copy);
  assert.equal(
    usageDelta(usage, {
      inputTokens: 200,
      cachedInputTokens: 0,
      outputTokens: 100,
    }).cachedInputTokens,
    0,
  );
  assert.deepEqual(accumulateUsage(usage), usage);
  assert.deepEqual(usageDelta(usage), usage);
});
