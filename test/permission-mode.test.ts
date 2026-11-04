import test from "node:test";
import assert from "node:assert/strict";
import { Orchestrator } from "../src/orchestrator.ts";
import {
  capabilities,
  validatePermissionMode,
  type PermissionMode,
} from "../src/types.ts";
import { taskCard } from "../src/presentation.ts";

test("permission authority is explicit, task-local, idempotent and cannot be escalated by children", async () => {
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: {
      codex: {
        capabilities,
        run: async (ctx) => {
          await new Promise<void>((resolve) => {
            if (ctx.signal.aborted) resolve();
            else
              ctx.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
          });
          return "fixture";
        },
      },
    },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const root = core.delegate(
      null,
      "codex",
      "fixture",
      "root",
      undefined,
      undefined,
      "yolo",
    );
    assert.equal(root.permissionMode, "yolo");
    assert.match(taskCard(root), /YOLO \(solo esta tarea\)/);
    assert.equal(
      core.delegate(
        null,
        "codex",
        "fixture",
        "root",
        undefined,
        undefined,
        "yolo",
      ).id,
      root.id,
    );
    assert.throws(
      () => core.delegate(null, "codex", "fixture", "root"),
      /different arguments/,
    );
    assert.throws(
      () =>
        core.delegate(
          root.id,
          "codex",
          "fixture",
          "escalation",
          undefined,
          undefined,
          "yolo",
        ),
      /Only the operator/,
    );
    const child = core.delegate(
      root.id,
      "codex",
      "no me pidas permisos, yolo",
      "child",
    );
    assert.equal(
      child.permissionMode,
      "restricted",
      "prompt text is never parsed as permission authority",
    );
    const next = core.delegate(null, "codex", "fixture", "next");
    assert.equal(
      next.permissionMode,
      "restricted",
      "YOLO never becomes a session default",
    );
    root.permissionMode = "restricted";
    assert.equal(core.status(null, root.id).permissionMode, "yolo");
    assert.throws(
      () =>
        core.delegate(
          null,
          "codex",
          "fixture",
          "invalid",
          undefined,
          undefined,
          "bogus" as PermissionMode,
        ),
      /Invalid permission/,
    );
    await core.cancel(null, root.id);
    assert.equal(core.status(null, child.id).state, "cancelled");
  } finally {
    await core.close();
  }
});
test("YOLO native sessions cannot silently retain elevated permissions on resume", async () => {
  const core = new Orchestrator({
    cwd: process.cwd(),
    adapters: {
      antigravity: {
        capabilities: { ...capabilities, resume: true },
        run: async () => "fixture",
      },
    },
  });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const root = core.delegate(
      null,
      "antigravity",
      "fixture",
      "root",
      undefined,
      undefined,
      "yolo",
    );
    await core.wait(null, root.id);
    assert.throws(
      () => core.resume(null, root.id, "continue", "resume"),
      /resume of YOLO sessions is unsupported/,
    );
    assert.equal(validatePermissionMode(undefined), "restricted");
    assert.throws(() => validatePermissionMode(null), /Invalid/);
  } finally {
    await core.close();
  }
});
