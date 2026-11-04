// Opt-in, quota-consuming benchmark of real exploration tasks through the orchestrator core.
// Captures raw provider usage (cache write vs read, turns, tool calls) to locate where tokens go.
// No supervisor model is invoked. Runs in a temporary clone; the operator's tree is never touched.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createService } from "../src/service.ts";
import { ClaudeAdapter } from "../src/adapters/claude.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { RuntimeProcess } from "../src/adapters/process.ts";
import { RuntimeCleanupError, type Engine } from "../src/types.ts";

if (process.env.ORCH_BENCH_LIVE !== "1")
  throw new Error("Set ORCH_BENCH_LIVE=1 to authorize quota consumption");
const REPETITIONS = 2,
  TIMEOUT_MS = 600_000,
  CLAUDE_USD_CAP = 6;
const selection: Record<
  "claude" | "codex",
  { model: string; thinking: string }
> = {
  claude: { model: "sonnet", thinking: "medium" },
  codex: { model: "gpt-6.1-sol", thinking: "medium" },
};
const tasks = [
  {
    id: "t1-retry-locate",
    prompt:
      "¿Dónde decide el orquestador si reintenta automáticamente una tarea fallida, y qué condiciones exactas lo impiden? Cita archivo:línea para cada condición.",
  },
  {
    id: "t2-docs-vs-code",
    prompt:
      "Compara lo que dice RELIABILITY.md sobre el reintento automático con la implementación real. Enumera solo discrepancias concretas, con evidencia archivo:línea de ambos lados. Si coinciden, dilo explícitamente; no inventes discrepancias.",
  },
  {
    id: "t3-yolo-flow",
    prompt:
      "Traza paso a paso cómo llegan al árbol de trabajo del operador los cambios de una tarea raíz en modo YOLO, desde que arranca hasta que se aplican o descartan. Cita archivo:línea en cada paso.",
  },
  {
    id: "t4-isolation-limits",
    prompt:
      "¿En qué casos una tarea YOLO NO queda aislada, o su worktree no refleja el estado de trabajo del operador? Enumera cada caso con evidencia archivo:línea.",
  },
  {
    id: "t5-mcp-authz",
    prompt:
      "¿Qué herramientas MCP puede usar un worker delegado y dónde se impide que inspeccione o controle tareas fuera de su propio subárbol? Cita archivo:línea.",
  },
  {
    id: "t6-verify",
    prompt:
      "Ejecuta la comprobación de tipos (npm run check) y los tests de test/scheduling.test.ts. Reporta el resultado exacto: si tsc pasa y cuántos tests aprueban o fallan. Si algo no se puede ejecutar, explica por qué sin inventar resultados.",
  },
];

// Raw protocol capture: counts and usage only, never message content.
type Capture = {
  claudeResult?: any;
  claudeTurns: number;
  tools: Record<string, number>;
  codexTotal?: any;
  codexLast?: any;
  codexItems: Record<string, number>;
};
let capture: Capture | undefined;
const proto = RuntimeProcess.prototype as any;
const deliver = proto.deliver;
proto.deliver = function (line: string) {
  if (capture && line.trim()) {
    try {
      const m = JSON.parse(line);
      if (m.type === "assistant" && Array.isArray(m.message?.content)) {
        capture.claudeTurns++;
        for (const b of m.message.content)
          if (b?.type === "tool_use")
            capture.tools[String(b.name)] =
              (capture.tools[String(b.name)] ?? 0) + 1;
      } else if (m.type === "result") {
        capture.claudeResult = {
          usage: m.usage,
          total_cost_usd: m.total_cost_usd,
          num_turns: m.num_turns,
          duration_api_ms: m.duration_api_ms,
          modelUsage: m.modelUsage,
          subtype: m.subtype,
        };
      } else if (m.method === "thread/tokenUsage/updated") {
        capture.codexTotal = m.params?.tokenUsage?.total;
        capture.codexLast = m.params?.tokenUsage?.last;
      } else if (m.method === "item/started") {
        const t = String(m.params?.item?.type ?? "unknown");
        capture.codexItems[t] = (capture.codexItems[t] ?? 0) + 1;
        if (t === "mcpToolCall")
          capture.tools[`mcp:${m.params.item.tool}`] =
            (capture.tools[`mcp:${m.params.item.tool}`] ?? 0) + 1;
        if (t === "commandExecution")
          capture.tools["command"] = (capture.tools["command"] ?? 0) + 1;
      }
    } catch {
      /* the real parser reports malformed lines */
    }
  }
  return deliver.call(this, line);
};

const repo = process.cwd();
const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
  cwd: repo,
})
  .toString()
  .trim();
const workspace = await mkdtemp(join(tmpdir(), "pi-bench-real-"));
execFileSync("git", [
  "clone",
  "--quiet",
  "--no-hardlinks",
  repo,
  join(workspace, "repo"),
]);
const cwd = join(workspace, "repo");
await symlink(join(repo, "node_modules"), join(cwd, "node_modules"));
await mkdir(join(repo, "artifacts"), { recursive: true });
const reportPath = join(repo, "artifacts", `bench-real-${Date.now()}.json`);
const rows: any[] = [];
const persist = () =>
  writeFile(
    reportPath,
    JSON.stringify(
      {
        configuration: {
          head,
          cwd,
          selection,
          repetitions: REPETITIONS,
          timeoutMs: TIMEOUT_MS,
          claudeUsdCap: CLAUDE_USD_CAP,
          permissionMode: "restricted",
          web: false,
          retries: false,
          supervisor: "none",
        },
        tasks,
        rows,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
console.log(`Report: ${reportPath}\nWorkspace: ${cwd} @ ${head}`);

const wrap = (adapter: ClaudeAdapter | CodexAdapter, row: any) => ({
  capabilities: adapter.capabilities,
  catalog: adapter.catalog?.bind(adapter),
  // Make failures non-retryable so no run is repeated; keep the original error for the report.
  run: async (ctx: any) => {
    try {
      return await adapter.run(ctx);
    } catch (e) {
      row.originalError = String(e).slice(0, 2000);
      throw new RuntimeCleanupError(String(e));
    }
  },
});

let claudeUsd = 0;
outer: for (let repetition = 1; repetition <= REPETITIONS; repetition++) {
  for (const [index, task] of tasks.entries()) {
    const order: Engine[] =
      (repetition + index) % 2 ? ["codex", "claude"] : ["claude", "codex"];
    for (const engine of order as ("claude" | "codex")[]) {
      const row: any = { engine, task: task.id, repetition };
      capture = { claudeTurns: 0, tools: {}, codexItems: {} };
      const started = performance.now();
      try {
        const adapter =
          engine === "claude" ? new ClaudeAdapter() : new CodexAdapter();
        const service = await createService(
          { cwd, timeoutMs: TIMEOUT_MS, maxConcurrent: 1, maxTasks: 1 },
          { [engine]: wrap(adapter, row) } as any,
        );
        try {
          const admitted = service.core.delegate(
            null,
            engine,
            task.prompt,
            `${task.id}-${repetition}`,
            undefined,
            selection[engine],
          );
          let view = admitted;
          while (!["completed", "failed", "cancelled"].includes(view.state))
            view = await service.core.wait(null, admitted.id, TIMEOUT_MS);
          Object.assign(row, {
            state: view.state,
            error: view.error,
            answer: view.result ?? view.partialResult ?? "",
            usage: view.usage,
            modelState: view.modelState
              ? {
                  model: view.modelState.model,
                  thinking: view.modelState.thinking,
                }
              : undefined,
          });
        } finally {
          await service.close();
        }
      } catch (e) {
        Object.assign(row, {
          state: "failed",
          error: String(e).slice(0, 2000),
        });
      }
      row.elapsedMs = Math.round(performance.now() - started);
      row.answerChars = (row.answer ?? "").length;
      row.raw = capture;
      capture = undefined;
      if (engine === "claude")
        claudeUsd += Number(row.raw.claudeResult?.total_cost_usd ?? 0);
      rows.push(row);
      await persist();
      console.log(
        JSON.stringify({
          engine,
          task: task.id,
          repetition,
          state: row.state,
          s: Math.round(row.elapsedMs / 1000),
          usage: row.usage,
          tools: row.raw.tools,
          claudeUsdTotal: Number(claudeUsd.toFixed(4)),
          error: row.originalError?.slice(0, 200),
        }),
      );
      if (rows.length === 2 && rows.every((r) => r.state !== "completed")) {
        console.log("STOP: first two runs failed");
        break outer;
      }
      if (claudeUsd > CLAUDE_USD_CAP) {
        console.log(
          `STOP: Claude reported spend ${claudeUsd.toFixed(2)} exceeded cap`,
        );
        break outer;
      }
    }
  }
}
console.log(`Completed ${rows.length} runs. Evidence: ${reportPath}`);
