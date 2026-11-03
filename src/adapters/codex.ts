import { capabilities, validatePermissionMode, yoloSandbox, type EngineCatalog, type RuntimeAdapter, type RuntimeContext } from "../types.ts";
import { RuntimeProcess } from "./process.ts";
import { WORKER_CONTRACT } from "../worker-contract.ts";
import { activityText, commandTarget, pathTarget } from "../activity.ts";

interface McpServerRow { name: string; runtimeStatus?: string | null }

/** Worker effort when the task does not request one. Overridable, never the user's global default. */
export function defaultEffort(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING?.trim();
  if (value === undefined || value === "") return "medium";
  if (!/^[a-z]{1,32}$/.test(value)) throw new Error("Invalid PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING");
  return value;
}

/** Names of config-defined MCP servers (user + project layers) as Codex resolves them for `cwd`. */
async function configuredMcpServers(request: (method: string, params: unknown) => Promise<any>, cwd: string): Promise<string[]> {
  const result = await request("config/read", { cwd, includeLayers: false });
  const servers = result?.config?.mcp_servers ?? {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) throw new Error("Codex returned an invalid configuration");
  const names = Object.keys(servers).filter((name) => name !== "pi_orchestrator");
  if (names.some((name) => !/^[A-Za-z0-9_-]{1,128}$/.test(name))) throw new Error("Codex returned an unsupported MCP server name");
  return names;
}

async function listMcpServers(request: (method: string, params: unknown) => Promise<any>, threadId: string): Promise<McpServerRow[]> {
  const rows: McpServerRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const result = await request("mcpServerStatus/list", { limit: 100, detail: "toolsAndAuthOnly", ...(threadId ? { threadId } : {}), ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(result?.data) || result.data.some((row: any) => typeof row?.name !== "string")) throw new Error("Codex returned an invalid MCP server listing");
    rows.push(...result.data);
    cursor = typeof result.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!cursor) return rows;
  }
  throw new Error("Codex MCP server listing did not terminate");
}

/** Dedicated app-server per attempt. Own authentication is inherited from Codex, not Pi. */
export class CodexAdapter implements RuntimeAdapter {
  // resume: thread/resume of a persisted (non-ephemeral) thread, for follow-ups that
  // reuse the context instead of paying the full fixed cost again.
  capabilities = { ...capabilities, steer: true, resume: true };

  constructor(private readonly executable = "codex") {}

  /** model/list from a short-lived app-server: initialize, list, exit. */
  async catalog(cwd: string, signal: AbortSignal): Promise<EngineCatalog> {
    const runtime = new RuntimeProcess(this.executable, ["app-server", "--listen", "stdio://", "--disable", "hooks", "-c", "notify=[]"], cwd, signal);
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
    let failure: Error | undefined;
    runtime.onFailure = (error) => { failure = error; for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    runtime.onMessage = (message) => {
      const waiter = typeof message.id === "number" ? pending.get(message.id) : undefined;
      if (!waiter || message.method !== undefined) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(typeof message.error?.message === "string" ? message.error.message : "Codex RPC failed")); else waiter.resolve(message.result);
    };
    let id = 0;
    const request = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const key = ++id; pending.set(key, { resolve, reject });
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Codex RPC timeout: ${method}`)); }, 20_000);
      pending.set(key, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      runtime.send({ id: key, method, params });
    });
    try {
      await request("initialize", { clientInfo: { name: "pi-orchestrator", title: "Pi orchestrator prototype", version: "0.1.0" }, capabilities: { experimentalApi: false } });
      runtime.send({ method: "initialized" });
      const listing = await request("model/list", { includeHidden: false, limit: 100 });
      if (!Array.isArray(listing?.data)) throw new Error("Codex returned an invalid model listing");
      return {
        models: listing.data.slice(0, 64).filter((item: any) => typeof item?.model === "string").map((item: any) => ({
          id: String(item.model).slice(0, 128), ...(typeof item.displayName === "string" ? { name: item.displayName.slice(0, 160) } : {}),
          efforts: Array.isArray(item.supportedReasoningEfforts) ? item.supportedReasoningEfforts.map((effort: any) => String(effort?.reasoningEffort)).slice(0, 16) : [],
          ...(item.isDefault === true ? { default: true } : {}),
        })),
        note: `Without thinking, workers use ${defaultEffort()} (PI_ORCHESTRATOR_CODEX_DEFAULT_THINKING); without model, Codex's configured default.`,
      };
    } finally { await runtime.stop(); }
  }

  async run(context: RuntimeContext): Promise<string> {
    const yolo = validatePermissionMode(context.task.permissionMode) === "yolo";
    const runtime = new RuntimeProcess(this.executable, ["app-server", "--listen", "stdio://", "--disable", "hooks", "-c", "notify=[]"], context.task.cwd, context.signal);
    runtime.observe(context.process);
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let finalResolve!: (result: string) => void;
    let finalReject!: (error: Error) => void;
    const completed = new Promise<string>((resolve, reject) => { finalResolve = resolve; finalReject = reject; });
    // The turn may fail before startup RPCs finish; attach a handler immediately.
    void completed.catch(() => {});
    let failed: Error | undefined;
    let lastMessage = "";
    let threadId: string | undefined;
    let turnId: string | undefined;
    let turnRequested = false;
    let receivedCompletion = false;
    let earlyBytes = 0;
    const earlyEvents: { method: string; params: any }[] = [];
    const turnEvent = (method: string, params: any) => {
      if (!turnRequested || params?.threadId !== threadId) throw new Error("Codex event does not belong to the requested thread");
      const eventTurnId = method === "turn/completed" ? params?.turn?.id : params?.turnId;
      if (typeof eventTurnId !== "string" || !eventTurnId) throw new Error("Codex event returned no turn id");
      if (!turnId) {
        earlyBytes += Buffer.byteLength(JSON.stringify(params));
        if (earlyEvents.length >= 128 || earlyBytes > 1_048_576) throw new Error("Codex pre-response event buffer exceeded");
        earlyEvents.push({ method, params });
        return;
      }
      if (eventTurnId !== turnId) throw new Error("Codex event does not belong to the requested turn");
      const item = params.item;
      if (method === "item/completed" && item?.type === "agentMessage") {
        if (typeof item.text !== "string") throw new Error("Codex returned invalid agent text");
        lastMessage = item.text;
        if (item.text.trim()) { try { context.partial?.(item.text); } catch { /* observer only */ } }
      }
      if (method === "item/started") {
        context.activity(item?.type === "mcpToolCall"
          ? `codex: mcp/${String(item.server)}/${String(item.tool)}`
          : item?.type === "commandExecution" ? activityText("codex", "commandExecution", commandTarget(item.command))
          : item?.type === "fileChange" ? activityText("codex", "fileChange", Array.isArray(item.changes) ? [...new Set(item.changes.map((change: any) => pathTarget(change?.path)).filter(Boolean))].slice(0, 3).join(", ") || undefined : undefined)
          : `codex: ${String(item?.type ?? "item")}`);
      }
      if (method === "item/completed" && item?.type === "mcpToolCall") {
        context.activity(`codex: mcp/${String(item.server)}/${String(item.tool)} ${String(item.status ?? "completed")}`);
      }
      if (method === "turn/completed") {
        if (receivedCompletion) throw new Error("Codex returned duplicate turn completion");
        receivedCompletion = true;
        const turn = params.turn;
        if (turn.status !== "completed") throw new Error(typeof turn.error?.message === "string" ? turn.error.message : `Codex turn ${String(turn.status)}`);
        if (!Array.isArray(turn.items)) throw new Error("Codex returned invalid turn items");
        const messages = turn.items.filter((entry: any) => entry?.type === "agentMessage");
        const text = messages.at(-1)?.text ?? lastMessage;
        if (typeof text !== "string") throw new Error("Codex returned invalid result text");
        finalResolve(text);
      }
    };
    const fail = (error: Error) => {
      failed ??= error;
      finalReject(error);
      for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
      pending.clear();
    };
    const request = (method: string, params: unknown): Promise<any> => {
      if (failed) return Promise.reject(failed);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Codex RPC timeout: ${method}`));
        }, 45_000);
        pending.set(id, { resolve, reject, timer });
        try { runtime.send({ id, method, params }); }
        catch (error) {
          clearTimeout(timer); pending.delete(id); reject(error);
        }
      });
    };
    runtime.onFailure = fail;
    runtime.onMessage = (message) => {
      if (typeof message.id === "number" && message.method === undefined) {
        const waiter = pending.get(message.id);
        if (!waiter) return;
        if (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) throw new Error("Invalid Codex RPC response");
        pending.delete(message.id); clearTimeout(waiter.timer);
        if (Object.hasOwn(message, "error")) waiter.reject(new Error(typeof message.error?.message === "string" ? message.error.message : "Codex RPC failed"));
        else waiter.resolve(message.result);
        return;
      }
      if (message.method && message.id !== undefined) {
        context.activity(`approval denied: ${String(message.method)}`);
        // No silent escalation to interactive approval or full-access mode.
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) {
          runtime.send({ id: message.id, result: { decision: "decline" } });
        } else {
          runtime.send({ id: message.id, error: { code: -32601, message: "Interactive requests unsupported in this prototype" } });
        }
        return;
      }
      if (message.method === "thread/tokenUsage/updated") {
        // Display-only counters; a foreign thread or malformed payload is ignored, not fatal.
        const total = message.params?.tokenUsage?.total;
        if (threadId && message.params?.threadId === threadId && total) {
          try { context.usage?.({ inputTokens: total.inputTokens, cachedInputTokens: total.cachedInputTokens, outputTokens: total.outputTokens, reasoningTokens: total.reasoningOutputTokens }); }
          catch { /* observer only */ }
        }
        return;
      }
      if (["item/started", "item/completed", "turn/completed"].includes(message.method)) turnEvent(message.method, message.params);
    };
    void runtime.closed.then(({ code }) => fail(new Error(`Codex app-server exited (${code}): ${runtime.stderr}`)));
    try {
      await request("initialize", {
        clientInfo: { name: "pi-orchestrator", title: "Pi orchestrator prototype", version: "0.1.0" },
        capabilities: { experimentalApi: false },
      });
      runtime.send({ method: "initialized" });
      // Isolation: user-configured MCP servers run OUTSIDE Codex's sandbox, so a
      // "read-only" worker that inherits them is not read-only. Disable every
      // config-defined server; plugin/app servers are off via features below.
      // config/read, not a global mcpServerStatus/list: the latter carries every
      // app/tool definition (~2.5 MB measured) and exceeds the protocol line bound.
      const disabled = await configuredMcpServers(request, context.task.cwd);
      const resuming = Boolean(context.resumeSessionId);
      const started = await request(resuming ? "thread/resume" : "thread/start", {
        ...(resuming ? { threadId: context.resumeSessionId, excludeTurns: true } : {}),
        cwd: context.task.cwd,
        // YOLO writes stay inside the task directory (its worktree) unless the operator opted out.
        sandbox: yolo ? yoloSandbox() === "off" ? "danger-full-access" : "workspace-write" : "read-only",
        approvalPolicy: "never",
        // Persisted so the operator (or the coordinating model) can continue it.
        ...(resuming ? {} : { ephemeral: false }),
        ...(context.task.selection?.model ? { model: context.task.selection.model } : {}),
        developerInstructions: `${yolo ? "The operator authorized unattended tool execution for this task only. Follow the task scope; do not request tool approvals." : "You are a read-only worker controlled by Pi. Do not modify files."} Use only the pi_orchestrator MCP tools for delegation. Delegate only if your task explicitly asks. Do not use native subagents, grant yourself or children additional permissions, ask the human directly, or expose credentials. A running child is not a result: wait until it settles. Report failed/cancelled children honestly. ${WORKER_CONTRACT}`,
        config: {
          "features.hooks": false,
          notify: [],
          "features.multi_agent": false,
          "features.apps": false,
          "features.plugins": false,
          // Tool families a delegated worker never uses. Measured: 17,400 → 16,160 input
          // tokens per model call (-7.1%) with shell, MCP and view_image still available.
          ...Object.fromEntries(["browser_use", "browser_use_external", "computer_use", "image_generation", "goals", "skill_search", "tool_suggest", "in_app_browser", "worktrees", "sleep_tool", "realtime_conversation", "plugin_discovery_prefetch"].map((feature) => [`features.${feature}`, false])),
          // Hosted search only when the operator granted it for this task.
          "web_search": context.task.web ? "live" : "disabled",
          // Never inherit the user's global effort (e.g. xhigh) for workers.
          model_reasoning_effort: context.task.selection?.thinking ?? defaultEffort(),
          "mcp_optional_startup_grace_ms": 10_000,
          ...Object.fromEntries(disabled.map((name) => [`mcp_servers.${name}.enabled`, false])),
          // Dotted keys only: mixing a nested `mcp_servers` object with dotted
          // `mcp_servers.X.enabled` overrides makes Codex drop some disables
          // (measured with codex-cli 0.166.0). Verified again after thread/start.
          "mcp_servers.pi_orchestrator.url": context.mcp.url,
          // Bridge approvals stay scoped independently of the task filesystem policy.
          // Spawning/cancelling workers are not read-only MCP operations.
          "mcp_servers.pi_orchestrator.enabled_tools": ["delegate", "status", "wait", "cancel"],
          ...Object.fromEntries(["delegate", "status", "wait", "cancel"].map((name) => [`mcp_servers.pi_orchestrator.tools.${name}.approval_mode`, "approve"])),
          "mcp_servers.pi_orchestrator.http_headers": { Authorization: `Bearer ${context.mcp.token}` },
          // Above the core's 600 s MCP wait bound, so a long wait is not cut client-side.
          "mcp_servers.pi_orchestrator.tool_timeout_sec": 660,
          "mcp_servers.pi_orchestrator.startup_timeout_sec": 15,
          "mcp_servers.pi_orchestrator.omit_tools_from": ["code_mode", "deferred"],
        },
      });
      if (typeof started?.thread?.id !== "string" || !started.thread.id) throw new Error("Codex returned no thread id");
      if (resuming && started.thread.id !== context.resumeSessionId) throw new Error("Codex resumed a different thread");
      threadId = String(started.thread.id);
      context.session(threadId);
      if (typeof started.model === "string" && started.model) {
        try { context.modelState?.({ model: started.model.slice(0, 128), thinking: context.task.selection?.thinking ?? defaultEffort(), availableModels: [], availableThinking: [] }); } catch { /* observer only */ }
      }
      // Fail closed: prove the thread really runs without inherited servers.
      const leaked = (await listMcpServers(request, threadId))
        .filter((server) => server.name !== "pi_orchestrator" && server.runtimeStatus !== "disabled")
        .map((server) => server.name);
      if (leaked.length) throw new Error(`Codex MCP isolation could not be verified; inherited servers active: ${leaked.join(", ")}`);
      if (context.task.selection?.thinking) {
        const listing = await request("model/list", { includeHidden: true, limit: 100 });
        const selectedModel = started.model ?? context.task.selection.model;
        const model = Array.isArray(listing?.data) ? listing.data.find((item: any) => item.model === selectedModel || item.id === selectedModel) : undefined;
        const levels = Array.isArray(model?.supportedReasoningEfforts) ? model.supportedReasoningEfforts.map((item: any) => item.reasoningEffort) : [];
        if (!levels.includes(context.task.selection.thinking)) throw new Error("Requested Codex reasoning effort is unavailable for the selected model; no fallback was used");
      }
      turnRequested = true;
      const turnStarted = await request("turn/start", {
        threadId,
        input: [{ type: "text", text: context.prompt }],
        ...(context.task.selection?.thinking ? { effort: context.task.selection.thinking } : {}),
      });
      if (typeof turnStarted?.turn?.id !== "string" || !turnStarted.turn.id) throw new Error("Codex returned no turn id");
      turnId = turnStarted.turn.id;
      for (const event of earlyEvents.splice(0)) turnEvent(event.method, event.params);
      if (!receivedCompletion) context.registerControls?.({ steer: async (text) => {
        context.signal.throwIfAborted();
        if (receivedCompletion || failed) throw new Error("Codex turn is no longer steerable");
        const expectedTurnId = turnId;
        const acknowledged = await request("turn/steer", { threadId, expectedTurnId, input: [{ type: "text", text }] });
        if (acknowledged?.turnId !== expectedTurnId) throw new Error("Codex steer acknowledged a different turn");
      } });
      return await completed;
    } finally {
      try { context.registerControls?.(undefined); } catch { /* A faulty host callback cannot prevent owned cleanup. */ }
      for (const request of pending.values()) {
        clearTimeout(request.timer); request.reject(new Error("Codex session closed"));
      }
      pending.clear();
      await runtime.stop();
      if (runtime.failure) throw runtime.failure;
    }
  }
}
