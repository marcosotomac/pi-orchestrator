import test from "node:test";
import assert from "node:assert/strict";
import {
  permissionSchema,
  updateSchema,
  initializedSchema,
} from "../src/acp-schema.ts";
import { selectAcpModel } from "../src/model-selection.ts";

test("ACP rejects malformed permissions, updates and identities at the boundary", () => {
  for (const input of [
    null,
    [],
    {},
    { sessionId: 1 },
    { sessionId: "s", toolCall: {}, options: [{ optionId: "x", kind: 1 }] },
  ]) {
    assert.equal(permissionSchema.safeParse(input).success, false);
  }
  assert.equal(
    updateSchema.safeParse({
      sessionId: "s",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: 42 },
      },
    }).success,
    false,
  );
  assert.equal(
    initializedSchema.safeParse({
      protocolVersion: "1",
      agentInfo: { name: "antigravity-acp" },
    }).success,
    false,
  );
});
test("ACP option parsing bounds recursion and rejects malformed configuration", async () => {
  const request = async () => ({});
  await assert.rejects(
    selectAcpModel({ configOptions: "invalid" }, {}, request, "s"),
  );
  let nested: unknown = { value: "model" };
  for (let i = 0; i < 20; i++) nested = { options: [nested] };
  await assert.rejects(
    selectAcpModel(
      { configOptions: [{ type: "select", id: "model", options: [nested] }] },
      {},
      request,
      "s",
    ),
    /nesting limit/,
  );
});
