import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type Service } from "../src/service.ts";
import { capabilities, type TaskView } from "../src/types.ts";

test("/orch natural instructions queue a Pi turn without fixed settings, selectors or eager runtime launches; tool choices stay per-task", async () => {
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let service: Service | undefined;
  let delegate: any;
  const requests: { text: string; options: unknown }[] = [];
  const fake = { registerMessageRenderer() {}, sendMessage() {}, on() {},
    sendUserMessage(text: string, options: unknown) { requests.push({ text, options }); },
    registerCommand(_name: string, definition: { handler: typeof command }) { command = definition.handler; },
    registerTool(tool: any) { if (tool.name === "orchestrator_delegate") delegate = tool; },
  } as unknown as ExtensionAPI;
  createOrchestratorExtension(async (options) => {
    service = await createService(options, Object.fromEntries(["antigravity", "codex", "claude"].map((engine) => [engine, { capabilities, run: async () => "fixture" }]))); return service;
  })(fake);
  const ctx = { cwd: process.cwd(), mode: "json", ui: { select: () => { throw new Error("must not open picker"); } } } as unknown as ExtensionCommandContext;
  try {
    for (const instruction of ["delega agy 3.8 flash high para explorar el repo", "usa Claude sonnet high para revisar", "openai high para explicar", ", delega antigravity", "manda a agy en yolo", "delega a agy, no me pidas permisos", "usa Claude y ejecuta sin solicitar mi aprobación"]) {
      await command(instruction, ctx);
      assert.ok(requests.at(-1)?.text.endsWith(instruction));
      assert.match(requests.at(-1)!.text, /orchestrator_delegate/);
      assert.deepEqual(requests.at(-1)!.options, { deliverAs: "followUp" });
    }
    await command("help", ctx);
    assert.equal(service, undefined, "interpretation is a Pi turn, not an eager runtime launch");
    await assert.rejects(command("x".repeat(32_001), ctx), /32000/);
    assert.equal(requests.length, 7);
    assert.match(delegate.description, /semantically, not by keyword/);
    // YOLO is only a proposal from the model: without a human TUI confirmation nothing starts.
    const live = () => (service as Service | undefined)?.core.list().length ?? 0;
    const before = live();
    await assert.rejects(delegate.execute("yolo-headless", { engine: "antigravity", prompt: "fixture", permissionMode: "yolo" }, undefined, undefined, ctx), /human confirmation/);
    const prompts: string[] = [];
    const tui = (answer: boolean) => ({ ...ctx, mode: "tui", hasUI: true, ui: { ...ctx.ui, confirm: async (_title: string, body: string) => { prompts.push(body); return answer; } } }) as unknown as ExtensionCommandContext;
    await assert.rejects(delegate.execute("yolo-declined", { engine: "antigravity", prompt: "fixture", permissionMode: "yolo" }, undefined, undefined, tui(false)), /did not confirm YOLO/);
    assert.equal(live(), before, "a declined or headless YOLO request must not start a task");
    assert.match(prompts.at(-1)!, /SIN pedir aprobación/);
    for (const [engine, model] of [["antigravity", "gemini-3.8-flash"], ["codex", "chosen"], ["claude", "sonnet"]]) {
      await delegate.execute(`tool-${engine}`, { engine, prompt: "fixture", model, thinking: "high", ...(engine === "antigravity" ? { permissionMode: "yolo" } : {}) }, undefined, undefined, engine === "antigravity" ? tui(true) : ctx);
      const task: TaskView = service!.core.list().at(-1)!;
      assert.deepEqual(task.selection, { model, thinking: "high" });
      assert.equal(task.permissionMode, engine === "antigravity" ? "yolo" : "restricted");
      await service!.core.wait(null, task.id);
    }
    await delegate.execute("no-fixed", { engine: "antigravity", prompt: "fixture" }, undefined, undefined, ctx);
    assert.equal(service!.core.list().at(-1)!.permissionMode, "restricted");
    assert.deepEqual(service!.core.list().at(-1)!.selection, {}, "previous task choices must not leak into later tasks");
  } finally { await service?.close(); }
});
