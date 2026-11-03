import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RunJournal, RunStore, type RunRecord } from "../src/journal.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { availableCensus } from "./census-helper.ts";
import { processCensus, reconcileRun } from "../src/reconciliation.ts";
import { planRecovery } from "../src/recovery.ts";
import { createService } from "../src/service.ts";
import { RuntimeProcess } from "../src/adapters/process.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { capabilities, type RuntimeAdapter, type RuntimeContext, type TaskView } from "../src/types.ts";

const posix = { skip: process.platform === "win32" };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pi-orchestrator-journal-"));
  const directory = join(root, "state");
  return { root, directory, store: new RunStore(directory), clean: () => rmSync(root, { recursive: true, force: true }) };
}
function task(cwd: string): TaskView {
  return { id: randomUUID(), title: "fixture task", attemptId: randomUUID(), parentId: null, engine: "codex", depth: 1, cwd, state: "running", createdAt: new Date().toISOString() };
}
const adapter = (run: RuntimeAdapter["run"]): RuntimeAdapter => ({ capabilities, run });
function coreWith(run: RuntimeAdapter["run"], checkpoint: (tasks: TaskView[]) => void, onPersistenceError?: (message: string) => void) {
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: adapter(run), claude: adapter(run) }, checkpoint, onPersistenceError });
  core.attachEndpoint("http://127.0.0.1:12345/mcp"); return core;
}

test("permission policy survives strict journal roundtrips without authorizing historical execution", posix, () => {
  const f = fixture();
  try {
    const journal = new RunJournal(f.store, f.root);
    const elevated = { ...task(f.root), permissionMode: "yolo" as const };
    journal.checkpoint([elevated]);
    const record = f.store.read(journal.runId);
    assert.equal(record.tasks[0]!.permissionMode, "yolo");
    assert.throws(() => f.store.write({ ...record, tasks: [{ ...elevated, permissionMode: "unexpected" as any }] }));
    const legacy = task(f.root);
    journal.checkpoint([legacy]);
    assert.equal(f.store.read(journal.runId).tasks[0]!.permissionMode, undefined);
  } finally { f.clean(); }
});

test("atomic private checkpoints retain identities/results, not authority or full prompts; restart never adopts archives", posix, async () => {
  const f = fixture();
  const tokens: string[] = [];
  let calls = 0;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  const run: RuntimeAdapter["run"] = async (ctx) => {
    calls++; tokens.push(ctx.mcp.token);
    const record = f.store.read(service!.journal!.runId);
    assert.ok(record.tasks.some((task) => task.id === ctx.task.id), "intention committed before runtime starts");
    ctx.session(`native-${ctx.task.engine}`);
    ctx.activity(`activity Bearer ${ctx.mcp.token}`);
    if (ctx.task.parentId === null) {
      const child = service!.core.delegate(ctx.task.id, "claude", "child fixture", "private-request-key");
      const completed = await service!.core.wait(ctx.task.id, child.id);
      return `parent received ${completed.result}`;
    }
    return `child result Bearer ${ctx.mcp.token}`;
  };
  try {
    assert.deepEqual(f.store.history(), { runs: [], unavailable: [], omitted: 0 });
    assert.equal(existsSync(f.directory), false, "history alone creates no directory");
    service = await createService({ cwd: f.root, stateDirectory: f.directory }, { codex: adapter(run), claude: adapter(run) });
    const root = service.core.delegate(null, "codex", "safe title ".repeat(20) + "FULL_PROMPT_SUFFIX_MUST_NOT_PERSIST", "root-private-key");
    assert.equal((await service.core.wait(null, root.id)).state, "completed");
    const runId = service.journal!.runId;
    const record = new RunStore(f.directory).read(runId);
    assert.equal(record.tasks.length, 2);
    assert.equal(record.tasks[1]!.parentId, root.id);
    assert.notEqual(record.tasks[0]!.attemptId, record.tasks[0]!.runtimeSessionId);
    assert.match(record.tasks[0]!.result!, /parent received child result/);
    assert.equal(f.store.history(runId).runs[0]!.disposition, "current");
    const filename = join(f.directory, `${runId}.json`);
    const bytes = readFileSync(filename, "utf8");
    for (const sensitive of [...tokens, "FULL_PROMPT_SUFFIX_MUST_NOT_PERSIST", "private-request-key", "root-private-key", "Authorization", '"mcp"', '"prompt"']) assert.ok(!bytes.includes(sensitive), sensitive);
    assert.match(bytes, /REDACTED/);
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    assert.equal(statSync(f.directory).mode & 0o777, 0o700);
    assert.ok(readdirSync(f.directory).every((name) => !name.startsWith(".tmp-")));
    await Promise.all([service.close(), service.close()]);
    assert.ok(f.store.read(runId).closedAt);
    assert.equal(f.store.history().runs[0]!.disposition, "closed");
    service = await createService({ cwd: f.root, stateDirectory: f.directory }, { codex: adapter(run), claude: adapter(run) });
    assert.deepEqual(service.core.list(), []);
    assert.equal(calls, 2, "no replay/resume/new agent at restart");
    await assert.rejects(service.core.cancel(null, root.id), /Unknown task/);
    assert.notEqual(service.journal!.runId, runId);
  } finally { await service?.close(); f.clean(); }
});

test("a failed initial checkpoint grants no authority, schedules no runtime, and refuses later work", async () => {
  let started = 0, reported = 0;
  const core = coreWith(async () => { started++; return "wrong"; }, () => { throw new Error("Bearer secret-filesystem-detail"); }, (message) => { reported++; assert.ok(!message.includes("secret-filesystem-detail")); throw new Error("observer failure"); });
  try {
    assert.throws(() => core.delegate(null, "codex", "do not start", "key"), /Durable state write failed/);
    await delay(0);
    assert.deepEqual(core.list(), []); assert.equal(started, 0); assert.equal(reported, 1);
    assert.throws(() => core.delegate(null, "codex", "still forbidden", "key2"), /Durable state write failed/);
  } finally { await core.close(); }
});

test("write failure mid-tree revokes/aborts all live work, waits for cleanup, and cannot publish late success", { timeout: 5_000 }, async () => {
  const contexts: RuntimeContext[] = [];
  let cleaned = 0, notifications = 0;
  let core!: Orchestrator;
  const run: RuntimeAdapter["run"] = async (ctx) => {
    contexts.push(ctx);
    if (ctx.task.parentId === null) core.delegate(ctx.task.id, "claude", "child", "child");
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => { void delay(20).then(() => { cleaned++; resolve(); }); }, { once: true }));
    return "late success";
  };
  core = coreWith(run, (tasks) => { if (tasks.some((task) => task.lastActivity === "trip")) throw new Error("disk failure"); }, () => { notifications++; });
  try {
    const root = core.delegate(null, "codex", "parent", "parent");
    while (contexts.length < 2) await delay(1);
    contexts[1]!.activity("trip");
    assert.equal(core.authenticate(contexts[0]!.mcp.token), undefined);
    assert.equal(core.authenticate(contexts[1]!.mcp.token), undefined);
    assert.equal(core.status(null, root.id).state, "cancelling");
    assert.equal(cleaned, 0);
    await core.wait(null, root.id);
    assert.equal(cleaned, 2); assert.equal(notifications, 1);
    assert.ok(core.list().every((task) => task.state === "cancelled" && task.result === undefined));
  } finally { await core.close(); }
});

test("native success is not published as completed if its final checkpoint fails", async () => {
  const events: string[] = [];
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: adapter(async () => "native success"), claude: adapter(async () => "unused") },
    checkpoint: (tasks) => { if (tasks.some((task) => task.state === "completed")) throw new Error("disk full"); },
    onEvent: (event) => { if (event.type === "settled") events.push(event.task.state); },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const root = core.delegate(null, "codex", "fixture", "key");
    const completed = await core.wait(null, root.id);
    assert.equal(completed.state, "failed"); assert.equal(completed.result, undefined);
    assert.match(completed.error!, /Durable state write failed/);
    assert.deepEqual(events, ["failed"]);
  } finally { await core.close(); }
});

test("a checkpoint failure on the very first process observation cleans up even before native protocol initialization", { ...posix, timeout: 5_000 }, async () => {
  const f = fixture();
  const executable = join(f.root, "node-only-fake-codex");
  writeFileSync(executable, "#!/usr/bin/env node\nsetInterval(()=>{},1000);\n", { mode: 0o700 });
  const core = new Orchestrator({ cwd: f.root, adapters: { codex: new CodexAdapter(executable), claude: adapter(async () => "unused") },
    checkpoint: (tasks) => { if (tasks.some((task) => task.runtimeProcess)) throw new Error("first process checkpoint failure"); },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const root = core.delegate(null, "codex", "Node fixture, never a real agent", "key");
    const stopped = await core.wait(null, root.id);
    assert.equal(stopped.state, "cancelled"); assert.ok(stopped.runtimeProcess?.exitedAt);
    assert.equal(stopped.runtimeSessionId, undefined); assert.equal(stopped.result, undefined);
  } finally { await core.close(); f.clean(); }
});

test("filesystem write failure cannot prevent real Node runtime cleanup or bridge closure", { ...posix, timeout: 8_000 }, async () => {
  const f = fixture();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let context!: RuntimeContext;
  const run: RuntimeAdapter["run"] = async (ctx) => {
    context = ctx;
    const proc = new RuntimeProcess(process.execPath, ["-e", "console.log(JSON.stringify({ready:true}));setInterval(()=>{},1000)"], f.root, ctx.signal);
    const pending = new Promise<string>((_resolve, reject) => {
      proc.onFailure = reject;
      proc.onMessage = () => { ctx.activity("node fixture ready"); ready(); };
      void proc.closed.then(() => reject(new Error("fixture exited")));
    });
    proc.observe(ctx.process);
    try { return await pending; } finally { await proc.stop(); }
  };
  const service = await createService({ cwd: f.root, stateDirectory: f.directory }, { codex: adapter(run), claude: adapter(run) });
  try {
    const root = service.core.delegate(null, "codex", "fixture", "key");
    await started;
    // Preserve the last good checkpoint, but make further writes fail deterministically (even as root).
    renameSync(f.directory, join(f.root, "last-good")); writeFileSync(f.directory, "not a directory", { mode: 0o600 });
    // Activity is throttled to one durable write per 5 s; a session report always persists.
    context.session("trip-real-filesystem-failure");
    const result = await service.core.wait(null, root.id);
    assert.equal(result.state, "cancelled"); assert.ok(result.runtimeProcess?.exitedAt);
    assert.match(result.error!, /Durable state write failed/);
    const saved = new RunStore(join(f.root, "last-good")).read(service.journal!.runId);
    assert.equal(saved.closedAt, undefined); assert.equal(saved.tasks[0]!.state, "running");
    await assert.rejects(service.close(), /Durable state unavailable/);
    await assert.rejects(fetch(context.mcp.url), "the transport is already closed even though final disk write failed");
  } finally { await service.close().catch(() => {}); f.clean(); }
});

test("malformed, foreign, cyclic and unsafe archives fail closed; one corrupt run does not hide healthy peers", posix, () => {
  const f = fixture();
  try {
    const journal = new RunJournal(f.store, f.root);
    journal.checkpoint([task(f.root)]);
    const base = f.store.read(journal.runId);
    const variants: ((run: RunRecord) => unknown)[] = [
      (run) => ({ ...run, schemaVersion: 2, unexpectedSecret: "do-not-print-this" }),
      (run) => ({ ...run, runId: randomUUID() }),
      (run) => ({ ...run, closedAt: new Date().toISOString() }),
      (run) => ({ ...run, tasks: [{ ...run.tasks[0]!, parentId: run.tasks[0]!.id }] }),
      // Tasks may run outside the run cwd (per-task cwd, YOLO worktrees), but only at absolute paths.
      (run) => ({ ...run, tasks: [{ ...run.tasks[0]!, cwd: "relative/escape" }] }),
      (run) => ({ ...run, tasks: [run.tasks[0]!, run.tasks[0]!] }),
      (run) => ({ ...run, tasks: [{ ...run.tasks[0]!, state: "completed" }] }),
    ];
    const path = join(f.directory, `${journal.runId}.json`);
    for (const variant of variants) {
      writeFileSync(path, JSON.stringify(variant(structuredClone(base))), { mode: 0o600 });
      assert.throws(() => f.store.read(journal.runId), (error: Error) => !error.message.includes("do-not-print-this") && /invalid/.test(error.message));
    }
    writeFileSync(path, "{half-written", { mode: 0o600 });
    const healthy = new RunJournal(f.store, f.root);
    writeFileSync(join(f.directory, ".tmp-not-published"), "partial bytes", { mode: 0o600 });
    assert.deepEqual(f.store.history().unavailable, [journal.runId]);
    assert.equal(f.store.history().runs[0]!.runId, healthy.runId);
    assert.equal(f.store.history().runs[0]!.disposition, "unreconciled", "unclosed does not mean dead owner");
    assert.throws(() => f.store.resolve("../../"));
    assert.throws(() => f.store.read("../../"));
    assert.throws(() => f.store.resolve(healthy.runId.slice(0, 7)));
    assert.equal(f.store.resolve(healthy.runId.slice(0, 8)), healthy.runId);
    chmodSync(join(f.directory, `${healthy.runId}.json`), 0o644);
    assert.throws(() => f.store.read(healthy.runId));
    chmodSync(f.directory, 0o755); assert.throws(() => f.store.history());
  } finally { f.clean(); }
});

test("symlinks are not read or followed, and failed validation leaves the prior checkpoint byte-identical", posix, () => {
  const f = fixture();
  try {
    const journal = new RunJournal(f.store, f.root);
    const filename = join(f.directory, `${journal.runId}.json`);
    const before = readFileSync(filename, "utf8");
    assert.throws(() => f.store.write({ ...f.store.read(journal.runId), tasks: [{ ...task(f.root), depth: 7 }] }));
    assert.equal(readFileSync(filename, "utf8"), before);
    const sentinel = join(f.root, "foreign-sentinel"); writeFileSync(sentinel, "leave me alone", { mode: 0o600 });
    const fakeId = randomUUID(); symlinkSync(sentinel, join(f.directory, `${fakeId}.json`));
    assert.throws(() => f.store.read(fakeId));
    f.store.write({ ...f.store.read(journal.runId), runId: fakeId });
    assert.equal(readFileSync(sentinel, "utf8"), "leave me alone", "atomic rename replaces the link, not its target");
    const alias = join(f.root, "alias"); symlinkSync(f.directory, alias);
    assert.throws(() => new RunStore(alias).read(journal.runId));
    assert.throws(() => new RunJournal(new RunStore(alias), f.root));
  } finally { f.clean(); }
});

test("reconciliation distinguishes saved state from numeric observations, including PID reuse and remaining groups", posix, (t) => {
  const f = fixture();
  try {
    const journal = new RunJournal(f.store, f.root);
    const tasks = Array.from({ length: 6 }, () => task(f.root));
    tasks[0]!.runtimeProcess = { pid: 101, groupId: 101, exitedAt: new Date().toISOString(), code: 0 };
    tasks[1]!.runtimeProcess = { pid: 102, groupId: 102 };
    tasks[2]!.runtimeProcess = { pid: 103, groupId: 103 };
    tasks[3]!.runtimeProcess = { pid: 104, groupId: 104 };
    tasks[4]!.runtimeProcess = { pid: 105, groupId: 105 };
    journal.checkpoint(tasks);
    const path = join(f.directory, `${journal.runId}.json`), before = readFileSync(path, "utf8");
    const run = f.store.read(journal.runId);
    const plan = reconcileRun(run, [{ pid: 103, groupId: 103, state: "S" }, { pid: 104, groupId: 204, state: "S" }, { pid: 999, groupId: 102, state: "S" }, { pid: 105, groupId: 105, state: "Z" }]);
    assert.equal(plan.closure, "unresolved");
    assert.deepEqual(plan.tasks.map((task) => task.observation), ["exit-recorded", "pid-absent", "numeric-match-only", "pid-or-group-changed", "numeric-match-only", "no-process-recorded"]);
    assert.equal(plan.tasks[1]!.numericGroupHasExecutingMembers, true, "leader absence is not group cleanup");
    assert.equal(plan.tasks[4]!.numericGroupHasExecutingMembers, false, "zombies are not executing");
    assert.equal(reconcileRun(run, undefined).tasks[1]!.observation, "census-unavailable");
    assert.match(plan.warning, /no acredita identidad ni autoridad/);
    assert.equal(readFileSync(path, "utf8"), before, "read-only plan never changes saved outcomes");
    assert.equal(f.store.history().runs[0]!.disposition, "unreconciled");
    const census = processCensus();
    // ps can fail or observe disappearing processes during concurrent fixture churn.
    // Production intentionally reports unknown, not a guessed absence or cleanup.
    if (census) {
      assert.ok(census.some((row) => row.pid === process.pid), "actual ps census includes this live process");
      assert.ok(census.every((row) => Object.keys(row).sort().join(",") === "groupId,pid,state"));
    } else t.diagnostic("Live ps census unavailable; conservative unknown is supported and tested above");
  } finally { f.clean(); }
});

test("an actual coordinator SIGKILL preserves its last checkpoint but never grants control of the surviving Node worker", { ...posix, timeout: 15_000 }, async () => {
  const f = fixture();
  const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("fixtures/crash-coordinator.ts", import.meta.url)), f.directory], { cwd: f.root, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let owned: { pid: number; groupId: number } | undefined;
  let stderr = "";
  child.stderr?.on("data", (data) => { stderr = (stderr + String(data)).slice(-4_000); });
  let restart: Awaited<ReturnType<typeof createService>> | undefined;
  const readiness = new Promise<{ runId: string; taskId: string }>((resolve, reject) => {
    child.on("message", (message: any) => {
      if (message.type === "owned-process") owned = { pid: message.pid, groupId: message.groupId };
      if (message.type === "ready") resolve(message);
    });
    child.once("error", reject);
    child.once("exit", () => reject(new Error(`Fixture exited before readiness: ${stderr}`)));
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([readiness, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Crash fixture readiness timeout")), 7_000); })]);
    clearTimeout(timer);
    assert.ok(owned);
    const saved = f.store.read(ready.runId);
    assert.equal(saved.tasks[0]!.runtimeProcess!.pid, owned.pid);
    assert.equal(saved.tasks[0]!.runtimeSessionId, "crash-fixture-native-session");
    assert.equal(saved.tasks[0]!.lastActivity, "simulated tool active");
    child.kill("SIGKILL"); // Only the process handle we just spawned, not a PID from disk.
    await exited;
    const bytes = readFileSync(join(f.directory, `${ready.runId}.json`), "utf8");
    const run = new RunStore(f.directory).read(ready.runId);
    assert.equal(run.closedAt, undefined); assert.equal(run.tasks[0]!.state, "running");
    assert.equal(f.store.history().runs[0]!.disposition, "unreconciled");
    const census = await availableCensus();
    assert.ok(census.some((row) => row.pid === owned!.pid && !row.state.startsWith("Z")), "worker really survived coordinator SIGKILL");
    const plan = reconcileRun(run, census);
    assert.equal(plan.closure, "unresolved"); assert.equal(plan.tasks[0]!.observation, "numeric-match-only");
    let resumed = false, explicitRestart = false;
    const forbidden = adapter(async (ctx) => {
      resumed = true;
      assert.ok(explicitRestart, "no implicit replay or resume");
      assert.equal(ctx.prompt, "fresh operator-approved instructions");
      assert.notEqual(ctx.task.id, ready.taskId);
      assert.notEqual(ctx.task.attemptId, run.tasks[0]!.attemptId);
      assert.equal(ctx.task.runtimeProcess, undefined);
      assert.equal(ctx.task.runtimeSessionId, undefined);
      return "new fixture result, not the old worker";
    });
    restart = await createService({ cwd: f.root, stateDirectory: f.directory }, { codex: forbidden, claude: forbidden });
    assert.deepEqual(restart.core.list(), []); assert.equal(resumed, false);
    await assert.rejects(restart.core.cancel(null, ready.taskId), /Unknown task/);
    assert.equal(readFileSync(join(f.directory, `${ready.runId}.json`), "utf8"), bytes);
    assert.ok((await availableCensus()).some((row) => row.pid === owned!.pid && !row.state.startsWith("Z")), "read-only recovery did not signal the orphan");
    const recovery = planRecovery(f.store, ready.runId, ready.taskId, f.root, "fresh operator-approved instructions", true);
    assert.equal(resumed, false, "planning itself executes nothing");
    explicitRestart = true;
    const replacement = restart.core.delegate(null, recovery.engine, recovery.prompt, "explicit-after-crash", recovery.recoverySource);
    const completed = await restart.core.wait(null, replacement.id);
    assert.equal(completed.state, "completed");
    assert.deepEqual(completed.recoverySource, { runId: ready.runId, taskId: ready.taskId, attemptId: run.tasks[0]!.attemptId });
    assert.equal(readFileSync(join(f.directory, `${ready.runId}.json`), "utf8"), bytes);
    assert.ok((await availableCensus()).some((row) => row.pid === owned!.pid && !row.state.startsWith("Z")), "new attempt neither adopts nor signals the surviving old worker");
  } finally {
    clearTimeout(timer);
    await restart?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    // Cleanup uses live fixture IPC registration, never authority inferred from a journal.
    if (owned) {
      try { process.kill(-owned.groupId, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      const deadline = Date.now() + 2_000;
      while ((await availableCensus()).some((row) => row.groupId === owned!.groupId && !row.state.startsWith("Z"))) {
        if (Date.now() > deadline) throw new Error("Owned crash fixture worker did not stop");
        await delay(20);
      }
    }
    f.clean();
  }
});

test("multiple coordinators have disjoint files; current, closed and unclosed peers are never conflated", posix, () => {
  const f = fixture();
  try {
    const own = new RunJournal(f.store, f.root);
    own.checkpoint([task(f.root)]);
    const ownPath = join(f.directory, `${own.runId}.json`), ownBytes = readFileSync(ownPath, "utf8");
    const peer = new RunJournal(new RunStore(f.directory), f.root);
    const unfinishedPeer = new RunJournal(new RunStore(f.directory), f.root);
    peer.close();
    const dispositions = new Map(f.store.history(own.runId).runs.map((run) => [run.runId, run.disposition]));
    assert.equal(dispositions.get(own.runId), "current");
    assert.equal(dispositions.get(peer.runId), "closed");
    assert.equal(dispositions.get(unfinishedPeer.runId), "unreconciled", "even a matching live owner PID grants no supervision");
    reconcileRun(f.store.read(unfinishedPeer.runId), processCensus());
    assert.equal(readFileSync(ownPath, "utf8"), ownBytes);
    const copy = f.store.read(own.runId); copy.tasks[0]!.title = "mutated copy";
    assert.equal(f.store.read(own.runId).tasks[0]!.title, "fixture task");
    assert.equal(f.store.read(peer.runId).sequence, 1);
    assert.equal(f.store.read(unfinishedPeer.runId).sequence, 0);
  } finally { f.clean(); }
});

test("history bounds parsed archives without pruning; ambiguous prefixes cannot select a run", posix, () => {
  const f = fixture();
  try {
    const journal = new RunJournal(f.store, f.root);
    const template = f.store.read(journal.runId);
    const ids = ["abcdefab-0000-4000-8000-000000000001", "abcdefab-0000-4000-8000-000000000002"];
    for (const runId of ids) f.store.write({ ...template, runId });
    assert.throws(() => f.store.resolve("abcdefab"), /ambiguo/);
    assert.equal(f.store.resolve(ids[0]!), ids[0]);
    for (let i = 0; i < 49; i++) f.store.write({ ...template, runId: randomUUID() });
    const history = f.store.history();
    assert.equal(history.runs.length, 50); assert.equal(history.omitted, 2);
    assert.equal(readdirSync(f.directory).filter((name) => name.endsWith(".json")).length, 52, "history performs no automatic deletion");
    assert.equal(f.store.read(journal.runId).runId, journal.runId, "full ID remains readable outside the history window");
  } finally { f.clean(); }
});

test("projection strips extra authority fields and redaction cannot make bounded text invalid on reload", posix, () => {
  const f = fixture();
  try {
    const journal = new RunJournal(f.store, f.root);
    const view = { ...task(f.root), title: "Bearer a ".repeat(17).slice(0, 160), prompt: "never persist full prompt", token: "never persist token", requestKey: "never persist request key" };
    journal.checkpoint([view]);
    const saved = f.store.read(journal.runId);
    assert.ok(saved.tasks[0]!.title.length <= 160);
    const text = readFileSync(join(f.directory, `${journal.runId}.json`), "utf8");
    assert.ok(!text.includes("never persist"));
    assert.match(saved.tasks[0]!.title, /REDACTED/);
  } finally { f.clean(); }
});

test("retention deletes only old closed runs; unclosed, invalid and current runs survive", async () => {
  const { mkdtemp, rm, writeFile, readdir, utimes } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { RunStore, RunJournal } = await import("../src/journal.ts");
  const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-retention-"));
  try {
    const store = new RunStore(join(directory, "state"));
    const closed = Array.from({ length: 4 }, () => { const run = new RunJournal(store, process.cwd()); run.close(); return run.runId; });
    const open = new RunJournal(store, process.cwd()).runId; // never closed: may be live elsewhere
    const bogus = "00000000-0000-4000-8000-000000000000";
    await writeFile(join(directory, "state", `${bogus}.json`), "{not json", { mode: 0o600 });
    // Oldest first: the open run and the invalid file are older than every closed run.
    let t = Date.now() / 1000 - 1000;
    for (const id of [open, bogus, ...closed]) await utimes(join(directory, "state", `${id}.json`), t, t++);
    const current = closed.at(-1)!;
    assert.equal(store.prune(1, current), 3, "three older closed runs deleted");
    const left = (await readdir(join(directory, "state"))).sort();
    assert.deepEqual(left, [open, bogus, current].map((id) => `${id}.json`).sort());
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("activity reaches the durable checkpoint at most every 5 s per task; the first and the settle always do", async () => {
  const writes: (string | undefined)[] = [];
  let ctx!: RuntimeContext; let finish!: () => void;
  const core = coreWith(async (context) => { ctx = context; await new Promise<void>((resolve) => { finish = resolve; }); return "done"; }, (tasks) => { writes.push(tasks[0]?.lastActivity); });
  try {
    const root = core.delegate(null, "codex", "parent", "parent");
    while (!ctx) await delay(1);
    const before = writes.length;
    for (let i = 0; i < 50; i++) ctx.activity(`tool ${i}`);
    assert.deepEqual(writes.slice(before), ["tool 0"], "a burst of 50 tool calls is one write");
    finish();
    await core.wait(null, root.id);
    assert.equal(writes.at(-1), "tool 49", "the settle checkpoint carries the latest activity");
  } finally { await core.close(); }
});
