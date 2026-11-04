import test from "node:test";
import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type ServiceOptions } from "../src/service.ts";
import { capabilities } from "../src/types.ts";

// Pi UI contract fixture, not a native permission grant or a human visual review.
test("only the Pi TUI human dialog can approve; headless, decline, abort and shutdown fail closed", async () => {
  let command!: (
    args: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  let shutdown!: () => Promise<void>;
  let options!: ServiceOptions;
  let approved = false,
    selects = 0;
  const fake = {
    registerTool() {},
    registerMessageRenderer() {},
    sendMessage() {},
    appendEntry() {},
    registerCommand(_name: string, value: { handler: typeof command }) {
      command = value.handler;
    },
    on(name: string, callback: typeof shutdown) {
      if (name === "session_shutdown") shutdown = callback;
    },
  } as unknown as ExtensionAPI;
  createOrchestratorExtension(async (input) => {
    options = input;
    return await createService(input, {
      codex: { capabilities, run: async () => "fixture" },
    });
  })(fake);
  const ui = {
    setStatus() {},
    setWidget() {},
    confirm: async () => approved,
    select: async (_title: string, labels: string[]) => {
      selects++;
      return labels[0];
    },
  };
  const ctx = {
    cwd: process.cwd(),
    mode: "json",
    ui,
  } as unknown as ExtensionCommandContext;
  const request = {
    id: "dialog",
    taskId: "task-123",
    engine: "antigravity",
    kind: "permission" as const,
    title: "fixture operation",
    detail: "operation details",
    options: [{ id: "once", label: "Allow once" }],
  };
  try {
    await command("status", ctx);
    assert.equal(
      await options.onInteraction!(request, new AbortController().signal),
      undefined,
    );
    await command("status", { ...ctx, mode: "tui" });
    assert.equal(
      await options.onInteraction!(request, new AbortController().signal),
      undefined,
    );
    approved = true;
    assert.deepEqual(
      await options.onInteraction!(request, new AbortController().signal),
      { optionId: "once" },
    );
    assert.equal(
      selects,
      0,
      "a one-time permission still needs explicit confirm, not a model tool",
    );
    assert.deepEqual(
      await options.onInteraction!(
        { ...request, kind: "question" },
        new AbortController().signal,
      ),
      { optionId: "once" },
    );
    assert.equal(selects, 1);
    const controller = new AbortController();
    controller.abort();
    assert.equal(
      await options.onInteraction!(request, controller.signal),
      undefined,
    );
    await shutdown();
    assert.equal(
      await options.onInteraction!(request, new AbortController().signal),
      undefined,
    );
  } finally {
    await shutdown();
  }
});
