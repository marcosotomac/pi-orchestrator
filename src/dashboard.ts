import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, Text, truncateToWidth, type Component, type KeybindingsManager } from "@earendil-works/pi-tui";
import { changesLine, contextLabel, elapsed, safeText, subtree, summary, urgentRows, taskRow, modelLabel, taskPhase, taskDetail, stateIcon, failureAdvice, friendlyError, formatTokens, activityLabel, isStalled, type Attention } from "./presentation.ts";
import { isTerminal, type TaskView } from "./types.ts";

/** Actions that need Pi dialogs, the editor or the chat run after the panel closes. */
export type PanelAction = { kind: "steer" | "resume" | "retry" | "editor" | "insert" | "copy" | "apply" | "discard"; taskId: string };
export interface PanelControls { steer: boolean; resume: boolean; retry: boolean }

export interface DashboardOptions {
  tasks: () => TaskView[];
  attention?: (id: string) => Attention | undefined;
  subscribe: (listener: () => void) => () => void;
  cancel: (id: string) => Promise<TaskView>;
  theme: Pick<Theme, "fg" | "bold">;
  keybindings: Pick<KeybindingsManager, "matches">;
  requestRender: () => void;
  rows: () => number;
  done: (action?: PanelAction) => void;
  /** Which native controls the selected task supports right now. */
  controls?: (id: string) => PanelControls;
  /** Renders trusted-sanitized markdown to lines; plain wrapping when absent. */
  markdown?: (text: string, width: number) => string[];
  now?: () => number;
}

/** A temporary Pi component, not another renderer or another agent interface. */
export class TaskDashboard implements Component {
  private list!: SelectList;
  private listHeight = 5;
  private width = 100;
  private selectedId?: string;
  private confirmationId?: string;
  private pendingId?: string;
  private notice = "";
  private offset = 0;
  private details = false;
  private filter: "all" | "active" | "failed" = "all";
  private pageSize = 6;
  private disposed = false;
  private unsubscribe: () => void;
  private timer: ReturnType<typeof setInterval>;

  constructor(private options: DashboardOptions) {
    this.refresh();
    this.unsubscribe = options.subscribe(() => { this.refresh(); this.renderNext(); });
    this.timer = setInterval(() => this.renderNext(), 1_000);
    this.timer.unref();
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }
  private visible(): TaskView[] {
    return this.options.tasks().filter((task) => this.filter === "all" || (this.filter === "active" ? !isTerminal(task) : task.state === "failed"));
  }

  private refresh(): void {
    const all = this.options.tasks();
    const rows = urgentRows(this.visible(), (id) => this.options.attention?.(id), this.now());
    const selected = this.selectedId;
    const theme = this.options.theme;
    this.listHeight = Math.max(1, Math.min(8, Math.floor(this.options.rows() / 4)));
    // SelectList adds a selection marker and its own right padding.
    this.list = new SelectList(rows.map(({ task, prefix }) => ({ value: task.id, label: taskRow(task, prefix, Math.max(20, this.width - 4), all, this.options.attention?.(task.id), this.now()) })), this.listHeight, {
      selectedPrefix: (text) => theme.fg("accent", text), selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text), scrollInfo: (text) => theme.fg("dim", text), noMatch: (text) => theme.fg("dim", text),
    });
    const index = rows.findIndex(({ task }) => task.id === selected);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.selectedId = this.list.getSelectedItem()?.value;
    this.list.onSelectionChange = (item) => { this.selectedId = item.value; this.offset = 0; this.notice = ""; };
  }

  private renderNext(): void { if (!this.disposed) this.options.requestRender(); }
  invalidate(): void { this.list.invalidate(); }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe();
  }
  private finish(action?: PanelAction): void { this.dispose(); this.options.done(action); }

  private controlsFor(task: TaskView | undefined): PanelControls {
    if (!task) return { steer: false, resume: false, retry: false };
    try { return this.options.controls?.(task.id) ?? { steer: false, resume: false, retry: false }; }
    catch { return { steer: false, resume: false, retry: false }; }
  }

  render(width: number): string[] {
    const height = Math.max(1, Math.min(8, Math.floor(this.options.rows() / 4)));
    if (this.listHeight !== height || this.width !== width) { this.width = width; this.refresh(); }
    const theme = this.options.theme;
    const tasks = this.options.tasks();
    const now = this.now();
    const task = tasks.find((entry) => entry.id === this.selectedId);
    const rule = theme.fg("dim", "─".repeat(Math.max(1, Math.min(width, 120))));
    const lines = [
      theme.fg("accent", theme.bold("Orquestador")) + theme.fg("muted", ` · ${summary(tasks, this.options.attention)}`),
      theme.fg("dim", `↑↓ elegir · f filtro: ${{ all: "todas", active: "activas", failed: "fallidas" }[this.filter]} · d ${this.details ? "ocultar" : "ver"} detalles`),
      rule,
      ...(this.list.getSelectedItem() ? this.list.render(Math.max(1, width)) : [tasks.length ? "No hay tareas con este filtro. Pulsa f para cambiarlo." : "Sin tareas. Vuelve con Esc y escribe /orch seguido de tu instrucción."]),
      rule,
    ];
    if (task) {
      const process = task.runtimeProcess;
      const attention = this.options.attention?.(task.id);
      const stalled = isStalled(task, tasks, now);
      const color = task.state === "failed" ? "error" : task.state === "completed" ? "success" : attention || stalled || task.state === "cancelling" ? "warning" : "accent";
      const tokens = formatTokens(task.usage) ?? contextLabel(task);
      lines.push(theme.fg(color, `${stateIcon[task.state]} ${taskPhase(task, attention)} · ${elapsed(task, now)}${tokens ? ` · ${tokens}` : ""}`));
      const detail = taskDetail(task, tasks, attention, now);
      const meta = safeText([
        modelLabel(task),
        ...(detail.text && !detail.text.startsWith("motor:") ? [detail.text] : []),
        ...(!isTerminal(task) && task.lastActivity ? [`Última acción reportada por el motor: ${activityLabel(task.lastActivity)}`] : []),
        ...(changesLine(task) ? [changesLine(task)!] : []),
        ...(task.changes?.state === "pending" && task.changes.summary ? [task.changes.summary] : []),
        ...(this.details ? ["", `Tarea: ${task.id}`, `Intento: ${task.attemptId}`, `Workspace: ${task.cwd}`,
          `Sesión nativa: ${task.runtimeSessionId ?? "no registrada"}`,
          `Proceso: ${process ? `${process.pid} · ${process.exitedAt ? "salida observada" : "salida aún no observada"}` : "no registrado"}`,
          ...(task.error && friendlyError(task.error) !== safeText(task.error) ? [`Error original: ${task.error}`] : [])] : []),
      ].join("\n"));
      const body = task.error
        ? [...new Text(safeText(`Motivo: ${friendlyError(task.error)}${task.state === "failed" ? `\n\n${failureAdvice(task)}` : ""}${task.partialResult ? `\n\n${task.partialResult}` : ""}`), 0, 0).render(Math.max(1, width))]
        : task.result
          ? (this.options.markdown ? this.options.markdown(safeText(task.result), Math.max(1, width)) : new Text(safeText(task.result), 0, 0).render(Math.max(1, width)))
          : [theme.fg("dim", "Esperando resultado del runtime…")];
      const wrapped = [...new Text(meta, 0, 0).render(Math.max(1, width)), "", ...body];
      this.pageSize = Math.max(1, Math.min(14, this.options.rows() - lines.length - 4));
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, wrapped.length - this.pageSize)));
      lines.push(...wrapped.slice(this.offset, this.offset + this.pageSize));
      if (wrapped.length > this.pageSize) lines.push(theme.fg("dim", `Resultado ${this.offset + 1}–${Math.min(wrapped.length, this.offset + this.pageSize)}/${wrapped.length}`));
    }
    const footer: string[] = [];
    if (this.confirmationId) {
      const count = subtree(tasks, this.confirmationId).filter((entry) => !isTerminal(entry)).length;
      footer.push(theme.fg("warning", `¿Cancelar esta tarea y su árbol (${count} activas)? y confirmar · Esc no`));
    } else if (this.pendingId) {
      footer.push(theme.fg("warning", "Cancelando: esperando cierre de procesos…"));
    } else if (this.notice) footer.push(theme.fg("muted", safeText(this.notice)));
    const controls = this.controlsFor(task);
    const text = task ? Boolean(task.result ?? task.error) : false;
    const actions = [
      ...(controls.steer ? ["s redirigir"] : []), ...(controls.resume ? ["r reanudar"] : []), ...(controls.retry ? ["R reintentar"] : []),
      ...(task?.changes?.state === "pending" && isTerminal(task) ? ["a aplicar cambios", "x descartar cambios"] : []),
      ...(text ? ["e editor", "i insertar en el chat", "y copiar"] : []),
      ...(task && !isTerminal(task) ? ["c cancelar árbol"] : []),
    ];
    if (actions.length) footer.push(theme.fg("muted", actions.join(" · ")));
    // Closing the view is intentionally NOT task cancellation.
    footer.push(theme.fg("dim", "PgUp/PgDn leer · Esc volver; las tareas continúan."));
    const rows = Math.max(1, this.options.rows());
    return [...lines.slice(0, Math.max(0, rows - footer.length)), ...footer.slice(-rows)]
      .map((line) => truncateToWidth(line, Math.max(1, width)));
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    const keys = this.options.keybindings;
    if (this.confirmationId) {
      if (keys.matches(data, "tui.select.cancel") || data === "n") { this.confirmationId = undefined; this.renderNext(); }
      else if (data === "y") {
        const id = this.confirmationId;
        this.confirmationId = undefined;
        if (this.options.tasks().some((task) => task.id === id && !isTerminal(task))) {
          this.pendingId = id;
          void this.options.cancel(id).then(
            (task) => { this.notice = task.state === "cancelled" ? "Cancelación finalizada; runtimes cerrados." : "Cancelación no confirmada; consulta el estado y error de la tarea."; },
            (error: unknown) => { this.notice = `No se pudo confirmar la cancelación: ${String(error)}`; },
          ).finally(() => { this.pendingId = undefined; this.renderNext(); });
        } else this.notice = "La tarea ya terminó; no se envió cancelación.";
        this.renderNext();
      }
      return;
    }
    if (keys.matches(data, "tui.select.cancel")) { this.finish(); return; }
    const task = this.options.tasks().find((entry) => entry.id === this.selectedId);
    const controls = this.controlsFor(task);
    const hasText = Boolean(task?.result ?? task?.error);
    const pending = Boolean(task && isTerminal(task) && task.changes?.state === "pending");
    const action = ({ s: controls.steer && "steer", r: controls.resume && "resume", R: controls.retry && "retry", e: hasText && "editor", i: hasText && "insert", y: hasText && "copy", a: pending && "apply", x: pending && "discard" } as Record<string, string | false>)[data];
    if (task && action) { this.finish({ kind: action as PanelAction["kind"], taskId: task.id }); return; }
    if (task && ["s", "r", "R", "e", "i", "y", "a", "x"].includes(data)) {
      this.notice = { s: "Redirigir solo está disponible en tareas de Codex o Claude en curso.", r: "Reanudar solo está disponible en sesiones completadas que lo admiten.", R: "Solo se reintentan tareas raíz ya terminadas.", e: "Esta tarea aún no tiene resultado.", i: "Esta tarea aún no tiene resultado.", y: "Esta tarea aún no tiene resultado.", a: "Esta tarea no tiene cambios pendientes.", x: "Esta tarea no tiene cambios pendientes." }[data as "s"]!;
    } else if (data === "d") { this.details = !this.details; this.offset = 0; }
    else if (data === "f") {
      this.filter = this.filter === "all" ? "active" : this.filter === "active" ? "failed" : "all";
      this.offset = 0; this.refresh();
    }
    else if (data === "c") {
      if (!this.pendingId && task && !isTerminal(task)) this.confirmationId = task.id;
      else this.notice = this.pendingId ? "Ya hay una cancelación en curso." : "Esta tarea ya está terminada.";
    } else if (keys.matches(data, "tui.select.pageDown") || matchesKey(data, Key.pageDown)) this.offset += this.pageSize;
    else if (keys.matches(data, "tui.select.pageUp") || matchesKey(data, Key.pageUp)) this.offset = Math.max(0, this.offset - this.pageSize);
    else this.list.handleInput(data);
    this.renderNext();
  }
}
