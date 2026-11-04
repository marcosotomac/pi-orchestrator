import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import { processCensus } from "../src/reconciliation.ts";

/** Retry only unavailable observations, never turn uncertainty into absence. */
export async function availableCensus(timeoutMs = 10_000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const rows = processCensus();
    if (rows !== undefined) return rows;
    await delay(40);
  } while (performance.now() < deadline);
  throw new Error(
    "Process census remained unavailable; cleanup or survival cannot be asserted",
  );
}
