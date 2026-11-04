import { registerOrchestratorTools } from "./extension-tools.ts";
import { registerOrchestratorCommands } from "./extension-commands.ts";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  truncateToWidth,
  type Component,
} from "@earendil-works/pi-tui";
import { TaskDashboard, type PanelAction } from "./dashboard.ts";
import {
  displayTitle,
  engineName,
  groupedRows,
  shortTitle,
  safeText,
  summary,
  taskLine,
  taskRows,
  taskCard,
  taskCardParts,
  taskRow,
  isStalled,
  modelLabel,
  failureAdvice,
  friendlyError,
  formatInteractionDetail,
  helpText,
  yoloConfirmation,
  type Attention,
} from "./presentation.ts";
import { createService } from "./service.ts";
import { DeliveryLedger, modelTask } from "./model-view.ts";
import { type HistoryPage, type RunRecord } from "./journal.ts";
import { productDefaults, runtimeConfiguration } from "./configuration.ts";
import { detectAntigravity } from "./antigravity-installation.ts";
import { reconcileRun, reconciliationWarning } from "./reconciliation.ts";
import { errorText, isTerminal, yoloSandbox, type TaskView } from "./types.ts";
import { isolationPreview } from "./workspace.ts";

/** Same precedence as the service: product default, then the environment. */
const isolationEnabled = () => {
  try {
    return (
      { ...productDefaults, ...runtimeConfiguration() }.isolateWrites !== false
    );
  } catch {
    return true;
  }
};

type TerminalHandle = {
  terminal: { write(data: string): void };
  requestRender(): void;
};

/** Markdown for sanitized result text; plain wrapping if Pi's theme is unavailable (tests, RPC). */
function markdownLines(text: string, width: number): string[] {
  try {
    return new Markdown(text, 0, 0, getMarkdownTheme()).render(
      Math.max(1, width),
    );
  } catch {
    return new Text(text, 0, 0).render(Math.max(1, width));
  }
}
class Stack implements Component {
  constructor(private readonly parts: Component[]) {}
  render(width: number): string[] {
    return this.parts.flatMap((part) => part.render(width));
  }
  invalidate(): void {
    for (const part of this.parts) part.invalidate?.();
  }
}
const markdownComponent = (text: string): Component => ({
  render: (width) => markdownLines(text, width),
  invalidate() {},
});

/** Clipboard via the OS tool when present, else OSC 52 through the terminal. Returns how it was copied. */
async function copyText(
  text: string,
  tui: TerminalHandle | undefined,
): Promise<string | undefined> {
  const tools: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : [
          ["wl-copy", []],
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
        ];
  for (const [command, args] of tools) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(command, args, {
          stdio: ["pipe", "ignore", "ignore"],
        });
        const timer = setTimeout(() => {
          child.kill();
          resolve(false);
        }, 3_000);
        child.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve(code === 0);
        });
        child.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
    if (ok) return command;
  }
  if (!tui || Buffer.byteLength(text) > 100_000) return undefined;
  try {
    tui.terminal.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return "OSC 52";
  } catch {
    return undefined;
  }
}

const usage =
  "/orch [panel] | start codex|claude|antigravity PROMPT | run codex|claude|antigravity PROMPT | status | result ID | cancel ID | apply ID | discard ID | reset | demo | history | inspect RUN | reconcile RUN | restart RUN TASK --accept-duplicate-risk PROMPT | engines | usage | capabilities TASK | steer TASK TEXT | resume TASK TEXT";
const demoPrompt =
  "You must delegate exactly one task to the claude engine using the pi_orchestrator MCP delegate tool: compute 17 * 19 and explain in one sentence. Use requestKey 'arithmetic-review'. Wait for the task to complete with the MCP wait tool. Return its task id, status and answer. Do not solve it yourself or launch other workers.";

/** Injection is only for local tests. Import/registration never opens sockets or starts processes. */
export function createOrchestratorExtension(
  serviceFactory: typeof createService = createService,
  defaults: { stateDirectory?: string } = {},
) {
  return function orchestratorExtension(pi: ExtensionAPI) {
    let service: Promise<Awaited<ReturnType<typeof createService>>> | undefined;
    let active = true;
    // History is on by default for the real extension (a private directory under
    // ~/.pi/agent); PI_ORCHESTRATOR_STATE_DIR overrides it and "off" disables it.
    const configuredState = process.env.PI_ORCHESTRATOR_STATE_DIR?.trim();
    const stateDirectory =
      configuredState === "off"
        ? undefined
        : configuredState || defaults.stateDirectory;
    let latestContext: ExtensionContext | undefined;
    const snapshots = new Map<string, TaskView>();
    const attention = new Map<string, Attention>();
    const listeners = new Set<() => void>();
    const tasks = () => [...snapshots.values()];
    // Tasks the model delegated itself: it receives their result through
    // orchestrator_wait, so the settled notice must not repeat it in context.
    // Model-delegated root tasks → the agent run that delegated them (its batch).
    const toolTasks = new Map<string, number>();
    let agentRun = 0;
    // `content` is the compact model view (results sent once per task);
    // `details` keeps the full TaskView for the TUI renderers.
    const ledger = new DeliveryLedger();
    const reply = (data: unknown, model: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(model) }],
      details: data,
    });
    let coreRef: Awaited<ReturnType<typeof createService>>["core"] | undefined;
    // `continuable`: the model may follow up in the same native session (cheaper than a fresh task).
    const hints = (task: TaskView, view: Record<string, unknown>) => {
      try {
        return coreRef?.controls(null, task.id).resumeReady
          ? { ...view, continuable: true }
          : view;
      } catch {
        return view;
      }
    };
    const once = (task: TaskView) =>
      hints(task, modelTask(task, ledger.take(task)));
    // Hosts that outlive a turn (TUI, RPC) can wake the model when a batch ends,
    // so it need not block in orchestrator_wait. Print/JSON runs end with the turn.
    const deferred = () =>
      latestContext?.mode === "tui" || latestContext?.mode === "rpc";
    const NEXT_DEFERRED =
      "No esperes: termina tu turno con una línea breve. Cuando terminen todas las tareas que delegaste, sus resultados llegarán en un único mensaje que inicia tu siguiente turno. Usa orchestrator_wait solo si necesitas el resultado para continuar en este mismo turno.";
    const NEXT_BLOCKING =
      "Llama a orchestrator_wait con los taskIds de este lote hasta que todos sean terminales.";
    /** Active orchestrator_wait calls per task: those results are delivered by the wait itself. */
    const waiting = new Map<string, number>();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    /**
     * One wake-up per batch: when no model-delegated root task is live, the
     * results the model has not received yet go out in a single message.
     * Per-task notices made the model spend a turn on each ("already included").
     */
    const flush = () => {
      flushTimer = undefined;
      if (!active) return;
      // A batch is what one agent run delegated: a long task from an earlier run
      // must not hold back the results of a later, faster batch.
      const batches = new Map<number, TaskView[]>();
      for (const [id, run] of toolTasks) {
        const task = snapshots.get(id);
        if (task) batches.set(run, [...(batches.get(run) ?? []), task]);
      }
      const pending: TaskView[] = [];
      for (const batch of batches.values()) {
        if (batch.some((task) => !isTerminal(task))) continue;
        pending.push(
          ...batch.filter(
            (task) => !waiting.has(task.id) && !ledger.has(task.id),
          ),
        );
        for (const task of batch)
          if (!waiting.has(task.id)) toolTasks.delete(task.id);
      }
      if (!pending.length || !deferred()) return;
      for (const task of pending) ledger.mark(task.id);
      const failed = pending.filter(
        (task) => task.state !== "completed",
      ).length;
      pi.sendMessage(
        {
          customType: "orchestrator",
          display: true,
          details: { batch: pending },
          content: `[Orquestador] Terminó el lote de ${pending.length} ${pending.length === 1 ? "tarea" : "tareas"} que delegaste${failed ? ` (${failed} sin completar)` : ""}. Resultados (cada uno se entrega una sola vez):\n${JSON.stringify(pending.map((task) => modelTask(task, "include")))}\nResume para el operador; no vuelvas a esperar estas tareas.`,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    };
    // A short debounce lets an in-flight orchestrator_wait mark its tasks delivered first.
    const scheduleFlush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = setTimeout(flush, 250);
      flushTimer.unref?.();
    };
    // `content` reaches the model; `details` drives the TUI card. A model-facing
    // override keeps the full card for the human without duplicating tokens.
    const message = (content: unknown, modelContent?: string) =>
      pi.sendMessage({
        customType: "orchestrator",
        content:
          modelContent ??
          (content && typeof content === "object" && "task" in content
            ? taskCard((content as { task: TaskView }).task, true)
            : JSON.stringify(content, null, 2)),
        display: true,
        details: content,
      });
    const attentionOf = (id: string) => attention.get(id);
    const appended = new Map<string, number>();
    // The terminal of the live TUI, captured from Pi's own component factories.
    let tuiRef: TerminalHandle | undefined;
    let ticker: ReturnType<typeof setInterval> | undefined;
    const notifyMode = (() => {
      const value = process.env.PI_ORCHESTRATOR_NOTIFY?.trim() || "desktop";
      return value === "bell" || value === "off" ? value : "desktop";
    })();
    /** In-TUI notice plus an optional terminal notification (useful from another tab or pane). */
    const alert = (
      title: string,
      body: string,
      level: "info" | "warning" | "error" = "info",
    ) => {
      const context = latestContext;
      if (!active || context?.mode !== "tui") return;
      try {
        context.ui.notify(safeText(`${title}: ${body}`), level);
      } catch {
        /* observer only */
      }
      if (notifyMode === "off" || !tuiRef) return;
      const clean = (text: string) =>
        safeText(text)
          .replace(/[;\\]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
      try {
        tuiRef.terminal.write(
          notifyMode === "bell"
            ? "\x07"
            : `\x1b]777;notify;${clean(title)};${clean(body)}\x07`,
        );
      } catch {
        /* observer only */
      }
    };
    // The widget renders live from `tasks()`: install it once per context and only
    // ask for a repaint afterwards (measured: one reinstall per event before).
    let widgetContext: ExtensionContext | undefined;
    let panelOpen = false;
    let lastStatus: string | undefined;
    const refresh = () => {
      for (const listener of listeners) {
        try {
          listener();
        } catch {
          /* independent view */
        }
      }
      if (latestContext?.mode !== "tui") return;
      const current = tasks();
      const live = current.some((task) => !isTerminal(task));
      // Elapsed time and stall warnings change without events: tick only while work is live.
      if (live && !ticker) {
        ticker = setInterval(() => {
          try {
            tuiRef?.requestRender();
          } catch {
            /* closed */
          }
        }, 1_000);
        ticker.unref();
      }
      if (!live && ticker) {
        clearInterval(ticker);
        ticker = undefined;
      }
      // One place at a time: the widget (or the open panel) already says everything,
      // so the footer status would only repeat it. Cleared once for older sessions.
      if (lastStatus !== "" || widgetContext !== latestContext) {
        latestContext.ui.setStatus("orchestrator", undefined);
        lastStatus = "";
      }
      if (!current.length) {
        latestContext.ui.setWidget("orchestrator", undefined);
        widgetContext = undefined;
        return;
      }
      if (widgetContext === latestContext && tuiRef) {
        try {
          tuiRef.requestRender();
        } catch {
          /* closed */
        }
        return;
      }
      widgetContext = latestContext;
      latestContext.ui.setWidget("orchestrator", (tui, theme) => {
        tuiRef = tui as unknown as TerminalHandle;
        return {
          render(width) {
            // The open panel shows everything: never draw the same tasks twice.
            if (panelOpen) return [];
            const all = tasks();
            const now = Date.now();
            const rows = groupedRows(all, attentionOf, now);
            const live = rows.filter((row) => !row.finished);
            const finishedRoots = rows
              .filter((row) => row.finished && row.depth === 0)
              .map((row) => row.task);
            const failed = finishedRoots.some(
              (task) => task.state === "failed",
            );
            const done = finishedRoots.length
              ? `${summary(finishedRoots)}`
              : "";
            // Nothing left to watch: one quiet line instead of a permanent block.
            if (!live.length) {
              return [
                truncateToWidth(
                  theme.fg(
                    failed ? "error" : "success",
                    `${failed ? "!" : "✓"} Orquestador · ${done || "sin tareas"}`,
                  ) +
                    theme.fg(
                      "dim",
                      failed ? " · /orch para revisar" : " · /orch",
                    ),
                  Math.max(1, width),
                ),
              ];
            }
            // Only live work and what needs you; finished work is a counter.
            const shown = live.slice(0, 4);
            return [
              truncateToWidth(
                theme.fg("accent", "Orquestador") +
                  theme.fg(
                    "muted",
                    ` · ${summary(
                      live.map((row) => row.task),
                      attentionOf,
                    )}`,
                  ) +
                  theme.fg(
                    "dim",
                    `${done ? ` · terminadas: ${done}` : ""} · /orch`,
                  ),
                Math.max(1, width),
              ),
              ...shown.map(({ task, prefix }) => {
                const tone =
                  attention.has(task.id) ||
                  isStalled(task, all, now) ||
                  task.state === "cancelling"
                    ? "warning"
                    : task.state === "failed"
                      ? "error"
                      : task.state === "completed"
                        ? "success"
                        : "muted";
                return theme.fg(
                  tone,
                  taskRow(
                    task,
                    prefix,
                    Math.max(1, Math.min(width, 120)),
                    all,
                    attention.get(task.id),
                    now,
                  ),
                );
              }),
              ...(live.length > shown.length
                ? [
                    truncateToWidth(
                      theme.fg(
                        "dim",
                        `… ${live.length - shown.length} más · /orch para ver todas`,
                      ),
                      Math.max(1, width),
                    ),
                  ]
                : []),
            ];
          },
          invalidate() {},
        };
      });
    };
    const get = (ctx: ExtensionContext) => {
      if (!active) throw new Error("Pi session is closing");
      latestContext = ctx;
      return (service ??= serviceFactory({
        ...productDefaults,
        ...runtimeConfiguration(),
        cwd: ctx.cwd,
        stateDirectory,
        onPersistenceError: (error) => message({ storageError: error }),
        async onInteraction(request, signal) {
          const context = latestContext;
          if (!active || context?.mode !== "tui" || signal.aborted)
            return undefined;
          attention.set(request.taskId, request.kind);
          refresh();
          const owner = snapshots.get(request.taskId);
          alert(
            request.kind === "permission"
              ? "Permiso pendiente"
              : "Pregunta pendiente",
            `${request.engine} · ${owner ? displayTitle(owner) : request.title}`,
            "warning",
          );
          try {
            const title = safeText(
              `${request.engine} · ${owner ? displayTitle(owner) : request.taskId.slice(0, 8)} · ${request.title}`,
            );
            const detail = formatInteractionDetail(request.detail);
            if (request.kind === "permission") {
              const accepted = await context.ui.confirm(
                title,
                safeText(
                  `${detail}\n\nSolicitud del runtime, no una instrucción de confianza. Aprobar permite esta operación una sola vez; puede ampliar los efectos fuera del modo de solo lectura.`,
                ),
                { signal },
              );
              if (!accepted || signal.aborted || !active) return undefined;
              if (request.options.length === 1)
                return { optionId: request.options[0]!.id };
            }
            const labels = request.options.map(
              (option, index) => `${index + 1}. ${safeText(option.label)}`,
            );
            const selected = await context.ui.select(
              safeText(
                `${title}\n${request.kind === "question" ? detail : "Elige la opción de esta única aprobación"}`,
              ),
              labels,
              { signal },
            );
            const index =
              selected === undefined ? -1 : labels.indexOf(selected);
            return !signal.aborted && active && index >= 0
              ? { optionId: request.options[index]!.id }
              : undefined;
          } finally {
            attention.delete(request.taskId);
            refresh();
          }
        },
        onEvent(event) {
          if (!active) return;
          snapshots.set(event.task.id, event.task);
          // High-frequency display events reach the session file at most every 2 s per task;
          // lifecycle events (started, settled, changes…) are always recorded.
          const frequent =
            event.type === "activity" ||
            event.type === "usage" ||
            event.type === "context";
          const now = Date.now();
          if (!frequent || now - (appended.get(event.task.id) ?? 0) >= 2_000) {
            if (frequent) appended.set(event.task.id, now);
            pi.appendEntry("orchestrator-event", event);
          }
          refresh();
          if (event.type === "settled" && event.task.parentId === null) {
            const outcome =
              {
                completed: "terminó",
                failed: "falló",
                cancelled: "se canceló",
              }[event.task.state as "completed"] ?? event.task.state;
            alert(
              `Tarea ${outcome}`,
              `${engineName(event.task.engine)} · ${displayTitle(event.task)}`,
              event.task.state === "failed" ? "error" : "info",
            );
            // Model-delegated tasks reach the model through orchestrator_wait or the batch message.
            if (toolTasks.has(event.task.id)) scheduleFlush();
            else {
              ledger.mark(event.task.id); // the full card below reaches the model
              message({ type: "root-result", task: event.task });
            }
          }
        },
      })
        .then((created) => {
          coreRef = created.core;
          return created;
        })
        .catch((error) => {
          service = undefined;
          throw error;
        }));
    };

    pi.on("session_start", () => {
      active = true;
    });
    pi.on("agent_start", () => {
      agentRun++;
    });
    pi.on("session_shutdown", async () => {
      active = false;
      const previous = service;
      service = undefined;
      try {
        await (await previous)?.close();
      } finally {
        if (ticker) {
          clearInterval(ticker);
          ticker = undefined;
        }
        latestContext?.ui.setStatus("orchestrator", undefined);
        latestContext?.ui.setWidget("orchestrator", undefined);
        widgetContext = undefined;
        lastStatus = undefined;
        appended.clear();
        snapshots.clear();
        attention.clear();
        listeners.clear();
        toolTasks.clear();
        ledger.clear();
        waiting.clear();
        latestContext = undefined;
        tuiRef = undefined;
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = undefined;
        }
      }
    });

    pi.registerMessageRenderer("orchestrator", (entry, options, theme) => {
      const batch = (entry.details as { batch?: TaskView[] } | undefined)
        ?.batch;
      if (Array.isArray(batch)) {
        // One card per task of the finished batch; results render as markdown.
        return new Stack([
          new Text(
            theme.fg("accent", "Orquestador") +
              theme.fg("muted", ` · lote terminado · ${summary(batch)}`),
            0,
            0,
          ),
          ...batch.flatMap((task) => {
            const parts = taskCardParts(task, options.expanded, undefined);
            const tone =
              task.state === "failed"
                ? "error"
                : task.state === "completed"
                  ? "success"
                  : "warning";
            return [
              new Text(
                "\n" +
                  theme.fg(tone, `${engineName(task.engine)} · ${parts.head}`),
                0,
                0,
              ),
              ...(parts.body
                ? [
                    parts.body.markdown
                      ? markdownComponent(parts.body.text)
                      : new Text(parts.body.text, 0, 0),
                  ]
                : []),
            ];
          }),
          new Text(
            "\n" +
              theme.fg(
                "dim",
                options.expanded
                  ? "Resultados completos arriba · /orch abre el panel"
                  : "Expande el mensaje para leer completo · /orch abre el panel",
              ),
            0,
            0,
          ),
        ]);
      }
      const data = entry.details as
        | {
            task?: TaskView;
            reset?: boolean;
            usage?: string;
            help?: boolean;
            report?: string;
            history?: HistoryPage;
            archive?: RunRecord;
            reconciliation?: ReturnType<typeof reconcileRun>;
            installation?: ReturnType<typeof detectAntigravity>;
          }
        | TaskView[]
        | TaskView
        | undefined;
      const selected =
        data && !Array.isArray(data)
          ? "task" in data
            ? data.task
            : "attemptId" in data
              ? data
              : undefined
          : undefined;
      let text: string;
      if (selected) {
        const parts = taskCardParts(
          selected,
          options.expanded,
          attention.get(selected.id),
        );
        let tail = parts.tail;
        if (selected.continuationSource)
          tail += `\nContinuación nativa de tarea ${selected.continuationSource.taskId} · intento nuevo, misma sesión nativa`;
        if (selected.recoverySource)
          tail += `\nIntento nuevo desde run ${selected.recoverySource.runId} · tarea ${selected.recoverySource.taskId}; no reanudación`;
        const tone =
          selected.state === "failed"
            ? "error"
            : selected.state === "completed"
              ? "success"
              : "accent";
        return new Stack([
          new Text(
            theme.fg("accent", "Orquestador") +
              "\n" +
              theme.fg(tone, parts.head),
            0,
            0,
          ),
          ...(parts.body
            ? [
                new Text("", 0, 0),
                parts.body.markdown
                  ? markdownComponent(parts.body.text)
                  : new Text(parts.body.text, 0, 0),
              ]
            : []),
          new Text("\n" + theme.fg("dim", tail), 0, 0),
        ]);
      } else if (data && !Array.isArray(data) && "help" in data && data.help) {
        text = helpText(usage);
      } else if (
        data &&
        !Array.isArray(data) &&
        "report" in data &&
        typeof data.report === "string"
      ) {
        text = data.report;
      } else if (
        data &&
        !Array.isArray(data) &&
        "history" in data &&
        data.history
      ) {
        const labels = {
          closed: "cierre registrado",
          current: "sesión actual",
          unreconciled: "sin reconciliar; podría seguir activo en otra sesión",
        };
        text = [
          "Historial persistido · solo lectura",
          ...data.history.runs.map(
            (run) =>
              `${run.runId} · ${labels[run.disposition]} · ${run.tasks} tareas\n${run.cwd}`,
          ),
          ...(data.history.unavailable.length
            ? [
                `Archivos no disponibles o inválidos: ${data.history.unavailable.join(", ")}`,
              ]
            : []),
          ...(data.history.omitted
            ? [
                `Vista limitada: ${data.history.omitted} archivos omitidos; usa inspect con su ID completo.`,
              ]
            : []),
          "/orch inspect RUN · /orch reconcile RUN · no reanuda ni cancela tareas históricas",
        ].join("\n");
      } else if (
        data &&
        !Array.isArray(data) &&
        "reconciliation" in data &&
        data.reconciliation
      ) {
        const plan = data.reconciliation;
        const visible = options.expanded ? plan.tasks : plan.tasks.slice(0, 8);
        text = [
          `Reconciliación · solo lectura · ${plan.runId}`,
          `Cierre: ${plan.closure}`,
          plan.warning,
          ...visible.map(
            (task) =>
              `${task.engine} ${task.taskId.slice(0, 8)} · guardado: ${task.recordedState} · ${task.observation}${task.recordedProcess ? `\nPID guardado ${task.recordedProcess.pid} · PGID ${task.recordedProcess.groupId ?? "no registrado"}` : ""}`,
          ),
          ...(visible.length < plan.tasks.length
            ? [
                `${plan.tasks.length - visible.length} tareas omitidas; expande el mensaje.`,
              ]
            : []),
        ].join("\n");
      } else if (
        data &&
        !Array.isArray(data) &&
        "archive" in data &&
        data.archive
      ) {
        const run = data.archive;
        text = [
          `Archivo ${run.runId} · ${run.closedAt ? "cierre registrado" : "sin cierre registrado"}`,
          reconciliationWarning,
          ...taskRows(run.tasks).map(
            ({ task, prefix }) =>
              `Estado guardado: ${taskLine(task, prefix)}${options.expanded ? `\nTarea ${task.id} · intento ${task.attemptId}\nSesión ${task.runtimeSessionId ?? "no registrada"}${task.recoverySource ? `\nReinicio explícito desde run ${task.recoverySource.runId} · tarea ${task.recoverySource.taskId} · intento ${task.recoverySource.attemptId}; no reanudación` : ""}\n${task.error ?? task.result ?? "Sin resultado guardado"}` : ""}`,
          ),
          ...(options.expanded
            ? []
            : ["Expande este mensaje para ver los resultados guardados."]),
        ].join("\n");
      } else if (
        data &&
        !Array.isArray(data) &&
        "installation" in data &&
        data.installation
      ) {
        text = `Antigravity: ${data.installation.status}\nACP: ${data.installation.executable ?? "no localizado"}\nNo se inició ningún servicio ni runtime. La presencia del binario no acredita autenticación ni compatibilidad.`;
      } else if (Array.isArray(data))
        text = [
          summary(data),
          ...taskRows(data).map(({ task, prefix }) => taskLine(task, prefix)),
        ].join("\n");
      else if (data && "reset" in data)
        text = "Orquestador reiniciado; runtimes anteriores cerrados.";
      else
        text = safeText(
          typeof entry.content === "string"
            ? entry.content
            : JSON.stringify(entry.content),
        );
      return new Text(
        theme.fg("accent", "Orquestador") + "\n" + safeText(text),
        0,
        0,
      );
    });

    // Presentation only: preserve structured tool results and model-facing JSON.
    pi.registerToolRenderer?.((name, next) => {
      if (
        ![
          "orchestrator_delegate",
          "orchestrator_status",
          "orchestrator_wait",
          "orchestrator_cancel",
          "orchestrator_continue",
        ].includes(name)
      )
        return next(); // engines: default rendering
      return {
        renderCall(args, theme) {
          const action = {
            orchestrator_delegate: "Delegar",
            orchestrator_status: "Consultar",
            orchestrator_wait: "Esperar",
            orchestrator_cancel: "Cancelar",
            orchestrator_continue: "Continuar",
          }[name];
          const input =
            args && typeof args === "object"
              ? (args as Record<string, unknown>)
              : {};
          const target =
            name === "orchestrator_delegate"
              ? [
                  input.engine,
                  typeof input.title === "string"
                    ? input.title
                    : typeof input.prompt === "string"
                      ? shortTitle(input.prompt)
                      : undefined,
                ]
                  .filter((value) => typeof value === "string")
                  .join(" · ")
              : typeof input.taskId === "string"
                ? tasks().find((task) =>
                    task.id.startsWith(String(input.taskId)),
                  )
                  ? displayTitle(
                      tasks().find((task) =>
                        task.id.startsWith(String(input.taskId)),
                      )!,
                    )
                  : String(input.taskId).slice(0, 8)
                : "tareas";
          return new Text(
            theme.fg("accent", `${action} · ${safeText(target)}`),
            0,
            0,
          );
        },
        renderResult(result, options) {
          const data = result.details as TaskView | TaskView[] | undefined;
          const text =
            data && !Array.isArray(data) && "attemptId" in data
              ? options.expanded
                ? taskCard(data, true, attention.get(data.id))
                : [
                    taskLine(data, "", attention.get(data.id)),
                    modelLabel(data),
                    ...(data.state === "failed" ? [failureAdvice(data)] : []),
                  ].join("\n")
              : Array.isArray(data)
                ? [
                    summary(data),
                    ...taskRows(data)
                      .slice(0, options.expanded ? data.length : 3)
                      .map(({ task, prefix }) =>
                        taskLine(task, prefix, attention.get(task.id)),
                      ),
                    ...(!options.expanded && data.length > 3
                      ? [`${data.length - 3} más · expande o abre /orch`]
                      : []),
                  ].join("\n")
                : result.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n");
          return new Text(
            safeText(options.expanded ? text : text.slice(0, 1_200)),
            0,
            0,
          );
        },
      };
    });

    registerOrchestratorTools(pi, {
      get,
      reply,
      once,
      deferred,
      isolationEnabled,
      ledger,
      waiting,
      scheduleFlush,
      NEXT_DEFERRED,
      NEXT_BLOCKING,
      track(task, ctx) {
        if (!toolTasks.has(task.id)) toolTasks.set(task.id, agentRun);
        latestContext = ctx;
      },
    });

    /** Runs a panel action. Returns true when the panel should reopen. */
    const panelAction = async (
      action: PanelAction,
      ctx: ExtensionContext,
      core: Awaited<ReturnType<typeof createService>>["core"],
    ): Promise<boolean> => {
      const task = tasks().find((entry) => entry.id === action.taskId);
      if (!task) {
        ctx.ui.notify("La tarea ya no está disponible.", "warning");
        return true;
      }
      // A partial answer is what the operator wants to keep from a cut-off task.
      const text = safeText(
        task.result ??
          task.partialResult ??
          (task.error ? friendlyError(task.error) : ""),
      );
      try {
        switch (action.kind) {
          case "steer": {
            const value = (
              await ctx.ui.input(
                `Redirigir la tarea de ${task.engine}`,
                "Nueva indicación para el turno actual…",
              )
            )?.trim();
            if (!value) return true;
            await core.steer(null, task.id, value);
            ctx.ui.notify(
              `${task.engine} recibió la indicación; eso no garantiza que la respuesta final la siga.`,
              "info",
            );
            return true;
          }
          case "resume": {
            const value = (
              await ctx.ui.input(
                `Continuar la sesión de ${task.engine}`,
                "Instrucción para continuar…",
              )
            )?.trim();
            if (!value) return true;
            message(core.resume(null, task.id, value, randomUUID()));
            return true;
          }
          case "retry": {
            if (
              task.permissionMode === "yolo" &&
              !(await ctx.ui.confirm(
                "Reintentar con YOLO",
                safeText(
                  `${task.engine} · ${task.title}\n\nEl reintento vuelve a ejecutarlo todo.\n${yoloConfirmation(task.engine, await isolationPreview(task.cwd, isolationEnabled()), yoloSandbox())}`,
                ),
              ))
            )
              return true;
            message(core.retry(null, task.id, randomUUID()));
            ctx.ui.notify("Reintento iniciado como una tarea nueva.", "info");
            return true;
          }
          case "apply": {
            const summary = task.changes
              ? `${task.changes.files} archivos · +${task.changes.insertions} −${task.changes.deletions}\n\n${task.changes.summary}`
              : "";
            if (
              !(await ctx.ui.confirm(
                "Aplicar cambios a tu repositorio",
                safeText(
                  `${task.engine} · ${task.title}\n\n${summary}\n\nSe aplicará el diff sobre tu árbol de trabajo (sin commit). Si hay conflictos no se escribe nada.`,
                ),
              ))
            )
              return true;
            await core.applyChanges(null, task.id);
            ctx.ui.notify(
              "Cambios aplicados a tu árbol de trabajo (sin commit).",
              "info",
            );
            return true;
          }
          case "discard": {
            if (
              !(await ctx.ui.confirm(
                "Descartar cambios",
                safeText(
                  `${task.engine} · ${task.title}\n\nSe borrará el worktree y su diff. No se puede deshacer.`,
                ),
              ))
            )
              return true;
            await core.discardChanges(null, task.id);
            ctx.ui.notify("Cambios descartados.", "info");
            return true;
          }
          case "copy": {
            const how = await copyText(text, tuiRef);
            ctx.ui.notify(
              how
                ? `Resultado copiado (${how}).`
                : "No se pudo copiar: no hay portapapeles disponible.",
              how ? "info" : "warning",
            );
            return true;
          }
          case "insert":
            ctx.ui.pasteToEditor(text);
            return false;
          case "editor": {
            // Read or edit; only a changed text is inserted into the chat.
            const edited = await ctx.ui.editor(
              safeText(`Resultado · ${task.title.slice(0, 60)}`),
              text,
            );
            if (edited?.trim() && edited !== text) ctx.ui.pasteToEditor(edited);
            return false;
          }
        }
      } catch (error) {
        ctx.ui.notify(
          `No se pudo completar la acción: ${friendlyError(errorText(error))}`,
          "error",
        );
        return true;
      }
    };

    registerOrchestratorCommands(pi, {
      get,
      currentService: () => service,
      message,
      tasks,
      stateDirectory,
      demoPrompt,
      async reset(ctx) {
        const previous = service;
        service = undefined;
        try {
          await (await previous)?.close();
        } finally {
          snapshots.clear();
          toolTasks.clear();
          ledger.clear();
          waiting.clear();
          latestContext = ctx;
          refresh();
        }
      },
      async openPanel(ctx) {
        const { core } = await get(ctx);
        // Actions that need Pi dialogs, the editor or the chat run after the panel
        // closes; quick ones reopen it so the operator keeps their place.
        panelOpen = true;
        refresh();
        try {
          for (;;) {
            const action = await ctx.ui.custom<PanelAction | undefined>(
              (tui, theme, keybindings, done) => {
                tuiRef = tui as unknown as TerminalHandle;
                return new TaskDashboard({
                  tasks,
                  attention: attentionOf,
                  theme,
                  keybindings,
                  rows: () => tui.terminal.rows,
                  requestRender: () => tui.requestRender(),
                  done: (selected) => done(selected),
                  subscribe(listener) {
                    listeners.add(listener);
                    return () => {
                      listeners.delete(listener);
                    };
                  },
                  cancel: (id) => core.cancel(null, id),
                  controls: (id) => {
                    const native = core.controls(null, id);
                    const task = tasks().find((entry) => entry.id === id);
                    return {
                      steer: native.steerReady,
                      resume: native.resumeReady,
                      retry: Boolean(
                        task && task.parentId === null && isTerminal(task),
                      ),
                    };
                  },
                  markdown: markdownLines,
                  prompt: (id) => core.promptOf(null, id),
                });
              },
            );
            if (!action) return;
            // Dialogs of an action run with the panel closed: show the widget meanwhile.
            panelOpen = false;
            refresh();
            const reopen = await panelAction(action, ctx, core);
            if (!reopen) return;
            panelOpen = true;
            refresh();
          }
        } finally {
          panelOpen = false;
          refresh();
        }
      },
    });
  };
}

export default createOrchestratorExtension(createService, {
  stateDirectory: join(homedir(), ".pi", "agent", "orchestrator-state"),
});
