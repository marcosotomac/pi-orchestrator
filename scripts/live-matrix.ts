// Opt-in live check (consumes quota): every engine solo and nested, in parallel,
// against a throwaway directory. Exit code 1 if any case does not return the marker.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createService } from "../src/service.ts";
import { productDefaults } from "../src/configuration.ts";
import type { Engine } from "../src/types.ts";

const cwd = mkdtempSync(join(tmpdir(), "orch-matrix-"));
writeFileSync(join(cwd, "secret.txt"), "MARKER-7731\n");
const selection = { codex: { thinking: "low" }, claude: { model: "haiku", thinking: "low" }, antigravity: { model: "gemini-3.8-flash", thinking: "low" } } as const;
const spec = (engine: Engine) => engine === "claude" ? "model 'haiku', thinking 'low'" : engine === "codex" ? "thinking 'low'" : "model 'gemini-3.8-flash', thinking 'low'";
const read = "Read secret.txt and reply with only its content.";
const cases: [string, Engine, Engine?][] = [
  ["codex", "codex"], ["claude", "claude"], ["antigravity", "antigravity"],
  ["claude→codex", "claude", "codex"], ["codex→antigravity", "codex", "antigravity"], ["antigravity→claude", "antigravity", "claude"],
];
const service = await createService({ ...productDefaults, maxConcurrent: 8, cwd });
let failures = 0;
try {
  const started = cases.map(([name, engine, child]) => ({ name, task: service.core.delegate(null, engine, child
    ? `Use the pi_orchestrator MCP delegate tool exactly once with engine '${child}', ${spec(child)}, requestKey 'c', prompt '${read}'. Then call the pi_orchestrator wait tool for that task id until it is completed. Reply with only the child's result.`
    : read, name, undefined, selection[engine]) }));
  for (const { name, task } of started) {
    let view = task;
    while (!["completed", "failed", "cancelled"].includes(view.state)) view = await service.core.wait(null, task.id, 300_000);
    const ok = /MARKER-7731/.test(view.result ?? "");
    if (!ok) failures++;
    const children = service.core.list().filter((entry) => entry.parentId === task.id).map((entry) => `${entry.engine}:${entry.state}`);
    console.log(`${ok ? "PASS" : "FAIL"} ${name.padEnd(20)} ${view.state.padEnd(9)} ${String(Math.round((Date.parse(view.endedAt!) - Date.parse(view.createdAt)) / 1000)).padStart(3)}s ${children.join(",")}${ok ? "" : ` · ${(view.error ?? view.result ?? "").slice(0, 200)}`}`);
  }
} finally { await service.close(); }
console.log(`${cases.length - failures}/${cases.length} live cases passed`);
process.exitCode = failures ? 1 : 0;
