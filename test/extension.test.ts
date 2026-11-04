import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { RunStore } from "../src/journal.ts";
import { createOrchestratorExtension } from "../src/extension.ts";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

test("Pi loads the actual extension file, exposes tools, executes commands without a model, and shuts down", async () => {
  const previousOffline = process.env.PI_OFFLINE;
  const previousDirectory = process.env.PI_ORCHESTRATOR_STATE_DIR;
  process.env.PI_OFFLINE = "1";
  const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-extension-test-"));
  const stateDirectory = join(cwd, "state");
  process.env.PI_ORCHESTRATOR_STATE_DIR = stateDirectory;
  const store = new RunStore(stateDirectory);
  const settingsManager = SettingsManager.inMemory({
    packages: [],
    extensions: [],
    skills: [],
    prompts: [],
    themes: [],
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [resolve("src/extension.ts")],
  });
  let session:
    | Awaited<ReturnType<typeof createAgentSession>>["session"]
    | undefined;
  const errors: string[] = [];
  try {
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({
      cwd,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      noTools: "builtin",
    }));
    await session.bindExtensions({
      mode: "json",
      onError: (error) => {
        errors.push(error.error);
      },
    });
    assert.deepEqual(session.getActiveToolNames().sort(), [
      "orchestrator_cancel",
      "orchestrator_continue",
      "orchestrator_delegate",
      "orchestrator_engines",
      "orchestrator_status",
      "orchestrator_wait",
    ]);
    assert.equal(
      existsSync(stateDirectory),
      false,
      "loading/binding starts no service or persistence",
    );
    await session.prompt("/orch history");
    assert.equal(
      existsSync(stateDirectory),
      false,
      "history does not create a journal/service",
    );
    await session.prompt("/orch status");
    const firstRun = store.history().runs[0]!.runId;
    await session.prompt("/orch reset");
    assert.ok(store.read(firstRun).closedAt);
    await session.prompt("/orch status");
    await session.prompt("/orch history");
    await session.prompt(`/orch inspect ${firstRun.slice(0, 8)}`);
    await session.prompt(`/orch reconcile ${firstRun}`);
    assert.deepEqual(errors, []);
    const results = session.messages.filter(
      (message) =>
        message.role === "custom" && message.customType === "orchestrator",
    );
    assert.equal(results.length, 7);
    assert.equal(
      store.history().runs.length,
      2,
      "archive commands never start another coordinator",
    );
    assert.equal(
      session.messages.filter((message) => message.role === "assistant").length,
      0,
      "No Pi model request is necessary for commands",
    );
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "reload",
    });
    await session.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    assert.deepEqual(errors, []);
    assert.ok(
      store.history().runs.every((run) => run.disposition === "closed"),
    );
  } finally {
    await session?.extensionRunner.emit({
      type: "session_shutdown",
      reason: "quit",
    });
    session?.dispose();
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
    if (previousDirectory === undefined)
      delete process.env.PI_ORCHESTRATOR_STATE_DIR;
    else process.env.PI_ORCHESTRATOR_STATE_DIR = previousDirectory;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("default persistence is disabled and the history command/registration remain lazy", async () => {
  const previous = process.env.PI_ORCHESTRATOR_STATE_DIR;
  delete process.env.PI_ORCHESTRATOR_STATE_DIR;
  let starts = 0;
  let command!: (
    args: string,
    context: ExtensionCommandContext,
  ) => Promise<void>;
  const messages: unknown[] = [];
  const fake = {
    registerMessageRenderer() {},
    registerTool() {},
    on() {},
    registerCommand(_name: string, options: { handler: typeof command }) {
      command = options.handler;
    },
    sendMessage(message: unknown) {
      messages.push(message);
    },
  } as unknown as ExtensionAPI;
  try {
    createOrchestratorExtension(async () => {
      starts++;
      throw new Error("service must remain stopped");
    })(fake);
    assert.equal(starts, 0);
    await command("engines", {
      hasUI: false,
      cwd: process.cwd(),
    } as ExtensionCommandContext);
    assert.equal(starts, 0, "installation discovery is filesystem-only");
    await assert.rejects(
      command("restart unknown unknown --accept-duplicate-risk fresh prompt", {
        hasUI: false,
        cwd: process.cwd(),
      } as ExtensionCommandContext),
      /persistencia privada/,
    );
    await command("history", {
      hasUI: false,
      cwd: process.cwd(),
    } as ExtensionCommandContext);
    assert.equal(starts, 0);
    assert.match(JSON.stringify(messages), /Persistencia desactivada/);
  } finally {
    if (previous !== undefined)
      process.env.PI_ORCHESTRATOR_STATE_DIR = previous;
  }
});
