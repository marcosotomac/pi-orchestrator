import { capabilities, validatePermissionMode, type RuntimeAdapter, type RuntimeContext } from "../types.ts";
import { RuntimeProcess } from "./process.ts";

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
  capabilities = { ...capabilities, steer: true };

  constructor(private readonly executable = "codex") {}

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
      const started = await request("thread/start", {
        cwd: context.task.cwd,
        sandbox: yolo ? "danger-full-access" : "read-only",
        approvalPolicy: "never",
        ephemeral: true,
        ...(context.task.selection?.model ? { model: context.task.selection.model } : {}),
        developerInstructions: `${yolo ? "The operator authorized unattended tool execution for this task only. Follow the task scope; do not request tool approvals." : "You are a read-only worker controlled by Pi. Do not modify files."} Use only the pi_orchestrator MCP tools for delegation. Delegate only if your task explicitly asks. Do not use native subagents, grant yourself or children additional permissions, ask the human directly, or expose credentials. A running child is not a result: wait until it settles. Report failed/cancelled children honestly.`,
        config: {
          "features.hooks": false,
          notify: [],
          "features.multi_agent": false,
          "features.apps": false,
          "features.plugins": false,
          "web_search": "disabled",
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
      threadId = String(started.thread.id);
      context.session(threadId);
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
