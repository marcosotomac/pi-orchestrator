import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { isTerminal, type TaskView } from "./types.ts";

const id = z.uuid();
const timestamp = z.iso.datetime();
const taskSchema = z.object({
  id, title: z.string().max(160), attemptId: id, parentId: id.nullable(),
  engine: z.enum(["codex", "claude", "antigravity"]), depth: z.number().int().min(1).max(256),
  cwd: z.string().min(1).max(8_192), state: z.enum(["queued", "running", "cancelling", "completed", "failed", "cancelled"]),
  createdAt: timestamp, endedAt: timestamp.optional(), runtimeSessionId: z.string().max(256).optional(),
  continuation: z.literal("native-resume").optional(),
  continuationSource: z.object({ taskId: id, attemptId: id }).strict().optional(),
  recoverySource: z.object({ runId: id, taskId: id, attemptId: id }).strict().optional(),
  runtimeProcess: z.object({
    pid: z.number().int().positive(), groupId: z.number().int().positive().optional(),
    exitedAt: timestamp.optional(), code: z.number().int().nullable().optional(), signal: z.string().max(64).nullable().optional(),
  }).strict().optional(),
  lastActivity: z.string().max(120).optional(), activityAt: timestamp.optional(),
  permissionMode: z.enum(["restricted", "yolo"]).optional(),
  selection: z.object({ model: z.string().max(128).optional(), thinking: z.string().max(128).optional() }).strict().optional(),
  modelState: z.object({ model: z.string().max(128).optional(), thinking: z.string().max(128).optional(), availableModels: z.array(z.object({ id: z.string().max(128), name: z.string().max(160) }).strict()).max(128), availableThinking: z.array(z.string().max(128)).max(128) }).strict().optional(),
  diagnostic: z.object({ category: z.enum(["authentication", "network", "quota", "transient", "protocol", "cleanup", "unknown"]), recovery: z.string().max(512), automaticRetry: z.boolean() }).strict().optional(),
  result: z.string().max(20_000).optional(), partialResult: z.string().max(20_000).optional(), error: z.string().max(8_000).optional(),
  workspace: z.enum(["worktree", "in-place"]).optional(),
  changes: z.object({ state: z.enum(["pending", "applied", "discarded", "none"]), files: z.number().int().nonnegative(), insertions: z.number().int().nonnegative(), deletions: z.number().int().nonnegative(), summary: z.string().max(4_000), repo: z.string().max(8_192).optional(), worktree: z.string().max(8_192).optional(), patchPath: z.string().max(8_192).optional(), base: z.string().max(64).optional(), error: z.string().max(500).optional() }).strict().optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), cachedInputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), reasoningTokens: z.number().int().nonnegative().optional(), costUsd: z.number().nonnegative().optional() }).strict().optional(),
}).strict();
const runSchema = z.object({
  schemaVersion: z.literal(1), runId: id, ownerPid: z.number().int().positive(), cwd: z.string().min(1).max(8_192),
  createdAt: timestamp, updatedAt: timestamp, sequence: z.number().int().nonnegative(), closedAt: timestamp.optional(),
  tasks: z.array(taskSchema).max(256),
}).strict().superRefine((run, ctx) => {
  const seen = new Map<string, number>();
  const attempts = new Set<string>();
  const previousTasks = new Map<string, z.infer<typeof taskSchema>>();
  for (const task of run.tasks) {
    const depth = task.parentId === null ? 1 : (seen.get(task.parentId) ?? -2) + 1;
    if (seen.has(task.id) || attempts.has(task.attemptId) || task.depth !== depth || !task.cwd.startsWith("/") || isTerminal(task) !== Boolean(task.endedAt)) {
      ctx.addIssue({ code: "custom", message: "Invalid task identity, tree, or lifecycle" });
    }
    if (task.continuation || task.continuationSource) {
      const source = task.continuationSource ? previousTasks.get(task.continuationSource.taskId) : undefined;
      if (task.continuation !== "native-resume" || !source || source.attemptId !== task.continuationSource?.attemptId || source.engine !== task.engine || source.state !== "completed" || !source.runtimeProcess?.exitedAt || !source.runtimeSessionId || task.parentId !== null || (task.runtimeSessionId !== undefined && task.runtimeSessionId !== source.runtimeSessionId)) ctx.addIssue({ code: "custom", message: "Invalid native continuation lineage" });
    }
    previousTasks.set(task.id, task);
    seen.set(task.id, task.depth); attempts.add(task.attemptId);
  }
  if (run.closedAt && run.tasks.some((task) => !isTerminal(task))) ctx.addIssue({ code: "custom", message: "Closed run contains unfinished tasks" });
});
export type RunRecord = z.infer<typeof runSchema>;
export interface RunSummary {
  runId: string; cwd: string; createdAt: string; updatedAt: string; sequence: number; tasks: number;
  disposition: "closed" | "current" | "unreconciled";
}
export interface HistoryPage { runs: RunSummary[]; unavailable: string[]; omitted: number }
const maxBytes = 4 * 1_024 * 1_024;
const archiveName = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.json$/;
const genericError = () => new Error("Durable state unavailable or invalid; no archive was adopted or signalled");

function privateStat(stat: Stats, directory: boolean): void {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) || stat.uid !== process.getuid?.()) throw genericError();
}
function validate(value: unknown): RunRecord {
  const parsed = runSchema.safeParse(value);
  if (!parsed.success) throw genericError(); // Never include validation input (possibly sensitive) in errors.
  return parsed.data;
}

/** Bounded atomic checkpoints, NOT a replayable command log. One writer and one UUID file per run. */
export class RunStore {
  readonly directory: string;
  constructor(directory: string) {
    if (process.platform === "win32" || !isAbsolute(directory)) throw new Error("Durable state requires POSIX and an absolute private directory");
    this.directory = resolve(directory);
  }
  private checkRoot(create: boolean): boolean {
    try {
      if (create) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      privateStat(lstatSync(this.directory), true);
      return true;
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw genericError();
    }
  }
  read(runId: string): RunRecord {
    if (!id.safeParse(runId).success || !this.checkRoot(false)) throw genericError();
    let fd: number | undefined;
    try {
      fd = openSync(join(this.directory, `${runId}.json`), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd); privateStat(stat, false);
      if (stat.size > maxBytes) throw genericError();
      const run = validate(JSON.parse(readFileSync(fd, "utf8")));
      if (run.runId !== runId) throw genericError();
      return run;
    } catch { throw genericError(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  write(value: RunRecord): RunRecord {
    // Validate before touching an existing checkpoint. Only schema fields can reach disk.
    const run = validate(value);
    for (const task of run.tasks) {
      for (const [key, limit] of [["title", 160], ["runtimeSessionId", 256], ["lastActivity", 120], ["result", 20_000], ["error", 8_000]] as const) {
        if (task[key] !== undefined) task[key] = task[key].replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]").slice(0, limit);
      }
    }
    const text = JSON.stringify(run) + "\n";
    if (Buffer.byteLength(text) > maxBytes) throw genericError();
    this.checkRoot(true);
    const temporary = join(this.directory, `.tmp-${run.runId}-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      writeFileSync(fd, text, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, join(this.directory, `${run.runId}.json`));
      // A successful checkpoint includes the directory entry, not merely a buffered write.
      fd = openSync(this.directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      return JSON.parse(text) as RunRecord;
    } catch { throw genericError(); }
    finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch { /* absent after successful publish */ }
    }
  }
  history(currentRunId?: string): HistoryPage {
    if (!this.checkRoot(false)) return { runs: [], unavailable: [], omitted: 0 };
    // Explicit bounded view. No pruning or mutation of other runs, including unclosed peers.
    const names = readdirSync(this.directory).filter((name) => archiveName.test(name)).map((name) => {
      try { return { name, modified: lstatSync(join(this.directory, name)).mtimeMs }; }
      catch { return { name, modified: 0 }; }
    }).sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name));
    const unavailable: string[] = [];
    const runs: RunSummary[] = [];
    const candidates = names.slice(0, 50);
    for (const { name } of candidates) {
      const runId = name.slice(0, -5);
      try {
        const run = this.read(runId);
        runs.push({ runId, cwd: run.cwd, createdAt: run.createdAt, updatedAt: run.updatedAt, sequence: run.sequence, tasks: run.tasks.length,
          disposition: run.closedAt ? "closed" : runId === currentRunId ? "current" : "unreconciled" });
      } catch { unavailable.push(runId); }
    }
    return { runs: runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)), unavailable, omitted: Math.max(0, names.length - candidates.length) };
  }
  /**
   * Retention: keeps the newest `keep` archives and deletes only older ones that
   * validate and record a closure. Unclosed runs (possibly live elsewhere),
   * invalid files and the current run are never touched. Returns deleted count.
   */
  prune(keep: number, currentRunId?: string): number {
    if (!Number.isSafeInteger(keep) || keep < 1 || !this.checkRoot(false)) return 0;
    const names = readdirSync(this.directory).filter((name) => archiveName.test(name)).map((name) => {
      try { return { name, modified: lstatSync(join(this.directory, name)).mtimeMs }; } catch { return { name, modified: Infinity }; }
    }).sort((a, b) => b.modified - a.modified);
    let deleted = 0;
    for (const { name } of names.slice(keep)) {
      const runId = name.slice(0, -5);
      if (runId === currentRunId) continue;
      try { if (this.read(runId).closedAt) { unlinkSync(join(this.directory, name)); deleted++; } } catch { /* invalid or unreadable: never deleted */ }
    }
    return deleted;
  }
  resolve(reference: string): string {
    if (id.safeParse(reference).success) return reference;
    if (!/^[0-9a-f-]{8,35}$/.test(reference) || !this.checkRoot(false)) throw new Error("Usa el ID completo del run o un prefijo único de al menos ocho caracteres");
    const matches = readdirSync(this.directory).filter((name) => archiveName.test(name) && name.startsWith(reference));
    if (matches.length !== 1) throw new Error("El ID del run es desconocido o ambiguo");
    return matches[0]!.slice(0, -5);
  }
}

export class RunJournal {
  private record: RunRecord;
  readonly runId = randomUUID();
  constructor(readonly store: RunStore, cwd: string) {
    const now = new Date().toISOString();
    this.record = store.write({ schemaVersion: 1, runId: this.runId, ownerPid: process.pid, cwd, createdAt: now, updatedAt: now, sequence: 0, tasks: [] });
  }
  checkpoint(tasks: TaskView[]): void {
    if (this.record.closedAt) throw new Error("Run journal is already closed");
    const projected = tasks.map((task) => {
      const parsed = taskSchema.safeParse(Object.fromEntries(Object.keys(taskSchema.shape).map((key) => [key, task[key as keyof TaskView]])));
      if (!parsed.success) throw genericError();
      return parsed.data;
    });
    this.record = this.store.write({ ...this.record, updatedAt: new Date().toISOString(), sequence: this.record.sequence + 1, tasks: projected });
  }
  close(): void {
    if (this.record.closedAt) return;
    this.record = this.store.write({ ...this.record, updatedAt: new Date().toISOString(), closedAt: new Date().toISOString(), sequence: this.record.sequence + 1 });
  }
}
