import test from "node:test";
import assert from "node:assert/strict";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { TaskDashboard, type PanelAction } from "../src/dashboard.ts";
import { activityLabel, formatInteractionDetail, formatTokens, friendlyError, isStalled, modelLabel, STALL_MS, summary, taskDetail, taskRow, urgentRows } from "../src/presentation.ts";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type Service } from "../src/service.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities, type TaskView } from "../src/types.ts";

const NOW = Date.parse("2026-01-01T00:10:00Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1_000).toISOString();
const task = (id: string, extra: Partial<TaskView> = {}): TaskView => ({
  id, attemptId: `attempt-${id}`, parentId: null, engine: "codex", depth: 1, title: `Tarea ${id}`, state: "running",
  cwd: "/tmp", createdAt: at(60), runtimeSessionId: "s", activityAt: at(5), ...extra,
});

test("rows are ordered by urgency with children under their parent, and summaries hide zero counts", () => {
  const done = task("done", { state: "completed", endedAt: at(1) });
  const failed = task("failed", { state: "failed", endedAt: at(1), error: "x" });
  const parent = task("parent");
  const quietChild = task("child", { parentId: "parent", depth: 2, engine: "claude" });
  const asking = task("asking");
  const order = urgentRows([done, parent, quietChild, failed, asking], (id) => id === "asking" ? "permission" : undefined, NOW).map((row) => row.task.id);
  assert.deepEqual(order, ["asking", "failed", "parent", "child", "done"]);
  assert.equal(summary([done, failed, parent], () => undefined), "1 fallida · 1 en curso · 1 lista");
  assert.equal(summary([asking], (id) => id === "asking" ? "permission" : undefined), "1 te necesita · 1 en curso");
  assert.equal(summary([]), "sin tareas");
});

test("stalls and subtask counts are host observations; provider text is labelled as the engine's report", () => {
  const stalled = task("stalled", { activityAt: at(STALL_MS / 1_000 + 1) });
  assert.equal(isStalled(stalled, [stalled], NOW), true);
  assert.match(taskDetail(stalled, [stalled], undefined, NOW).text!, /sin actividad hace 3m/);
  assert.equal(taskDetail(stalled, [stalled], undefined, NOW).tone, "warning");
  const child = task("kid", { parentId: "stalled", engine: "antigravity" });
  assert.equal(isStalled(stalled, [stalled, child], NOW), false, "waiting on a live child is not a stall");
  assert.equal(taskDetail(stalled, [stalled, child], undefined, NOW).text, "1 subtarea activa (agy)");
  const busy = task("busy", { lastActivity: "codex: commandExecution · npm test" });
  assert.equal(taskDetail(busy, [busy], undefined, NOW).text, "motor: ejecutando `npm test`");
  assert.equal(activityLabel("codex: mcp/pi_orchestrator/wait"), "esperando a sus subtareas");
  assert.equal(activityLabel("claude: Grep"), "buscando en el código");
  assert.equal(activityLabel("antigravity: read · AGENTS.md"), "leyendo AGENTS.md", "the real target, not 'using tools'");
  assert.equal(activityLabel("antigravity: other · invoke_subagent"), "usando invoke_subagent");
  assert.equal(activityLabel("codex: fileChange · a.ts, b.ts"), "editando a.ts, b.ts");
  assert.equal(activityLabel("codex: mcp/figma/get_file"), "herramienta figma/get_file");
  assert.equal(activityLabel("99% done, waiting for parent"), "99% done, waiting for parent", "unknown text is shown as reported, never upgraded to a phase");
});

test("human rows carry no IDs and keep status visible on narrow terminals", () => {
  const long = task("0123456789abcdef", { title: "Revisa toda la arquitectura del pipeline de reels y propone mejoras de rendimiento 界", lastActivity: "claude: Read", engine: "claude" });
  for (const width of [40, 80, 160]) {
    const row = taskRow(long, "", width, [long], undefined, NOW);
    assert.ok(visibleWidth(row) <= width, `fits ${width}`);
    assert.ok(!row.includes("01234567"), "no technical ID");
    assert.match(row, /trabajando/);
    assert.ok(!row.includes("\x1b"), "no ANSI reset from truncation: the caller's row colour must survive the ellipsis");
  }
  assert.match(taskRow(long, "", 160, [long], undefined, NOW), /motor: leyendo archivos · 1m 0s/);
});

test("tokens, Spanish errors, default effort and permission details are readable and sanitized", () => {
  assert.equal(formatTokens({ inputTokens: 45_000, cachedInputTokens: 38_000, outputTokens: 2_100, reasoningTokens: 900 }), "47k tokens · 38k de caché · 900 razonando");
  assert.equal(formatTokens({ inputTokens: 900, cachedInputTokens: 0, outputTokens: 50, costUsd: 0.0123 }), "950 tokens · ~$0.012");
  assert.equal(formatTokens(undefined), undefined);
  assert.equal(friendlyError("Task deadline exceeded"), "Se agotó el plazo de la tarea (PI_ORCHESTRATOR_TASK_TIMEOUT_MS).");
  assert.match(friendlyError("Error: Codex MCP isolation could not be verified; inherited servers active: playwright"), /servidores MCP heredados \(playwright\)/);
  assert.equal(friendlyError("fixture failure"), "fixture failure", "unknown errors pass through verbatim");
  assert.equal(modelLabel(task("m")), "Codex · modelo por defecto · razonamiento medio (por defecto)");
  const detail = formatInteractionDetail(JSON.stringify({ request: "Run shell", input: { zeta: "z", CommandLine: "rm -rf build\x1b]52;c;secret\x07", path: "/repo/build" } }));
  const lines = detail.split("\n");
  assert.equal(lines[0], "Solicitud: Run shell");
  assert.equal(lines[1], "Comando:", "the command comes first");
  assert.match(lines[2]!, /rm -rf build/);
  assert.ok(!detail.includes("secret") && !detail.includes("\x1b"));
  assert.match(detail, /Archivo: \/repo\/build/);
  assert.equal(formatInteractionDetail("not json"), "not json");
  assert.match(formatInteractionDetail(JSON.stringify({ input: {} })), /no envió detalles/);
});

function panel(tasks: TaskView[], controls = { steer: false, resume: false, retry: false }) {
  const actions: (PanelAction | undefined)[] = [];
  const view = new TaskDashboard({
    tasks: () => tasks, rows: () => 40, cancel: async (id) => ({ ...tasks.find((entry) => entry.id === id)!, state: "cancelled" }),
    keybindings: getKeybindings(), theme: { fg: (_color, text) => text, bold: (text) => text },
    subscribe: () => () => {}, requestRender() {}, done: (action) => { actions.push(action); },
    controls: () => controls, markdown: (text) => [`MD:${text}`], now: () => NOW,
  });
  return { view, actions };
}

test("panel actions appear only when available and close the panel with the request", async () => {
  const running = panel([task("run")], { steer: true, resume: false, retry: false });
  const screen = running.view.render(120).join("\n");
  assert.match(screen, /s redirigir/); assert.ok(!screen.includes("r reanudar")); assert.ok(!screen.includes("y copiar"));
  running.view.handleInput("y");
  assert.deepEqual(running.actions, [], "no result yet: nothing to copy");
  assert.match(running.view.render(120).join("\n"), /aún no tiene resultado/);
  running.view.handleInput("s");
  assert.deepEqual(running.actions, [{ kind: "steer", taskId: "run" }]);

  const finished = panel([task("ok", { state: "completed", endedAt: at(1), result: "# Hecho\n- uno" })], { steer: false, resume: true, retry: true });
  const done = finished.view.render(120).join("\n");
  assert.match(done, /MD:# Hecho/, "completed results render as markdown");
  const keys = done.split("\n").at(-1)!;
  assert.match(keys, /r continuar · R repetir · e editor · i al chat · y copiar · d detalles · f filtro · Esc cerrar$/, "one line, only the keys that work here");
  assert.ok(visibleWidth(keys) <= 120, "the key line fits");
  const { fitKeys } = await import("../src/dashboard.ts");
  for (const width of [40, 60, 80]) { const line = fitKeys(["↑↓ elegir", "r continuar", "R reintentar", "e editor", "i insertar en el chat", "y copiar", "d detalles", "f filtro", "Esc cerrar"], width); assert.ok(visibleWidth(line) <= width, `fits ${width}`); assert.match(line, /Esc cerrar$/); }
  assert.ok(!done.includes("c cancelar"));
  finished.view.handleInput("R");
  assert.deepEqual(finished.actions, [{ kind: "retry", taskId: "ok" }]);
  const insert = panel([task("ok", { state: "completed", endedAt: at(1), result: "r" })]);
  insert.view.handleInput("i");
  assert.deepEqual(insert.actions, [{ kind: "insert", taskId: "ok" }]);
});

test("the core retries only settled roots, with the same prompt, selection and permission mode", async () => {
  const prompts: string[] = [];
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: { capabilities, run: async (ctx) => { prompts.push(ctx.prompt); ctx.usage?.({ inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }); ctx.usage?.({ inputTokens: -1, cachedInputTokens: 0, outputTokens: 0 }); return "done"; } } } });
  core.attachEndpoint("http://127.0.0.1:1/mcp");
  try {
    const root = core.delegate(null, "codex", "original prompt", "root", undefined, { thinking: "high" });
    const settled = await core.wait(null, root.id);
    assert.deepEqual(settled.usage, { inputTokens: 10, cachedInputTokens: 4, outputTokens: 2 }, "malformed usage reports are ignored");
    assert.throws(() => core.retry(root.id, root.id, "nested"), /Only the operator/);
    const again = core.retry(null, root.id, "retry-1");
    assert.notEqual(again.id, root.id);
    assert.deepEqual(again.selection, { thinking: "high" });
    await core.wait(null, again.id);
    assert.deepEqual(prompts, ["original prompt", "original prompt"]);
  } finally { await core.close(); }
});

test("widget collapses when idle, alerts reach the terminal, and operator screens stay out of the model context", async () => {
  let service: Service | undefined;
  const tools = new Map<string, any>();
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let widget: any;
  const writes: string[] = [];
  const notices: string[] = [];
  const sent: any[] = [];
  const fake = {
    registerMessageRenderer() {}, registerToolRenderer() {}, on() {}, appendEntry() {}, sendUserMessage() {},
    sendMessage(message: any) { sent.push(message); },
    registerCommand(_name: string, definition: { handler: typeof command }) { command = definition.handler; },
    registerTool(tool: any) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  createOrchestratorExtension(async (options) => {
    service = await createService(options, { codex: { capabilities, run: async () => { await gate; return "listo"; } } });
    return service;
  })(fake);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const tui = { terminal: { write: (data: string) => { writes.push(data); }, rows: 30 }, requestRender() {} };
  const ctx = { cwd: process.cwd(), mode: "tui", hasUI: true, ui: {
    setStatus() {}, notify: (text: string) => { notices.push(text); },
    setWidget: (_key: string, factory: any) => { widget = factory ? factory(tui, theme) : undefined; },
  } } as unknown as ExtensionCommandContext;
  try {
    const delegated = (await tools.get("orchestrator_delegate").execute("w", { engine: "codex", prompt: "Revisa el widget" }, undefined, undefined, ctx)).details as TaskView;
    const live = widget.render(100) as string[];
    assert.ok(live.length >= 2 && live.some((line) => line.includes("Revisa el widget")));
    assert.ok(!live.join("\n").includes(delegated.id.slice(0, 8)), "the widget shows no IDs");
    release();
    await service!.core.wait(null, delegated.id);
    const idle = widget.render(100) as string[];
    assert.equal(idle.length, 1, "nothing left to watch: one line");
    assert.match(idle[0]!, /✓ Orquestador · 1 lista/);
    assert.ok(writes.some((data) => data.startsWith("\x1b]777;notify;Tarea terminó;codex · Revisa el widget")), "desktop notification through the terminal");
    assert.ok(notices.some((text) => /Tarea terminó/.test(text)));
    await command("help", ctx);
    await command("usage", ctx);
    const screens = sent.filter((message) => message.details?.help || typeof message.details?.report === "string");
    assert.equal(screens.length, 2);
    for (const screen of screens) assert.match(screen.content, /^\[.*operador\]$/, "the model gets one line, not the screen");
    assert.match(screens[1].details.report, /Tareas: 1\/32/);
  } finally { await service?.close(); }
});

test("pending changes show in the panel with apply/discard keys, and the model is told they are not applied", async () => {
  const { modelTask } = await import("../src/model-view.ts");
  const { changesLine } = await import("../src/presentation.ts");
  const changes = { state: "pending" as const, files: 2, insertions: 10, deletions: 3, summary: " src/a.ts | 9 ++++++---\n src/b.ts | 4 ++++", repo: "/r", worktree: "/w", patchPath: "/p/changes.patch" };
  const done = task("yolo", { state: "completed", endedAt: at(1), result: "hecho", permissionMode: "yolo", workspace: "worktree", changes });
  const view = panel([done], { steer: false, resume: false, retry: true });
  const screen = view.view.render(120).join("\n");
  assert.match(screen, /Cambios pendientes de revisión: 2 archivos · \+10 −3/);
  assert.match(screen.split("\n").at(-1)!, /a aplicar · x descartar/);
  view.view.handleInput("a");
  assert.deepEqual(view.actions, [{ kind: "apply", taskId: "yolo" }]);
  const other = panel([{ ...done, changes: { ...changes, state: "applied" as const } }]);
  other.view.handleInput("x");
  assert.deepEqual(other.actions, [], "nothing pending: no discard");
  const model = modelTask(done, "include") as any;
  assert.equal(model.changes.files, 2); assert.match(model.changes.note, /NO están en el repo/);
  assert.equal(changesLine(task("p", { workspace: "in-place", state: "completed" })), "Sin aislamiento: no es un repositorio git; los cambios se escribieron directamente.");
});

test("titles are short and human; a repeated cancelled task reads as superseded; live work comes first", async () => {
  const { shortTitle, displayTitle, supersededBy, groupedRows, modelName } = await import("../src/presentation.ts");
  const prompt = "Explora el repositorio /Users/marcosotomaceda/Desktop/nology-platform. Lee las instrucciones aplicables (AGENTS.md). Identifica propósito, stack y estructura.";
  assert.equal(shortTitle(prompt), "Explora el repositorio nology-platform");
  assert.ok(shortTitle("a ".repeat(80)).length <= 60);
  assert.equal(displayTitle(task("l", { title: prompt, label: "Explorar nology-platform" })), "Explorar nology-platform", "the model's label wins");
  assert.deepEqual(["gemini-3.8-flash", "gpt-6.1-sol", "claude-sonnet-5-5", "sonnet"].map(modelName), ["Gemini 3.8 Flash", "GPT-6.1 Sol", "Claude Sonnet 5.5", "Claude Sonnet"]);
  const old = task("old", { engine: "antigravity", title: prompt, state: "cancelled", createdAt: at(300), endedAt: at(260) });
  const current = task("new", { engine: "antigravity", title: prompt, createdAt: at(200) });
  assert.equal(supersededBy(old, [old, current])?.id, "new");
  assert.equal(supersededBy(current, [old, current]), undefined);
  const reworded = task("rw", { engine: "antigravity", title: "Explora el repositorio actual /Users/m/Desktop/nology-platform sin modificar archivos. Lee AGENTS.md.", state: "cancelled", createdAt: at(400), endedAt: at(360) });
  assert.equal(supersededBy(reworded, [reworded, current])?.id, "new", "a reworded retry of the same request also counts");
  const unrelated = task("un", { engine: "antigravity", title: "Resume el changelog de pagos", state: "cancelled", createdAt: at(400), endedAt: at(360) });
  assert.equal(supersededBy(unrelated, [unrelated, current]), undefined, "different work is not 'superseded'");
  assert.match(taskRow(old, "", 120, [old, current], undefined, NOW), /cancelada · sustituida/);
  const done = task("done", { state: "completed", endedAt: at(1) });
  assert.deepEqual(groupedRows([done, old, current]).map((row) => [row.task.id, row.finished]), [["new", false], ["done", true], ["old", true]], "live first, then finished newest first");
});

test("the panel shows the last steps and, with d, the full prompt; the widget hides while it is open and only lists live work", async () => {
  const running = task("run", { title: "Explora el repositorio /Users/x/proj. Lee AGENTS.md.", recentActivity: [
    { at: at(40), text: "antigravity: execute · ls -la" }, { at: at(20), text: "antigravity: read · AGENTS.md" }, { at: at(5), text: "antigravity: search · export" }] });
  const view = new TaskDashboard({ tasks: () => [running], rows: () => 40, cancel: async () => running, keybindings: getKeybindings(), theme: { fg: (_c, text) => text, bold: (text) => text },
    subscribe: () => () => {}, requestRender() {}, done() {}, now: () => NOW, prompt: () => "PROMPT COMPLETO con /ruta/larga" });
  let screen = view.render(120).join("\n");
  const plain = screen.split("\n").map((line) => line.trimEnd()).join("\n");
  assert.match(plain, /Últimos pasos\n\s+hace 5s\s+buscando export\n\s+hace 20s\s+leyendo AGENTS\.md\n\s+hace 40s\s+ejecutando `ls -la`/);
  assert.match(screen, /Aún sin respuesta\./); assert.ok(!screen.includes("runtime") && !screen.includes("árbol"));
  assert.ok(!screen.includes("PROMPT COMPLETO"));
  view.handleInput("d");
  assert.match(view.render(120).map((line) => line.trimEnd()).join("\n"), /Encargo completo:\nPROMPT COMPLETO con \/ruta\/larga/);
  view.dispose();

  let service: Service | undefined;
  let command!: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
  let widget: any; const statuses: unknown[] = [];
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  const tools = new Map<string, any>();
  createOrchestratorExtension(async (options) => (service = await createService(options, { codex: { capabilities, run: async (ctx) => { if (ctx.prompt === "slow") await gate; return "ok"; } } })))({
    registerMessageRenderer() {}, registerToolRenderer() {}, on() {}, appendEntry() {}, sendUserMessage() {}, sendMessage() {},
    registerCommand(_n: string, d: any) { command = d.handler; }, registerTool(tool: any) { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI);
  const tui = { terminal: { write() {}, rows: 30 }, requestRender() {} };
  let panelDone!: (value: undefined) => void; let panelOpened!: () => void; const opened = new Promise<void>((resolve) => { panelOpened = resolve; });
  const ctx = { cwd: process.cwd(), mode: "tui", hasUI: true, ui: {
    setStatus: (_k: string, value: unknown) => { statuses.push(value); }, notify() {},
    setWidget: (_k: string, factory: any) => { widget = factory ? factory(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t }) : undefined; },
    custom: (factory: any) => new Promise((resolve) => { panelDone = resolve; factory(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t }, getKeybindings(), resolve); panelOpened(); }),
  } } as unknown as ExtensionCommandContext;
  try {
    const quick = (await tools.get("orchestrator_delegate").execute("q", { engine: "codex", prompt: "quick", title: "Tarea rápida" }, undefined, undefined, ctx)).details as TaskView;
    await service!.core.wait(null, quick.id);
    await tools.get("orchestrator_delegate").execute("s", { engine: "codex", prompt: "slow", title: "Explorar nology-platform" }, undefined, undefined, ctx);
    const lines = widget.render(100) as string[];
    assert.equal(lines.length, 2, "header + the one live task; finished work is a counter");
    assert.match(lines[0]!, /1 en curso · terminadas: 1 lista/); assert.match(lines[1]!, /Explorar nology-platform/);
    assert.ok(statuses.every((value) => value === undefined), "no footer status repeating the widget");
    const panel = command("", ctx);
    await opened;
    assert.deepEqual(widget.render(100), [], "while the panel is open the widget draws nothing");
    panelDone(undefined); await panel;
    assert.equal((widget.render(100) as string[]).length, 2, "and it comes back when the panel closes");
    release();
  } finally { await service?.close(); }
});
