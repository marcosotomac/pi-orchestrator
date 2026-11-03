import { CodexAdapter } from "./adapters/codex.ts";
import { AntigravityAdapter } from "./adapters/antigravity.ts";
import { ClaudeAdapter } from "./adapters/claude.ts";
import { startMcpBridge, type BridgeAudit } from "./mcp-bridge.ts";
import { Orchestrator, type OrchestratorOptions } from "./orchestrator.ts";
import { RunJournal, RunStore } from "./journal.ts";

export interface ServiceOptions extends Omit<OrchestratorOptions, "adapters" | "checkpoint"> {
  onBridgeAudit?: (event: BridgeAudit) => void;
  stateDirectory?: string;
  /** Archives kept by retention (closed runs beyond this are deleted). */
  keepRuns?: number;
}
export interface Service {
  core: Orchestrator;
  journal?: RunJournal;
  close(): Promise<void>;
}

export async function createService(options: ServiceOptions, adapters: OrchestratorOptions["adapters"] = { codex: new CodexAdapter(), claude: new ClaudeAdapter(), antigravity: new AntigravityAdapter() }): Promise<Service> {
  let journal: RunJournal | undefined;
  const core = new Orchestrator({ ...options, adapters, checkpoint: (tasks) => journal?.checkpoint(tasks) });
  // Failure here opens no bridge and launches no runtime. Persistence is explicitly opt-in.
  if (options.stateDirectory) {
    const store = new RunStore(options.stateDirectory);
    journal = new RunJournal(store, core.cwd);
    // Default-on persistence needs bounded disk use; retention never blocks startup.
    try { store.prune(options.keepRuns ?? 100, journal.runId); } catch { /* retention is best effort */ }
  }
  let bridge: Awaited<ReturnType<typeof startMcpBridge>>;
  try { bridge = await startMcpBridge(core, options.onBridgeAudit); }
  catch (error) { journal?.close(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    core, journal,
    close: () => closing ??= (async () => {
      // Storage problems must never prevent process/transport cleanup.
      await bridge.close();
      journal?.checkpoint(core.list());
      journal?.close();
    })(),
  };
}
