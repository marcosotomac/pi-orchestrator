import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import {
  setImmediate as tick,
  setTimeout as delay,
} from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Orchestrator } from "../src/orchestrator.ts";
import { startMcpBridge, type BridgeAudit } from "../src/mcp-bridge.ts";
import {
  capabilities,
  type Engine,
  type RuntimeAdapter,
  type RuntimeContext,
  type TaskView,
} from "../src/types.ts";

async function connect(mcp: RuntimeContext["mcp"]) {
  const client = new Client({ name: "orchestrator-test", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(mcp.url), {
      requestInit: { headers: { Authorization: `Bearer ${mcp.token}` } },
    }),
  );
  return client;
}
function unpack(result: any): any {
  return JSON.parse(result.content[0].text);
}

for (const engine of ["codex", "claude"] as Engine[]) {
  test(`real MCP transport: simulated ${engine} delegates to the opposite engine and receives its result`, async () => {
    const run: RuntimeAdapter["run"] = async (ctx) => {
      if (ctx.task.depth === 2) return "child-proof";
      const client = await connect(ctx.mcp);
      try {
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
          "cancel",
          "delegate",
          "status",
          "wait",
        ]);
        const args = {
          engine: engine === "codex" ? "claude" : "codex",
          prompt: "child",
          requestKey: "nested",
        };
        const first = await client.callTool({
          name: "delegate",
          arguments: args,
        });
        assert.notEqual(first.isError, true);
        const child = unpack(first) as TaskView;
        const retry = unpack(
          await client.callTool({ name: "delegate", arguments: args }),
        );
        assert.equal(retry.id, child.id);
        const result = unpack(
          await client.callTool({
            name: "wait",
            arguments: { taskId: child.id },
          }),
        );
        assert.equal(result.state, "completed");
        return `parent received ${result.result}`;
      } finally {
        await client.close();
      }
    };
    const core = new Orchestrator({
      cwd: process.cwd(),
      adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
    });
    const bridge = await startMcpBridge(core);
    try {
      const task = core.delegate(null, engine, "parent", "parent");
      assert.equal(
        (await core.wait(null, task.id)).result,
        "parent received child-proof",
      );
      assert.equal(core.list().length, 2);
      assert.equal(core.list()[1]!.parentId, task.id);
    } finally {
      await bridge.close();
    }
  });
}

test("concurrent MCP retries consume one slot, limits reject excess work, and a child cannot cancel its sibling", async () => {
  const contexts = new Map<string, RuntimeContext>();
  const run: RuntimeAdapter["run"] = async (ctx) => {
    contexts.set(ctx.task.id, ctx);
    await delay(60_000, undefined, { signal: ctx.signal });
    return "never";
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  const clients: Client[] = [];
  try {
    const parent = core.delegate(null, "codex", "parallel parent", "parent");
    await tick();
    const first = await connect(contexts.get(parent.id)!.mcp);
    clients.push(first);
    const retrying = await connect(contexts.get(parent.id)!.mcp);
    clients.push(retrying);
    const args = {
      engine: "claude",
      prompt: "shared child",
      requestKey: "same",
    };
    const responses = await Promise.all(
      [first, retrying].map((client) =>
        client.callTool({ name: "delegate", arguments: args }),
      ),
    );
    assert.ok(responses.every((response) => !response.isError));
    const left = unpack(responses[0]) as TaskView;
    assert.equal(unpack(responses[1]).id, left.id);
    const right = unpack(
      await first.callTool({
        name: "delegate",
        arguments: { ...args, requestKey: "different" },
      }),
    ) as TaskView;
    assert.notEqual(right.id, left.id);
    assert.equal(core.list().length, 3);
    const atCapacityRetry = await first.callTool({
      name: "delegate",
      arguments: args,
    });
    assert.notEqual(atCapacityRetry.isError, true);
    assert.equal(unpack(atCapacityRetry).id, left.id);
    const excess = await first.callTool({
      name: "delegate",
      arguments: { ...args, requestKey: "excess" },
    });
    assert.equal(excess.isError, true);
    assert.match(unpack(excess).error, /Concurrency/);
    const conflicting = await retrying.callTool({
      name: "delegate",
      arguments: { ...args, prompt: "changed" },
    });
    assert.equal(conflicting.isError, true);
    assert.match(unpack(conflicting).error, /different arguments/);
    const child = await connect(contexts.get(left.id)!.mcp);
    clients.push(child);
    const deep = await child.callTool({ name: "delegate", arguments: args });
    assert.equal(deep.isError, true);
    assert.match(unpack(deep).error, /depth/);
    const siblingStop = await child.callTool({
      name: "cancel",
      arguments: { taskId: right.id },
    });
    assert.equal(siblingStop.isError, true);
    assert.match(unpack(siblingStop).error, /subtree/);
    const cancelled = unpack(
      await first.callTool({ name: "cancel", arguments: { taskId: left.id } }),
    );
    assert.equal(cancelled.state, "cancelled");
    assert.equal(core.status(null, parent.id).state, "running");
    assert.equal(core.status(null, right.id).state, "running");
    assert.equal(
      core.list().length,
      3,
      "Rejected requests must not create attempts",
    );
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await bridge.close();
  }
});

test("a request authenticated at headers is refused if credentials are revoked before its body arrives", async () => {
  let credentials!: RuntimeContext["mcp"];
  let received!: () => void;
  const headersReceived = new Promise<void>((resolve) => {
    received = resolve;
  });
  const run: RuntimeAdapter["run"] = async (ctx) => {
    credentials = ctx.mcp;
    await delay(60_000, undefined, { signal: ctx.signal });
    return "never";
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core, (event) => {
    if (event.phase === "received" && event.authenticated) received();
  });
  let pending: ReturnType<typeof request> | undefined;
  try {
    const task = core.delegate(null, "codex", "slow body", "slow");
    await tick();
    const status = new Promise<number>((resolve, reject) => {
      pending = request(
        bridge.url,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.token}`,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      pending.on("error", reject);
      pending.setTimeout(5_000, () =>
        pending?.destroy(new Error("fixture request timeout")),
      );
      pending.flushHeaders();
    });
    await headersReceived;
    await core.cancel(null, task.id);
    pending!.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "slow-fixture", version: "1" },
        },
      }),
    );
    assert.equal(
      await status,
      401,
      "Header authentication is not authority after revocation",
    );
  } finally {
    pending?.destroy();
    await bridge.close();
  }
});

test("bridge attachment failure closes the newly opened socket without closing the existing bridge", async () => {
  const run: RuntimeAdapter["run"] = async () => "fixture";
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  const original = core.attachEndpoint.bind(core);
  let refusedUrl = "";
  core.attachEndpoint = (url) => {
    refusedUrl = url;
    original(url);
  };
  try {
    await assert.rejects(startMcpBridge(core), /already attached/);
    assert.ok(refusedUrl && refusedUrl !== bridge.url);
    await assert.rejects(
      fetch(refusedUrl, { signal: AbortSignal.timeout(1_000) }),
    );
    assert.equal((await fetch(bridge.url)).status, 401);
  } finally {
    await bridge.close();
  }
});

test("bridge close shares one promise and closes HTTP even when core shutdown rejects", async () => {
  const run: RuntimeAdapter["run"] = async () => "fixture";
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  const original = core.close.bind(core);
  core.close = async () => {
    await original();
    throw new Error("fixture shutdown failure");
  };
  const closing = bridge.close();
  assert.equal(bridge.close(), closing);
  await assert.rejects(closing, /fixture shutdown failure/);
  await assert.rejects(
    fetch(bridge.url, { signal: AbortSignal.timeout(1_000) }),
  );
});

test("disconnecting an MCP wait aborts its listener, not the task or its authority", async () => {
  let credentials!: RuntimeContext["mcp"];
  let observedSignal: AbortSignal | undefined;
  let observedWait: Promise<TaskView> | undefined;
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const run: RuntimeAdapter["run"] = async (ctx) => {
    credentials = ctx.mcp;
    await delay(60_000, undefined, { signal: ctx.signal });
    return "never";
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  const originalWait = core.wait.bind(core);
  core.wait = (caller, id, timeoutMs, signal) => {
    observedSignal = signal;
    observedWait = originalWait(caller, id, timeoutMs, signal);
    void observedWait.catch(() => {});
    began();
    return observedWait;
  };
  let pending: ReturnType<typeof request> | undefined;
  try {
    const task = core.delegate(null, "codex", "wait fixture", "wait fixture");
    await tick();
    pending = request(bridge.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
    });
    pending.on("error", () => {});
    pending.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 42,
        method: "tools/call",
        params: {
          name: "wait",
          arguments: { taskId: task.id, timeoutMs: 60_000 },
        },
      }),
    );
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        started,
        new Promise<void>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Fixture wait never started")),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert.ok(
      observedSignal,
      "The SDK request cancellation must reach core.wait",
    );
    pending.destroy();
    await assert.rejects(observedWait!);
    assert.equal(observedSignal.aborted, true);
    assert.equal(core.status(null, task.id).state, "running");
    const client = await connect(credentials);
    try {
      assert.equal(
        unpack(
          await client.callTool({
            name: "status",
            arguments: { taskId: task.id },
          }),
        ).id,
        task.id,
      );
    } finally {
      await client.close();
    }
  } finally {
    pending?.destroy();
    await bridge.close();
  }
});

test("tool invocation revalidates authority after body admission, before executing the operation", async () => {
  let token = "";
  const run: RuntimeAdapter["run"] = async (ctx) => {
    token = ctx.mcp.token;
    await new Promise<void>((resolve) =>
      ctx.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw ctx.signal.reason;
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  try {
    const parent = core.delegate(
      null,
      "codex",
      "revocation fixture",
      "revocation fixture",
    );
    await tick();
    const original = core.authenticate.bind(core);
    let checks = 0;
    let cancellation: Promise<unknown> | undefined;
    core.authenticate = (credential) => {
      // Headers and the complete body were accepted; revoke at the invocation boundary.
      if (++checks === 3) cancellation = core.cancel(null, parent.id);
      return original(credential);
    };
    const response = await fetch(bridge.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "delegate",
          arguments: {
            engine: "claude",
            prompt: "must never start",
            requestKey: "revoked",
          },
        },
      }),
    });
    const result = (await response.json()) as any;
    assert.equal(result.result.isError, true);
    assert.equal(
      JSON.parse(result.result.content[0].text).error,
      "Caller credentials were revoked",
    );
    assert.equal(checks, 3);
    assert.equal(core.list().length, 1);
    await cancellation;
    assert.equal(original(token), undefined);
  } finally {
    await bridge.close();
  }
});

test("HTTP rejects mismatched authority, empty Origin, malformed UTF-8, oversized bodies, paths and methods", async () => {
  let credentials!: RuntimeContext["mcp"];
  const run: RuntimeAdapter["run"] = async (ctx) => {
    credentials = ctx.mcp;
    await delay(60_000, undefined, { signal: ctx.signal });
    return "never";
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  try {
    core.delegate(null, "codex", "HTTP fixture", "HTTP fixture");
    await tick();
    const headers = {
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    // fetch may normalize forbidden/empty headers; assert the exact bytes using node:http.
    for (const extra of [{ Host: "127.0.0.1:1" }, { Origin: "" }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const pending = request(
          bridge.url,
          { method: "POST", headers: { ...headers, ...extra } },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode!));
          },
        );
        pending.on("error", reject);
        pending.setTimeout(2_000, () =>
          pending.destroy(new Error("Fixture request timeout")),
        );
        pending.end("{}");
      });
      assert.equal(status, 403);
    }
    assert.equal(
      (
        await fetch(bridge.url + "/other", {
          method: "POST",
          headers,
          body: "{}",
        })
      ).status,
      404,
    );
    for (const method of ["GET", "DELETE"])
      assert.equal((await fetch(bridge.url, { method, headers })).status, 405);
    const invalid = await fetch(bridge.url, {
      method: "POST",
      headers,
      body: Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
    });
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "Invalid MCP request" });
    assert.equal(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers,
          body: "x".repeat(256_001),
        })
      ).status,
      413,
    );
  } finally {
    await bridge.close();
  }
});

test("MCP authentication, browser protection, schema validation, ownership, and revocation", async () => {
  const audit: BridgeAudit[] = [];
  const contexts: RuntimeContext[] = [];
  const run: RuntimeAdapter["run"] = async (ctx) => {
    contexts.push(ctx);
    await delay(60_000, undefined, { signal: ctx.signal });
    return "never";
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core, (event) => {
    audit.push(event);
  });
  try {
    const task = core.delegate(null, "codex", "root", "root");
    const sibling = core.delegate(null, "claude", "sibling", "sibling");
    await tick();
    const credentials = contexts[0]!.mcp;
    assert.equal((await fetch(bridge.url, { method: "POST" })).status, 401);
    assert.equal(
      (
        await fetch(bridge.url, {
          method: "POST",
          headers: { Origin: "https://evil.example" },
        })
      ).status,
      403,
    );
    const client = await connect(credentials);
    try {
      const result = await client.callTool({
        name: "status",
        arguments: { taskId: sibling.id },
      });
      assert.equal(result.isError, true);
      assert.match(unpack(result).error, /subtree/);
      const invalid = await client.callTool({
        name: "delegate",
        arguments: { engine: "shell", prompt: "x", requestKey: "x" },
      });
      assert.equal(invalid.isError, true);
      const selfCancel = await client.callTool({
        name: "cancel",
        arguments: { taskId: task.id },
      });
      assert.equal(selfCancel.isError, true);
      const own = await client.callTool({
        name: "status",
        arguments: { taskId: task.id },
      });
      assert.equal(unpack(own).id, task.id);
      await core.cancel(null, task.id);
      assert.equal(
        (
          await fetch(bridge.url, {
            method: "POST",
            headers: { Authorization: `Bearer ${credentials.token}` },
          })
        ).status,
        401,
      );
      assert.ok(
        audit.some(
          (event) =>
            event.phase === "responded" &&
            event.authenticated &&
            event.status === 200,
        ),
      );
      assert.ok(
        audit.some(
          (event) =>
            event.phase === "responded" &&
            !event.authenticated &&
            event.status === 401,
        ),
      );
      assert.ok(
        !JSON.stringify(audit).includes(credentials.token),
        "transport diagnostics must never include bearer credentials or request bodies",
      );
    } finally {
      await client.close();
    }
  } finally {
    await bridge.close();
  }
});

test("real MCP transport: one wait call collects several children (one turn, not N)", async () => {
  let waitCalls = 0;
  const run: RuntimeAdapter["run"] = async (ctx) => {
    if (ctx.task.depth === 2) {
      await delay(20 * Number(ctx.prompt.at(-1)));
      return `proof-${ctx.prompt}`;
    }
    const client = await connect(ctx.mcp);
    try {
      const ids = [];
      for (const n of [1, 2, 3])
        ids.push(
          unpack(
            await client.callTool({
              name: "delegate",
              arguments: {
                engine: "claude",
                prompt: `child-${n}`,
                requestKey: `k${n}`,
              },
            }),
          ).id,
        );
      waitCalls++;
      const views = unpack(
        await client.callTool({ name: "wait", arguments: { taskIds: ids } }),
      ) as TaskView[];
      assert.deepEqual(
        views.map((view) => view.state),
        ["completed", "completed", "completed"],
      );
      const missing = await client.callTool({ name: "wait", arguments: {} });
      assert.equal(missing.isError, true);
      return views.map((view) => view.result).join(",");
    } finally {
      await client.close();
    }
  };
  const core = new Orchestrator({
    cwd: process.cwd(),
    maxConcurrent: 4,
    adapters: { codex: { capabilities, run }, claude: { capabilities, run } },
  });
  const bridge = await startMcpBridge(core);
  try {
    const task = core.delegate(null, "codex", "parent", "parent");
    const done = await core.wait(null, task.id, 10_000);
    assert.equal(done.result, "proof-child-1,proof-child-2,proof-child-3");
    assert.equal(waitCalls, 1);
    const metrics = core.usage().orchestration;
    assert.equal(metrics.waitCalls, 1, "the parent's single call");
    assert.equal(metrics.waitedTasks, 3);
  } finally {
    await bridge.close();
  }
});
