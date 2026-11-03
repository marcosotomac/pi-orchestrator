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
  const busy = task("busy", { lastActivity: "codex: commandExecution" });
  assert.equal(taskDetail(busy, [busy], undefined, NOW).text, "motor: ejecutando un comando");
  assert.equal(activityLabel("codex: mcp/pi_orchestrator/wait"), "consultando sus subtareas");
  assert.equal(activityLabel("claude: Grep"), "buscando en el código");
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
  assert.match(modelLabel(task("m")), /thinking medium \(predeterminado del orquestador\)/);
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

test("panel actions appear only when available and close the panel with the request", () => {
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
  assert.match(done, /r reanudar · R reintentar · e editor · i insertar en el chat · y copiar/);
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
