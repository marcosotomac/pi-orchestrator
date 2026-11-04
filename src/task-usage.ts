import type { TaskUsage } from "./types.ts";

export function validUsage(value: TaskUsage): TaskUsage | undefined {
  const count = (n: unknown) =>
    typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n < 1e12;
  if (
    !value ||
    !count(value.inputTokens) ||
    !count(value.cachedInputTokens) ||
    !count(value.outputTokens)
  )
    return undefined;
  if (value.reasoningTokens !== undefined && !count(value.reasoningTokens))
    return undefined;
  if (value.cacheWriteTokens !== undefined && !count(value.cacheWriteTokens))
    return undefined;
  if (
    value.costUsd !== undefined &&
    !(
      typeof value.costUsd === "number" &&
      Number.isFinite(value.costUsd) &&
      value.costUsd >= 0 &&
      value.costUsd < 1e6
    )
  )
    return undefined;
  return {
    inputTokens: value.inputTokens,
    outputTokens: value.outputTokens,
    ...(value.reasoningTokens !== undefined
      ? { reasoningTokens: value.reasoningTokens }
      : {}),
    ...(value.costUsd !== undefined ? { costUsd: value.costUsd } : {}),
    cachedInputTokens: Math.min(value.cachedInputTokens, value.inputTokens),
    ...(value.cacheWriteTokens !== undefined
      ? {
          cacheWriteTokens: Math.min(value.cacheWriteTokens, value.inputTokens),
        }
      : {}),
  };
}

/** Provider totals can include earlier turns; attribute only the delta to this task. */
export function usageDelta(raw: TaskUsage, baseline?: TaskUsage): TaskUsage {
  if (!baseline) return { ...raw };
  const result: TaskUsage = {
    inputTokens: Math.max(0, raw.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(
      0,
      raw.cachedInputTokens - baseline.cachedInputTokens,
    ),
    outputTokens: Math.max(0, raw.outputTokens - baseline.outputTokens),
  };
  for (const key of [
    "reasoningTokens",
    "cacheWriteTokens",
    "costUsd",
  ] as const) {
    if (raw[key] !== undefined)
      result[key] = Math.max(0, raw[key] - (baseline[key] ?? 0));
  }
  result.cachedInputTokens = Math.min(
    result.cachedInputTokens,
    result.inputTokens,
  );
  return result;
}

/** Include completed automatic attempts without double-counting cumulative updates. */
export function accumulateUsage(
  current: TaskUsage,
  carry?: TaskUsage,
): TaskUsage {
  if (!carry) return { ...current };
  const result: TaskUsage = {
    inputTokens: carry.inputTokens + current.inputTokens,
    cachedInputTokens: carry.cachedInputTokens + current.cachedInputTokens,
    outputTokens: carry.outputTokens + current.outputTokens,
  };
  for (const key of [
    "reasoningTokens",
    "cacheWriteTokens",
    "costUsd",
  ] as const) {
    if (carry[key] !== undefined || current[key] !== undefined)
      result[key] = (carry[key] ?? 0) + (current[key] ?? 0);
  }
  return result;
}
