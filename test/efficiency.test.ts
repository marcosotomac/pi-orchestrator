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

test("orchestrator_wait settles several tasks in one call, and settled notices do not repeat tool results to the model", async () => {
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
    const a = (await tools.get("orchestrator_delegate").execute("a", { engine: "codex", prompt: "alpha" }, undefined, undefined, ctx)).details as TaskView;
    const b = (await tools.get("orchestrator_delegate").execute("b", { engine: "claude", prompt: "beta" }, undefined, undefined, ctx)).details as TaskView;
    const both = (await tools.get("orchestrator_wait").execute("w", { taskIds: [a.id, b.id] }, undefined, undefined, ctx)).details as TaskView[];
    assert.deepEqual(both.map((task) => [task.state, task.result]), [["completed", "answer for alpha"], ["completed", "answer for beta"]]);
    const single = (await tools.get("orchestrator_wait").execute("w1", { taskId: a.id }, undefined, undefined, ctx)).details as TaskView;
    assert.equal(single.id, a.id, "a single taskId keeps returning one task, not an array");
    await assert.rejects(tools.get("orchestrator_wait").execute("w0", {}, undefined, undefined, ctx), /taskId or taskIds/);
    const notices = sent.filter((message) => message.details?.type === "root-result");
    assert.equal(notices.length, 2);
    for (const notice of notices) {
      assert.equal(typeof notice.content, "string");
      assert.ok(!String(notice.content).includes("answer for"), "the model already gets the result from orchestrator_wait");
      assert.match(String(notice.content), /no se repite/);
      assert.match(notice.details.task.result, /answer for/, "the human-facing card still carries the full result");
    }
  } finally { await service?.close(); }
});
