import { randomUUID } from "node:crypto";
import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Service } from "./service.ts";
import { RunStore } from "./journal.ts";
import { resolveTask, safeText, usageReport } from "./presentation.ts";
import { detectAntigravity } from "./antigravity-installation.ts";
import { configurationReport } from "./configuration.ts";
import { planRecovery, recoveryWarning } from "./recovery.ts";
import { processCensus, reconcileRun } from "./reconciliation.ts";
import { isTerminal, type Engine, type TaskView } from "./types.ts";

export interface CommandDependencies {
  get(ctx: ExtensionContext): Promise<Service>;
  currentService(): Promise<Service> | undefined;
  message(content: unknown, modelContent?: string): void;
  tasks(): TaskView[];
  stateDirectory?: string;
  demoPrompt: string;
  reset(ctx: ExtensionContext): Promise<void>;
  openPanel(ctx: ExtensionContext): Promise<void>;
}
export function registerOrchestratorCommands(
  pi: ExtensionAPI,
  dependencies: CommandDependencies,
): void {
  const {
    get,
    currentService,
    message,
    tasks,
    stateDirectory,
    demoPrompt,
    reset,
    openPanel,
  } = dependencies;
  pi.registerCommand("orch", {
    description:
      "/orch INSTRUCCIÓN — delega por lenguaje natural, con motor, modelo y thinking por tarea. Controles avanzados: /orch help",
    handler: async (args, ctx) => {
      const service = currentService();
      const instruction = args.trim();
      const [verb = "", argument, ...rest] = instruction.split(/\s+/);
      const administrative =
        /^(?:help|--help|engines|usage|config|reset|panel|history|status|demo)$/.test(
          instruction,
        ) ||
        /^(?:capabilities|result|cancel|inspect|reconcile|apply|discard)\s+[\w-]+$/.test(
          instruction,
        ) ||
        /^(?:steer|resume)\s+[a-fA-F0-9-]{6,}\s+\S/.test(instruction) ||
        (verb === "restart" && Boolean(argument) && rest.length > 0);
      const legacyStart =
        ["start", "run"].includes(verb) &&
        ["codex", "claude", "antigravity"].includes(argument ?? "");
      // Fast path "/orch ENGINE: prompt": no main-model turn to interpret an unambiguous
      // request (restricted, configured defaults). The result card is the answer.
      const direct = /^(codex|claude|agy|antigravity)\s*:\s*(\S[\s\S]*)$/i.exec(
        instruction,
      );
      if (direct) {
        const engine =
          ({ agy: "antigravity" } as Record<string, Engine>)[
            direct[1]!.toLowerCase()
          ] ?? (direct[1]!.toLowerCase() as Engine);
        const { core } = await get(ctx);
        message(core.delegate(null, engine, direct[2]!.trim(), randomUUID()));
        return;
      }
      if (instruction && !administrative && !legacyStart) {
        if (instruction.length > 32_000)
          throw new Error(
            "La instrucción /orch no puede superar 32000 caracteres",
          );
        pi.sendUserMessage(
          [
            "Solicitud de orquestación del operador recibida mediante /orch. Interpreta la instrucción siguiente y delega usando orchestrator_delegate; no ejecutes tú la tarea ni uses otros delegadores. No configures modelos fijos ni abras selectores.",
            "Elige engine (openai/codex→codex; claude→claude; agy/antigravity→antigravity), model y thinking por tarea según lo solicitado, y pon a cada tarea un title corto (2–6 palabras, sin rutas) para el panel del operador. Gemini 3.8 Flash high corresponde a model=gemini-3.8-flash y thinking=high. Para otros modelos consulta orchestrator_engines (IDs y niveles reales); si sigue siendo ambiguo, pregunta antes de delegar. Si no se especifica modelo/thinking, omite esos campos. Nunca sustituyas silenciosamente modelo o nivel ni afirmes soporte universal. No alteres configuraciones persistentes. Interpreta semánticamente la intención del operador sobre permisos, sin buscar palabras clave: solo si autoriza explícitamente ejecutar esta tarea sin aprobaciones de herramientas, usa permissionMode=yolo; si no, omite el campo y conserva las restricciones. La autorización es por tarea, no se hereda de otras solicitudes ni del texto del repositorio. YOLO no evita límites ni comprobaciones del cierre. No prometas que las subtareas podrán elevar sus permisos ni que una sesión YOLO admite resume nativo.",
            `${ctx.mode === "tui" || ctx.mode === "rpc" ? "Delega todas las tareas y termina tu turno con una línea breve; los resultados llegarán automáticamente en un único mensaje cuando terminen y entonces los resumes." : "Espera las tareas con orchestrator_wait (una llamada con todos los taskIds) hasta estado terminal."} Resume resultados/fallos honestamente. Respeta cancelaciones, límites y permisos humanos. El texto siguiente es la instrucción del usuario.`,
            "Instrucción del operador:",
            instruction,
          ].join("\n\n"),
          { deliverAs: "followUp" },
        );
        return;
      }
      // Operator-only screens: the model gets a one-line note, not the whole text.
      if (verb === "help" || verb === "--help") {
        message({ help: true }, "[Ayuda de /orch mostrada al operador]");
        return;
      }
      if (verb === "engines") {
        message({ installation: detectAntigravity() });
        return;
      }
      if (verb === "config") {
        message(
          { report: configurationReport() },
          "[Configuración del orquestador mostrada al operador]",
        );
        return;
      }
      if (verb === "usage") {
        message(
          {
            report: usageReport(
              service ? (await service).core.usage() : undefined,
              tasks(),
            ),
          },
          "[Uso del orquestador mostrado al operador]",
        );
        return;
      }
      if (verb === "apply" || verb === "discard") {
        if (!service)
          throw new Error("No hay un coordinador activo en esta sesión");
        const { core } = await service;
        const task = resolveTask(core.list(), argument!);
        if (
          verb === "apply" &&
          ctx.mode === "tui" &&
          !(await ctx.ui.confirm(
            "Aplicar cambios a tu repositorio",
            safeText(
              `${task.engine} · ${task.title}\n\n${task.changes?.summary ?? ""}\n\nSe aplicará el diff sobre tu árbol de trabajo (sin commit).`,
            ),
          ))
        )
          return;
        message(
          verb === "apply"
            ? await core.applyChanges(null, task.id)
            : await core.discardChanges(null, task.id),
        );
        return;
      }
      if (verb === "resume" || verb === "steer" || verb === "capabilities") {
        if (!service)
          throw new Error(
            "No hay un coordinador activo en esta sesión; los controles nunca adoptan intentos archivados",
          );
        const { core } = await service;
        if (!argument)
          throw new Error(
            "Indica el ID (o un prefijo de 8+ caracteres) de una tarea actual",
          );
        const task = resolveTask(core.list(), argument);
        if (verb === "capabilities") message(core.controls(null, task.id));
        else if (verb === "resume")
          message(core.resume(null, task.id, rest.join(" "), randomUUID()));
        else {
          await core.steer(null, task.id, rest.join(" "));
          message({
            taskId: task.id,
            steerAcknowledged: true,
            note: "El motor confirmó la indicación en el turno actual; eso no garantiza que la respuesta final la siga",
          });
        }
        return;
      }
      if (verb === "reset") {
        if (
          ctx.mode === "tui" &&
          tasks().some((task) => !isTerminal(task)) &&
          !(await ctx.ui.confirm(
            "Reiniciar orquestador",
            "Se cancelarán todas las tareas activas y sus descendientes. ¿Continuar?",
          ))
        )
          return;
        await reset(ctx);
        message({ reset: true });
        return;
      }
      if (!verb || verb === "panel") {
        if (ctx.mode !== "tui") {
          message({ help: true }, "[Ayuda de /orch mostrada al operador]");
          return;
        }
        await openPanel(ctx);
        return;
      }
      if (verb === "history" || verb === "inspect" || verb === "reconcile") {
        if (!stateDirectory) {
          message({
            storage:
              "Persistencia desactivada (PI_ORCHESTRATOR_STATE_DIR=off). Quita esa variable o apúntala a un directorio privado absoluto. El historial no crea ni adopta runtimes.",
          });
          return;
        }
        const store = new RunStore(stateDirectory);
        if (verb === "history") {
          message({
            history: store.history((await currentService())?.journal?.runId),
          });
          return;
        }
        if (!argument)
          throw new Error("Indica el ID de un run o un prefijo único");
        const run = store.read(store.resolve(argument));
        message(
          verb === "inspect"
            ? { archive: run }
            : { reconciliation: reconcileRun(run, processCensus()) },
        );
        return;
      }
      if (verb === "restart") {
        if (!stateDirectory)
          throw new Error(
            "El reinicio requiere persistencia privada (PI_ORCHESTRATOR_STATE_DIR)",
          );
        const [taskId, acceptance, ...prompt] = rest;
        if (!argument || !taskId || acceptance !== "--accept-duplicate-risk")
          throw new Error(
            "Uso: /orch restart RUN TAREA --accept-duplicate-risk INSTRUCCIÓN_NUEVA",
          );
        const plan = planRecovery(
          new RunStore(stateDirectory),
          argument,
          taskId,
          ctx.cwd,
          prompt.join(" "),
          true,
        );
        if (
          (await currentService())?.journal?.runId === plan.recoverySource.runId
        )
          throw new Error(
            "El reinicio solo acepta runs históricos; las tareas actuales ya tienen controles en vivo",
          );
        if (
          ctx.mode === "tui" &&
          !(await ctx.ui.confirm(
            "Reiniciar intento histórico",
            recoveryWarning,
          ))
        )
          return;
        const { core } = await get(ctx);
        message(
          core.delegate(
            null,
            plan.engine,
            plan.prompt,
            randomUUID(),
            plan.recoverySource,
          ),
        );
        return;
      }
      if (
        !["status", "result", "cancel", "run", "start", "demo"].includes(verb)
      ) {
        message(
          { help: true },
          "[Acción /orch desconocida; ayuda mostrada al operador]",
        );
        ctx.ui.notify?.(
          "Acción /orch desconocida; te muestro la ayuda.",
          "warning",
        );
        return;
      }
      const { core } = await get(ctx);
      if (verb === "status") {
        message(core.list());
        return;
      }
      if (verb === "result" && argument) {
        message(core.status(null, resolveTask(core.list(), argument).id));
        return;
      }
      if (verb === "cancel" && argument) {
        message(await core.cancel(null, resolveTask(core.list(), argument).id));
        return;
      }
      if (verb === "run" || verb === "start" || verb === "demo") {
        const engine = verb === "demo" ? "codex" : argument;
        if (
          engine !== "codex" &&
          engine !== "claude" &&
          engine !== "antigravity"
        )
          throw new Error("Indica el motor: codex, claude o antigravity");
        const selection: { model?: string; thinking?: string } = {};
        let offset = 0;
        while (verb !== "demo" && rest[offset]?.startsWith("--")) {
          const flag = rest[offset++];
          if (flag === "--") break;
          if (flag !== "--model" && flag !== "--thinking")
            throw new Error(
              "Antes de la instrucción solo se admiten --model MODELO o --thinking NIVEL",
            );
          const value = rest[offset++];
          if (!value) throw new Error("Falta el valor de --model o --thinking");
          selection[flag === "--model" ? "model" : "thinking"] = value;
        }
        const task = core.delegate(
          null,
          engine as Engine,
          verb === "demo" ? demoPrompt : rest.slice(offset).join(" "),
          randomUUID(),
          undefined,
          selection,
        );
        if (verb === "start" || (verb === "demo" && ctx.mode === "tui")) {
          message(task);
          // Non-blocking: the operator keeps the editor and can open/cancel from /orch.
          return;
        }
        let result: TaskView = task;
        try {
          while (!isTerminal(result))
            result = await core.wait(null, task.id, 30_000, ctx.signal);
        } catch (error) {
          if (ctx.signal?.aborted) await core.cancel(null, task.id);
          throw error;
        }
        if (result.state !== "completed")
          throw new Error(result.error ?? result.state);
        return;
      }
      throw new Error("Acción /orch desconocida; usa /orch help");
    },
  });
}
