import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService, type Service } from "../src/service.ts";
import { RunStore } from "../src/journal.ts";
import { isTerminal, type Engine, type TaskView } from "../src/types.ts";

// Opt-in only. This script launches authenticated native agents and (pi-model) a Pi model request.
const scenario = process.argv[2];
const engine = process.argv[3] ?? "codex";
if (!["analysis", "selective", "failure", "pi-model", "pi-nested"].includes(scenario ?? "") || !(scenario === "pi-nested" ? ["codex", "claude", "antigravity"] : ["codex", "claude"]).includes(engine)) {
  throw new Error("Usage: npm run smoke:cases -- analysis|selective|failure|pi-model|pi-nested [PARENT] [CHILD for pi-nested]");
}
if (process.platform === "win32") throw new Error("These process-group checks require POSIX");
const opposite = (process.argv[4] ?? (engine === "codex" ? "claude" : "codex")) as Engine;
if (!["codex", "claude", "antigravity"].includes(opposite) || opposite === engine || (process.argv[4] && scenario !== "pi-nested")) throw new Error("Explicit child engine is supported only for pi-nested and must differ from the parent");
const usesPiModel = scenario === "pi-model" || scenario === "pi-nested";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.umask(0o077);
await mkdir(join(root, "artifacts"), { recursive: true });
const evidenceDirectory = await mkdtemp(join(root, "artifacts", `cases-${scenario}-${engine}-`));
const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-cases-"));
const stateDirectory = join(evidenceDirectory, "state");
const markers = { data: `DATA-${randomBytes(10).toString("hex")}`, review: `REVIEW-${randomBytes(10).toString("hex")}` };
const sources: Record<string, string> = {
  "data.json": JSON.stringify({ marker: markers.data, records: [
    { id: "a", paid: true, cents: 125 }, { id: "b", paid: false, cents: 900 },
    { id: "c", paid: true, cents: 375 }, { id: "d", paid: true, cents: 50 },
  ] }, null, 2),
  "review.js": `// ${markers.review}\n// Contract: total cents for paid records only, including zero.\nexport function paidTotal(records) {\n  return records.filter(r => !r.paid).reduce((sum, r) => sum + r.cents, 0);\n}\n`,
};
for (const [name, source] of Object.entries(sources)) await writeFile(join(cwd, name), source);
const events: { type: string; task: TaskView; detail?: string }[] = [];
const calls: { name: string; id: string }[] = [];
const modelResponses: { stopReason: string; contentTypes: string[]; errorCategory?: string; httpStatus?: string }[] = [];
const errors: string[] = [];
let service: Service | undefined;
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let piModel: { provider: string; id: string } | undefined;
let finalText: string | undefined;
let failure: unknown;
let interrupted = false;
let assertionsPassed = false;
const startedAt = new Date().toISOString();
const current = () => service?.core.list() ?? [];
const startService: typeof createService = async (options) => {
  assert.equal(service, undefined, "Only one coordinator is allowed in this harness");
  service = await createService({ ...options, stateDirectory, maxTasks: usesPiModel ? 2 : 3,
    onEvent(event) { events.push(event); options.onEvent?.(event); },
  });
  return service;
};
const stop = () => {
  interrupted = true;
  void session?.abort();
  void service?.core.close();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const waitUntil = async (predicate: () => boolean, timeoutMs: number, description: string) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(!interrupted, "Harness interrupted");
    assert.ok(Date.now() < deadline, description);
    await delay(10);
  }
};
const settled = async (id: string) => {
  let task = service!.core.status(null, id);
  while (!isTerminal(task)) {
    assert.ok(!interrupted, "Harness interrupted");
    task = await service!.core.wait(null, id, 30_000);
  }
  return task;
};
// Only live process metadata obtained from this coordinator is used, never archived identities.
const processRows = () => {
  const groups = new Set(current().flatMap((task) => task.runtimeProcess?.groupId ? [task.runtimeProcess.groupId] : []));
  return execFileSync("ps", ["-axo", "pid=,pgid=,stat="], { encoding: "utf8", timeout: 2_000, maxBuffer: 2 * 1024 * 1024 })
    .split("\n").flatMap((line) => {
      const [pid, groupId, state] = line.trim().split(/\s+/);
      return groups.has(Number(groupId)) ? [{ pid: Number(pid), groupId: Number(groupId), state: state! }] : [];
    });
};
// The expected answer is checked by the harness, not provided to the worker.
const dataPrompt = "Read data.json with your own read-only tools. Do not delegate. Return its marker verbatim and PAID_TOTAL=<computed integer> after computing the actual sum of cents for paid records. Explain the computation briefly.";
const reviewPrompt = "Read review.js with your own read-only tools. Do not delegate. Return its marker verbatim. Find the filter bug against the comment contract, state the minimal correction, and include BUG_FOUND if the predicate is inverted. Do not edit the file.";
try {
  console.log(`Live case ${scenario}; native engines and isolated read-only fixtures. Consumes model quota.`);
  if (usesPiModel) {
    const settingsManager = SettingsManager.inMemory({ packages: [], extensions: [], skills: [], prompts: [], themes: [],
      retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off",
    });
    const modelRuntime = await ModelRuntime.create();
    const requestedProvider = process.env.PI_ORCHESTRATOR_PI_PROVIDER ?? process.env.PI_PROVIDER;
    const requestedModel = process.env.PI_ORCHESTRATOR_PI_MODEL ?? process.env.PI_MODEL;
    const model = requestedProvider && requestedModel ? modelRuntime.getModel(requestedProvider, requestedModel) : undefined;
    if (requestedProvider || requestedModel) assert.ok(model, "Both Pi provider and model must resolve; use PI_ORCHESTRATOR_PI_PROVIDER and PI_ORCHESTRATOR_PI_MODEL");
    const loader = new DefaultResourceLoader({
      cwd, agentDir: getAgentDir(), settingsManager, noExtensions: true, noSkills: true,
      noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [createOrchestratorExtension(startService)],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    ({ session } = await createAgentSession({ cwd, settingsManager, modelRuntime, ...(model ? { model } : {}),
      thinkingLevel: "low", resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
    }));
    assert.ok(session.model, "A configured Pi model with its own credentials is required");
    piModel = { provider: session.model.provider, id: session.model.id };
    await session.bindExtensions({ mode: "json", onError: (error) => { errors.push(error.error); } });
    assert.deepEqual(session.getActiveToolNames().sort(), ["orchestrator_cancel", "orchestrator_delegate", "orchestrator_status", "orchestrator_wait"]);
    let turns = 0;
    session.subscribe((event) => {
      if (event.type === "turn_start" && ++turns > 16) stop();
      if (event.type === "tool_execution_start") calls.push({ name: event.toolName, id: event.toolCallId });
      if (event.type === "message_end" && event.message.role === "assistant") {
        const message = event.message;
        const error = message.errorMessage ?? "";
        // Fixed labels only, never provider bodies, headers, URLs or credentials.
        const errorCategory = !error ? undefined : /expired|unauthori[sz]ed|invalid.*(?:token|key)|auth/i.test(error) ? "authentication"
          : /not.found|unsupported|not.support|does.not.exist/i.test(error) ? "unsupported-model-or-endpoint"
          : /quota|rate.limit|credit|billing/i.test(error) ? "quota-or-rate-limit"
          : /network|fetch|connect/i.test(error) ? "network" : "provider-error";
        modelResponses.push({ stopReason: message.stopReason, contentTypes: message.content.map((block) => block.type),
          errorCategory, httpStatus: error.match(/\b(?:401|403|404|429|500|502|503)\b/)?.[0],
        });
      }
    });
    const timeout = setTimeout(stop, 240_000);
    try {
      // No commands, forced tool choice, injected calls or model-result replacement.
      const nestedPrompt = `Autorizo ejecutar un agente real ${engine} de solo lectura que debe delegar exactamente una tarea al motor ${opposite} mediante su MCP pi_orchestrator y esperar su resultado terminal. ` +
        "La tarea del hijo: leer data.json con sus propias herramientas, devolver su marca exacta y calcular PAID_TOTAL=<suma de centavos de registros pagados>. El hijo no debe delegar más. " +
        "El padre no debe leer el archivo ni calcular por sí mismo: debe devolver el ID del hijo, su estado y su resultado exacto. " +
        "Coordina esta cadena con tus herramientas disponibles, espera el resultado terminal del padre y devuelve la marca exacta y PAID_TOTAL. No ejecutes tú el hijo como otra tarea raíz, no edites archivos ni inventes resultados.";
      const parallelPrompt = "Autorizo ejecutar exactamente dos agentes reales de solo lectura: Codex para analizar data.json y Claude Code para revisar review.js, sin delegación anidada. " +
        "Coordínalos con las herramientas disponibles. Codex debe calcular el total en centavos de los registros pagados y devolver la marca del archivo. " +
        "Claude debe identificar el bug de filtrado frente al contrato del comentario, proponer la corrección sin editar y devolver su marca. " +
        "Espera los dos resultados terminales; si una espera agota su tiempo, repítela. Devuelve ambas marcas exactas, PAID_TOTAL=<total> y BUG_FOUND si corresponde. No inventes lecturas, resultados ni tareas.";
      await session.prompt(scenario === "pi-nested" ? nestedPrompt : parallelPrompt);
    } finally { clearTimeout(timeout); }
    assert.ok(!interrupted, "Pi model exceeded its bounded run or was interrupted");
    finalText = session.getLastAssistantText();
    assert.ok(finalText, "The Pi model must provide a final answer");
    assert.equal(calls.filter((call) => call.name === "orchestrator_delegate").length, scenario === "pi-nested" ? 1 : 2, "The Pi model must choose only the permitted root delegates");
    assert.ok(calls.some((call) => call.name === "orchestrator_wait"), "The model must choose to wait for results");
    const tasks = current();
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((task) => task.state === "completed"));
    assert.deepEqual(tasks.map((task) => task.engine).sort(), scenario === "pi-nested" ? [engine, opposite].sort() : ["claude", "codex"]);
    if (scenario === "pi-nested") {
      const parent = tasks.find((task) => task.parentId === null)!;
      const child = tasks.find((task) => task.parentId === parent.id)!;
      assert.equal(parent.engine, engine);
      assert.equal(child.engine, opposite);
      assert.ok(child.result?.includes(markers.data));
      assert.ok(parent.result?.includes(markers.data) && parent.result.includes(child.id));
      assert.ok(finalText.includes(markers.data));
    } else {
      assert.ok(tasks.every((task) => task.parentId === null));
      assert.ok(tasks.find((task) => task.engine === "codex")?.result?.includes(markers.data));
      assert.ok(tasks.find((task) => task.engine === "claude")?.result?.includes(markers.review));
      assert.ok(finalText.includes(markers.data) && finalText.includes(markers.review));
      assert.match(finalText, /BUG_FOUND/);
    }
    assert.match(finalText, /PAID_TOTAL\s*=\s*550/);
  } else {
    await startService({ cwd });
    if (scenario === "analysis") {
      const prompt = [
        `You must use pi_orchestrator MCP to delegate exactly two independent tasks to ${opposite}, before waiting for either.`,
        `First call delegate with requestKey 'data' and prompt ${JSON.stringify(dataPrompt)}.`,
        "Then repeat that delegate call once with byte-identical arguments and requestKey to test idempotency. Check the two returned IDs match. Do not change that prompt.",
        `Next call delegate with requestKey 'review' and prompt ${JSON.stringify(reviewPrompt)}.`,
        "Do not read either file yourself. Wait for both tasks using MCP wait, repeating until terminal.",
        "Return both markers verbatim, PAID_TOTAL=<computed total>, BUG_FOUND, and IDEMPOTENCY_OK only if the repeated IDs matched. Report any failure honestly.",
      ].join(" ");
      const parent = service!.core.delegate(null, engine as Engine, prompt, "analysis");
      const result = await settled(parent.id);
      assert.equal(result.state, "completed", "The native analysis parent must complete");
      assert.equal(current().length, 3, "Idempotent retry must not launch a third child");
      const children = current().filter((task) => task.parentId === parent.id);
      assert.equal(children.length, 2);
      assert.ok(events.some((event) => event.type === "request-reused" && children.some((child) => child.id === event.task.id)), "The native parent's actual retry must be observed by the coordinator, not merely claimed in its answer");
      assert.ok(children.every((task) => task.engine === opposite && task.state === "completed"));
      assert.ok(children.some((task) => task.result?.includes(markers.data)));
      assert.ok(children.some((task) => task.result?.includes(markers.review)));
      finalText = result.result;
      assert.ok(finalText, "The native parent must provide a final answer");
      assert.ok(finalText.includes(markers.data) && finalText.includes(markers.review));
      assert.match(finalText, /PAID_TOTAL\s*=\s*550/);
      assert.match(finalText, /BUG_FOUND/);
      assert.match(finalText, /IDEMPOTENCY_OK/);
      const starts = children.map((child) => events.findIndex((event) => event.type === "started" && event.task.id === child.id));
      const ends = children.map((child) => events.findIndex((event) => event.type === "settled" && event.task.id === child.id));
      assert.ok(Math.max(...starts) < Math.min(...ends), "Both children must be admitted before either settles");
      const processStarts = children.map((child) => events.findIndex((event) => event.type === "process" && event.task.id === child.id));
      const processExits = children.map((child) => events.findIndex((event) => event.type === "process-exited" && event.task.id === child.id));
      assert.ok(processStarts.every((index) => index >= 0) && Math.max(...processStarts) < Math.min(...processExits), "Both native processes must be observed before either exits");
    } else if (scenario === "failure") {
      const key = opposite === "codex" ? "PI_ORCHESTRATOR_CODEX_MODEL" : "PI_ORCHESTRATOR_CLAUDE_MODEL";
      const previous = process.env[key];
      try {
        // Deliberate invalid model, local to this test process; no auth/config files are edited.
        process.env[key] = `orchestrator-invalid-model-${randomBytes(8).toString("hex")}`;
        const parent = service!.core.delegate(null, engine as Engine, [
          `Use pi_orchestrator MCP to delegate exactly one task to ${opposite}, requestKey 'expected-failure', prompt 'Read data.json and return its marker. Do not delegate further.'`,
          "The operator deliberately configured the child with an invalid model for this test. Wait for its terminal status using MCP wait.",
          "Do not retry, read the file yourself, invent a marker, or launch another child. Return CHILD_FAILED only if its status is failed, plus its actual task ID and status. If it succeeds, say UNEXPECTED_SUCCESS.",
        ].join(" "), "failure");
        const parentResult = await settled(parent.id);
        assert.equal(parentResult.state, "completed", "The parent must report the expected child failure honestly");
        const child = current().find((task) => task.parentId === parent.id)!;
        assert.ok(child);
        assert.equal(child.state, "failed");
        assert.ok(child.error);
        assert.equal(child.result, undefined);
        assert.equal(current().length, 2, "Failed work must not be silently retried");
        assert.match(parentResult.result!, /CHILD_FAILED/);
        assert.ok(parentResult.result?.includes(child.id));
        finalText = parentResult.result;
      } finally {
        if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
      }
      // A native failure is not a coordinator-wide shutdown: a fresh valid attempt can still run.
      const recovery = service!.core.delegate(null, opposite, dataPrompt, "after-failure");
      const recovered = await settled(recovery.id);
      assert.equal(recovered.state, "completed", "Restored native model must work after the expected failure");
      assert.ok(recovered.result?.includes(markers.data));
      assert.match(recovered.result!, /PAID_TOTAL\s*=\s*550/);
    } else {
      const holdPrompt = "Read data.json with your own read-only tools and return its marker later. Do not delegate. This is an operator cancellation test: after reading, keep active by repeatedly calling pi_orchestrator status on your own task (use the ID in the runtime prompt if supplied; otherwise reread data.json). Do not return a final answer until cancelled. Do not pretend to have finished.";
      const parentPrompt = [
        `Delegate exactly two children to ${opposite} with pi_orchestrator MCP, before waiting for either.`,
        `First requestKey 'stop-me', prompt ${JSON.stringify(holdPrompt)}.`,
        `Second requestKey 'keep-me', prompt ${JSON.stringify(reviewPrompt)}.`,
        "Do not read files yourself or launch more children. The Pi operator will cancel only stop-me while keep-me runs.",
        "Wait for BOTH terminal child results using MCP wait. A cancelled child is expected, not a reason to cancel the other or to exit early.",
        "Return CANCELLED_BRANCH for the cancelled child and SURVIVOR_COMPLETED plus the surviving review marker and BUG_FOUND if the other completed.",
      ].join(" ");
      const parent = service!.core.delegate(null, engine as Engine, parentPrompt, "selective");
      let victim: TaskView | undefined;
      await waitUntil(() => {
        const children = current().filter((task) => task.parentId === parent.id);
        victim = children.find((task) => task.title === holdPrompt.slice(0, 160));
        if (isTerminal(service!.core.status(null, parent.id))) throw new Error("Parent ended before selective cancellation");
        return children.length === 2 && Boolean(victim?.runtimeSessionId && victim.runtimeProcess && !victim.runtimeProcess.exitedAt && /commandExecution|claude: Read/.test(victim.lastActivity ?? ""));
      }, 150_000, "Two children and a native read operation are required before cancellation");
      const sibling = current().find((task) => task.parentId === parent.id && task.id !== victim!.id)!;
      const running = processRows();
      assert.ok(running.some((row) => row.pid === victim!.runtimeProcess!.pid && !row.state.startsWith("Z")));
      assert.equal((await service!.core.cancel(null, victim!.id)).state, "cancelled");
      const siblingAfter = service!.core.status(null, sibling.id);
      assert.ok(["running", "completed"].includes(siblingAfter.state), "Selective stop must not cancel its sibling");
      const result = await settled(parent.id);
      assert.equal(result.state, "completed", "The native parent must complete after selective cancellation");
      assert.equal(current().length, 3);
      assert.equal(service!.core.status(null, victim!.id).result, undefined);
      assert.equal(service!.core.status(null, sibling.id).state, "completed");
      assert.ok(service!.core.status(null, sibling.id).result?.includes(markers.review));
      finalText = result.result;
      assert.match(finalText!, /CANCELLED_BRANCH/);
      assert.match(finalText!, /SURVIVOR_COMPLETED/);
      assert.ok(finalText?.includes(markers.review));
    }
  }
  assert.deepEqual(errors, []);
  for (const [name, source] of Object.entries(sources)) assert.equal(await readFile(join(cwd, name), "utf8"), source);
  assert.deepEqual((await readdir(cwd)).sort(), Object.keys(sources).sort(), "Workspace must remain unchanged");
  for (const task of current()) {
    assert.ok(task.runtimeProcess?.exitedAt, "Observed native exit is required even for failed attempts");
    if (task.state !== "failed") assert.ok(task.runtimeSessionId, "A successful or cancelled native session must be identified");
    const history = events.filter((event) => event.task.id === task.id);
    const exit = history.findIndex((event) => event.type === "process-exited");
    assert.ok(exit >= 0 && exit < history.findIndex((event) => event.type === "settled"));
  }
  assertionsPassed = true;
} catch (error) { failure = error; }
finally {
  try {
    await session?.abort();
    await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    await service?.close();
    if (service) {
      const record = new RunStore(stateDirectory).read(service.journal!.runId);
      assert.ok(record.closedAt);
      assert.deepEqual(record.tasks, current(), "Durable final state must match the live coordinator");
      await waitUntil(() => !processRows().some((row) => !row.state.startsWith("Z")), 2_000, "Owned process groups must have no executing members");
    }
  } catch (error) { failure ??= error; }
  session?.dispose();
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  const report = {
    startedAt, endedAt: new Date().toISOString(), scenario, engine: scenario === "pi-model" ? undefined : engine, childEngine: scenario === "pi-nested" ? opposite : undefined,
    host: usesPiModel ? "Pi model-selected tools (ordinary prompt, no commands or forced calls)" : "Service API host; native parent uses MCP",
    piModel, calls, modelResponses, passed: assertionsPassed && !failure, runId: service?.journal?.runId,
    tasks: current(), usage: service?.core.usage(), events, finalText, errors: errors.length,
    // Do not serialize provider/HTTP errors, credentials, headers, env or process argv.
    failure: failure ? { name: failure instanceof Error ? failure.name : "UnknownError", message: "Case failed; inspect private task evidence and rerun locally" } : undefined,
  };
  const reportPath = join(evidenceDirectory, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rm(cwd, { recursive: true, force: true });
  console.log(`Evidence: ${reportPath}`);
}
if (failure) {
  // Assertion diffs can include task/provider errors, so print only the fixed operator label.
  if (failure instanceof assert.AssertionError) console.error(`FAIL: harness assertion (${failure.operator}); inspect the private report.`);
  else console.error("FAIL: live case failed; private evidence retained (no provider error bodies printed).");
  if (modelResponses.length) console.error(JSON.stringify({ modelResponses }));
  process.exitCode = 1;
} else console.log(`PASS: ${scenario}; native results, unchanged workspace, observed exits and durable closure verified.`);
