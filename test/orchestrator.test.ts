import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { Orchestrator, TRUNCATION_NOTE } from "../src/orchestrator.ts";
import { capabilities, RuntimeCleanupError, type RuntimeAdapter, type RuntimeContext } from "../src/types.ts";

const adapter = (run: RuntimeAdapter["run"]): RuntimeAdapter => ({ capabilities, run });
const blocked = async ({ signal }: RuntimeContext): Promise<string> => {
  await delay(60_000, undefined, { signal }); return "unreachable";
};
const make = (run: RuntimeAdapter["run"] = blocked, limits = {}) => {
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: adapter(run), claude: adapter(run) }, ...limits });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  return core;
};

test("result, attempt and native session identities remain distinct; token revoked on completion", async () => {
  let token = "";
  const core = make(async (ctx) => { token = ctx.mcp.token; ctx.session("native-session"); return "answer"; });
  const task = core.delegate(null, "codex", "read only", "key");
  assert.notEqual(task.id, task.attemptId);
  const result = await core.wait(null, task.id);
  assert.equal(result.state, "completed"); assert.equal(result.result, "answer");
  assert.equal(result.runtimeSessionId, "native-session"); assert.equal(core.authenticate(token), undefined);
  await core.close();
});

test("same request key is idempotent, changed arguments are refused", async () => {
  const reuse: string[] = [];
  const core = make(blocked, { onEvent: (event: { type: string; task: { id: string } }) => {
    if (event.type === "request-reused") reuse.push(event.task.id);
  } });
  const one = core.delegate(null, "codex", "a", "retry");
  assert.equal(core.delegate(null, "codex", "a", "retry").id, one.id);
  assert.throws(() => core.delegate(null, "claude", "a", "retry"), /different arguments/);
  assert.deepEqual(reuse, [one.id], "Only actual idempotent reuse is observed, never conflicts");
  await core.close();
});

test("subtree authorization: descendants are visible, siblings and ancestors are not", async () => {
  const core = make(blocked, { maxConcurrent: 4 });
  const root = core.delegate(null, "codex", "root", "root");
  const sibling = core.delegate(null, "claude", "sibling", "sibling");
  const child = core.delegate(root.id, "claude", "child", "child");
  assert.equal(core.status(root.id, child.id).id, child.id);
  assert.throws(() => core.status(root.id, sibling.id), /subtree/);
  assert.throws(() => core.status(child.id, root.id), /subtree/);
  await assert.rejects(core.cancel(root.id, sibling.id), /subtree/);
  await core.close();
});

test("depth and concurrency count waiting parents; retries do not consume slots", async () => {
  const core = make(blocked, { maxConcurrent: 2 });
  const root = core.delegate(null, "codex", "root", "root");
  const child = core.delegate(root.id, "claude", "child", "child");
  assert.equal(core.delegate(root.id, "claude", "child", "child").id, child.id);
  assert.throws(() => core.delegate(child.id, "codex", "too deep", "deep"), /depth/);
  assert.throws(() => core.delegate(root.id, "claude", "too many", "other"), /Concurrency/);
  await core.close();
});

test("total task limit bounds completed work too", async () => {
  const core = make(async () => "done", { maxTasks: 1 });
  const task = core.delegate(null, "codex", "one", "one");
  await core.wait(null, task.id);
  assert.throws(() => core.delegate(null, "codex", "two", "two"), /Total task/);
  await core.close();
});

test("cancel revokes credentials immediately but confirms terminal state only after cleanup", async () => {
  let release!: () => void;
  let token = "";
  const core = make(async (ctx) => {
    token = ctx.mcp.token;
    await new Promise<void>((resolve) => { release = resolve; });
    return "late result";
  });
  const task = core.delegate(null, "codex", "root", "root");
  await tick();
  const cancellation = core.cancel(null, task.id);
  assert.equal(core.authenticate(token), undefined);
  assert.equal(core.status(null, task.id).state, "cancelling");
  assert.throws(() => core.delegate(task.id, "claude", "late", "late"), /no longer running/);
  release();
  assert.equal((await cancellation).state, "cancelled");
  assert.equal(core.status(null, task.id).result, undefined);
  await core.close();
});

test("parent cancellation cascades and cannot be overwritten by late results", async () => {
  const core = make();
  const parent = core.delegate(null, "codex", "parent", "parent");
  const child = core.delegate(parent.id, "claude", "child", "child");
  await tick();
  await core.cancel(null, parent.id);
  assert.equal(core.status(null, parent.id).state, "cancelled");
  assert.equal(core.status(null, child.id).state, "cancelled");
  await core.close();
});

test("completed parents clean up unfinished descendants", async () => {
  let finish!: () => void;
  const core = make(async (ctx) => {
    if (ctx.task.engine === "claude") return blocked(ctx);
    await new Promise<void>((resolve) => { finish = resolve; });
    return "parent done";
  });
  const parent = core.delegate(null, "codex", "parent", "parent");
  await tick();
  const child = core.delegate(parent.id, "claude", "child", "child");
  finish();
  assert.equal((await core.wait(null, parent.id)).state, "completed");
  assert.equal(core.status(null, child.id).state, "cancelled");
  await core.close();
});

test("runtime failures and empty results are not successes; observer failures are isolated", async () => {
  const core = make(async () => { throw new Error("provider unavailable"); });
  const task = core.delegate(null, "codex", "x", "x");
  assert.match((await core.wait(null, task.id)).error!, /provider unavailable/);
  const empty = make(async () => "");
  const other = empty.delegate(null, "claude", "x", "x");
  assert.equal((await empty.wait(null, other.id)).state, "failed");
  const observer = make(async () => "done", { onEvent: () => { throw new Error("observer broken"); } });
  assert.equal((await observer.wait(null, observer.delegate(null, "codex", "x", "x").id)).state, "completed");
  await Promise.all([core.close(), empty.close(), observer.close()]);
});

for (const [name, value] of [
  ["undefined", undefined], ["null", null], ["false", false], ["zero", 0], ["empty string", ""],
  ["symbol", Symbol("fixture failure")], ["unprintable object", { toString() { throw new Error("broken string conversion"); } }],
] as const) {
  test(`a runtime rejecting with ${name} settles as failed without an unhandled rejection`, async () => {
    const core = make(async () => { throw value; });
    try {
      const task = core.delegate(null, "codex", "bad runtime", "failure");
      const result = await core.wait(null, task.id, 1_000);
      assert.equal(result.state, "failed");
      assert.equal(result.result, undefined);
      assert.ok(result.error && result.endedAt);
    } finally { await core.close(); }
  });
}

test("oversized results are truncated with an explicit notice, the exact boundary is intact, and session identities redact credentials", async () => {
  const core = make(async (ctx) => {
    ctx.session(`session ${ctx.mcp.token} Bearer unrelated-secret`);
    return "x".repeat(ctx.prompt === "too long" ? 20_001 : 20_000);
  });
  try {
    const oversized = core.delegate(null, "codex", "too long", "oversized");
    const truncated = await core.wait(null, oversized.id);
    assert.equal(truncated.state, "completed");
    assert.equal(truncated.result!.length, 20_000);
    const saved = /Texto completo \(20001 caracteres\) en (\S+\.md)\]$/.exec(truncated.result!);
    assert.ok(saved, "truncation must be labelled, never silent, and point to the full text");
    const { readFileSync, statSync } = await import("node:fs");
    assert.equal(readFileSync(saved![1]!, "utf8"), "x".repeat(20_001), "nothing the runtime wrote is lost");
    assert.equal(statSync(saved![1]!).mode & 0o777, 0o600);
    void TRUNCATION_NOTE; // fallback note when the file cannot be written
    assert.equal(truncated.runtimeSessionId, "session [REDACTED] Bearer [REDACTED]");
    const exact = core.delegate(null, "claude", "exact", "exact");
    const completed = await core.wait(null, exact.id);
    assert.equal(completed.state, "completed");
    assert.equal(completed.result!.length, 20_000);
  } finally { await core.close(); }
});

test("timer overflow and non-finite/fractional limits are rejected rather than becoming immediate deadlines", () => {
  for (const timeoutMs of [2_147_483_648, Number.MAX_SAFE_INTEGER, Infinity, NaN, 0, -1, 1.5]) {
    assert.throws(() => make(blocked, { timeoutMs }), /Invalid limit: timeoutMs/);
  }
  const core = make(blocked, { timeoutMs: 2_147_483_647 });
  void core.close();
});

test("deadline cancels a task tree; wait timeout does not cancel", async () => {
  const core = make(blocked, { timeoutMs: 50 });
  const root = core.delegate(null, "codex", "root", "root");
  assert.equal((await core.wait(null, root.id, 1)).state, "running");
  const result = await core.wait(null, root.id, 1000);
  assert.equal(result.state, "cancelled"); assert.match(result.error!, /deadline/);
  await core.close();
});

test("wait abort removes the listener and does not itself grant cancellation authority", async () => {
  const core = make();
  const task = core.delegate(null, "codex", "x", "x");
  const controller = new AbortController();
  const waiting = core.wait(null, task.id, 1000, controller.signal);
  controller.abort(new Error("stop wait"));
  await assert.rejects(waiting, /stop wait/);
  assert.equal(core.status(null, task.id).state, "running");
  await core.close();
});

test("credentials are stripped from runtime errors and results", async () => {
  const core = make(async (ctx) => {
    ctx.activity(`oops ${ctx.mcp.token} Bearer somebody-elses-secret`);
    return `oops ${ctx.mcp.token} Bearer somebody-elses-secret`;
  });
  const task = core.delegate(null, "codex", "x", "x");
  const result = await core.wait(null, task.id);
  assert.equal(result.result, "oops [REDACTED] Bearer [REDACTED]");
  assert.equal(result.lastActivity, "oops [REDACTED] Bearer [REDACTED]");
  await core.close();
});

test("late session/activity cannot rewrite a cancelling attempt, but observed process exit is retained", async () => {
  let context!: RuntimeContext;
  let release!: () => void;
  const core = make(async (ctx) => {
    context = ctx; ctx.session("original-session"); ctx.activity("Read");
    ctx.process?.({ pid: 12345, groupId: 12345 });
    await new Promise<void>((resolve) => { release = resolve; });
    return "late output";
  });
  const task = core.delegate(null, "codex", "read proof", "proof");
  await tick();
  const external = core.status(null, task.id);
  external.runtimeProcess!.pid = 1;
  assert.equal(core.status(null, task.id).runtimeProcess!.pid, 12345, "views must not mutate the authoritative nested process identity");
  const cancellation = core.cancel(null, task.id);
  context.session("late-session"); context.activity("late-success");
  const exitedAt = new Date().toISOString();
  context.process?.({ pid: 12345, groupId: 12345, exitedAt, signal: "SIGTERM", code: null });
  release();
  const result = await cancellation;
  assert.equal(result.runtimeSessionId, "original-session");
  assert.equal(result.lastActivity, "Read");
  assert.equal(result.runtimeProcess!.exitedAt, exitedAt);
  assert.equal(result.state, "cancelled");
  context.activity("after settlement");
  assert.equal(core.status(null, task.id).lastActivity, "Read");
  await core.close();
});

test("request keys are scoped to the parent and stay idempotent after terminal results", async () => {
  const core = make(async (ctx) => ctx.task.depth === 2 ? "child result" : blocked(ctx), { maxConcurrent: 4 });
  try {
    const left = core.delegate(null, "codex", "left", "left");
    const right = core.delegate(null, "claude", "right", "right");
    const a = core.delegate(left.id, "claude", "same", "shared-key");
    const b = core.delegate(right.id, "codex", "same", "shared-key");
    assert.notEqual(a.id, b.id);
    assert.equal((await core.wait(null, a.id)).state, "completed");
    assert.equal((await core.wait(null, b.id)).state, "completed");
    assert.equal(core.delegate(left.id, "claude", "same", "shared-key").id, a.id);
    assert.throws(() => core.delegate(left.id, "claude", "changed", "shared-key"), /different arguments/);
    assert.equal(core.list().length, 4);
  } finally { await core.close(); }
});

test("selective child cancellation does not stop its parent or sibling, and failures stay distinct", async () => {
  const releases = new Map<string, () => void>();
  const core = make(async (ctx) => {
    if (ctx.prompt === "failure") throw new Error("fixture provider failure");
    await new Promise<void>((resolve) => {
      releases.set(ctx.task.id, resolve);
      ctx.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return `finished ${ctx.prompt}`;
  });
  try {
    const parent = core.delegate(null, "codex", "parent", "parent");
    const left = core.delegate(parent.id, "claude", "left", "left");
    const right = core.delegate(parent.id, "codex", "right", "right");
    await tick();
    assert.throws(() => core.delegate(parent.id, "claude", "excess", "excess"), /Concurrency/);
    await assert.rejects(core.cancel(left.id, right.id), /subtree/);
    assert.equal((await core.cancel(parent.id, left.id)).state, "cancelled");
    assert.equal(core.status(null, parent.id).state, "running");
    assert.equal(core.status(null, right.id).state, "running");
    releases.get(right.id)!();
    assert.equal((await core.wait(null, right.id)).result, "finished right");
    const failed = core.delegate(parent.id, "claude", "failure", "failure");
    assert.equal((await core.wait(null, failed.id)).state, "failed");
    assert.equal(core.status(null, failed.id).result, undefined);
    assert.equal(core.status(null, parent.id).state, "running");
    releases.get(parent.id)!();
    assert.equal((await core.wait(null, parent.id)).state, "completed");
    assert.equal(core.status(null, left.id).state, "cancelled");
    assert.equal(core.status(null, failed.id).state, "failed");
  } finally { await core.close(); }
});

test("a finished runtime cannot admit late children while its previous children are cleaning up", async () => {
  let finishParent!: () => void;
  let finishChild!: () => void;
  const core = make(async (ctx) => {
    if (ctx.prompt === "late") return "unexpected late execution";
    await new Promise<void>((resolve) => {
      if (ctx.task.depth === 1) finishParent = resolve;
      else finishChild = resolve;
    });
    return "native result";
  });
  try {
    const parent = core.delegate(null, "codex", "parent", "parent");
    const child = core.delegate(parent.id, "claude", "child", "child");
    await tick();
    finishParent();
    await tick();
    assert.equal(core.status(null, child.id).state, "cancelling");
    // Parent has not settled yet: cleanup still owns its completion promise.
    assert.throws(() => core.delegate(parent.id, "codex", "late", "late"), /no longer running/);
    assert.equal(core.list().length, 2);
    finishChild();
    assert.equal((await core.wait(null, parent.id)).state, "completed");
  } finally { finishParent?.(); finishChild?.(); await core.close(); }
});

for (const cancelled of [false, true]) {
  test(`a reported process without observed exit cannot acknowledge ${cancelled ? "cancellation" : "success"}`, async () => {
    const core = make(async (ctx) => {
      ctx.process?.({ pid: 12345, groupId: 12345 }); // Metadata fixture; never signalled.
      if (cancelled) await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
      return "premature result";
    });
    try {
      const task = core.delegate(null, "codex", "missing exit", "missing exit");
      await tick();
      const result = cancelled ? await core.cancel(null, task.id) : await core.wait(null, task.id);
      assert.equal(result.state, "failed"); assert.equal(result.result, undefined);
      assert.match(result.error!, /cleanup could not be confirmed/);
      assert.equal(result.runtimeProcess?.exitedAt, undefined);
    } finally { await core.close(); }
  });
}

test("a cleanup failure after the leader exited still refuses cancellation acknowledgement", async () => {
  const core = make(async (ctx) => {
    ctx.process?.({ pid: 12345, groupId: 12345 });
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    ctx.process?.({ pid: 12345, groupId: 12345, exitedAt: new Date().toISOString(), code: 0 });
    throw new RuntimeCleanupError(new Error("private fixture cause"));
  });
  try {
    const task = core.delegate(null, "codex", "group cleanup failure", "group cleanup failure");
    await tick();
    const result = await core.cancel(null, task.id);
    assert.equal(result.state, "failed"); assert.equal(result.result, undefined);
    assert.ok(result.runtimeProcess?.exitedAt);
    assert.match(result.error!, /no cancellation or process-group cleanup was acknowledged/);
    assert.ok(!result.error!.includes("private fixture cause"));
  } finally { await core.close(); }
});

test("unconfirmed descendant cleanup propagates to its parent instead of falsely confirming the tree cancelled", async () => {
  const core = make(async (ctx) => {
    await new Promise<void>((resolve) => ctx.signal.addEventListener("abort", () => resolve(), { once: true }));
    if (ctx.task.parentId) throw new RuntimeCleanupError();
    throw ctx.signal.reason;
  });
  try {
    const parent = core.delegate(null, "codex", "parent", "parent");
    await tick();
    const child = core.delegate(parent.id, "claude", "child", "child");
    await tick();
    assert.equal((await core.cancel(null, parent.id)).state, "failed");
    assert.equal(core.status(null, child.id).state, "failed");
    assert.ok(core.list().every((task) => !task.result && /cleanup could not be confirmed/.test(task.error!)));
  } finally { await core.close(); }
});

test("shutdown is idempotent, cancels live work, refuses new tasks", async () => {
  const core = make();
  const task = core.delegate(null, "codex", "x", "x");
  await Promise.all([core.close(), core.close()]);
  assert.equal(core.status(null, task.id).state, "cancelled");
  assert.throws(() => core.delegate(null, "claude", "x", "x"), /shutting down/);
});
