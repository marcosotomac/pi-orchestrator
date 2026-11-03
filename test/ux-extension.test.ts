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
    const delegated = await tools.get("orchestrator_delegate").execute("card-test", { engine: "codex", prompt: "Explore architecture" }, undefined, undefined, { cwd: process.cwd(), mode: "json", ui: { setStatus() {}, setWidget() {} } });
    const data = JSON.parse(delegated.content[0].text);
    assert.equal(data.id, delegated.details.id, "machine-facing JSON remains unchanged");
    await service!.core.wait(null, data.id);
    const root = messages.find((entry) => entry.details?.type === "root-result");
    assert.ok(root); assert.ok(!root.content.startsWith("{"));
    const card = renderer(root, { expanded: false }, theme).render(100).join("\n");
    assert.match(card, /completada/); assert.match(card, /Résultat/);
    assert.ok(!card.includes("attemptId")); assert.ok(!card.includes("secret"));
    assert.ok(!card.includes(root.details.task.attemptId));
    const resolved = resolver("orchestrator_wait", () => undefined);
    const renderedTool = resolved.renderResult({ details: root.details.task, content: delegated.content }, { expanded: false }).render(100).join("\n");
    assert.match(renderedTool, /completada/);
    assert.equal(resolver("unrelated_tool", () => "untouched"), "untouched");
  } finally { await shutdown?.(); }
});
