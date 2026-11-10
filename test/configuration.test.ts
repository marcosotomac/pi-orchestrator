import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configurationReport, settingsRegistry } from "../src/configuration.ts";

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sources(join(directory, entry.name))
      : entry.name.endsWith(".ts")
        ? [join(directory, entry.name)]
        : [],
  );
}

test("every PI_ORCHESTRATOR_* variable read in src/ is in the registry", () => {
  const registered = new Set(settingsRegistry.map((setting) => setting.name));
  const used = new Set<string>();
  for (const file of sources("src"))
    for (const match of readFileSync(file, "utf8").matchAll(
      /PI_ORCHESTRATOR_[A-Z_]*[A-Z]/g,
    ))
      used.add(match[0]);
  // Per-engine MODEL/THINKING are built from a template prefix.
  used.delete("PI_ORCHESTRATOR_");
  const missing = [...used].filter((name) => !registered.has(name));
  assert.deepEqual(missing, []);
  assert.equal(registered.size, settingsRegistry.length, "no duplicates");
});

test("the report shows origin, flags invalid values and unknown names", () => {
  const report = configurationReport({
    PI_ORCHESTRATOR_MAX_TASKS: "8",
    PI_ORCHESTRATOR_QUEUE: "lifo",
    PI_ORCHESTRATOR_TYPO: "1",
  });
  assert.match(report, /MAX_TASKS = 8 \(entorno\)/);
  assert.match(report, /MAX_DEPTH = 2 \(predeterminado\)/);
  assert.match(
    report,
    /Configuración inválida: Invalid orchestrator queue policy/,
  );
  assert.match(report, /desconocidas, ignoradas: PI_ORCHESTRATOR_TYPO/);
  assert.match(configurationReport({}), /Valores válidos\./);
});

test("fallback pairs parse strictly", async () => {
  const { runtimeConfiguration } = await import("../src/configuration.ts");
  assert.deepEqual(
    runtimeConfiguration({
      PI_ORCHESTRATOR_FALLBACK: "claude:codex, codex:claude",
    }).fallback,
    { claude: "codex", codex: "claude" },
  );
  for (const bad of [
    "claude",
    "claude:claude",
    "claude:gpt",
    "a:b:c",
    "claude:codex,claude:antigravity",
  ])
    assert.throws(
      () => runtimeConfiguration({ PI_ORCHESTRATOR_FALLBACK: bad }),
      /PI_ORCHESTRATOR_FALLBACK/,
      bad,
    );
});
