import type { TaskView } from "./types.ts";

export interface SessionSpend {
  tokens: number;
  costUsd: number;
  costEngines: string[];
  estimatedTokens: number;
  estimatedEngines: string[];
}

/** Provider-reported spend: tokens from every engine, dollars only where reported (Claude). */
export function sessionSpend(views: Iterable<TaskView>): SessionSpend {
  let tokens = 0,
    costUsd = 0,
    estimatedTokens = 0;
  const costEngines = new Set<string>(),
    estimatedEngines = new Set<string>();
  for (const view of views) {
    if (!view.usage) {
      // Antigravity reports no token usage, only context occupancy. Its peak is a
      // lower bound of the input tokens billed (every model call resends at least
      // that much), so the token guard is no longer blind to those tasks.
      const peak = view.context?.peak ?? view.context?.used;
      if (peak !== undefined) {
        tokens += peak;
        estimatedTokens += peak;
        estimatedEngines.add(view.engine);
      }
      continue;
    }
    tokens += view.usage.inputTokens + view.usage.outputTokens;
    if (view.usage.costUsd !== undefined) {
      costUsd += view.usage.costUsd;
      costEngines.add(view.engine);
    }
  }
  return {
    tokens,
    costUsd,
    costEngines: [...costEngines],
    estimatedTokens,
    estimatedEngines: [...estimatedEngines],
  };
}

/** Refuses new work once a session spend guard is reached; running work continues. */
export function assertSpendWithin(
  { tokens, costUsd }: SessionSpend,
  limits: { maxTokens?: number; maxCostUsd?: number },
): void {
  if (limits.maxTokens !== undefined && tokens >= limits.maxTokens)
    throw new Error(
      `Session token limit reached (${tokens} ≥ ${limits.maxTokens}, PI_ORCHESTRATOR_MAX_TOKENS); new work is refused`,
    );
  if (limits.maxCostUsd !== undefined && costUsd >= limits.maxCostUsd)
    throw new Error(
      `Session cost limit reached ($${costUsd.toFixed(2)} ≥ $${limits.maxCostUsd}, PI_ORCHESTRATOR_MAX_COST_USD); new work is refused`,
    );
}
