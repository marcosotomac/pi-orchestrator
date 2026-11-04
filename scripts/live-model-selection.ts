// Explicit opt-in: consumes native runtime quota. No agent is started by npm test.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createService } from "../src/service.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { ClaudeAdapter } from "../src/adapters/claude.ts";

const [engine, model, thinking] = process.argv.slice(2);
if ((engine !== "codex" && engine !== "claude") || !model || !thinking)
  throw new Error(
    "Usage: tsx scripts/live-model-selection.ts codex|claude MODEL_OR_DASH THINKING",
  );
const root = resolve(import.meta.dirname, "..");
const cwd = await mkdtemp(join(tmpdir(), "orch-model-selection-"));
const evidence = await mkdtemp(
  join(root, "artifacts", `native-model-${engine}-`),
);
const source = `Verification marker: ${randomUUID()}\n`;
await writeFile(join(cwd, "challenge.txt"), source, { mode: 0o600 });
const service = await createService(
  { cwd },
  {
    codex: new CodexAdapter("/opt/homebrew/bin/codex"),
    claude: new ClaudeAdapter("/opt/homebrew/bin/claude"),
  },
);
let passed = false;
try {
  let task = service.core.delegate(
    null,
    engine,
    "Read challenge.txt using native read-only tools. Return its verification marker, and nothing else. Do not modify files or delegate.",
    "model-selection",
    undefined,
    { ...(model !== "-" ? { model } : {}), thinking },
  );
  while (task.state === "queued" || task.state === "running")
    task = await service.core.wait(null, task.id, 30_000);
  assert.equal(task.state, "completed", task.error);
  assert.ok(task.result?.includes(source.trim().split(": ")[1]!));
  assert.equal(await readFile(join(cwd, "challenge.txt"), "utf8"), source);
  assert.deepEqual(await readdir(cwd), ["challenge.txt"]);
  assert.ok(task.runtimeProcess?.exitedAt);
  passed = true;
} finally {
  await service.close();
  await mkdir(evidence, { recursive: true });
  await writeFile(
    join(evidence, "report.json"),
    JSON.stringify(
      {
        passed,
        scope:
          "Native read with per-task model/effort flags. Claude effort is passed to CLI, not independently echoed as confirmed by its protocol. Not a natural-language interpretation test.",
        tasks: service.core.list(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  await rm(cwd, { recursive: true, force: true });
  console.log(
    `${passed ? "PASS" : "FAIL"}: private report ${join(evidence, "report.json")}`,
  );
}
