import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_RESULT,
  PARTIAL_NOTE,
  TRUNCATION_NOTE,
  partialResult,
  publishedResult,
} from "../src/task-output.ts";
import { assertSpendWithin, sessionSpend } from "../src/spend.ts";
import type { TaskView } from "../src/types.ts";

test("a short result is published untouched and nothing is saved", () => {
  let saved = false;
  const text = publishedResult("hecho", [], () => {
    saved = true;
    return "/x";
  });
  assert.equal(text, "hecho");
  assert.equal(saved, false);
});

test("a long result is truncated to the bound and points to the full file", () => {
  const long = "a".repeat(MAX_RESULT + 500);
  let full = "";
  const text = publishedResult(long, [], (value) => {
    full = value;
    return "/tmp/full.md";
  });
  assert.equal(full, long);
  assert.equal(text.length, MAX_RESULT);
  assert.match(
    text,
    /Texto completo \(20500 caracteres\) en \/tmp\/full\.md\]$/,
  );
  const unsaved = publishedResult(long, [], () => undefined);
  assert.ok(unsaved.endsWith(TRUNCATION_NOTE));
  assert.equal(unsaved.length, MAX_RESULT);
});

test("a partial result is marked and stays within the bound", () => {
  assert.equal(partialResult("medio", []), "medio" + PARTIAL_NOTE);
  const long = partialResult("b".repeat(MAX_RESULT * 2), []);
  assert.ok(long.endsWith(TRUNCATION_NOTE + PARTIAL_NOTE));
  assert.ok(long.length <= MAX_RESULT);
});

test("spend counts reported tokens, dollars and estimated context peaks", () => {
  const views = [
    {
      engine: "claude",
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.5 },
    },
    { engine: "codex", usage: { inputTokens: 100, outputTokens: 20 } },
    { engine: "antigravity", context: { used: 30, size: 100, peak: 40 } },
    { engine: "codex" },
  ] as unknown as TaskView[];
  const spend = sessionSpend(views);
  assert.deepEqual(spend, {
    tokens: 175,
    costUsd: 0.5,
    costEngines: ["claude"],
    estimatedTokens: 40,
    estimatedEngines: ["antigravity"],
  });
  assert.doesNotThrow(() => assertSpendWithin(spend, {}));
  assert.throws(
    () => assertSpendWithin(spend, { maxTokens: 175 }),
    /token limit reached/,
  );
  assert.throws(
    () => assertSpendWithin(spend, { maxCostUsd: 0.5 }),
    /cost limit reached/,
  );
});
