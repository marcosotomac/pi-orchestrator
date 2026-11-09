import type { OrchestratorOptions } from "./orchestrator.ts";

/**
 * Product defaults for the Pi extension; explicit environment settings win.
 * The core keeps its conservative library defaults (reject queue, 3 slots, 60 s
 * dialogs) so embedding and tests stay explicit.
 * - fair: a fan-out of N root tasks queues instead of failing the (N+1)th.
 * - 4 slots: with fair, one slot is reserved for nested children, so three
 *   roots still run in parallel as before.
 * - 5 min dialogs: a permission must survive the operator being in another tab.
 * - Claude workers default to Sonnet: without --model the CLI uses the account
 *   default (measured: claude-opus-5-5). Opus stays one explicit request away.
 * - YOLO roots run in a private git worktree; the operator applies or discards the diff.
 */
export const productDefaults: Partial<OrchestratorOptions> = {
  queuePolicy: "fair",
  maxConcurrent: 4,
  interactionTimeoutMs: 300_000,
  defaultSelection: { claude: { model: "sonnet" } },
  isolateWrites: true,
};

/** Read-only configuration parsing; no timers, files, ports or subprocesses. */
export function runtimeConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): Partial<OrchestratorOptions> {
  const options: Partial<OrchestratorOptions> = {};
  const fields = {
    PI_ORCHESTRATOR_MAX_CONCURRENT: "maxConcurrent",
    PI_ORCHESTRATOR_MAX_TASKS: "maxTasks",
    PI_ORCHESTRATOR_MAX_DEPTH: "maxDepth",
    PI_ORCHESTRATOR_MAX_RUNTIME_MS: "maxRuntimeMs",
    PI_ORCHESTRATOR_TASK_TIMEOUT_MS: "timeoutMs",
    PI_ORCHESTRATOR_MAX_QUEUED: "maxQueued",
    PI_ORCHESTRATOR_RESERVED_CHILD_SLOTS: "reservedChildSlots",
    PI_ORCHESTRATOR_INTERACTION_TIMEOUT_MS: "interactionTimeoutMs",
  } as const;
  for (const [name, field] of Object.entries(fields)) {
    const value = env[name];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`Invalid orchestrator setting: ${name}`);
    options[field] = Number(value);
  }
  if (env.PI_ORCHESTRATOR_MAX_TOKENS !== undefined) {
    if (
      !/^\d+$/.test(env.PI_ORCHESTRATOR_MAX_TOKENS) ||
      Number(env.PI_ORCHESTRATOR_MAX_TOKENS) < 1
    )
      throw new Error(
        "Invalid orchestrator setting: PI_ORCHESTRATOR_MAX_TOKENS",
      );
    options.maxTokens = Number(env.PI_ORCHESTRATOR_MAX_TOKENS);
  }
  if (env.PI_ORCHESTRATOR_MAX_COST_USD !== undefined) {
    const value = Number(env.PI_ORCHESTRATOR_MAX_COST_USD);
    if (
      !/^\d+(?:\.\d{1,2})?$/.test(env.PI_ORCHESTRATOR_MAX_COST_USD) ||
      !(value > 0)
    )
      throw new Error(
        "Invalid orchestrator setting: PI_ORCHESTRATOR_MAX_COST_USD",
      );
    options.maxCostUsd = value;
  }
  if (env.PI_ORCHESTRATOR_ALLOWED_ROOTS !== undefined) {
    const roots = env.PI_ORCHESTRATOR_ALLOWED_ROOTS.split(":")
      .map((root) => root.trim())
      .filter(Boolean);
    if (roots.some((root) => !root.startsWith("/")))
      throw new Error(
        "PI_ORCHESTRATOR_ALLOWED_ROOTS must list absolute paths separated by ':'",
      );
    options.allowedRoots = roots;
  }
  if (env.PI_ORCHESTRATOR_ISOLATE_WRITES !== undefined) {
    if (!["0", "1"].includes(env.PI_ORCHESTRATOR_ISOLATE_WRITES))
      throw new Error(
        "Invalid PI_ORCHESTRATOR_ISOLATE_WRITES (expected 0 or 1)",
      );
    options.isolateWrites = env.PI_ORCHESTRATOR_ISOLATE_WRITES === "1";
  }
  if (env.PI_ORCHESTRATOR_SPEND_ENFORCEMENT !== undefined) {
    if (!["admission", "abort"].includes(env.PI_ORCHESTRATOR_SPEND_ENFORCEMENT))
      throw new Error(
        "Invalid PI_ORCHESTRATOR_SPEND_ENFORCEMENT (expected admission or abort)",
      );
    options.spendEnforcement = env.PI_ORCHESTRATOR_SPEND_ENFORCEMENT as
      | "admission"
      | "abort";
  }
  if (env.PI_ORCHESTRATOR_QUEUE !== undefined) {
    if (!["reject", "fair"].includes(env.PI_ORCHESTRATOR_QUEUE))
      throw new Error("Invalid orchestrator queue policy");
    options.queuePolicy = env.PI_ORCHESTRATOR_QUEUE as "reject" | "fair";
  }
  return options;
}

/** Every PI_ORCHESTRATOR_* setting, for `/orch config`; a test keeps it in sync with src/. */
export const settingsRegistry: readonly {
  name: string;
  fallback: string;
  description: string;
}[] = [
  {
    name: "PI_ORCHESTRATOR_MAX_CONCURRENT",
    fallback: "4",
    description: "plazas de runtime simultáneas",
  },
  {
    name: "PI_ORCHESTRATOR_MAX_TASKS",
    fallback: "32",
    description: "tareas por sesión del núcleo",
  },
  {
    name: "PI_ORCHESTRATOR_MAX_DEPTH",
    fallback: "2",
    description: "runtimes anidados bajo Pi",
  },
  {
    name: "PI_ORCHESTRATOR_MAX_QUEUED",
    fallback: "32",
    description: "raíces en cola",
  },
  {
    name: "PI_ORCHESTRATOR_RESERVED_CHILD_SLOTS",
    fallback: "1",
    description: "plazas reservadas a subtareas",
  },
  {
    name: "PI_ORCHESTRATOR_QUEUE",
    fallback: "fair",
    description: "política de cola (fair|reject)",
  },
  {
    name: "PI_ORCHESTRATOR_TASK_TIMEOUT_MS",
    fallback: "900000",
    description: "plazo por intento",
  },
  {
    name: "PI_ORCHESTRATOR_MAX_RUNTIME_MS",
    fallback: "sin límite",
    description: "tiempo total de runtime de la sesión",
  },
  {
    name: "PI_ORCHESTRATOR_INTERACTION_TIMEOUT_MS",
    fallback: "300000",
    description: "espera de permisos y preguntas",
  },
  {
    name: "PI_ORCHESTRATOR_MAX_TOKENS",
    fallback: "sin límite",
    description: "tope de tokens de la sesión",
  },
  {
    name: "PI_ORCHESTRATOR_MAX_COST_USD",
    fallback: "sin límite",
    description: "tope en USD de la sesión (solo Claude informa dólares)",
  },
  {
    name: "PI_ORCHESTRATOR_SPEND_ENFORCEMENT",
    fallback: "admission",
    description:
      "al llegar al tope: admission (rechaza nuevo) | abort (cancela lo vivo)",
  },
  {
    name: "PI_ORCHESTRATOR_ALLOWED_ROOTS",
    fallback: "solo el cwd",
    description: "directorios extra para cwd por tarea",
  },
  {
    name: "PI_ORCHESTRATOR_ISOLATE_WRITES",
    fallback: "1",
    description: "YOLO en worktree aislado (0|1)",
  },
  {
    name: "PI_ORCHESTRATOR_YOLO_SANDBOX",
    fallback: "on",
    description: "sandbox de Bash en YOLO (on|off)",
  },
  {
    name: "PI_ORCHESTRATOR_STATE_DIR",
    fallback: "~/.pi/agent/orchestrator-state",
    description: "historial (ruta|off)",
  },
  {
    name: "PI_ORCHESTRATOR_EARLY_FAILURE_WAKE",
    fallback: "1",
    description: "despertar al modelo ante un fallo sin esperar al lote (0|1)",
  },
  {
    name: "PI_ORCHESTRATOR_NOTIFY",
    fallback: "desktop",
    description: "avisos (desktop|bell|off)",
  },
  {
    name: "PI_ORCHESTRATOR_CODEX_MODEL",
    fallback: "config de Codex",
    description: "modelo de Codex por defecto",
  },
  {
    name: "PI_ORCHESTRATOR_CODEX_THINKING",
    fallback: "—",
    description: "thinking de Codex por defecto",
  },
  {
    name: "PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING",
    fallback: "medium",
    description: "esfuerzo de Codex sin thinking",
  },
  {
    name: "PI_ORCHESTRATOR_CLAUDE_MODEL",
    fallback: "sonnet",
    description: "modelo de Claude por defecto",
  },
  {
    name: "PI_ORCHESTRATOR_CLAUDE_THINKING",
    fallback: "—",
    description: "thinking de Claude por defecto",
  },
  {
    name: "PI_ORCHESTRATOR_CLAUDE_MAX_TURNS",
    fallback: "40",
    description: "turnos de Claude (1–500)",
  },
  {
    name: "PI_ORCHESTRATOR_CLAUDE_MAX_BUDGET_USD",
    fallback: "1.00",
    description: "--max-budget-usd por tarea",
  },
  {
    name: "PI_ORCHESTRATOR_ANTIGRAVITY_MODEL",
    fallback: "del runtime",
    description: "modelo de Antigravity por defecto",
  },
  {
    name: "PI_ORCHESTRATOR_ANTIGRAVITY_THINKING",
    fallback: "—",
    description: "thinking de Antigravity por defecto",
  },
  {
    name: "PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL",
    fallback: "1",
    description: "habilita Antigravity ACP (0|1)",
  },
  {
    name: "PI_ORCHESTRATOR_ANTIGRAVITY_ACP",
    fallback: ".runtimes/antigravity",
    description: "ejecutable ACP",
  },
  {
    name: "PI_ORCHESTRATOR_ANTIGRAVITY_PROFILE",
    fallback: ".runtimes/antigravity/profile",
    description: "perfil privado",
  },
  {
    name: "PI_ORCHESTRATOR_ANTIGRAVITY_READONLY_AUTO",
    fallback: "1",
    description: "autoaprobar comandos de solo lectura (0|1)",
  },
];

/** Effective settings and their origin; read-only, never starts the service. */
export function configurationReport(
  env: NodeJS.ProcessEnv = process.env,
): string {
  let validation = "Valores válidos.";
  try {
    runtimeConfiguration(env);
  } catch (error) {
    validation = `Configuración inválida: ${error instanceof Error ? error.message : String(error)}`;
  }
  const rows = settingsRegistry.map(({ name, fallback, description }) => {
    const raw = env[name]?.trim();
    const value = raw
      ? `${raw.length > 80 ? raw.slice(0, 77) + "…" : raw} (entorno)`
      : `${fallback} (predeterminado)`;
    return `${name.slice("PI_ORCHESTRATOR_".length)} = ${value} · ${description}`;
  });
  const unknown = Object.keys(env).filter(
    (name) =>
      name.startsWith("PI_ORCHESTRATOR_") &&
      !settingsRegistry.some((setting) => setting.name === name),
  );
  return [
    "Configuración del orquestador (prefijo PI_ORCHESTRATOR_)",
    validation,
    ...rows,
    ...(unknown.length
      ? [`Variables desconocidas, ignoradas: ${unknown.join(", ")}`]
      : []),
  ].join("\n");
}
