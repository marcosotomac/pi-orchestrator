import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService } from "../src/service.ts";
import { RunJournal, RunStore } from "../src/journal.ts";
import { capabilities } from "../src/types.ts";

test("restart command requires fresh instructions and explicit risk acceptance; declining TUI confirmation starts nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "orch-restart-command-"));
  const cwd = realpathSync(process.cwd());
  const previous = process.env.PI_ORCHESTRATOR_STATE_DIR;
  process.env.PI_ORCHESTRATOR_STATE_DIR = directory;
  const journal = new RunJournal(new RunStore(directory), cwd);
  const taskId = randomUUID();
  journal.checkpoint([{ id: taskId, attemptId: randomUUID(), parentId: null, engine: "codex", cwd, depth: 1, title: "old intent", state: "running", createdAt: new Date().toISOString() }]);
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let service: Awaited<ReturnType<typeof createService>> | undefined;
  let starts = 0;
  const pi = { registerTool() {}, registerMessageRenderer() {}, on() {}, appendEntry() {}, sendMessage() {}, registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; } } as unknown as ExtensionAPI;
  try {
    createOrchestratorExtension(async (options) => {
      starts++;
      const run = async () => "fixture restarted";
      service = await createService(options, { codex: { capabilities, run } });
      return service;
    })(pi);
    const args = `restart ${journal.runId} ${taskId}`;
    const ctx = { cwd, mode: "json", ui: {} } as ExtensionCommandContext;
    await assert.rejects(command(`${args} instructions`, ctx), /accept-duplicate-risk/);
    await assert.rejects(command(`${args} --accept-duplicate-risk`, ctx), /instrucción nueva/);
    assert.equal(starts, 0);
    await command(`${args} --accept-duplicate-risk new instructions`, { ...ctx, mode: "tui", ui: { confirm: async () => false } } as unknown as ExtensionCommandContext);
    assert.equal(starts, 0);
    await command(`${args} --accept-duplicate-risk new instructions`, ctx);
    assert.equal(starts, 1);
    const task = service!.core.list()[0]!;
    assert.equal((await service!.core.wait(null, task.id)).state, "completed");
    assert.equal(task.recoverySource?.runId, journal.runId);
    await assert.rejects(command(`restart ${service!.journal!.runId} ${task.id} --accept-duplicate-risk new instructions`, ctx), /solo acepta runs históricos/);
    assert.equal(service!.core.list().length, 1);
  } finally {
    await service?.close();
    if (previous === undefined) delete process.env.PI_ORCHESTRATOR_STATE_DIR; else process.env.PI_ORCHESTRATOR_STATE_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
