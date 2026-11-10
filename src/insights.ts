import type { Engine, TaskView } from "./types.ts";

/** Minimal task shape shared by live views and journal records. */
export type TaskRecord = Pick<
  TaskView,
  "engine" | "state" | "createdAt" | "endedAt" | "diagnostic" | "usage"
>;

export interface EngineRecord {
  tasks: number;
  completed: number;
  failed: number;
  cancelled: number;
  /** Failures by diagnosed category (quota, authentication, network…). */
  failures: Record<string, number>;
  /** Median wall time of settled tasks, queue time included. */
  medianMs?: number;
  /** Median input+output tokens of tasks that reported usage. */
  medianTokens?: number;
  /**
   * The latest settled task failed for a reason that will likely repeat
   * (quota, authentication) and nothing has succeeded since.
   */
  blocked?: { category: string; at: string };
}

const BLOCKING = new Set(["quota", "authentication"]);

const median = (values: number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

/** Per-engine track record of settled tasks; pure, so it is cheap to test and reuse. */
export function engineRecords(
  tasks: Iterable<TaskRecord>,
): Partial<Record<Engine, EngineRecord>> {
  const byEngine = new Map<Engine, TaskRecord[]>();
  for (const task of tasks)
    if (task.endedAt)
      byEngine.set(task.engine, [...(byEngine.get(task.engine) ?? []), task]);
  const records: Partial<Record<Engine, EngineRecord>> = {};
  for (const [engine, settled] of byEngine) {
    settled.sort((a, b) => a.endedAt!.localeCompare(b.endedAt!));
    const failures: Record<string, number> = {};
    for (const task of settled)
      if (task.state === "failed") {
        const category = task.diagnostic?.category ?? "unknown";
        failures[category] = (failures[category] ?? 0) + 1;
      }
    const last = settled.findLast((task) => task.state !== "cancelled");
    const record: EngineRecord = {
      tasks: settled.length,
      completed: settled.filter((task) => task.state === "completed").length,
      failed: settled.filter((task) => task.state === "failed").length,
      cancelled: settled.filter((task) => task.state === "cancelled").length,
      failures,
    };
    const ms = median(
      settled.map(
        (task) => Date.parse(task.endedAt!) - Date.parse(task.createdAt),
      ),
    );
    if (ms !== undefined) record.medianMs = ms;
    const tokens = median(
      settled
        .filter((task) => task.usage)
        .map((task) => task.usage!.inputTokens + task.usage!.outputTokens),
    );
    if (tokens !== undefined) record.medianTokens = tokens;
    if (
      last?.state === "failed" &&
      BLOCKING.has(last.diagnostic?.category ?? "")
    )
      record.blocked = {
        category: last.diagnostic!.category,
        at: last.endedAt!,
      };
    records[engine] = record;
  }
  return records;
}

/** Sum of numeric counters across runs; unknown keys are kept, so new metrics need no migration. */
export function sumMetrics(
  runs: Iterable<Record<string, number> | undefined>,
): Record<string, number> {
  const total: Record<string, number> = {};
  for (const metrics of runs)
    for (const [key, value] of Object.entries(metrics ?? {}))
      if (key === "queueWaitMsMax")
        total[key] = Math.max(total[key] ?? 0, value);
      else total[key] = (total[key] ?? 0) + value;
  return total;
}
