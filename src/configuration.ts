import type { OrchestratorOptions } from "./orchestrator.ts";

/**
 * Product defaults for the Pi extension; explicit environment settings win.
 * The core keeps its conservative library defaults (reject queue, 3 slots, 60 s
 * dialogs) so embedding and tests stay explicit.
 * - fair: a fan-out of N root tasks queues instead of failing the (N+1)th.
 * - 4 slots: with fair, one slot is reserved for nested children, so three
 *   roots still run in parallel as before.
 * - 5 min dialogs: a permission must survive the operator being in another tab.
 */
export const productDefaults: Partial<OrchestratorOptions> = { queuePolicy: "fair", maxConcurrent: 4, interactionTimeoutMs: 300_000 };

/** Read-only configuration parsing; no timers, files, ports or subprocesses. */
export function runtimeConfiguration(env: NodeJS.ProcessEnv = process.env): Partial<OrchestratorOptions> {
  const options: Partial<OrchestratorOptions> = {};
  const fields = { PI_ORCHESTRATOR_MAX_CONCURRENT: "maxConcurrent", PI_ORCHESTRATOR_MAX_TASKS: "maxTasks", PI_ORCHESTRATOR_MAX_DEPTH: "maxDepth", PI_ORCHESTRATOR_MAX_RUNTIME_MS: "maxRuntimeMs", PI_ORCHESTRATOR_TASK_TIMEOUT_MS: "timeoutMs", PI_ORCHESTRATOR_MAX_QUEUED: "maxQueued", PI_ORCHESTRATOR_RESERVED_CHILD_SLOTS: "reservedChildSlots", PI_ORCHESTRATOR_INTERACTION_TIMEOUT_MS: "interactionTimeoutMs" } as const;
  for (const [name, field] of Object.entries(fields)) {
    const value = env[name];
    if (value === undefined) continue;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`Invalid orchestrator setting: ${name}`);
    options[field] = Number(value);
  }
  if (env.PI_ORCHESTRATOR_QUEUE !== undefined) {
    if (!["reject", "fair"].includes(env.PI_ORCHESTRATOR_QUEUE)) throw new Error("Invalid orchestrator queue policy");
    options.queuePolicy = env.PI_ORCHESTRATOR_QUEUE as "reject" | "fair";
  }
  return options;
}
