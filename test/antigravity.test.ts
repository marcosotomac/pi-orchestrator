import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chmodSync } from "node:fs";
import { detectAntigravity } from "../src/antigravity-installation.ts";
import { AntigravityAdapter } from "../src/adapters/antigravity.ts";
import type { RuntimeContext, RuntimeProcessInfo } from "../src/types.ts";

const executable = fileURLToPath(new URL("./fixtures/antigravity-acp.cjs", import.meta.url));
const context = (signal: AbortSignal, processes: RuntimeProcessInfo[], sessions: string[]): RuntimeContext => ({
  task: { id: "fixture", attemptId: "attempt", parentId: null, depth: 1, cwd: process.cwd(), engine: "antigravity", state: "running", title: "fixture", createdAt: new Date().toISOString() },
  prompt: "fixture prompt", signal, mcp: { url: "http://127.0.0.1:12345/mcp", token: "fixture-private-token" },
  process: (info) => processes.push(info), session: (id) => sessions.push(id), activity: () => {},
});

for (const scenario of ["yolo-success", "yolo-late", "yolo-invalid-id", "yolo-foreign", "yolo-persistent", "yolo-question", "yolo-duplicate", "yolo-invalid-options", "success", "version", "identity", "no-http", "auth", "no-session", "no-plan", "permission", "question", "client-write", "wrong-session", "oversize", "malformed", "bad-stop", "duplicate", "trailing", "early-exit", "hang", "bridge-success", "bridge-unknown-tool", "bridge-foreign-session", "bridge-question", "bridge-title-spoof", "bridge-no-mcp", "bridge-foreign-server", "bridge-only-always", "human-allow", "human-deny", "human-question", "early-update", "early-foreign"]) {
  test(`Antigravity ACP fixture: ${scenario}`, { skip: process.platform === "win32", timeout: 5000 }, async () => {
    chmodSync(executable, 0o700);
    const previous = process.env.ORCH_ACP_FIXTURE_CASE;
    process.env.ORCH_ACP_FIXTURE_CASE = scenario;
    const controller = new AbortController();
    const processes: RuntimeProcessInfo[] = [], sessions: string[] = [];
    const timeout = setTimeout(() => controller.abort(new Error("fixture deadline")), scenario === "hang" ? 200 : 3000);
    try {
      const ctx = context(controller.signal, processes, sessions);
      if (scenario.startsWith("yolo-")) {
        ctx.task.permissionMode = "yolo";
        ctx.interact = async (request) => {
          assert.equal(request.kind, "question", "YOLO must never open a tool permission dialog");
          return undefined; // No fabricated answers to genuine questions.
        };
      }
      if (scenario.startsWith("human-")) ctx.interact = async (request) => {
        assert.equal(request.kind, scenario === "human-question" ? "question" : "permission");
        if (request.kind === "permission") assert.deepEqual(request.options.map((option) => option.id), ["once"], "persistent approval is never offered");
        assert.ok(request.detail.includes("fixture only"));
        return scenario === "human-deny" ? undefined : { optionId: "once" };
      };
      const run = new AntigravityAdapter(executable, true, () => process.env).run(ctx);
      if (["yolo-success", "success", "bridge-success", "human-allow", "human-question", "early-update"].includes(scenario)) {
        assert.equal(await run, "fixture answer"); assert.deepEqual(sessions, ["fixture-session"]);
      } else if (scenario === "oversize") {
        // The adapter keeps one char past the bound; the core labels the truncation.
        assert.equal((await run).length, 20_001); assert.deepEqual(sessions, ["fixture-session"]);
      } else await assert.rejects(run, (error: Error) => {
        assert.ok(!error.message.includes("private provider error"));
        assert.ok(!error.message.includes("fixture-private-token"));
        if (scenario === "early-foreign") assert.match(error.message, /unknown session/, "a held update from another session still fails closed");
        return true;
      });
      assert.ok(processes[0]?.pid); assert.ok(processes.at(-1)?.exitedAt, "actual owned exit before settlement");
    } finally {
      clearTimeout(timeout); controller.abort();
      if (previous === undefined) delete process.env.ORCH_ACP_FIXTURE_CASE; else process.env.ORCH_ACP_FIXTURE_CASE = previous;
    }
  });
}

test("Antigravity installation detection never substitutes agy CLI and honors explicit configuration", () => {
  assert.equal(detectAntigravity({ PATH: "/no-runtime" }, "/no-managed-runtime").executable, undefined);
  assert.equal(detectAntigravity({ PATH: "relative" }, "/no-managed-runtime").executable, undefined);
  assert.equal(detectAntigravity({ PI_ORCHESTRATOR_ANTIGRAVITY_ACP: "relative" }).executable, undefined);
  const result = detectAntigravity({ PI_ORCHESTRATOR_ANTIGRAVITY_ACP: executable, PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL: "1" });
  assert.equal(result.executable, executable); assert.equal(result.enabled, true);
  assert.match(result.status, /still require runtime validation/);
  assert.equal(detectAntigravity({}).enabled, true, "operator-authorized execution needs no launcher flag");
  assert.equal(detectAntigravity({ PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL: "0" }).enabled, false);
  assert.equal(detectAntigravity({ PI_ORCHESTRATOR_ANTIGRAVITY_EXPERIMENTAL: "invalid" }).enabled, false);
});

test("Antigravity disabled or missing ACP fails without spawning; never falls back to installed agy CLI", async () => {
  const processes: RuntimeProcessInfo[] = [];
  const ctx = context(new AbortController().signal, processes, []);
  await assert.rejects(new AntigravityAdapter(executable, false).run(ctx), /explicitly disabled/);
  await assert.rejects(new AntigravityAdapter("agy", true).run(ctx), /absolute official ACP/);
  await assert.rejects(new AntigravityAdapter("/no-such-runtime/agy_acp_server.par", true).run(ctx), /unavailable/);
  assert.deepEqual(processes, []);
});
