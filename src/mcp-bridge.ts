import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { Orchestrator } from "./orchestrator.ts";
import { errorText } from "./types.ts";

const pack = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function sessionServer(core: Orchestrator, caller: string, authorized: () => boolean): McpServer {
  const server = new McpServer({ name: "pi-orchestrator", version: "0.1.0" });
  const guarded = <T,>(operation: (args: T, signal: AbortSignal) => unknown) => async (args: T, extra: { signal: AbortSignal }) => {
    try {
      extra.signal.throwIfAborted();
      if (!authorized()) throw new Error("Caller credentials were revoked");
      return pack(await operation(args, extra.signal));
    }
    catch (error) { return { ...pack({ error: errorText(error) }), isError: true }; }
  };
  server.registerTool("delegate", {
    description: "Delegate a read-only task to another real runtime. Reuse requestKey for retries. Returns task id; use wait for the result. Parent executions count toward concurrency. Never delegate unless your assigned task permits it. Nested tasks are restricted; only the operator can authorize YOLO, and it is not inherited.",
    inputSchema: { permissionMode: z.enum(["restricted", "yolo"]).optional(), model: z.string().min(1).max(128).optional(), thinking: z.string().min(1).max(128).optional(), engine: z.enum(["codex", "claude", "antigravity"]), prompt: z.string().min(1).max(32_000), requestKey: z.string().min(1).max(128) },
  }, guarded(({ engine, prompt, requestKey, model, thinking, permissionMode }: { engine: "codex" | "claude" | "antigravity"; prompt: string; requestKey: string; model?: string; thinking?: string; permissionMode?: "restricted" | "yolo" }) => core.delegate(caller, engine, prompt, requestKey, undefined, { ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) }, permissionMode)));
  server.registerTool("status", {
    description: "Inspect your own task or a descendant. Ancestors and sibling tasks are forbidden.",
    inputSchema: { taskId: z.string() },
  }, guarded(({ taskId }: { taskId: string }) => core.status(caller, taskId)));
  server.registerTool("wait", {
    description: "Wait up to 30 seconds for a descendant result. If still running, call again. A timeout is not task failure.",
    inputSchema: { taskId: z.string(), timeoutMs: z.number().int().min(1).max(60_000).optional() },
  }, guarded(({ taskId, timeoutMs }: { taskId: string; timeoutMs?: number }, signal) => core.wait(caller, taskId, timeoutMs, signal)));
  server.registerTool("cancel", {
    description: "Request cancellation of an owned descendant and its children. A cancelled state confirms cleanup; failed with a cleanup error does not confirm process exit.",
    inputSchema: { taskId: z.string() },
  }, guarded(({ taskId }: { taskId: string }) => {
    if (taskId === caller) throw new Error("Cannot cancel yourself via MCP");
    return core.cancel(caller, taskId);
  }));
  return server;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 256_000) throw new Error("Request too large");
    chunks.push(chunk);
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
}

export interface BridgeAudit {
  at: string;
  phase: "received" | "responded";
  method: string;
  authenticated: boolean;
  callerId?: string;
  status?: number;
}

export async function startMcpBridge(core: Orchestrator, onAudit?: (event: BridgeAudit) => void): Promise<{ url: string; close(): Promise<void> }> {
  let authority = "";
  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const authorization = request.headers.authorization ?? "";
    let caller = authorization.startsWith("Bearer ") ? core.authenticate(authorization.slice(7)) : undefined;
    // No headers, bodies, URLs or credentials in diagnostic events.
    const audit = (phase: BridgeAudit["phase"]) => {
      try { onAudit?.({ at: new Date().toISOString(), phase, method: ["GET", "POST", "DELETE"].includes(request.method ?? "") ? request.method! : "other", authenticated: Boolean(caller), callerId: caller, ...(phase === "responded" ? { status: response.statusCode } : {}) }); } catch { /* observer only */ }
    };
    audit("received");
    response.once("finish", () => audit("responded"));
    // Loopback binding plus Host/Origin checks defend against browser-origin/DNS rebinding requests.
    if (request.headers.host !== authority || request.headers.origin !== undefined) {
      response.writeHead(403).end(); return;
    }
    if (request.url !== "/mcp") { response.writeHead(404).end(); return; }
    if (!caller) { response.writeHead(401).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    if (Number(request.headers["content-length"]) > 256_000) {
      response.writeHead(413, { Connection: "close" }).end(); return;
    }
    let server: McpServer | undefined;
    try {
      const body = await readBody(request);
      // Reading a delayed body crosses an async boundary: header-time authority may be revoked.
      caller = core.authenticate(authorization.slice(7));
      if (!caller) { response.writeHead(401).end(); return; }
      const admittedCaller = caller;
      server = sessionServer(core, caller, () => core.authenticate(authorization.slice(7)) === admittedCaller);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.once("close", () => { void server?.close().catch(() => {}); });
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) response.writeHead(400).end(JSON.stringify({ error: "Invalid MCP request" }));
      else response.end();
      await server?.close().catch(() => {});
    }
  };
  const http = createServer((request, response) => { void handle(request, response); });
  http.requestTimeout = 70_000;
  http.headersTimeout = 10_000;
  const closeHttp = () => new Promise<void>((resolve) => {
    http.close(() => resolve());
    http.closeAllConnections();
  });
  let url: string;
  try {
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("No loopback address");
    authority = `127.0.0.1:${address.port}`;
    url = `http://${authority}/mcp`;
    core.attachEndpoint(url);
  } catch (error) { await closeHttp(); throw error; }
  let closing: Promise<void> | undefined;
  return {
    url,
    close: () => closing ??= (async () => {
      // Core must stop workers first so their pending MCP waits can finish.
      // Even an unexpected core failure must not leave a listening socket behind.
      try { await core.close(); }
      finally { await closeHttp(); }
    })(),
  };
}
