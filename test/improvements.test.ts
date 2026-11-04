import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Orchestrator, PARTIAL_NOTE, WRAP_UP_TEXT } from "../src/orchestrator.ts";
import { productDefaults, runtimeConfiguration } from "../src/configuration.ts";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type Service } from "../src/service.ts";
import { DELIVERED_NOTE, AVAILABLE_NOTE } from "../src/model-view.ts";
import { taskCard, taskDetail } from "../src/presentation.ts";
import { capabilities, type RuntimeContext, type TaskView } from "../src/types.ts";

test("product defaults queue a root fan-out instead of rejecting it, and env still wins", async () => {
  assert.deepEqual(productDefaults, { queuePolicy: "fair", maxConcurrent: 4, interactionTimeoutMs: 300_000, defaultSelection: { claude: { model: "sonnet" } }, isolateWrites: true });
  assert.equal({ ...productDefaults, ...runtimeConfiguration({ PI_ORCHESTRATOR_QUEUE: "reject" }) }.queuePolicy, "reject");
  assert.equal({ ...productDefaults, ...runtimeConfiguration({ PI_ORCHESTRATOR_ISOLATE_WRITES: "0" }) }.isolateWrites, false);
  assert.deepEqual(runtimeConfiguration({ PI_ORCHESTRATOR_ALLOWED_ROOTS: "/a:/b/c" }).allowedRoots, ["/a", "/b/c"]);
  assert.throws(() => runtimeConfiguration({ PI_ORCHESTRATOR_ALLOWED_ROOTS: "relative" }), /absolute/);
  const blocked = async (ctx: RuntimeContext) => { await delay(60_000, undefined, { signal: ctx.signal }); return "x"; };
  const core = new Orchestrator({ cwd: process.cwd(), ...productDefaults, adapters: { codex: { capabilities, run: blocked } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const states = Array.from({ length: 5 }, (_, i) => core.delegate(null, "codex", `t${i}`, `k${i}`).state);
    // One of four slots stays reserved for nested children: three roots run, as before.
    assert.deepEqual(states, ["running", "running", "running", "queued", "queued"]);
  } finally { await core.close(); }
});

test("a cut-off attempt publishes its last text as partialResult, redacted; completion never does", async () => {
  let token = "";
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: { capabilities, run: async (ctx) => {
    token = ctx.mcp.token;
    ctx.partial?.(`draft one ${ctx.mcp.token}`);
    ctx.partial?.(`draft two ${ctx.mcp.token}`);
    if (ctx.prompt === "ok") return "final";
    throw new Error("error_max_turns");
  } } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const failed = await core.wait(null, core.delegate(null, "codex", "cut", "cut").id);
    assert.equal(failed.state, "failed");
    assert.equal(failed.result, undefined, "a partial is never a completion");
    assert.ok(failed.partialResult!.startsWith("draft two [REDACTED]"));
    assert.ok(failed.partialResult!.endsWith(PARTIAL_NOTE));
    assert.ok(!failed.partialResult!.includes(token));
    assert.match(taskCard(failed, true), /draft two/, "the operator sees it in the card");
    const ok = await core.wait(null, core.delegate(null, "codex", "ok", "ok").id);
    assert.equal(ok.result, "final"); assert.equal(ok.partialResult, undefined);
  } finally { await core.close(); }
});

test("at the soft deadline a steerable runtime is asked to conclude; the operator sees it as a host fact", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const steers: string[] = [];
  let finish!: (text: string) => void;
  const core = new Orchestrator({ cwd: process.cwd(), timeoutMs: 100_000, adapters: { codex: { capabilities: { ...capabilities, steer: true }, run: (ctx) => {
    ctx.registerControls?.({ steer: async (text) => { steers.push(text); } });
    return new Promise<string>((resolve) => { finish = resolve; });
  } } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const task = core.delegate(null, "codex", "long", "long");
    await Promise.resolve(); await Promise.resolve();
    t.mock.timers.tick(84_000);
    assert.deepEqual(steers, [], "not before 85%");
    t.mock.timers.tick(1_000);
    assert.deepEqual(steers, [WRAP_UP_TEXT]);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const view = core.status(null, task.id);
    assert.equal(taskDetail(view, [view]).text, "plazo casi agotado; se pidió cerrar");
    assert.equal(taskDetail(view, [view]).tone, "warning");
    finish("concluded");
    t.mock.timers.reset();
    assert.equal((await core.wait(null, task.id)).result, "concluded");
  } finally { t.mock.timers.reset(); await core.close(); }
});

test("the model gets a compact view and each result only once; listings carry no result text", async () => {
  let service: Service | undefined;
  const tools = new Map<string, any>();
  const fake = { registerMessageRenderer() {}, registerToolRenderer() {}, on() {}, appendEntry() {}, sendUserMessage() {}, registerCommand() {}, sendMessage() {},
    registerTool(tool: any) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  createOrchestratorExtension(async (options) => {
    service = await createService(options, { codex: { capabilities, run: async (ctx) => { ctx.usage?.({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }); return `answer for ${ctx.prompt}`; } } });
    return service;
  })(fake);
  const ctx = { cwd: process.cwd(), mode: "json", ui: {} } as unknown as ExtensionCommandContext;
  let calls = 0;
  const call = async (name: string, args: unknown) => {
    const result = await tools.get(name).execute(`call-${++calls}`, args, undefined, undefined, ctx);
    return { model: JSON.parse(result.content[0].text), details: result.details };
  };
  try {
    const a = (await call("orchestrator_delegate", { engine: "codex", prompt: "alpha" })).details as TaskView;
    const b = (await call("orchestrator_delegate", { engine: "codex", prompt: "beta" })).details as TaskView;
    const first = await call("orchestrator_wait", { taskIds: [a.id, b.id] });
    assert.deepEqual(first.model.map((task: any) => task.result), ["answer for alpha", "answer for beta"]);
    for (const key of ["attemptId", "runtimeProcess", "cwd", "modelState", "createdAt", "depth"]) assert.ok(!(key in first.model[0]), `${key} is not sent to the model`);
    assert.equal(first.model[0].tokens, 120);
    assert.equal(first.details[0].attemptId, a.attemptId, "the TUI keeps the full TaskView");
    const again = await call("orchestrator_wait", { taskIds: [a.id, b.id] });
    assert.deepEqual(again.model.map((task: any) => task.result), [DELIVERED_NOTE, DELIVERED_NOTE], "a re-poll does not resend results");
    assert.equal(again.details[0].result, "answer for alpha");
    const listing = await call("orchestrator_status", {});
    assert.deepEqual(listing.model.map((task: any) => task.result), [AVAILABLE_NOTE, AVAILABLE_NOTE]);
    const one = await call("orchestrator_status", { taskId: a.id });
    assert.equal(one.model.result, "answer for alpha", "an explicit status always returns the result");
  } finally { await service?.close(); }
});

test("per-engine defaults apply only when neither the environment nor the request chooses a model", async () => {
  const seen: (string | undefined)[] = [];
  const run = async (ctx: RuntimeContext) => { seen.push(ctx.task.selection?.model); return "ok"; };
  const core = new Orchestrator({ cwd: process.cwd(), ...productDefaults, adapters: { claude: { capabilities, run }, codex: { capabilities, run } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  const previous = process.env.PI_ORCHESTRATOR_CLAUDE_MODEL;
  try {
    await core.wait(null, core.delegate(null, "claude", "a", "a").id);
    await core.wait(null, core.delegate(null, "claude", "b", "b", undefined, { model: "opus" }).id);
    process.env.PI_ORCHESTRATOR_CLAUDE_MODEL = "haiku";
    await core.wait(null, core.delegate(null, "claude", "c", "c").id);
    await core.wait(null, core.delegate(null, "codex", "d", "d").id);
    assert.deepEqual(seen, ["sonnet", "opus", "haiku", undefined], "Codex keeps its own configured model");
  } finally {
    if (previous === undefined) delete process.env.PI_ORCHESTRATOR_CLAUDE_MODEL; else process.env.PI_ORCHESTRATOR_CLAUDE_MODEL = previous;
    await core.close();
  }
});

test("a transient failure of a read-only task is retried once, with usage summed; YOLO and parents of children are not", async () => {
  const attempts: Record<string, number> = {};
  let core!: Orchestrator;
  const run = async (ctx: RuntimeContext) => {
    attempts[ctx.prompt] = (attempts[ctx.prompt] ?? 0) + 1;
    ctx.usage?.({ inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, costUsd: 0.01 });
    if (ctx.prompt === "parent" && attempts.parent === 1) core.delegate(ctx.task.id, "codex", "child-ok", "c");
    if (ctx.prompt === "flaky" && (attempts.flaky ?? 0) > 1) return "recovered";
    if (ctx.prompt === "child-ok") return "child";
    throw new Error("Selected model is at capacity. Please try a different model.");
  };
  core = new Orchestrator({ cwd: process.cwd(), retryDelayMs: 10, maxConcurrent: 4, adapters: { codex: { capabilities, run } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const flaky = await core.wait(null, core.delegate(null, "codex", "flaky", "f").id);
    assert.equal(flaky.state, "completed"); assert.equal(flaky.result, "recovered"); assert.equal(attempts.flaky, 2);
    assert.deepEqual(flaky.usage, { inputTokens: 200, cachedInputTokens: 0, outputTokens: 20, costUsd: 0.02 }, "both attempts count");
    const always = await core.wait(null, core.delegate(null, "codex", "always", "a").id);
    assert.equal(always.state, "failed"); assert.equal(attempts.always, 2, "only one automatic retry");
    assert.equal(always.diagnostic?.category, "transient");
    const yolo = await core.wait(null, core.delegate(null, "codex", "yolo-flaky", "y", undefined, undefined, "yolo").id);
    assert.equal(yolo.state, "failed"); assert.equal(attempts["yolo-flaky"], 1, "side effects could repeat: no retry");
    const parent = await core.wait(null, core.delegate(null, "codex", "parent", "p").id);
    assert.equal(parent.state, "failed"); assert.equal(attempts.parent, 1, "children would be duplicated: no retry");
  } finally { await core.close(); }
});

test("a continuation counts only its own share of a resumed thread's cumulative usage", async () => {
  const run = async (ctx: RuntimeContext) => {
    ctx.session("thread-1");
    ctx.process?.({ pid: 1, exitedAt: new Date().toISOString() });
    // Codex reports thread-wide totals: the second turn includes the first.
    ctx.usage?.(ctx.resumeSessionId ? { inputTokens: 160, cachedInputTokens: 95, outputTokens: 14 } : { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10 });
    return ctx.resumeSessionId ? "continued" : "first";
  };
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: { capabilities: { ...capabilities, resume: true }, run } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const first = await core.wait(null, core.delegate(null, "codex", "read", "r").id);
    assert.equal(core.controls(null, first.id).resumeReady, true);
    const next = await core.wait(null, core.resume(null, first.id, "follow up", "f").id);
    assert.equal(next.result, "continued");
    assert.deepEqual(next.usage, { inputTokens: 60, cachedInputTokens: 55, outputTokens: 4 });
    const yolo = await core.wait(null, core.delegate(null, "codex", "w", "w", undefined, undefined, "yolo").id);
    assert.equal(core.controls(null, yolo.id).resumeReady, false, "YOLO sessions are never offered as continuable");
  } finally { await core.close(); }
});

test("spend guards refuse new work once reached, never kill running work, and are parsed strictly", async () => {
  assert.deepEqual(runtimeConfiguration({ PI_ORCHESTRATOR_MAX_TOKENS: "1000", PI_ORCHESTRATOR_MAX_COST_USD: "2.50" }), { maxTokens: 1000, maxCostUsd: 2.5 });
  for (const bad of [{ PI_ORCHESTRATOR_MAX_TOKENS: "1e3" }, { PI_ORCHESTRATOR_MAX_COST_USD: "-1" }, { PI_ORCHESTRATOR_MAX_COST_USD: "abc" }]) assert.throws(() => runtimeConfiguration(bad), /Invalid/);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async (ctx: RuntimeContext) => { ctx.usage?.({ inputTokens: 900, cachedInputTokens: 0, outputTokens: 200, costUsd: 0.6 }); if (ctx.prompt === "long") await gate; return "ok"; };
  const core = new Orchestrator({ cwd: process.cwd(), maxTokens: 1000, maxConcurrent: 4, adapters: { claude: { capabilities, run } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const long = core.delegate(null, "claude", "long", "l");
    while (!core.status(null, long.id).usage) await delay(1);
    assert.throws(() => core.delegate(null, "claude", "more", "m"), /Session token limit reached \(1100 ≥ 1000/);
    release();
    assert.equal((await core.wait(null, long.id)).state, "completed", "running work is never killed by the guard");
    assert.deepEqual(core.usage().spend, { tokens: 1100, costUsd: 0.6, costEngines: ["claude"], estimatedTokens: 0, estimatedEngines: [] });
  } finally { await core.close(); }
  const priced = new Orchestrator({ cwd: process.cwd(), maxCostUsd: 0.5, adapters: { claude: { capabilities, run } } });
  priced.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    await priced.wait(null, priced.delegate(null, "claude", "a", "a").id);
    assert.throws(() => priced.delegate(null, "claude", "b", "b"), /Session cost limit reached \(\$0\.60/);
  } finally { await priced.close(); }
});

test("internet access is operator-only, task-local and never inherited", async () => {
  let core!: Orchestrator;
  const seen: Record<string, boolean | undefined> = {};
  const run = async (ctx: RuntimeContext) => {
    seen[ctx.prompt] = ctx.task.web;
    if (ctx.prompt === "parent") {
      assert.throws(() => core.delegate(ctx.task.id, "claude", "child-web", "cw", undefined, undefined, undefined, undefined, true), /Only the operator may grant internet/);
      await core.wait(ctx.task.id, core.delegate(ctx.task.id, "claude", "child", "c").id, 10_000);
    }
    return "ok";
  };
  core = new Orchestrator({ cwd: process.cwd(), maxConcurrent: 4, adapters: { claude: { capabilities, run } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const parent = await core.wait(null, core.delegate(null, "claude", "parent", "p", undefined, undefined, undefined, undefined, true).id);
    assert.equal(parent.web, true);
    assert.deepEqual(seen, { parent: true, child: undefined }, "the child of a web task has no internet");
  } finally { await core.close(); }
});
