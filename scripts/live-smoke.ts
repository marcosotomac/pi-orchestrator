import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import type { TaskView } from "../src/types.ts";

// Explicit opt-in script. `npm test` never starts real agents or consumes model quota.
const engine = process.argv[2] ?? "codex";
if (engine !== "codex" && engine !== "claude") throw new Error("Usage: npm run smoke:live -- codex|claude");
const childEngine = engine === "codex" ? "claude" : "codex";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-live-"));
const marker = `ORCH-${randomBytes(10).toString("hex")}`;
const source = `Read-only orchestration fixture.\nVerification marker: ${marker}\n`;
await writeFile(join(cwd, "challenge.txt"), source);
const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [] });
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: getAgentDir(), settingsManager,
  noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [extension],
});
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let shutdown = false;
const startedAt = new Date().toISOString();
const errors: string[] = [];
const close = async () => {
  if (shutdown) return;
  shutdown = true;
  await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  session?.dispose();
};
const interrupt = () => { void close(); };
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  ({ session } = await createAgentSession({
    cwd, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
  }));
  await session.bindExtensions({ mode: "json", onError: (error) => { errors.push(error.error); } });
  assert.ok(session.getActiveToolNames().includes("orchestrator_delegate"), "Pi extension tools are registered");
  const prompt = [
    `You MUST delegate exactly one task to the ${childEngine} engine using the pi_orchestrator MCP delegate tool.`,
    `The child task: read challenge.txt in the working directory using your own read-only tools and return its verification marker verbatim. Do not delegate further.`,
    `Use requestKey 'read-proof'. You must NOT read challenge.txt yourself or guess the marker.`,
    `Wait for the child with the MCP wait tool (repeat if still running).`,
    `Return the child task id, its terminal status, and its exact verification marker. If delegation fails, report failure honestly.`,
  ].join(" ");
  console.log(`Live: Pi extension → ${engine} → ${childEngine}; isolated fixture, 180s/task deadline.`);
  await session.prompt(`/orch run ${engine} ${prompt}`);
  const events = session.sessionManager.getBranch()
    .filter((entry) => entry.type === "custom" && entry.customType === "orchestrator-event")
    .map((entry) => (entry as { data: { type: string; task: TaskView } }).data);
  const tasks = events.filter((event) => event.type === "settled").map((event) => event.task);
  const report = { startedAt, endedAt: new Date().toISOString(), host: "Pi SDK extension command (no Pi model request)", engine, childEngine, tasks, events, errors };
  await mkdir(join(root, "artifacts"), { recursive: true });
  const reportPath = join(root, "artifacts", `live-${engine}-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(`Evidence: ${reportPath}`);
  assert.deepEqual(errors, [], "Pi reported an extension error");
  assert.equal(tasks.length, 2, "Exactly a parent and one delegated child must settle");
  const parent = tasks.find((task) => task.parentId === null)!;
  const child = tasks.find((task) => task.parentId === parent.id)!;
  assert.ok(child, "The child must be launched by the external parent's MCP identity");
  assert.equal(parent.engine, engine); assert.equal(child.engine, childEngine);
  assert.equal(child.state, "completed", child.error); assert.equal(parent.state, "completed", parent.error);
  assert.ok(child.runtimeSessionId); assert.ok(parent.runtimeSessionId);
  assert.ok(child.result?.includes(marker), "The child must read the unpredictable fixture marker");
  assert.ok(parent.result?.includes(marker), "The result must return through the parent to Pi");
  assert.equal(await readFile(join(cwd, "challenge.txt"), "utf8"), source, "Fixture must stay unchanged");
  assert.deepEqual(await readdir(cwd), ["challenge.txt"], "Workers must not create workspace files");
  console.log(`PASS: ${engine}(${parent.runtimeSessionId}) → ${childEngine}(${child.runtimeSessionId}) → Pi. Marker verified; workspace unchanged.`);
} finally {
  await close();
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  await rm(cwd, { recursive: true, force: true });
}
