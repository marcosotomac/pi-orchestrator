import { mkdtempSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createOrchestratorExtension } from "../src/extension.ts";
import { createService } from "../src/service.ts";

/** Manual TUI harness: uses the real Pi dialog handler, never manufactures an answer. */
export default createOrchestratorExtension(async (options) => {
  const directory = mkdtempSync(resolve("artifacts/human-permissions-"));
  const observations: { kind: string; answered: boolean; aborted: boolean; at: string }[] = [];
  const persist = (closed: boolean, tasks: ReturnType<Awaited<ReturnType<typeof createService>>["core"]["list"]> = []) => {
    writeFileSync(join(directory, "report.json"), JSON.stringify({
      scope: "Manual native permission exercise; answers come from Pi UI, not an automated test. Native operation success requires separate operator review.",
      closed, observations, tasks: tasks.map((task) => ({ id: task.id, engine: task.engine, state: task.state, exited: Boolean(task.runtimeProcess?.exitedAt) })),
    }, null, 2), { mode: 0o600 });
  };
  persist(false);
  const service = await createService({ ...options, onInteraction: async (request, signal) => {
    const answer = await options.onInteraction?.(request, signal);
    observations.push({ kind: request.kind, answered: Boolean(answer), aborted: signal.aborted, at: new Date().toISOString() });
    persist(false);
    return answer;
  } });
  return { ...service, close: async () => { try { await service.close(); } finally { persist(true, service.core.list()); } } };
});
