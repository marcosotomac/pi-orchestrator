import { spawnSync } from "node:child_process";
import type { RunRecord } from "./journal.ts";

export interface ProcessRow { pid: number; groupId: number; state: string }
export type ProcessCensus = ProcessRow[] | undefined;

/** Numeric metadata only. Never read argv/environment or issue a signal to an archived PID/group. */
export function processCensus(): ProcessCensus {
  if (process.platform === "win32") return undefined;
  const result = spawnSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2_000, maxBuffer: 2 * 1_024 * 1_024 });
  if (result.status !== 0 || result.error) return undefined;
  const rows: ProcessRow[] = [];
  for (const line of result.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>0-9-]+)\s*$/.exec(line);
    if (!match) { if (line.trim()) return undefined; continue; }
    rows.push({ pid: Number(match[1]), groupId: Number(match[2]), state: match[3]! });
  }
  return rows;
}

export const reconciliationWarning = "Archivo de solo lectura. Los estados guardados son históricos; un PID/PGID coincidente no acredita identidad ni autoridad. Sin adopción, reanudación ni señales. Un run sin cierre puede seguir activo en otra sesión.";

/** A diagnostic plan, not an execution or ownership-transfer mechanism. Does not mutate the archive. */
export function reconcileRun(run: RunRecord, census: ProcessCensus) {
  return {
    runId: run.runId,
    closure: run.closedAt ? "closure-recorded" as const : "unresolved" as const,
    warning: reconciliationWarning,
    tasks: run.tasks.map((task) => {
      const process = task.runtimeProcess;
      const matching = census?.find((row) => row.pid === process?.pid);
      const observation = process?.exitedAt ? "exit-recorded" : !process ? "no-process-recorded" : !census ? "census-unavailable" : !matching ? "pid-absent" : process.groupId !== undefined && matching.groupId !== process.groupId ? "pid-or-group-changed" : "numeric-match-only";
      return {
        taskId: task.id, engine: task.engine, recordedState: task.state, observation,
        ...(process ? { recordedProcess: { ...process } } : {}),
        ...(matching ? { currentNumericState: matching.state } : {}),
        ...(process?.groupId !== undefined && census ? { numericGroupHasExecutingMembers: census.some((row) => row.groupId === process.groupId && !row.state.startsWith("Z")) } : {}),
      };
    }),
  };
}
