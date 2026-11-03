import test from "node:test";
import assert from "node:assert/strict";
import { diagnoseFailure, runtimeRequestError } from "../src/diagnostics.ts";
import { RuntimeCleanupError } from "../src/types.ts";

test("RPC error categories preserve safe advice without leaking provider bodies", () => {
  for (const [code, category] of [[401, "authentication"], [429, "quota"], [-32603, "unknown"]] as const) {
    const error = runtimeRequestError({ code, message: "PRIVATE_PROVIDER_BODY" });
    assert.equal(diagnoseFailure(error).category, category);
    assert.ok(!error.message.includes("PRIVATE_PROVIDER_BODY"));
  }
});

test("diagnostics distinguish actionable failures without publishing external text or retrying", () => {
  for (const [error, category] of [
    [new Error("OAuth authentication failed PRIVATE"), "authentication"],
    [Object.assign(new Error("PRIVATE"), { code: "ECONNRESET" }), "network"],
    [new Error("quota exhausted PRIVATE"), "quota"],
    [new Error("Malformed JSON PRIVATE"), "protocol"],
    [new RuntimeCleanupError(new Error("PRIVATE")), "cleanup"],
    [undefined, "unknown"], [new Error("PRIVATE"), "unknown"],
  ] as const) {
    const diagnostic = diagnoseFailure(error);
    assert.equal(diagnostic.category, category); assert.equal(diagnostic.automaticRetry, false);
    assert.ok(!JSON.stringify(diagnostic).includes("PRIVATE"));
  }
});
