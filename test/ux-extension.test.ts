import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type Service } from "../src/service.ts";
import { capabilities } from "../src/types.ts";

test("human-facing task cards hide JSON and technical IDs while machine-facing tool contracts remain intact", async () => {
  const tools = new Map<string, any>();
  const messages: any[] = [];
  let resolver: any, renderer: any, shutdown: any;
  let service: Service | undefined;
  const fake = {
    registerTool(tool: any) { tools.set(tool.name, tool); }, registerCommand() {}, appendEntry() {},
    registerToolRenderer(value: any) { resolver = value; }, registerMessageRenderer(_name: string, value: any) { renderer = value; },
    sendMessage(value: any) { messages.push(value); },
    on(name: string, value: any) { if (name === "session_shutdown") shutdown = value; },
  } as unknown as ExtensionAPI;
  createOrchestratorExtension(async (input) => {
    service = await createService(input, { codex: { capabilities, run: async () => "Résultat 界\x1b]52;c;secret\x07" } }); return service;
  })(fake);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  try {
    const delegated = await tools.get("orchestrator_delegate").execute("card-test", { engine: "codex", prompt: "Explore architecture" }, undefined, undefined, { cwd: process.cwd(), mode: "rpc", ui: { setStatus() {}, setWidget() {} } });
    const data = JSON.parse(delegated.content[0].text);
    assert.equal(data.id, delegated.details.id, "machine-facing JSON remains unchanged");
    assert.match(data.next, /termina tu turno/, "a long-lived host tells the model not to block");
    await service!.core.wait(null, data.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    // A model-delegated task is announced once per batch, never as a per-task notice.
    assert.equal(messages.filter((entry) => entry.details?.type === "root-result").length, 0);
    const root = messages.find((entry) => Array.isArray(entry.details?.batch));
    assert.ok(root); assert.ok(!root.content.startsWith("{"));
    assert.ok(!root.content.includes("secret"), "the batch content is sanitized");
    const card = renderer(root, { expanded: false }, theme).render(100).join("\n");
    assert.match(card, /completada/); assert.match(card, /Résultat/);
    assert.ok(!card.includes("attemptId")); assert.ok(!card.includes("secret"));
    assert.ok(!card.includes(root.details.batch[0].attemptId));
    const resolved = resolver("orchestrator_wait", () => undefined);
    const renderedTool = resolved.renderResult({ details: root.details.batch[0], content: delegated.content }, { expanded: false }).render(100).join("\n");
    assert.match(renderedTool, /completada/);
    assert.equal(resolver("unrelated_tool", () => "untouched"), "untouched");
  } finally { await shutdown?.(); }
});
