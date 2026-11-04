import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService } from "../src/service.ts";
import type { BridgeAudit } from "../src/mcp-bridge.ts";
import type { TaskView } from "../src/types.ts";

// Opt-in: consumes real runtime quota. No shell access is granted to Claude.
const engine = process.argv[2] ?? "claude";
if (!["claude", "codex", "antigravity"].includes(engine))
  throw new Error("Usage: npm run smoke:cancel -- PARENT [CHILD]");
if (process.platform === "win32")
  throw new Error("This process-group verification requires POSIX ps");
const childEngine =
  process.argv[3] ??
  (engine === "claude"
    ? "codex"
    : engine === "antigravity"
      ? "codex"
      : "claude");
if (
  !["claude", "codex", "antigravity"].includes(childEngine) ||
  childEngine === engine
)
  throw new Error("Expected a different supported child engine");
process.umask(0o077);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-live-cancel-"));
const source = Array.from(
  { length: 200 },
  (_, i) => `measurement_${i}: ${i * 17 + 19}`,
).join("\n");
await writeFile(join(cwd, "challenge.txt"), source);
const settingsManager = SettingsManager.inMemory({
  packages: [],
  extensions: [],
  skills: [],
  prompts: [],
  themes: [],
});
const bridgeAudit: BridgeAudit[] = [];
const shutdownEvents: { type: string; task: TaskView; detail?: string }[] = [];
const extension = createOrchestratorExtension((options) =>
  createService({
    ...options,
    onBridgeAudit: (event) => {
      if (bridgeAudit.length < 200) bridgeAudit.push(event);
    },
    onEvent: (event) => {
      shutdownEvents.push(event);
      options.onEvent?.(event);
    },
  }),
);
const loader = new DefaultResourceLoader({
  cwd,
  agentDir: getAgentDir(),
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [extension],
});
let session:
  | Awaited<ReturnType<typeof createAgentSession>>["session"]
  | undefined;
const errors: string[] = [];
const events = () =>
  session?.sessionManager
    .getBranch()
    .filter(
      (entry) =>
        entry.type === "custom" && entry.customType === "orchestrator-event",
    )
    .map(
      (entry) =>
        (entry as { data: { type: string; task: TaskView; detail?: string } })
          .data,
    ) ?? [];
const tasks = () => [
  ...new Map(events().map((event) => [event.task.id, event.task])).values(),
];
const ownedProcesses = (groupIds: Set<number>) =>
  execFileSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,comm="], {
    encoding: "utf8",
  })
    .split("\n")
    .flatMap((row) => {
      const [pid, ppid, pgid, state, ...command] = row.trim().split(/\s+/);
      return groupIds.has(Number(pgid))
        ? [
            {
              pid: Number(pid),
              ppid: Number(ppid),
              pgid: Number(pgid),
              state: state!,
              command: command.join(" "),
            },
          ]
        : [];
    });
let before: ReturnType<typeof ownedProcesses> = [],
  after: typeof before = [];
let failure: unknown;
const startedAt = new Date().toISOString();
let cancellationRequestedAt: string | undefined;
try {
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd,
    settingsManager,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "builtin",
  }));
  await session.bindExtensions({
    mode: "json",
    onError: (error) => {
      errors.push(error.error);
    },
  });
  console.log(
    `Live cancellation: Pi → ${engine} → ${childEngine}; waiting until the child starts a native tool operation.`,
  );
  await session.prompt(
    `/orch start ${engine} You MUST delegate exactly one task to ${childEngine} via the pi_orchestrator MCP delegate tool with requestKey 'cancel-proof': read challenge.txt with your read-only tools, check its numerical progression, and provide 20 concise independent observations. The child must not delegate further. You must not read the file yourself. Do not use native subagents, shell, planning tools or other tools: use only pi_orchestrator delegate, status and wait. Wait for the child result via MCP wait. This is an operator cancellation test; stop honestly if cancelled.`,
  );
  const deadline = Date.now() + 160_000;
  let parent: TaskView | undefined, child: TaskView | undefined;
  while (Date.now() < deadline) {
    const current = tasks();
    parent = current.find((task) => task.parentId === null);
    child = current.find((task) => task.parentId === parent?.id);
    if (current.some((task) => task.state !== "running"))
      throw new Error(
        "A task ended before cancellation could be exercised; inspect the private report",
      );
    if (
      parent?.runtimeProcess &&
      child?.runtimeProcess &&
      child.runtimeSessionId &&
      /(?:commandExecution|claude: Read|antigravity: tool activity)/.test(
        child.lastActivity ?? "",
      )
    )
      break;
    await delay(10);
  }
  assert.ok(
    parent?.runtimeProcess && child?.runtimeProcess && child.runtimeSessionId,
    "Both native sessions must be live",
  );
  assert.match(
    child.lastActivity ?? "",
    /(?:commandExecution|claude: Read|antigravity: tool activity)/,
    "The child must have started a native tool operation, not just its CLI (commandExecution alone does not prove a file was read)",
  );
  const groups = new Set([
    parent.runtimeProcess.groupId!,
    child.runtimeProcess.groupId!,
  ]);
  before = ownedProcesses(groups);
  for (const task of [parent, child])
    assert.ok(
      before.some(
        (process) =>
          process.pid === task.runtimeProcess!.pid &&
          !process.state.startsWith("Z"),
      ),
      "Owned runtime leader must be executing before cancellation",
    );
  cancellationRequestedAt = new Date().toISOString();
  await session.prompt(`/orch cancel ${parent.id}`);
  const settled = tasks();
  assert.equal(settled.length, 2);
  for (const task of settled) {
    assert.equal(task.state, "cancelled");
    assert.equal(
      task.result,
      undefined,
      "No late success may overwrite cancellation",
    );
    assert.ok(
      task.runtimeProcess?.exitedAt,
      "Native CLI exit must actually be observed",
    );
    const history = events().filter((event) => event.task.id === task.id);
    assert.ok(history.some((event) => event.type === "cancelling"));
    assert.ok(
      history.findIndex((event) => event.type === "process-exited") <
        history.findIndex((event) => event.type === "settled"),
    );
  }
  for (let i = 0; i < 80; i++) {
    after = ownedProcesses(groups);
    if (!after.some((process) => !process.state.startsWith("Z"))) break;
    await delay(25);
  }
  assert.deepEqual(
    after.filter((process) => !process.state.startsWith("Z")),
    [],
    "No executing process may remain in either owned group",
  );
  await session.prompt(`/orch cancel ${parent.id}`); // Idempotent stop; no new runtime.
  assert.deepEqual(errors, []);
  assert.equal(await readFile(join(cwd, "challenge.txt"), "utf8"), source);
  assert.deepEqual(await readdir(cwd), ["challenge.txt"]);
  console.log(
    "PASS: both tasks cancelled; native exits observed; neither owned process group has live members; fixture unchanged.",
  );
} catch (error) {
  failure = error;
} finally {
  await session?.extensionRunner.emit({
    type: "session_shutdown",
    reason: "quit",
  });
  const report = {
    startedAt,
    endedAt: new Date().toISOString(),
    cancellationRequestedAt,
    engine,
    childEngine,
    before,
    after,
    tasks: [
      ...new Map(
        shutdownEvents.map((event) => [event.task.id, event.task]),
      ).values(),
    ],
    events: shutdownEvents,
    bridgeAudit,
    errors,
    failure: failure ? String(failure) : undefined,
  };
  await mkdir(join(root, "artifacts"), { recursive: true });
  const path = join(
    root,
    "artifacts",
    `live-cancel-${engine}-${Date.now()}.json`,
  );
  await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Evidence: ${path}`);
  session?.dispose();
  await rm(cwd, { recursive: true, force: true });
}
if (failure) {
  console.error(
    "FAIL: native cancellation not confirmed; private evidence retained.",
  );
  process.exitCode = 1;
}
