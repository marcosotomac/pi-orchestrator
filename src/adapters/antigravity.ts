import { accessSync, constants } from "node:fs";
import { isAbsolute } from "node:path";
import { selectAcpModel } from "../model-selection.ts";
import { runtimeRequestError } from "../diagnostics.ts";
import {
  capabilities,
  validatePermissionMode,
  type EngineCatalog,
  type RuntimeAdapter,
  type RuntimeContext,
} from "../types.ts";
import { RuntimeProcess } from "./process.ts";
import { activityText, commandTarget, pathTarget } from "../activity.ts";
import { antigravityEnvironment } from "../antigravity-profile.ts";
import { detectAntigravity } from "../antigravity-installation.ts";
import { readOnlyAutoApproval, readOnlyCommand } from "../readonly-commands.ts";

const MAX_DENIALS = 8;

/** ACP only. Never falls back to agy --print or edits a global MCP/auth profile. */
export class AntigravityAdapter implements RuntimeAdapter {
  capabilities = {
    ...capabilities,
    interactiveQuestions: true,
    interactivePermissions: true,
    resume: true,
  };
  constructor(
    private readonly executable = detectAntigravity().executable,
    private readonly enabled = detectAntigravity().enabled,
    private readonly environment: (
      executable: string,
    ) => NodeJS.ProcessEnv = antigravityEnvironment,
  ) {}

  /** Opens a session without a prompt to read the real model and thought-level lists. */
  async catalog(cwd: string, signal: AbortSignal): Promise<EngineCatalog> {
    if (!this.enabled || !this.executable || !isAbsolute(this.executable))
      throw new Error("Antigravity ACP is not configured");
    const runtime = new RuntimeProcess(
      this.executable,
      process.platform === "linux" ? ["--uid="] : [],
      cwd,
      signal,
      undefined,
      this.environment(this.executable),
    );
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    let failure: Error | undefined,
      id = 0;
    runtime.onFailure = (error) => {
      failure = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    runtime.onMessage = (message) => {
      if (message.method) {
        // Never grant anything while probing: requests are refused, notifications ignored.
        if (message.id !== undefined)
          runtime.send({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: "Unsupported while listing models",
            },
          });
        return;
      }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(runtimeRequestError(message.error));
      else waiter.resolve(message.result);
    };
    const request = (method: string, params: unknown) =>
      new Promise<any>((resolve, reject) => {
        if (failure) {
          reject(failure);
          return;
        }
        const key = ++id;
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Antigravity ACP timeout: ${method}`));
        }, 30_000);
        pending.set(key, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        runtime.send({ jsonrpc: "2.0", id: key, method, params });
      });
    try {
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "pi-orchestrator", version: "0.1.0" },
      });
      if (
        initialized?.protocolVersion !== 1 ||
        initialized.agentInfo?.name !== "antigravity-acp"
      )
        throw new Error("Antigravity ACP identity or protocol unavailable");
      await request("authenticate", { methodId: "oauth-personal" });
      const session = await request("session/new", {
        cwd,
        _meta: { antigravity: { disabledTools: ["run_workflow"] } },
        mcpServers: [],
      });
      if (typeof session?.sessionId !== "string")
        throw new Error("Antigravity ACP returned no session");
      const state = await selectAcpModel(
        session,
        {},
        request,
        session.sessionId,
      );
      return {
        models: state.availableModels.map((model) => ({
          id: model.id,
          name: model.name,
          ...(model.id === state.model ? { default: true } : {}),
        })),
        thinking: state.availableThinking,
        note: "thinking sets Antigravity's thought_level; the session default model is marked.",
      };
    } finally {
      await runtime.stop();
    }
  }

  async run(ctx: RuntimeContext): Promise<string> {
    const yolo = validatePermissionMode(ctx.task.permissionMode) === "yolo";
    const autoReadOnly = readOnlyAutoApproval();
    if (!this.enabled)
      throw new Error(
        "Antigravity ACP execution is explicitly disabled; remove PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL=0 or set it to 1",
      );
    if (!this.executable || !isAbsolute(this.executable))
      throw new Error(
        "Set PI_ORCHESTRATOR_ANTIGRAVITY_ACP to an absolute official ACP executable; agy CLI is not ACP",
      );
    try {
      accessSync(this.executable, constants.X_OK);
    } catch {
      throw new Error("Antigravity ACP executable is unavailable");
    }
    const runtime = new RuntimeProcess(
      this.executable,
      process.platform === "linux" ? ["--uid="] : [],
      ctx.task.cwd,
      ctx.signal,
      undefined,
      this.environment(this.executable),
    );
    const interactionIds = new Set<string | number>();
    const pending = new Map<
      number,
      { resolve: (value: any) => void; reject: (error: Error) => void }
    >();
    let promptRequestId: number | undefined;
    let nextId = 0,
      sessionId: string | undefined,
      prompting = false,
      stopping = false,
      output = "",
      protocolError: Error | undefined;
    // A refused operation is answered "cancelled" and the turn goes on, as Codex and
    // Claude do; protocol anomalies still fail. Measured: failing the whole task on
    // the first unapproved tool lost ~15% of nested Antigravity runs.
    let denials = 0;
    const deny = (reason: string) => {
      denials++;
      ctx.activity(`antigravity: denied permission (${reason})`);
      if (denials > MAX_DENIALS)
        throw new Error(
          `Antigravity kept requesting unapproved operations (${denials} denied)`,
        );
    };
    const early: any[] = [];
    let earlyBytes = 0;
    const onUpdate = (params: any) => {
      if (!sessionId || params?.sessionId !== sessionId)
        throw new Error("Antigravity update has unknown session");
      const update = params?.update;
      if (update?.sessionUpdate === "agent_message_chunk") {
        if (
          !prompting ||
          update.content?.type !== "text" ||
          typeof update.content.text !== "string"
        )
          throw new Error("Invalid Antigravity agent text");
        // Keep one char past the bound so the core detects and labels truncation;
        // aborting here would discard the whole answer and its tokens.
        if (output.length <= 20_000)
          output += update.content.text.slice(0, 20_001 - output.length);
        ctx.partial?.(output);
      } else if (update?.sessionUpdate === "tool_call") {
        // Measured (1.4.5): kind read|execute|edit|search|other, locations[].path, rawInput.CommandLine.
        const kind =
          typeof update.kind === "string" ? update.kind.slice(0, 24) : "tool";
        const target = Array.isArray(update.locations)
          ? pathTarget(update.locations[0]?.path)
          : undefined;
        ctx.activity(
          activityText(
            "antigravity",
            kind,
            target ??
              commandTarget(update.rawInput?.CommandLine) ??
              (typeof update.title === "string"
                ? commandTarget(
                    update.title
                      .replace(/^Run(ning)?\s+/i, "")
                      .replace(/\?$/, ""),
                  )
                : undefined),
          ),
        );
      } else if (
        update?.sessionUpdate === "usage_update" &&
        typeof update.used === "number" &&
        typeof update.size === "number"
      )
        ctx.context?.(update.used, update.size);
    };
    const fail = (error: Error) => {
      protocolError ??= error;
      prompting = false;
      for (const request of pending.values()) request.reject(protocolError);
      pending.clear();
    };
    const request = (method: string, params: unknown): Promise<any> =>
      new Promise((resolve, reject) => {
        if (protocolError) {
          reject(protocolError);
          return;
        }
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        if (method === "session/prompt") promptRequestId = id;
        try {
          runtime.send({ jsonrpc: "2.0", id, method, params });
        } catch {
          pending.delete(id);
          reject(new Error("Antigravity ACP request failed"));
        }
      });
    runtime.onFailure = fail;
    runtime.onMessage = (message) => {
      try {
        if (message.jsonrpc !== "2.0")
          throw new Error("Invalid Antigravity ACP envelope");
        if (message.method) {
          if (
            message.method === "session/request_permission" &&
            message.id !== undefined
          ) {
            if (
              !(
                typeof message.id === "string" &&
                message.id.length > 0 &&
                message.id.length <= 128
              ) &&
              !(
                typeof message.id === "number" &&
                Number.isSafeInteger(message.id)
              )
            )
              throw new Error(
                "Invalid Antigravity permission request identity",
              );
            const params = message.params;
            const call = params?.toolCall;
            const tool = call?._meta?.mcp?.tool;
            const scopedBridge =
              prompting &&
              params?.sessionId === sessionId &&
              typeof call?.toolCallId === "string" &&
              !call.toolCallId.startsWith("interaction_") &&
              call?._meta?.is_mcp_tool_call === true &&
              call?._meta?.mcp?.server === "pi_orchestrator" &&
              ["delegate", "status", "wait", "cancel"].includes(tool) &&
              call.title === `pi_orchestrator_${tool}`;
            const local =
              prompting &&
              !stopping &&
              !protocolError &&
              !ctx.signal.aborted &&
              params?.sessionId === sessionId &&
              typeof call?.toolCallId === "string" &&
              call.toolCallId.length > 0;
            const question =
              local && call.toolCallId.startsWith("interaction_");
            if (local) {
              if (interactionIds.size >= 128 || interactionIds.has(message.id))
                throw new Error(
                  "Antigravity interaction limit or duplicate request",
                );
              interactionIds.add(message.id);
              if (
                !Array.isArray(params.options) ||
                params.options.length < 1 ||
                params.options.length > 128 ||
                params.options.some(
                  (option: any) =>
                    !option ||
                    typeof option.optionId !== "string" ||
                    !option.optionId.length ||
                    option.optionId.length > 128,
                ) ||
                new Set(params.options.map((option: any) => option.optionId))
                  .size !== params.options.length
              )
                throw new Error("Invalid Antigravity permission options");
            }
            // Restricted tasks: a recognised read-only inspection command (ls, du, git log…) needs no human.
            const inspection =
              local &&
              !question &&
              !yolo &&
              !scopedBridge &&
              autoReadOnly &&
              call.kind === "execute"
                ? readOnlyCommand(call.rawInput?.CommandLine)
                : undefined;
            const allow =
              local && !question && (scopedBridge || yolo || inspection?.ok)
                ? params.options.find(
                    (option: any) => option.kind === "allow_once",
                  )
                : undefined;
            if (allow) {
              runtime.send({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  outcome: { outcome: "selected", optionId: allow.optionId },
                },
              });
              ctx.activity(
                inspection?.ok
                  ? `antigravity: read-only command auto-approved (${inspection.commands.join(" | ")})`
                  : yolo && !scopedBridge
                    ? "antigravity: task-authorized YOLO approval (once)"
                    : "antigravity: scoped bridge approval",
              );
              return; // Task-local only; persistent grants are never selected.
            }
            if (ctx.interact && local && (!yolo || question)) {
              const choices = params.options.filter(
                (option: any) => question || option.kind === "allow_once",
              );
              const detail = JSON.stringify({
                request: call._meta?.prompt ?? call.title,
                ...(typeof call.kind === "string"
                  ? { kind: call.kind.slice(0, 32) }
                  : {}),
                input: call.rawInput ?? {},
              });
              ctx.activity(
                question
                  ? "antigravity: waiting for user answer"
                  : "antigravity: waiting for human permission",
              );
              void ctx
                .interact({
                  kind: question ? "question" : "permission",
                  title:
                    typeof call.title === "string"
                      ? call.title
                      : "Runtime request",
                  detail,
                  options: choices.map((option: any) => ({
                    id: option.optionId,
                    label: option.name ?? option.kind,
                  })),
                })
                .then((answer) => {
                  if (
                    ctx.signal.aborted ||
                    stopping ||
                    protocolError ||
                    !prompting
                  )
                    return;
                  runtime.send({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      outcome: answer
                        ? { outcome: "selected", optionId: answer.optionId }
                        : { outcome: "cancelled" },
                    },
                  });
                  if (!answer) {
                    try {
                      deny("not granted by the operator");
                    } catch (error) {
                      fail(error as Error);
                    }
                  }
                })
                .catch(() =>
                  fail(new Error("Antigravity interaction failed closed")),
                );
              return;
            }
            runtime.send({
              jsonrpc: "2.0",
              id: message.id,
              result: { outcome: { outcome: "cancelled" } },
            });
            const reason =
              params?.sessionId !== sessionId
                ? "foreign-session"
                : typeof call?.toolCallId === "string" &&
                    call.toolCallId.startsWith("interaction_")
                  ? "user-question"
                  : call?._meta?.is_mcp_tool_call !== true
                    ? "non-mcp-tool"
                    : call?._meta?.mcp?.server !== "pi_orchestrator"
                      ? "foreign-server"
                      : !["delegate", "status", "wait", "cancel"].includes(tool)
                        ? "unknown-tool"
                        : call.title !== `pi_orchestrator_${tool}`
                          ? "title-mismatch"
                          : "no-allow-once";
            // Outside this session's live turn the request is an anomaly, not a tool choice.
            if (!local) {
              ctx.activity(`antigravity: denied permission (${reason})`);
              throw new Error(
                "Antigravity permission request outside the live session turn",
              );
            }
            deny(reason);
            return;
          }
          if (message.id !== undefined) {
            runtime.send({
              jsonrpc: "2.0",
              id: message.id,
              error: { code: -32601, message: "Unsupported client method" },
            });
            throw new Error(
              "Antigravity requested unsupported client capability",
            );
          }
          if (message.method === "session/update") {
            // Antigravity may notify (measured: usage_update) before answering
            // session/new. Hold those, bounded, and validate them once the id is known.
            if (!sessionId) {
              earlyBytes += Buffer.byteLength(
                JSON.stringify(message.params ?? null),
              );
              if (early.length >= 64 || earlyBytes > 262_144)
                throw new Error(
                  "Antigravity pre-session update buffer exceeded",
                );
              early.push(message.params);
              return;
            }
            onUpdate(message.params);
          }
          return;
        }
        const receiver = pending.get(message.id);
        if (
          !receiver ||
          Object.hasOwn(message, "result") === Object.hasOwn(message, "error")
        )
          throw new Error("Invalid Antigravity ACP response");
        pending.delete(message.id);
        if (message.id === promptRequestId) prompting = false;
        if (message.error) receiver.reject(runtimeRequestError(message.error));
        else receiver.resolve(message.result);
      } catch (error) {
        fail(
          error instanceof Error
            ? error
            : new Error("Invalid Antigravity ACP event"),
        );
      }
    };
    runtime.observe(ctx.process);
    void runtime.closed.then(() => {
      if (!stopping) fail(new Error("Antigravity ACP process closed"));
    });
    try {
      const initialized = await request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "pi-orchestrator", version: "0.1.0" },
      });
      if (
        initialized?.protocolVersion !== 1 ||
        initialized.agentInfo?.name !== "antigravity-acp" ||
        initialized.agentInfo?.version !== "1.4.5" ||
        initialized.agentCapabilities?.mcpCapabilities?.http !== true
      )
        throw new Error(
          "Antigravity ACP identity, protocol or HTTP MCP capability unavailable",
        );
      // Uses the runtime's own cached OAuth profile; unattended browser sign-in is disabled.
      await request("authenticate", { methodId: "oauth-personal" });
      if (
        ctx.resumeSessionId &&
        !initialized.agentCapabilities?.sessionCapabilities?.resume
      )
        throw new Error("Antigravity ACP does not advertise native resume");
      sessionId = ctx.resumeSessionId;
      const session = await request(
        ctx.resumeSessionId ? "session/resume" : "session/new",
        {
          ...(ctx.resumeSessionId ? { sessionId: ctx.resumeSessionId } : {}),
          cwd: ctx.task.cwd,
          _meta: { antigravity: { disabledTools: ["run_workflow"] } },
          mcpServers: [
            {
              type: "http",
              name: "pi_orchestrator",
              url: ctx.mcp.url,
              headers: [
                { name: "Authorization", value: `Bearer ${ctx.mcp.token}` },
              ],
            },
          ],
        },
      );
      if (ctx.resumeSessionId) {
        if (
          session?.sessionId !== undefined &&
          session.sessionId !== ctx.resumeSessionId
        )
          throw new Error("Antigravity resumed a different session");
      } else {
        if (typeof session?.sessionId !== "string" || !session.sessionId.trim())
          throw new Error("Antigravity ACP returned no session");
        sessionId = String(session.sessionId);
      }
      ctx.session(sessionId!);
      // Same strict checks as live updates: a foreign session id still fails closed.
      for (const params of early.splice(0)) onUpdate(params);
      if (
        (!ctx.resumeSessionId || session?.modes !== undefined) &&
        (!Array.isArray(session?.modes?.availableModes) ||
          !session.modes.availableModes.some(
            (mode: any) => mode.id === "default",
          ))
      )
        throw new Error(
          "Antigravity ACP does not advertise required approval mode",
        );
      await request("session/set_mode", { sessionId, modeId: "default" });
      ctx.modelState?.(
        await selectAcpModel(
          session,
          ctx.task.selection ?? {},
          request,
          sessionId!,
        ),
      );
      prompting = true;
      // No WORKER_CONTRACT here: appended to the prompt it made Antigravity reach for
      // approval-gated tools; restricted nested tasks then failed (measured 0/4 vs 6/6).
      const result = await request("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: ctx.prompt }],
      });
      prompting = false;
      if (result?.stopReason !== "end_turn" || !output.trim())
        throw new Error("Antigravity ACP turn did not complete with text");
    } finally {
      stopping = true;
      await runtime.stop();
    }
    if (runtime.failure) throw runtime.failure;
    if (protocolError) throw protocolError;
    // Labelled, like Claude's denied tools: the answer may be incomplete.
    return denials
      ? `${output}\n\n[Aviso del orquestador: Antigravity pidió ${denials} ${denials === 1 ? "operación" : "operaciones"} sin aprobación y se ${denials === 1 ? "denegó" : "denegaron"}; el resultado puede estar incompleto.]`
      : output;
  }
}
