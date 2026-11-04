// PTY test fixture only. This extension NEVER launches Codex or Claude.
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createOrchestratorExtension } from "../../src/extension.ts";
import { Orchestrator } from "../../src/orchestrator.ts";
import { createService, type ServiceOptions } from "../../src/service.ts";
import { RuntimeProcess } from "../../src/adapters/process.ts";
import { capabilities, type RuntimeAdapter } from "../../src/types.ts";

async function fakeService(options: ServiceOptions) {
  let core!: Orchestrator;
  const adapter: RuntimeAdapter = {
    capabilities,
    async run(context) {
      const runtime = new RuntimeProcess(
        process.execPath,
        [
          fileURLToPath(new URL("./tui-worker.cjs", import.meta.url)),
          join(context.task.cwd, ".fixture-lifeline"),
        ],
        context.task.cwd,
        context.signal,
      );
      // A private FIFO closes with the harness; workers exit themselves even if Pi crashes.
      try {
        const result = new Promise<string>((resolve, reject) => {
          runtime.onFailure = reject;
          void runtime.closed.then(() =>
            reject(new Error("fixture runtime closed")),
          );
          runtime.onMessage = () => {
            context.session(`fixture-${context.task.id}`);
            context.activity("SIMULADO · sin agentes reales");
            if (context.task.depth === 1) {
              const child = core.delegate(
                context.task.id,
                "claude",
                "Hijo SIMULADO 界",
                "fixture-child",
              );
              void core
                .wait(context.task.id, child.id, 60_000)
                .then(() => resolve("fixture result"), reject);
            }
          };
        });
        runtime.observe(context.process);
        return await result;
      } finally {
        await delay(350); // Make the pending-cancel UI observable in a real terminal.
        await runtime.stop();
      }
    },
  };
  const service = await createService(options, {
    codex: adapter,
    claude: adapter,
  });
  core = service.core;
  return service;
}

export default createOrchestratorExtension(fakeService);
