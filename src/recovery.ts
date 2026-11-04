import { realpathSync } from "node:fs";
import { RunStore } from "./journal.ts";
import type { Engine, RecoverySource } from "./types.ts";

export const recoveryWarning =
  "Reinicio explícito, no reanudación: el intento anterior podría seguir activo. Se creará una raíz con nuevas identidades y credenciales; no se adoptan ni señalan procesos archivados. No se repite automáticamente el subárbol ni se recupera el prompt original.";

/** Pure read-only planning. No coordinator, ports, runtime execution or process census. */
export function planRecovery(
  store: RunStore,
  runPrefix: string,
  taskPrefix: string,
  cwd: string,
  prompt: string,
  acceptDuplicateRisk: boolean,
): { engine: Engine; prompt: string; recoverySource: RecoverySource } {
  if (!acceptDuplicateRisk)
    throw new Error(
      "Debes aceptar explícitamente el riesgo de trabajo duplicado (--accept-duplicate-risk)",
    );
  if (!prompt.trim() || prompt.length > 32_000)
    throw new Error("Se requiere una instrucción nueva de 1–32000 caracteres");
  const run = store.read(store.resolve(runPrefix));
  if (realpathSync(cwd) !== run.cwd)
    throw new Error("El workspace actual no coincide con el del run archivado");
  if (taskPrefix.length < 8)
    throw new Error(
      "Usa el ID de la tarea o un prefijo único de al menos ocho caracteres",
    );
  const matches = run.tasks.filter((task) => task.id.startsWith(taskPrefix));
  if (matches.length !== 1)
    throw new Error("El ID de tarea archivada es desconocido o ambiguo");
  const task = matches[0]!;
  return {
    engine: task.engine,
    prompt,
    recoverySource: {
      runId: run.runId,
      taskId: task.id,
      attemptId: task.attemptId,
    },
  };
}
