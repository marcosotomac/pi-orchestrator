import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { defaultEffort } from "./adapters/codex.ts";
import {
  isTerminal,
  type Engine,
  type TaskUsage,
  type TaskView,
} from "./types.ts";
import type { IsolationPreview } from "./workspace.ts";
import type { OrchestrationMetrics } from "./orchestrator.ts";

/** Provider output is untrusted terminal data: no OSC links, escapes, or control bytes. */
export function safeText(text: string): string {
  return stripTerminalSequences(text)
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
    .replace(/\t/g, "  ");
}
const oneLine = (text: string) => safeText(text).replace(/\s*\n\s*/g, " ");
export const stateLabel = {
  queued: "en cola",
  running: "en curso",
  cancelling: "cancelando",
  completed: "completada",
  failed: "fallida",
  cancelled: "cancelada",
} as const;

/** Only non-zero counts; what needs the human comes first. */
export function summary(
  tasks: TaskView[],
  attention?: (id: string) => Attention | undefined,
): string {
  const count = (predicate: (task: TaskView) => boolean) =>
    tasks.filter(predicate).length;
  const waiting = attention
    ? count((task) => !isTerminal(task) && Boolean(attention(task.id)))
    : 0;
  const parts: [number, string][] = [
    [waiting, waiting === 1 ? "te necesita" : "te necesitan"],
    [count((task) => task.state === "failed"), "fallida"],
    [count((task) => task.state === "running"), "en curso"],
    [count((task) => task.state === "cancelling"), "cancelando"],
    [count((task) => task.state === "queued"), "en cola"],
    [count((task) => task.state === "completed"), "lista"],
    [count((task) => task.state === "cancelled"), "cancelada"],
  ];
  const plural = (n: number, label: string) =>
    n === 1 ||
    label.startsWith("te ") ||
    label === "en curso" ||
    label === "en cola" ||
    label === "cancelando"
      ? label
      : `${label}s`;
  const text = parts
    .filter(([n]) => n > 0)
    .map(([n, label]) =>
      label.startsWith("te ") ? `${n} ${label}` : `${n} ${plural(n, label)}`,
    )
    .join(" · ");
  return text || "sin tareas";
}

/** Stable preorder by actual parent identity, never by a provider's claimed depth. */
export function taskRows(
  tasks: TaskView[],
): { task: TaskView; prefix: string }[] {
  const rows: { task: TaskView; prefix: string }[] = [];
  const seen = new Set<string>();
  const visit = (task: TaskView, depth: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    rows.push({ task, prefix: depth ? `${"  ".repeat(depth - 1)}└─ ` : "" });
    for (const child of tasks)
      if (child.parentId === task.id) visit(child, depth + 1);
  };
  for (const task of tasks)
    if (!task.parentId || !tasks.some((parent) => parent.id === task.parentId))
      visit(task, 0);
  for (const task of tasks) visit(task, 0);
  return rows;
}
export type Attention = "permission" | "question";
export const stateIcon = {
  queued: "○",
  running: "●",
  cancelling: "◌",
  completed: "✓",
  failed: "!",
  cancelled: "–",
} as const;

/** Running tasks without host-observed activity for this long are flagged (host clock, not provider text). */
export const STALL_MS = 180_000;
export function isStalled(
  task: TaskView,
  tasks: TaskView[] = [],
  now = Date.now(),
): boolean {
  if (task.state !== "running" || !task.runtimeSessionId) return false;
  if (tasks.some((child) => child.parentId === task.id && !isTerminal(child)))
    return false; // waiting on children is not a stall
  const last = Date.parse(task.activityAt ?? task.createdAt);
  return Number.isFinite(last) && now - last >= STALL_MS;
}

/** Lower is more urgent: what needs the human, then failures, then live work, then history. */
export function urgency(
  task: TaskView,
  attention?: Attention,
  tasks: TaskView[] = [],
  now = Date.now(),
): number {
  if (attention && !isTerminal(task)) return 0;
  if (task.state === "failed") return 1;
  if (isStalled(task, tasks, now)) return 2;
  return {
    cancelling: 3,
    running: 4,
    queued: 5,
    completed: 6,
    cancelled: 7,
    failed: 1,
  }[task.state];
}

/** Preorder tree whose roots and siblings are ordered by the most urgent task in their subtree. */
export function urgentRows(
  tasks: TaskView[],
  attention: (id: string) => Attention | undefined = () => undefined,
  now = Date.now(),
) {
  const memo = new Map<string, number>();
  const score = (task: TaskView): number => {
    const cached = memo.get(task.id);
    if (cached !== undefined) return cached;
    memo.set(task.id, Number.POSITIVE_INFINITY); // cycle guard
    const own = urgency(task, attention(task.id), tasks, now);
    const value = Math.min(
      own,
      ...tasks.filter((child) => child.parentId === task.id).map(score),
    );
    memo.set(task.id, value);
    return value;
  };
  const order = (list: TaskView[]) =>
    [...list].sort(
      (a, b) =>
        score(a) - score(b) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt),
    );
  const rows: { task: TaskView; prefix: string; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (task: TaskView, depth: number) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    rows.push({
      task,
      prefix: depth ? `${"  ".repeat(depth - 1)}└ ` : "",
      depth,
    });
    for (const child of order(
      tasks.filter((entry) => entry.parentId === task.id),
    ))
      visit(child, depth + 1);
  };
  for (const task of order(
    tasks.filter(
      (entry) =>
        !entry.parentId ||
        !tasks.some((parent) => parent.id === entry.parentId),
    ),
  ))
    visit(task, 0);
  for (const task of tasks) visit(task, 0);
  return rows;
}

/**
 * Panel/widget order: trees with live work (most urgent first), then finished
 * trees, newest first. `finished` marks rows of the second group.
 */
export function groupedRows(
  tasks: TaskView[],
  attention: (id: string) => Attention | undefined = () => undefined,
  now = Date.now(),
) {
  const rows = urgentRows(tasks, attention, now);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const rootOf = (task: TaskView) => {
    let current = task;
    const seen = new Set<string>();
    while (
      current.parentId &&
      byId.has(current.parentId) &&
      !seen.has(current.id)
    ) {
      seen.add(current.id);
      current = byId.get(current.parentId)!;
    }
    return current;
  };
  const liveRoots = new Set(
    tasks.filter((task) => !isTerminal(task)).map((task) => rootOf(task).id),
  );
  const active = rows
    .filter(({ task }) => liveRoots.has(rootOf(task).id))
    .map((row) => ({ ...row, finished: false }));
  const ended = (task: TaskView) =>
    Date.parse(rootOf(task).endedAt ?? rootOf(task).createdAt);
  const finished = rows
    .filter(({ task }) => !liveRoots.has(rootOf(task).id))
    .map((row, index) => ({ ...row, index }))
    .sort((a, b) => ended(b.task) - ended(a.task) || a.index - b.index)
    .map(({ index: _index, ...row }) => ({ ...row, finished: true }));
  return [...active, ...finished];
}

export function taskPhase(task: TaskView, attention?: Attention): string {
  if (task.state !== "running") return stateLabel[task.state];
  if (attention)
    return attention === "permission"
      ? "esperando tu permiso"
      : "esperando tu respuesta";
  if (!task.runtimeSessionId) return "arrancando";
  // A live child alone does not prove that its parent is waiting for it.
  return "trabajando";
}

/**
 * Readable label for the runtime's own last reported action. It is shown as
 * "what the engine reported", never as a host-verified phase or progress.
 */
export function activityLabel(raw?: string): string | undefined {
  if (!raw) return undefined;
  const text = oneLine(raw);
  const orchestrator = /^orchestrator: (.+)$/.exec(text);
  if (orchestrator) return orchestrator[1];
  // "engine: action · target" from the adapters; the target is already a short name.
  const [, action = text, target] =
    /^(?:codex|claude|antigravity):\s*(.*?)(?: · (.+))?$/.exec(text) ?? [];
  const on = (verb: string) => (target ? `${verb} ${target}` : verb);
  const quoted = (verb: string) => (target ? `${verb} \`${target}\`` : verb);
  const rules: [RegExp, () => string][] = [
    [
      /mcp\/pi_orchestrator\/delegate|mcp__pi_orchestrator__delegate/,
      () => "delegando una subtarea",
    ],
    [
      /mcp\/pi_orchestrator\/wait|mcp__pi_orchestrator__wait/,
      () => "esperando a sus subtareas",
    ],
    [
      /mcp\/pi_orchestrator\/(status|cancel)|mcp__pi_orchestrator__(status|cancel)/,
      () => "gestionando sus subtareas",
    ],
    [/waiting for human permission/, () => "esperando tu permiso"],
    [/waiting for user answer/, () => "esperando tu respuesta"],
    [
      /approval denied|denied permission/,
      () => "una acción fue denegada por permisos",
    ],
    [/YOLO approval/, () => "acción aprobada (YOLO)"],
    [/scoped bridge approval/, () => "hablando con el orquestador"],
    [/^(commandExecution|Bash|execute)$/, () => quoted("ejecutando")],
    [/^(fileChange|Write|Edit|MultiEdit|edit)$/, () => on("editando")],
    [
      /^(Grep|Glob|search)$/,
      () => (target ? `buscando ${target}` : "buscando en el código"),
    ],
    [
      /^(Read|read)$/,
      () => (target ? `leyendo ${target}` : "leyendo archivos"),
    ],
    [/^reasoning$/, () => "pensando"],
    [/^agentMessage$/, () => "redactando la respuesta"],
    [/^(webSearch|WebSearch|WebFetch|fetch)$/, () => on("consultando la web")],
    [
      /^(tool activity|tool|other)$/,
      () => (target ? `usando ${target}` : "usando una herramienta"),
    ],
  ];
  for (const [pattern, label] of rules)
    if (pattern.test(action) || pattern.test(text)) return label();
  const mcp =
    /mcp\/([\w.-]+)\/([\w.-]+)/.exec(text) ??
    /mcp__([\w.-]+)__([\w.-]+)/.exec(text);
  if (mcp) return `herramienta ${mcp[1]}/${mcp[2]}`;
  return (
    text.replace(/^(codex|claude|antigravity):\s*/, "").slice(0, 60) ||
    undefined
  );
}

const short = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1_000));
  return s < 60
    ? `${s}s`
    : s < 3_600
      ? `${Math.floor(s / 60)}m ${s % 60}s`
      : `${Math.floor(s / 3_600)}h ${Math.floor((s % 3_600) / 60)}m`;
};

/** Host facts first (children, stall), then the engine's own reported action. */
export function taskDetail(
  task: TaskView,
  tasks: TaskView[] = [],
  attention?: Attention,
  now = Date.now(),
): { text?: string; tone: "warning" | "muted" } {
  if (isTerminal(task) || attention) return { tone: "muted" };
  // The orchestrator's own action (soft deadline) is a host fact, not an engine report.
  if (task.lastActivity?.startsWith("orchestrator: "))
    return { text: task.lastActivity.slice(14), tone: "warning" };
  const live = tasks.filter(
    (child) => child.parentId === task.id && !isTerminal(child),
  );
  if (live.length) {
    const engines = [
      ...new Set(live.map((child) => engineName(child.engine))),
    ].join(", ");
    return {
      text: `${live.length} ${live.length === 1 ? "subtarea activa" : "subtareas activas"} (${engines})`,
      tone: "muted",
    };
  }
  if (isStalled(task, tasks, now))
    return {
      text: `sin actividad hace ${short(now - Date.parse(task.activityAt ?? task.createdAt))}`,
      tone: "warning",
    };
  const action = activityLabel(task.lastActivity);
  return { text: action ? `motor: ${action}` : undefined, tone: "muted" };
}

export function engineName(engine: TaskView["engine"]): string {
  return engine === "antigravity" ? "agy" : engine;
}

export function formatTokens(usage?: TaskUsage): string | undefined {
  if (!usage) return undefined;
  const k = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${Math.round(n / 1_000)}k`
        : `${n}`;
  const total = usage.inputTokens + usage.outputTokens;
  const parts = [`${k(total)} tokens`];
  if (usage.cachedInputTokens)
    parts.push(`${k(usage.cachedInputTokens)} de caché`);
  if (usage.cacheWriteTokens)
    parts.push(`${k(usage.cacheWriteTokens)} escritos en caché`);
  if (usage.reasoningTokens)
    parts.push(`${k(usage.reasoningTokens)} razonando`);
  if (usage.costUsd !== undefined)
    parts.push(`~$${usage.costUsd.toFixed(usage.costUsd < 0.1 ? 3 : 2)}`);
  return parts.join(" · ");
}

/** "gemini-3.8-flash" → "Gemini 3.8 Flash", "gpt-6.1-sol" → "GPT-6.1 Sol", "claude-sonnet-5-5" → "Claude Sonnet 5.5". */
export function modelName(id: string): string {
  const claude = /^claude-([a-z]+)-(\d+)-(\d+)$/.exec(id);
  if (claude)
    return `Claude ${claude[1]![0]!.toUpperCase()}${claude[1]!.slice(1)} ${claude[2]}.${claude[3]}`;
  if (/^(haiku|sonnet|opus)$/.test(id))
    return `Claude ${id[0]!.toUpperCase()}${id.slice(1)}`;
  const gpt = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
  if (gpt)
    return `GPT-${gpt[1]}${
      gpt[2]
        ? ` ${gpt[2]
            .split("-")
            .map((part) => part[0]!.toUpperCase() + part.slice(1))
            .join(" ")}`
        : ""
    }`;
  return id
    .split("-")
    .map((part) =>
      /^\d/.test(part) ? part : part[0]!.toUpperCase() + part.slice(1),
    )
    .join(" ");
}

const thinkingNames: Record<string, string> = {
  minimal: "mínimo",
  low: "bajo",
  medium: "medio",
  high: "alto",
  xhigh: "muy alto",
  max: "máximo",
  ultra: "ultra",
};
export const thinkingName = (level: string) => thinkingNames[level] ?? level;

/** Plain words: engine · model · reasoning · permissions. Technical provenance lives in the details. */
export function modelLabel(task: TaskView): string {
  const model = task.modelState?.model ?? task.selection?.model;
  let thinking = task.modelState?.thinking ?? task.selection?.thinking;
  let defaulted = false;
  if (!thinking && task.engine === "codex") {
    try {
      thinking = defaultEffort();
      defaulted = true;
    } catch {
      /* invalid env */
    }
  }
  return safeText(
    [
      task.engine === "codex"
        ? "Codex"
        : task.engine === "claude"
          ? "Claude"
          : "Antigravity",
      model ? modelName(model) : "modelo por defecto",
      thinking
        ? `razonamiento ${thinkingName(thinking)}${defaulted ? " (por defecto)" : ""}`
        : undefined,
      task.permissionMode === "yolo" ? "YOLO (solo esta tarea)" : undefined,
      task.web ? "con internet" : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  ).replace(/\n/g, " ");
}

/** Where the model and level came from, for the detail view. */
export function selectionDetail(task: TaskView): string | undefined {
  const parts: string[] = [];
  if (task.selection?.model)
    parts.push(
      `modelo pedido: ${task.selection.model}${task.modelState?.model && task.modelState.model !== task.selection.model ? ` → usado: ${task.modelState.model}` : ""}`,
    );
  else if (task.modelState?.model)
    parts.push(`modelo usado: ${task.modelState.model}`);
  if (task.selection?.thinking)
    parts.push(`razonamiento pedido: ${task.selection.thinking}`);
  return parts.length ? parts.join(" · ") : undefined;
}

/**
 * A human title: the model's short label, else the prompt's first sentence with
 * absolute paths reduced to their last name, bounded to 60 columns at a word.
 */
export function shortTitle(text: string): string {
  let line = oneLine(text).replace(
    /(?:~|\/(?:Users|home|private|var|tmp|opt|Volumes))?(?:\/[^\s/'"`]+)+\/?/g,
    (path) => path.replace(/\/+$/, "").split("/").pop() ?? path,
  );
  const sentence = /^(.{12,}?[.!?])(?:\s|$)/.exec(line);
  if (sentence) line = sentence[1]!.replace(/[.]$/, "");
  if (line.length <= 60) return line;
  const cut = line.slice(0, 59);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 30 ? cut.lastIndexOf(" ") : 59)}…`;
}
export const displayTitle = (task: TaskView) =>
  task.label ?? shortTitle(task.title);

/** Same request reworded: at least half of the significant words (4+ letters) in common. */
function similar(a: string, b: string): boolean {
  const words = (text: string) =>
    new Set(
      shortTitle(text)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .split(/[^a-z0-9-]+/)
        .filter((word) => word.length >= 4),
    );
  const left = words(a),
    right = words(b);
  if (left.size < 2 || right.size < 2) return false;
  const shared = [...left].filter((word) => right.has(word)).length;
  return shared / Math.min(left.size, right.size) >= 0.5 && shared >= 2;
}

/** A cancelled/failed root repeated later by a task with the same engine and a similar request. */
export function supersededBy(
  task: TaskView,
  tasks: TaskView[],
): TaskView | undefined {
  if (task.state !== "cancelled" && task.state !== "failed") return undefined;
  return tasks.find(
    (other) =>
      other.id !== task.id &&
      other.engine === task.engine &&
      other.parentId === task.parentId &&
      Date.parse(other.createdAt) > Date.parse(task.createdAt) &&
      (other.title === task.title ||
        (task.label !== undefined && other.label === task.label) ||
        similar(other.title, task.title)),
  );
}

/** Spanish wording for the human; the raw message is kept for machines and expanded views. */
export function friendlyError(error: string): string {
  const rules: [RegExp, string][] = [
    [
      /MCP isolation could not be verified; inherited servers active: (.+)/,
      "No se pudo aislar Codex: siguen activos servidores MCP heredados ($1). La tarea se detuvo antes de empezar.",
    ],
    [
      /Task deadline exceeded/,
      "Se agotó el plazo de la tarea (PI_ORCHESTRATOR_TASK_TIMEOUT_MS).",
    ],
    [/Cancelled by owner/, "Cancelada por ti."],
    [/Parent execution ended/, "Su tarea padre terminó antes que ella."],
    [/Pi session closed/, "Se cerró la sesión de Pi."],
    [
      /Aggregate runtime budget exhausted/,
      "Se agotó el presupuesto total de tiempo de ejecución.",
    ],
    [
      /Concurrency limit reached/,
      "Límite de tareas simultáneas alcanzado; espera a que termine alguna.",
    ],
    [
      /Total task limit reached/,
      "Límite de tareas de esta sesión alcanzado (PI_ORCHESTRATOR_MAX_TASKS); usa /orch reset.",
    ],
    [
      /Delegation depth limit reached/,
      "Límite de profundidad de delegación alcanzado.",
    ],
    [/Runtime returned no result/, "El motor terminó sin devolver texto."],
    [
      /Runtime cleanup could not be confirmed/,
      "No se pudo confirmar el cierre de los procesos del motor.",
    ],
    [/Codex RPC timeout: (.+)/, "Codex no respondió a tiempo ($1)."],
    [
      /Claude error_max_turns|max.?turns/i,
      "Claude alcanzó su límite de turnos (PI_ORCHESTRATOR_CLAUDE_MAX_TURNS).",
    ],
    [
      /Claude error_max_budget|max.?budget/i,
      "Claude alcanzó su presupuesto por tarea (--max-budget-usd).",
    ],
    [
      /at capacity|overloaded|temporarily unavailable/i,
      "El modelo del proveedor estaba saturado temporalmente.",
    ],
  ];
  const text = safeText(error);
  for (const [pattern, label] of rules)
    if (pattern.test(text))
      return text.replace(
        new RegExp(`^[\\s\\S]*?${pattern.source}[\\s\\S]*$`, pattern.flags),
        label,
      );
  return text;
}

export function failureAdvice(task: TaskView): string {
  if (task.error && /MCP isolation could not be verified/.test(task.error))
    return "Revisa que tu ~/.codex/config.toml no fuerce esos servidores; no relajes el aislamiento para reintentar.";
  const category = task.diagnostic?.category ?? "unknown";
  return {
    authentication:
      "Autentica este motor con su propia cuenta antes de volver a delegar.",
    network:
      "Comprueba la conexión y el estado de las subtareas antes de reintentar: podría duplicarse trabajo.",
    quota:
      "Comprueba la cuota de la cuenta o espera a que se restablezca. No se cambió de cuenta ni de modelo.",
    transient:
      "El proveedor no estaba disponible temporalmente. Si era de solo lectura y sin subtareas ya se reintentó una vez; reinténtalo más tarde (R en el panel).",
    protocol:
      "Comprueba la compatibilidad de esta versión del motor; no relajes las validaciones.",
    cleanup:
      "El cierre no está confirmado. No reutilices esta sesión ni des por cancelados sus procesos.",
    unknown:
      "Consulta los detalles antes de iniciar otro intento. No hubo reintento automático.",
  }[category];
}

/** Technical one-liner with the short ID: archives, history and the transcript. */
export function taskLine(
  task: TaskView,
  prefix = "",
  attention?: Attention,
): string {
  return `${prefix}${stateIcon[task.state]} ${task.engine} ${task.id.slice(0, 8)} · ${taskPhase(task, attention)} · ${displayTitle(task)}`;
}

/**
 * Width-bounded plain text with "…". Unlike truncateToWidth it emits no ANSI
 * reset, so a row coloured by the caller keeps its colour after the ellipsis.
 */
export function clip(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let out = "";
  for (const { segment } of new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  }).segment(text)) {
    if (visibleWidth(out + segment) > width - 1) break;
    out += segment;
  }
  return `${out}…`;
}

/** Human row for the widget and panel: no IDs; title shrinks first so status stays visible. */
export function taskRow(
  task: TaskView,
  prefix: string,
  width: number,
  tasks: TaskView[] = [],
  attention?: Attention,
  now = Date.now(),
): string {
  const detail = taskDetail(task, tasks, attention, now).text;
  const right = [
    taskPhase(task, attention),
    supersededBy(task, tasks) ? "sustituida" : undefined,
    detail,
    elapsed(task, now),
  ]
    .filter(Boolean)
    .join(" · ");
  const left = `${prefix}${stateIcon[task.state]} ${engineName(task.engine).padEnd(6)} `;
  const room = Math.max(
    8,
    width - visibleWidth(left) - visibleWidth(right) - 2,
  );
  const title = clip(displayTitle(task), room);
  return clip(
    `${left}${title}${" ".repeat(Math.max(1, room - visibleWidth(title) + 1))} ${right}`,
    Math.max(1, width),
  );
}

/** Card sections, so the TUI can render a completed result as markdown. All strings are sanitized. */
export function taskCardParts(
  task: TaskView,
  expanded = false,
  attention?: Attention,
): { head: string; body?: { text: string; markdown: boolean }; tail: string } {
  const result = safeText(
    task.error
      ? `${friendlyError(task.error)}${task.partialResult ? `\n\n${task.partialResult}` : ""}`
      : (task.result ?? ""),
  );
  const preview =
    expanded || result.length <= 480 ? result : `${result.slice(0, 480)}…`;
  const tokens = formatTokens(task.usage) ?? contextLabel(task);
  const head = [
    `${stateIcon[task.state]} ${displayTitle(task)}`,
    `${taskPhase(task, attention)} · ${elapsed(task)}${tokens ? ` · ${tokens}` : ""}`,
    modelLabel(task),
  ];
  if (!isTerminal(task) && task.lastActivity)
    head.push(`Ahora: ${activityLabel(task.lastActivity)}`);
  const tail: string[] = [];
  const changes = changesLine(task);
  if (changes) tail.push(changes);
  if (task.web && expanded)
    tail.push("Con acceso a internet (autorizado por ti para esta tarea).");
  if (task.state === "failed") tail.push(failureAdvice(task));
  if (expanded) {
    tail.push(
      `Tarea: ${task.id} · intento: ${task.attemptId}`,
      `Workspace: ${safeText(task.cwd)}`,
      `Sesión nativa: ${safeText(task.runtimeSessionId ?? "no registrada")}`,
    );
    if (task.error && friendlyError(task.error) !== safeText(task.error))
      tail.push(`Error original: ${safeText(task.error)}`);
    const selection = selectionDetail(task);
    if (selection) tail.push(safeText(selection));
  } else
    tail.push(
      `/orch para abrir el panel${result.length > 480 ? " · expande para leer más" : ""}`,
    );
  return {
    head: safeText(head.join("\n")),
    ...(preview
      ? {
          body: {
            text: task.error ? `Motivo: ${preview}` : preview,
            markdown: !task.error && task.state === "completed",
          },
        }
      : {}),
    tail: safeText(tail.join("\n")),
  };
}

/** Shared plain-text card for the transcript and TUI; technical identities are opt-in. */
export function taskCard(
  task: TaskView,
  expanded = false,
  attention?: Attention,
): string {
  const parts = taskCardParts(task, expanded, attention);
  return [
    parts.head,
    ...(parts.body ? ["", parts.body.text] : []),
    "",
    parts.tail,
  ].join("\n");
}
export function elapsed(task: TaskView, now = Date.now()): string {
  return short(
    (task.endedAt ? Date.parse(task.endedAt) : now) -
      Date.parse(task.createdAt),
  );
}
export function subtree(tasks: TaskView[], id: string): TaskView[] {
  const ids = new Set([id]);
  let size: number;
  do {
    size = ids.size;
    for (const task of tasks)
      if (task.parentId && ids.has(task.parentId)) ids.add(task.id);
  } while (size !== ids.size);
  return tasks.filter((task) => ids.has(task.id));
}
export function resolveTask(tasks: TaskView[], reference: string): TaskView {
  const exact = tasks.find((task) => task.id === reference);
  if (exact) return exact;
  const matches =
    reference.length >= 8
      ? tasks.filter((task) => task.id.startsWith(reference))
      : [];
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? "Identificador ambiguo; utiliza el ID completo"
        : "Tarea desconocida; utiliza el ID o un prefijo de al menos 8 caracteres",
    );
  return matches[0]!;
}

/**
 * Permission/question details arrive as runtime JSON. Show what will happen —
 * command and paths first — instead of a raw blob. Untrusted: sanitized and bounded.
 */
export function formatInteractionDetail(detail: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(detail);
  } catch {
    return safeText(detail).slice(0, 4_000);
  }
  if (!parsed || typeof parsed !== "object")
    return safeText(String(parsed)).slice(0, 4_000);
  const { request, input } = parsed as { request?: unknown; input?: unknown };
  const lines: string[] = [];
  if (typeof request === "string" && request.trim())
    lines.push(`Solicitud: ${oneLine(request).slice(0, 400)}`);
  const flat: [string, string][] = [];
  const walk = (value: unknown, path: string, depth: number) => {
    if (flat.length >= 24) return;
    if (value === null || value === undefined) return;
    if (typeof value !== "object") {
      flat.push([path, String(value)]);
      return;
    }
    if (depth >= 3) {
      flat.push([path, JSON.stringify(value).slice(0, 200)]);
      return;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>))
      walk(child, path ? `${path}.${key}` : key, depth + 1);
  };
  walk(input ?? (request === undefined ? parsed : {}), "", 0);
  const weight = (key: string) =>
    /command|cmd|commandline|script|code/i.test(key)
      ? 0
      : /path|file|cwd|dir|url|target/i.test(key)
        ? 1
        : 2;
  const label = (key: string) =>
    /command|cmd|commandline/i.test(key)
      ? "Comando"
      : /path|file/i.test(key)
        ? "Archivo"
        : /cwd|dir/i.test(key)
          ? "Directorio"
          : /url/i.test(key)
            ? "URL"
            : key;
  for (const [key, value] of flat.sort((a, b) => weight(a[0]) - weight(b[0]))) {
    const text = safeText(value);
    const shown =
      text.length > 600
        ? `${text.slice(0, 600)}… (${text.length} caracteres)`
        : text;
    lines.push(
      weight(key) === 0
        ? `${label(key)}:\n  ${shown.replace(/\n/g, "\n  ")}`
        : `${label(key)}: ${shown.replace(/\n/g, " ")}`,
    );
  }
  return lines.length
    ? lines.join("\n")
    : "El motor no envió detalles de la operación. Deniega si no puedes verificarla.";
}

/** "contexto 13.6k de 1.0M": occupancy, labelled so it is never read as consumption. */
export function contextLabel(task: TaskView): string | undefined {
  if (!task.context) return undefined;
  const k = (n: number) =>
    n >= 1_000_000
      ? `${(n / 1_000_000).toFixed(1)}M`
      : n >= 1_000
        ? `${(n / 1_000).toFixed(1)}k`
        : String(n);
  return `contexto ${k(task.context.used)} de ${k(task.context.size)}`;
}

const ISOLATION_TEXT: Record<"not-git" | "no-commit" | "disabled", string> = {
  "not-git":
    "⚠ SIN AISLAMIENTO: no es un repositorio git; escribirá directamente en tus archivos.",
  "no-commit":
    "⚠ SIN AISLAMIENTO: el repositorio no tiene commits; escribirá directamente en tus archivos.",
  disabled:
    "⚠ SIN AISLAMIENTO: PI_ORCHESTRATOR_ISOLATE_WRITES=0; escribirá directamente en tus archivos.",
};

/**
 * Body of the YOLO confirmation. Must match what the adapters really enforce:
 * a worktree only separates checkouts, and only Codex/Claude add an OS sandbox.
 * Antigravity's adapter has none (measured: no sandbox flag reaches its runtime).
 */
export function yoloConfirmation(
  engine: Engine,
  isolation: IsolationPreview,
  sandbox: "on" | "off",
): string {
  const lines = [
    "Ejecutará comandos y modificará archivos SIN pedir aprobación.",
  ];
  lines.push(
    isolation.isolated
      ? "Trabaja en un worktree aislado: tu checkout no se toca y tú revisas el diff antes de aplicarlo. Un worktree separa archivos del repositorio; no es un sandbox."
      : ISOLATION_TEXT[isolation.reason],
  );
  const missing = isolation.isolated
    ? (isolation.untracked ?? 0) + (isolation.ignored ?? 0)
    : 0;
  if (isolation.isolated && missing) {
    const parts = [
      isolation.untracked
        ? `${isolation.untracked} ${isolation.untracked === 1 ? "archivo sin versionar" : "archivos sin versionar"}`
        : "",
      isolation.ignored
        ? `${isolation.ignored} ${isolation.ignored === 1 ? "ruta ignorada" : "rutas ignoradas"}`
        : "",
    ]
      .filter(Boolean)
      .join(" y ");
    lines.push(
      `⚠ No se copian al worktree: ${parts}${isolation.examples?.length ? ` (p. ej. ${isolation.examples.join(", ")})` : ""}. Si la tarea los necesita (.env, dependencias, archivos nuevos sin git add), fallará o verá un proyecto incompleto.`,
    );
  }
  if (engine === "antigravity")
    lines.push(
      "⚠ SIN SANDBOX: Antigravity puede escribir fuera del worktree, usar la red y leer credenciales de tu cuenta.",
    );
  else if (sandbox === "off")
    lines.push(
      "⚠ SIN SANDBOX (PI_ORCHESTRATOR_YOLO_SANDBOX=off): puede escribir en cualquier ruta y usar la red.",
    );
  else if (engine === "codex")
    lines.push(
      "Sandbox de Codex: escribe solo en el directorio de trabajo y temporales, sin red.",
    );
  else
    lines.push(
      "Sandbox de Claude Code solo para Bash (sin red). Write/Edit no pasan por ese sandbox y pueden escribir fuera del worktree.",
    );
  lines.push("Confirma solo si tú lo pediste explícitamente.");
  return lines.join("\n");
}

/** One line about a YOLO task's isolated changes, or undefined. */
export function changesLine(task: TaskView): string | undefined {
  const changes = task.changes;
  if (task.workspace === "in-place")
    return "Sin aislamiento (no es un repositorio git con commits, o el aislamiento está desactivado): los cambios se escribieron directamente.";
  if (!changes)
    return task.workspace === "worktree" && !isTerminal(task)
      ? "Escribe en un worktree aislado; tu repositorio no se toca."
      : undefined;
  if (changes.state === "none") return "Sin cambios en archivos.";
  const size = `${changes.files} ${changes.files === 1 ? "archivo" : "archivos"} · +${changes.insertions} −${changes.deletions}`;
  return {
    pending: `Cambios pendientes de revisión: ${size} · a aplicar · x descartar${changes.error ? ` · ${changes.error}` : ""}`,
    applied: `Cambios aplicados a tu repositorio: ${size}`,
    discarded: `Cambios descartados: ${size}`,
  }[changes.state];
}

export function helpText(advanced: string): string {
  return [
    "Uso: /orch INSTRUCCIÓN en lenguaje natural",
    "  /orch delega a agy 3.8 flash high para explorar este repo sin modificar archivos",
    "  /orch usa codex high para revisar los tests y claude para resumir el README",
    "  /orch claude: resume el README   (directo: sin pasar por el modelo principal)",
    "",
    "Panel: /orch (o /orch panel)",
    "  ↑↓ elegir · s redirigir · r continuar · R reintentar · e editor · i insertar en el chat",
    "  y copiar · a aplicar cambios · x descartar cambios · c cancelar (y sus subtareas) · d detalles · f filtro",
    "  PgUp/PgDn leer · Esc volver",
    "",
    "YOLO en un repositorio git con commits: la tarea escribe en un worktree aislado (no es un sandbox; Antigravity no tiene sandbox);",
    "  tú revisas el diff y lo aplicas (a o /orch apply ID) o lo descartas (x o /orch discard ID).",
    "",
    "Comandos: status · result ID · cancel ID · apply ID · discard ID · usage · config · engines · history · reset",
    "Avanzado:",
    `  ${advanced.split(" | ").join("\n  ")}`,
    "",
    "Variables PI_ORCHESTRATOR_*: /orch config muestra todas, su valor efectivo y su origen.",
  ].join("\n");
}

export function usageReport(
  usage:
    | {
        runtimeMs: number;
        maxRuntimeMs?: number;
        activeSlots: number;
        tasks: number;
        queued: number;
        maxTasks: number;
        maxConcurrent: number;
        maxTokens?: number;
        maxCostUsd?: number;
        spend?: { tokens: number; costUsd: number; estimatedTokens?: number };
        orchestration?: OrchestrationMetrics;
      }
    | undefined,
  tasks: TaskView[],
): string {
  const lines = ["Uso del orquestador"];
  if (!usage) lines.push("Aún no se ha iniciado ninguna tarea en esta sesión.");
  else {
    lines.push(
      `Tareas: ${usage.tasks}/${usage.maxTasks} · simultáneas ${usage.activeSlots}/${usage.maxConcurrent}${usage.queued ? ` · ${usage.queued} en cola` : ""}`,
    );
    lines.push(
      `Tiempo de ejecución acumulado: ${short(usage.runtimeMs)}${usage.maxRuntimeMs ? ` de ${short(usage.maxRuntimeMs)}` : ""}`,
    );
    if (usage.maxTokens !== undefined && usage.spend)
      lines.push(
        `Tope de tokens: ${usage.spend.tokens.toLocaleString("es")} de ${usage.maxTokens.toLocaleString("es")} (PI_ORCHESTRATOR_MAX_TOKENS${usage.spend.estimatedTokens ? `; incluye ≥${usage.spend.estimatedTokens.toLocaleString("es")} estimados de Antigravity` : ""})`,
      );
    if (usage.maxCostUsd !== undefined && usage.spend)
      lines.push(
        `Tope de coste: $${usage.spend.costUsd.toFixed(2)} de $${usage.maxCostUsd.toFixed(2)} (solo Claude informa dólares; PI_ORCHESTRATOR_MAX_COST_USD)`,
      );
  }
  const reported = tasks.filter((task) => task.usage);
  if (reported.length) {
    const total = reported.reduce<TaskUsage>(
      (sum, task) => ({
        inputTokens: sum.inputTokens + task.usage!.inputTokens,
        cachedInputTokens:
          sum.cachedInputTokens + task.usage!.cachedInputTokens,
        outputTokens: sum.outputTokens + task.usage!.outputTokens,
        reasoningTokens:
          (sum.reasoningTokens ?? 0) + (task.usage!.reasoningTokens ?? 0),
        ...(sum.cacheWriteTokens !== undefined ||
        task.usage!.cacheWriteTokens !== undefined
          ? {
              cacheWriteTokens:
                (sum.cacheWriteTokens ?? 0) +
                (task.usage!.cacheWriteTokens ?? 0),
            }
          : {}),
        ...(sum.costUsd !== undefined || task.usage!.costUsd !== undefined
          ? { costUsd: (sum.costUsd ?? 0) + (task.usage!.costUsd ?? 0) }
          : {}),
      }),
      { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    );
    lines.push(
      `Tokens reportados por los motores: ${formatTokens(total)} (${reported.length} de ${tasks.length} tareas)`,
    );
    for (const engine of ["codex", "claude", "antigravity"] as const) {
      const own = reported.filter((task) => task.engine === engine);
      if (own.length)
        lines.push(
          `  ${engineName(engine)}: ${formatTokens(own.reduce<TaskUsage>((sum, task) => ({ inputTokens: sum.inputTokens + task.usage!.inputTokens, cachedInputTokens: sum.cachedInputTokens + task.usage!.cachedInputTokens, outputTokens: sum.outputTokens + task.usage!.outputTokens }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }))}`,
        );
    }
  } else if (tasks.length && !tasks.some((task) => task.context))
    lines.push(
      "Ningún motor ha reportado tokens todavía (Antigravity no los informa).",
    );
  const estimated = tasks.filter((task) => !task.usage && task.context);
  if (estimated.length)
    lines.push(
      `Estimación de entrada sin contador (${estimated.length} ${estimated.length === 1 ? "tarea" : "tareas"}, sobre todo Antigravity): ≥${estimated.reduce((sum, task) => sum + (task.context!.peak ?? task.context!.used), 0).toLocaleString("es")} tokens, cota inferior por el contexto máximo.`,
    );
  if (usage?.orchestration)
    lines.push(...orchestrationLines(usage.orchestration));
  lines.push("No es una factura: son los contadores que informa cada motor.");
  return lines.join("\n");
}

/** Counters from older archives may lack newer metrics: they count as zero. */
export function metricsWithDefaults(
  partial: Record<string, number>,
): OrchestrationMetrics {
  const zero: OrchestrationMetrics = {
    boundedExpiries: 0,
    waitClamps: 0,
    childQueued: 0,
    nestedRejected: 0,
    queueDispatches: 0,
    queueWaitMsTotal: 0,
    queueWaitMsMax: 0,
    waitCalls: 0,
    waitedTasks: 0,
    batchWakes: 0,
    earlyFailureWakes: 0,
    spendAborts: 0,
    queueExpired: 0,
  };
  for (const key of Object.keys(zero) as (keyof OrchestrationMetrics)[])
    if (typeof partial[key] === "number") zero[key] = partial[key];
  return zero;
}

/** Scheduling counters, so each decision can be measured in real sessions and tuned. */
export function orchestrationLines(metrics: OrchestrationMetrics): string[] {
  const m = metrics;
  const span = (ms: number) => (ms < 1_000 ? `${ms} ms` : short(ms));
  const average = m.queueDispatches
    ? Math.round(m.queueWaitMsTotal / m.queueDispatches)
    : 0;
  return [
    "Orquestación:",
    `  Cola: ${m.queueDispatches} esperaron una plaza (media ${span(average)}, máx. ${span(m.queueWaitMsMax)}) · ${m.childQueued} subtareas en cola · ${m.nestedRejected} subtareas rechazadas · ${m.queueExpired} caducadas en cola`,
    `  Plazos: ${m.boundedExpiries} subtareas cortadas por el plazo del padre · ${m.waitClamps} esperas anidadas acortadas`,
    `  Esperas: ${m.waitCalls} llamadas para ${m.waitedTasks} tareas${m.waitCalls ? ` (${(m.waitedTasks / m.waitCalls).toFixed(1)} por llamada)` : ""}`,
    `  Despertares del modelo: ${m.batchWakes} por lote terminado · ${m.earlyFailureWakes} anticipados por fallo${m.spendAborts ? ` · ${m.spendAborts} cancelaciones por tope de gasto` : ""}`,
  ];
}
