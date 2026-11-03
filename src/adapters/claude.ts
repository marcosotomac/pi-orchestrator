import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { capabilities, validatePermissionMode, RuntimeCleanupError, type RuntimeAdapter, type RuntimeContext } from "../types.ts";
import { RuntimeProcess } from "./process.ts";

/** Bounded integer from the environment; invalid values fail closed. */
export function claudeLimit(name: string, fallback: number, min: number, max: number, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}

/** Claude Code CLI session with its own OAuth/API credentials and scoped MCP tools. */
export class ClaudeAdapter implements RuntimeAdapter {
  capabilities = capabilities;

  constructor(private readonly executable = "claude") {}

  async run(context: RuntimeContext): Promise<string> {
    const yolo = validatePermissionMode(context.task.permissionMode) === "yolo";
    const tools = yolo ? "Read,Glob,Grep,Bash,Write,Edit" : "Read,Glob,Grep";
    const directory = await mkdtemp(join(tmpdir(), "pi-orchestrator-claude-"));
    let runtime: RuntimeProcess | undefined;
    try {
      const configPath = join(directory, "mcp.json");
      // Credentials never appear in argv or project files. Directory mode is 0700; file is 0600.
      await writeFile(configPath, JSON.stringify({ mcpServers: {
        pi_orchestrator: { type: "http", url: context.mcp.url, headers: { Authorization: `Bearer ${context.mcp.token}` } },
      } }), { mode: 0o600 });
      const args = [
        "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
        ...(!yolo ? ["--restricted"] : ["--dangerously-skip-permissions"]),
        "--tools", tools, "--allowedTools", `${tools},mcp__pi_orchestrator__*`,
        "--permission-mode", yolo ? "bypassPermissions" : "dontAsk", "--permission-prompts", "none",
        "--setting-sources", "", "--strict-mcp-config", "--mcp-config", configPath,
        "--settings", JSON.stringify({ disableAllHooks: true, enabledPlugins: {}, autoMemoryEnabled: false }),
        "--disable-slash-commands", "--no-chrome", "--max-turns", String(claudeLimit("PI_ORCHESTRATOR_CLAUDE_MAX_TURNS", 40, 1, 500)), "--max-budget-usd", "1.00",
        "--append-system-prompt", `${yolo ? "The operator authorized unattended tool execution for this task only. Follow the task scope; do not request tool approvals." : "You are a read-only worker supervised by Pi. Do not modify files."} Delegate only when explicitly required by your assigned task, using pi_orchestrator MCP tools, never native subagents. Wait for delegated results. Do not grant yourself or children additional permissions, ask the human directly, or expose credentials. Report child failures honestly.`,
        ...(context.task.selection?.model ? ["--model", context.task.selection.model] : []),
        ...(context.task.selection?.thinking ? ["--effort", context.task.selection.thinking] : []),
      ];
      runtime = new RuntimeProcess(this.executable, args, context.task.cwd, context.signal);
      runtime.observe(context.process);
      const child = runtime;
      let resolve!: (text: string) => void;
      let reject!: (error: Error) => void;
      const result = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
      void result.catch(() => {});
      let sessionId: string | undefined;
      let receivedResult = false;
      child.onFailure = reject;
      child.onMessage = (message) => {
        if (message.type === "system" && message.subtype === "init") {
          if (sessionId || typeof message.session_id !== "string" || !message.session_id) throw new Error("Claude returned invalid session initialization");
          sessionId = message.session_id;
          context.session(sessionId);
          const bridge = Array.isArray(message.mcp_servers) ? message.mcp_servers.find((server: any) => server?.name === "pi_orchestrator") : undefined;
          if (bridge?.status !== "connected") throw new Error("Claude MCP bridge is not connected");
        }
        if (message.type === "control_request") throw new Error("Claude interactive control requests are unsupported");
        if (message.type === "assistant" || message.type === "result") {
          if (!sessionId || message.session_id !== sessionId) throw new Error("Claude event does not belong to the initialized session");
        }
        if (message.type === "assistant") {
          if (!Array.isArray(message.message?.content)) throw new Error("Claude returned invalid assistant content");
          for (const block of message.message.content) {
            if (block.type === "tool_use") context.activity(`claude: ${String(block.name)}`);
          }
        }
        if (message.type === "result") {
          if (receivedResult) throw new Error("Claude returned duplicate results");
          receivedResult = true;
          const usage = message.usage;
          if (usage && typeof usage === "object") {
            const read = Number(usage.cache_read_input_tokens ?? 0), created = Number(usage.cache_creation_input_tokens ?? 0);
            try { context.usage?.({ inputTokens: Number(usage.input_tokens ?? 0) + read + created, cachedInputTokens: read, outputTokens: Number(usage.output_tokens ?? 0),
              ...(typeof message.total_cost_usd === "number" ? { costUsd: message.total_cost_usd } : {}) }); }
            catch { /* observer only */ }
          }
          if (message.is_error || message.subtype !== "success") {
            reject(new Error(`Claude ${message.subtype}: ${JSON.stringify(message.errors ?? message.result ?? "No result")}`));
          } else if (typeof message.result === "string") {
            // A restricted worker that tried a forbidden tool still produced a
            // valid answer; publishing it labelled beats discarding its tokens.
            const denied = Array.isArray(message.permission_denials) ? message.permission_denials : [];
            const names = [...new Set(denied.map((entry: any) => String(entry?.tool_name ?? "unknown").slice(0, 64)))].slice(0, 8);
            resolve(denied.length ? `${message.result}\n\n[Aviso del orquestador: Claude intentó herramientas no autorizadas (${names.join(", ")}) y fueron denegadas; el resultado puede estar incompleto.]` : message.result);
          }
          else reject(new Error("Claude returned no text result"));
        }
      };
      void child.closed.then(({ code }) => reject(new Error(`Claude exited before a result (${code}): ${child.stderr}`)));
      child.send({ type: "user", message: { role: "user", content: context.prompt }, parent_tool_use_id: null, session_id: "" });
      child.child.stdin.end();
      return await result;
    } finally {
      try {
        await runtime?.stop();
        if (runtime?.failure) throw runtime.failure;
      } finally {
        try { await rm(directory, { recursive: true, force: true }); }
        catch (error) { throw new RuntimeCleanupError(error); }
      }
    }
  }
}
