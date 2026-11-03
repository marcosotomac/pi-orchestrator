import { mkdtemp, writeFile, mkdir, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os"; import { join } from "node:path";
import { dirname, resolve } from "node:path"; import { fileURLToPath } from "node:url";
// Opt-in live benchmark: real Pi main model + real runtimes; consumes quota.
// npm run bench:live -- LABEL fanout|trivial [runs]   (BENCH_MODE=rpc|json, BENCH_OUT=file)
const R = process.env.ORCH_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createAgentSession, DefaultResourceLoader, getAgentDir, SessionManager, SettingsManager } = await import(R + "/node_modules/@earendil-works/pi-coding-agent/dist/index.js");
const extension = (await import(R + "/src/extension.ts")).default;
const [label, scenario, runsArg] = process.argv.slice(2);
const files: Record<string, string> = {
  "package.json": '{ "name": "bench-fixture", "type": "module" }\n',
  "src/math.ts": ["// Statistics helpers", "export function sum(xs: number[]): number {", "  return xs.reduce((a, b) => a + b, 0);", "}", "", "export function average(xs: number[]): number {", "  return sum(xs) / xs.length;", "}", "", "export function median(xs: number[]): number {", "  const s = [...xs].sort((a, b) => a - b);", "  return s[Math.floor(s.length / 2)];", "}", ""].join("\n"),
  "src/auth.ts": ["import { createHash } from \"node:crypto\";", "", "export function login(user: string, password: string, token: string): boolean {", "  const ok = createHash(\"sha256\").update(password).digest(\"hex\") === lookup(user);", "  console.log(`login ${user} ok=${ok} token=${token}`);", "  return ok;", "}", "", "function lookup(user: string): string {", "  return user === \"admin\" ? \"5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8\" : \"\";", "}", ""].join("\n"),
  "notes.txt": "MARKER=violeta-42\n",
};
const out = process.env.BENCH_OUT ?? join(R, "artifacts", "bench.jsonl");
await mkdir(join(out, ".."), { recursive: true });
for (let run = 1; run <= Number(runsArg ?? 1); run++) {
  const cwd = await mkdtemp(join(tmpdir(), "orch-bench-"));
  for (const [path, text] of Object.entries(files)) { await mkdir(join(cwd, path, ".."), { recursive: true }); await writeFile(join(cwd, path), text); }
  const settingsManager = SettingsManager.inMemory({ defaultProvider: "openai-codex", defaultModel: "gpt-6.1-sol", defaultThinkingLevel: "low", packages: [], extensions: [], skills: [], prompts: [], themes: [] });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [extension] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(cwd) });
  const errors: string[] = [];
  await session.bindExtensions({ mode: (process.env.BENCH_MODE ?? "json") as any, onError: (e: any) => { errors.push(String(e.error)); } });
  let blockedMs = 0, last = Date.now();
  const t0 = Date.now();
  const tick = setInterval(() => { const now = Date.now(); if (session.isStreaming) blockedMs += now - last; last = now; }, 100);
  const prompt = scenario === "fanout"
    ? "/orch Analiza este repo con tres tareas en paralelo: (1) claude: qué función devuelve NaN con un array vacío; (2) codex: si algún secreto o token se escribe en logs; (3) claude: si median es correcta para arrays de longitud par. Al final dame un resumen con archivo:línea de cada hallazgo."
    : scenario === "catalog" ? "/orch usa antigravity con el modelo argon y thinking low para leer notes.txt y decirme el valor de MARKER."
    : "¿Qué valor tiene MARKER en notes.txt?";
  let firstReturn = 0;
  const settleAll = async () => {
    const live = () => session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "orchestrator-event").map((e: any) => e.data.task).reduce((m: Map<string, any>, t: any) => m.set(t.id, t), new Map()).values();
    for (let quiet = 0; quiet < 8;) {
      await new Promise((r) => setTimeout(r, 1000));
      const pending = [...live()].some((t: any) => !["completed", "failed", "cancelled"].includes(t.state));
      quiet = pending || session.isStreaming ? 0 : quiet + 1;
    }
    await session.waitForIdle();
  };
  let phaseStart = 0;
  if (scenario === "followup") {
    await session.prompt("/orch codex con thinking low: lee src/math.ts y src/auth.ts y resume en dos líneas qué hace cada función.");
    await session.waitForIdle(); await settleAll();
    phaseStart = (session.messages as any[]).length;
  }
  try {
    await session.prompt(scenario === "followup" ? "Pregúntale a esa misma tarea de codex qué función falla con un array vacío y en qué archivo:línea." : prompt);
    await session.waitForIdle();
    firstReturn = Date.now() - t0;
    // Non-blocking flows wake the agent later: wait until no task is live and the agent is idle.
    const live = () => session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "orchestrator-event").map((e: any) => e.data.task).reduce((m: Map<string, any>, t: any) => m.set(t.id, t), new Map()).values();
    for (let quiet = 0; quiet < 8;) {
      await new Promise((r) => setTimeout(r, 1000));
      const pending = [...live()].some((t: any) => !["completed", "failed", "cancelled"].includes(t.state));
      quiet = pending || session.isStreaming ? 0 : quiet + 1;
      if (Date.now() - t0 > 900_000) break;
    }
    await session.waitForIdle();
  } finally { clearInterval(tick); }
  const total = Date.now() - t0;
  const msgs = session.messages as any[];
  const assistants = msgs.filter((m) => m.role === "assistant");
  const main = assistants.reduce((a, m) => ({ input: a.input + (m.usage?.input ?? 0) + (m.usage?.cacheRead ?? 0) + (m.usage?.cacheWrite ?? 0), cached: a.cached + (m.usage?.cacheRead ?? 0), output: a.output + (m.usage?.output ?? 0) }), { input: 0, cached: 0, output: 0 });
  const phaseTools = (msgs.slice(phaseStart) as any[]).filter((m) => m.role === "assistant").flatMap((m) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.name));
  const toolCalls = assistants.flatMap((m) => m.content.filter((c: any) => c.type === "toolCall").map((c: any) => c.name));
  const events = session.sessionManager.getBranch().filter((e: any) => e.type === "custom" && e.customType === "orchestrator-event").map((e: any) => e.data);
  const settled = new Map(events.filter((e: any) => e.type === "settled").map((e: any) => [e.task.id, e.task]));
  const tasks = [...settled.values()] as any[];
  const final = assistants.map((m) => m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("")).join("\n---\n");
  const lastText = assistants.at(-1)?.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("") ?? "";
  const emptyTurns = assistants.filter((m) => /ya (est[aá]|fue) (incluido|entregado)|already (included|delivered)|Resultado ya incluido/i.test(m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""))).length;
  const checks = scenario === "catalog" ? { listed: toolCalls.includes("orchestrator_engines"), model: tasks.some((t) => t.modelState?.model === "gemini-4-argon" || t.selection?.model === "gemini-4-argon"), marker: /violeta-42/.test(final) } : scenario === "followup" ? { nan: /average/.test(final) && /math\.ts:?\s*(L)?[67]\b/.test(final), usedContinue: phaseTools.includes("orchestrator_continue") } : scenario === "fanout"
    ? { nan: /average/.test(final) && /math\.ts:?\s*(L)?[67]\b/.test(final), secret: /auth\.ts:?\s*(L)?5\b/.test(final), median: /median/.test(final) && /math\.ts:?\s*(L)?1[0-2]\b/.test(final) }
    : { marker: /violeta-42/.test(final) };
  const evidence = tasks.filter((t) => /\b[\w/.-]+\.ts:\d+/.test(t.result ?? "")).length;
  const row = { label, scenario, run, totalS: Math.round(total / 1000), chatBlockedS: Math.round(blockedMs / 1000), firstReturnS: Math.round(firstReturn / 1000),
    mainTurns: assistants.length, phaseTools, mainInput: main.input, mainCached: main.cached, mainOutput: main.output, toolCalls,
    workers: tasks.map((t) => ({ engine: t.engine, label: t.label, state: t.state, model: t.modelState?.model ?? t.selection?.model ?? "default", tokens: t.usage ? t.usage.inputTokens + t.usage.outputTokens : null, costUsd: t.usage?.costUsd ?? null, seconds: Math.round((Date.parse(t.endedAt) - Date.parse(t.createdAt)) / 1000), evidence: /\b[\w/.-]+\.ts:\d+/.test(t.result ?? "") })),
    workerTokens: tasks.reduce((a, t) => a + (t.usage ? t.usage.inputTokens + t.usage.outputTokens : 0), 0), workerCostUsd: Number(tasks.reduce((a, t) => a + (t.usage?.costUsd ?? 0), 0).toFixed(4)),
    checks, correct: Object.values(checks).filter(Boolean).length + "/" + Object.keys(checks).length, evidenceRate: tasks.length ? `${evidence}/${tasks.length}` : "-", errors, emptyTurns, lastText: lastText.slice(0, 200), final: final.slice(0, 1500) };
  console.log(JSON.stringify(row));
  await appendFile(out, JSON.stringify(row) + "\n");
  await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); session.dispose();
}
