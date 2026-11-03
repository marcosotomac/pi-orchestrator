import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type Service } from "../src/service.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { runtimeConfiguration } from "../src/configuration.ts";
import { defaultEffort } from "../src/adapters/codex.ts";
import { claudeLimit } from "../src/adapters/claude.ts";
import { capabilities, type TaskView } from "../src/types.ts";

test("limits are configurable, fail closed, and defaults no longer kill normal tasks", () => {
  assert.equal(runtimeConfiguration({ PI_ORCHESTRATOR_TASK_TIMEOUT_MS: "1200000" }).timeoutMs, 1_200_000);
  assert.throws(() => runtimeConfiguration({ PI_ORCHESTRATOR_TASK_TIMEOUT_MS: "15m" }), /Invalid orchestrator setting/);
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: { capabilities, run: async () => "x" } } });
  assert.equal(core.limits.timeoutMs, 900_000);
  assert.equal(core.limits.maxTasks, 32);
  assert.equal(defaultEffort({}), "medium");
  assert.equal(defaultEffort({ PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING: "low" }), "low");
  assert.throws(() => defaultEffort({ PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING: "x high" }), /Invalid/);
  assert.equal(claudeLimit("T", 40, 1, 500, {}), 40);
  assert.equal(claudeLimit("T", 40, 1, 500, { T: "80" }), 80);
  for (const bad of ["0", "501", "-1", "1.5", "many"]) assert.throws(() => claudeLimit("T", 40, 1, 500, { T: bad }), /Invalid T/);
});

test("the host and Codex/Claude workers may wait long; Antigravity callers keep the short window", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async () => { await gate; return "done"; };
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: { capabilities, run }, antigravity: { capabilities, run } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const agy = core.delegate(null, "antigravity", "agy root", "agy");
    assert.equal((await core.wait(null, root.id, 1)).state, "running");
    await assert.rejects(core.wait(null, root.id, 600_001), /1–600000/);
    // Every MCP poll costs the worker a model turn: Codex/Claude clients allow 660 s.
    await assert.rejects(core.wait(root.id, root.id, 600_001), /1–600000 ms/);
    assert.deepEqual(core.waitWindow(root.id), { defaultMs: 300_000, maxMs: 600_000 });
    await assert.rejects(core.wait(agy.id, agy.id, 60_001), /1–60000 ms/);
    assert.deepEqual(core.waitWindow(agy.id), { defaultMs: 30_000, maxMs: 60_000 });
    const waiting = core.wait(null, root.id, 600_000);
    release();
    assert.equal((await waiting).state, "completed");
  } finally { await core.close(); }
});

test("orchestrator_wait settles several tasks in one call; a blocking host sends no per-task notices", async () => {
  let service: Service | undefined;
  const tools = new Map<string, any>();
  const sent: { content: unknown; details: any }[] = [];
  const fake = { registerMessageRenderer() {}, on() {}, appendEntry() {}, sendUserMessage() {}, registerCommand() {},
    sendMessage(message: { content: unknown; details: unknown }) { sent.push(message as never); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  createOrchestratorExtension(async (options) => {
    service = await createService(options, { codex: { capabilities, run: async (ctx) => `answer for ${ctx.prompt}` }, claude: { capabilities, run: async (ctx) => `answer for ${ctx.prompt}` } });
    return service;
  })(fake);
  const ctx = { cwd: process.cwd(), mode: "json", ui: {} } as unknown as ExtensionCommandContext;
  try {
    const delegated = await tools.get("orchestrator_delegate").execute("a", { engine: "codex", prompt: "alpha" }, undefined, undefined, ctx);
    assert.match(JSON.parse(delegated.content[0].text).next, /orchestrator_wait/, "a print/JSON run must wait: nothing would wake it");
    const a = delegated.details as TaskView;
    const b = (await tools.get("orchestrator_delegate").execute("b", { engine: "claude", prompt: "beta" }, undefined, undefined, ctx)).details as TaskView;
    const both = (await tools.get("orchestrator_wait").execute("w", { taskIds: [a.id, b.id] }, undefined, undefined, ctx)).details as TaskView[];
    assert.deepEqual(both.map((task) => [task.state, task.result]), [["completed", "answer for alpha"], ["completed", "answer for beta"]]);
    const single = (await tools.get("orchestrator_wait").execute("w1", { taskId: a.id }, undefined, undefined, ctx)).details as TaskView;
    assert.equal(single.id, a.id, "a single taskId keeps returning one task, not an array");
    await assert.rejects(tools.get("orchestrator_wait").execute("w0", {}, undefined, undefined, ctx), /taskId or taskIds/);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // Measured before this change: each notice cost the model a turn of "already included".
    assert.equal(sent.filter((message) => message.details?.type === "root-result" || message.details?.batch).length, 0);
  } finally { await service?.close(); }
});

test("a long-lived host wakes the model once per batch with the undelivered results; waited results are not repeated", async () => {
  let service: Service | undefined;
  const tools = new Map<string, any>();
  const sent: { message: any; options: any }[] = [];
  const gates = new Map<string, () => void>();
  const fake = { registerMessageRenderer() {}, on() {}, appendEntry() {}, sendUserMessage() {}, registerCommand() {},
    sendMessage(message: any, options: any) { sent.push({ message, options }); },
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  createOrchestratorExtension(async (options) => {
    service = await createService(options, { codex: { capabilities, run: async (ctx) => { await new Promise<void>((resolve) => gates.set(ctx.prompt, resolve)); return `answer for ${ctx.prompt}`; } } });
    return service;
  })(fake);
  const ctx = { cwd: process.cwd(), mode: "rpc", ui: {} } as unknown as ExtensionCommandContext;
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 400)); };
  try {
    const first = await tools.get("orchestrator_delegate").execute("a", { engine: "codex", prompt: "alpha" }, undefined, undefined, ctx);
    assert.match(JSON.parse(first.content[0].text).next, /termina tu turno/);
    const a = first.details as TaskView;
    const b = (await tools.get("orchestrator_delegate").execute("b", { engine: "codex", prompt: "beta" }, undefined, undefined, ctx)).details as TaskView;
    while (gates.size < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    gates.get("alpha")!(); await service!.core.wait(null, a.id); await settle();
    assert.equal(sent.length, 0, "no wake-up while the batch still has live work");
    gates.get("beta")!(); await service!.core.wait(null, b.id); await settle();
    assert.equal(sent.length, 1, "exactly one message for the whole batch");
    assert.deepEqual(sent[0]!.options, { triggerTurn: true, deliverAs: "followUp" });
    assert.match(sent[0]!.message.content, /answer for alpha/); assert.match(sent[0]!.message.content, /answer for beta/);
    assert.deepEqual(sent[0]!.message.details.batch.map((task: TaskView) => task.id), [a.id, b.id]);
    const again = JSON.parse((await tools.get("orchestrator_wait").execute("w", { taskIds: [a.id, b.id] }, undefined, undefined, ctx)).content[0].text);
    assert.ok(again.every((task: any) => /ya entregado/.test(task.result)), "the batch message counts as delivery");

    // A result the model is already blocking on is delivered by that wait, not by a wake-up.
    const c = (await tools.get("orchestrator_delegate").execute("c", { engine: "codex", prompt: "gamma" }, undefined, undefined, ctx)).details as TaskView;
    while (!gates.has("gamma")) await new Promise((resolve) => setTimeout(resolve, 5));
    const waited = tools.get("orchestrator_wait").execute("wc", { taskId: c.id }, undefined, undefined, ctx);
    await new Promise((resolve) => setTimeout(resolve, 20));
    gates.get("gamma")!();
    assert.equal(JSON.parse((await waited).content[0].text).result, "answer for gamma");
    await settle();
    assert.equal(sent.length, 1, "no second message for a waited task");
  } finally { await service?.close(); }
});
