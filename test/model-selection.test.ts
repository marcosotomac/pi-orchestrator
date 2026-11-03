import test from "node:test";
import assert from "node:assert/strict";
import { selectAcpModel, validateSelection } from "../src/model-selection.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { capabilities } from "../src/types.ts";

const config = () => [
  { id: "model", category: "model", type: "select", currentValue: "default-model", options: [{ value: "default-model", name: "Default" }, { value: "gemini-3.8-flash", name: "Gemini Flash" }] },
  { id: "thinking_level", category: "thought_level", type: "select", currentValue: "low", options: [{ value: "low", name: "Low" }, { value: "high", name: "High" }] },
];
test("ACP selects model then thinking via acknowledged config, without fallback or guessing legacy aliases", async () => {
  let options = config();
  const calls: string[] = [];
  const request = async (method: string, params: any) => {
    assert.equal(method, "session/set_config_option"); assert.equal(params.sessionId, "native-session");
    calls.push(params.configId); options = options.map((option) => option.id === params.configId ? { ...option, currentValue: params.value } : option);
    return { configOptions: options };
  };
  const state = await selectAcpModel({ configOptions: options }, { model: "gemini-3.8-flash", thinking: "high" }, request, "native-session");
  assert.deepEqual(calls, ["model", "thinking_level"]); assert.equal(state.model, "gemini-3.8-flash"); assert.equal(state.thinking, "high");
  await assert.rejects(selectAcpModel({ configOptions: options }, { model: "gemini-3.8-flash-high" }, request, "native-session"), /unavailable/);
  await assert.rejects(selectAcpModel({ configOptions: options }, { thinking: "extreme" }, request, "native-session"), /unavailable/);
});
test("ACP preserves runtime defaults, rejects false acknowledgements and requires updated thinking options", async () => {
  const forbidden = async () => { throw new Error("must not change defaults"); };
  assert.equal((await selectAcpModel({ configOptions: config() }, {}, forbidden, "session")).model, "default-model");
  await assert.rejects(selectAcpModel({ configOptions: config() }, { model: "gemini-3.8-flash" }, async () => ({}), "session"), /confirm/);
  await assert.rejects(selectAcpModel({ configOptions: config() }, { thinking: "high" }, async () => ({}), "session"), /confirm/);
  await assert.rejects(selectAcpModel({}, { model: "invented" }, forbidden, "session"), /unavailable/);
  assert.throws(() => validateSelection({ model: "--unsafe argument" }), /Invalid/);
});
test("per-task selection participates in idempotency, reaches runtime and cannot be mutated through snapshots", async () => {
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { antigravity: { capabilities, run: async (ctx) => {
    assert.deepEqual(ctx.task.selection, { model: "gemini-3.8-flash", thinking: "high" }); return "done";
  } } } });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const selection = { model: "gemini-3.8-flash", thinking: "high" };
    const task = core.delegate(null, "antigravity", "fixture", "same-key", undefined, selection);
    selection.model = "changed"; task.selection!.model = "also changed";
    assert.equal(core.status(null, task.id).selection?.model, "gemini-3.8-flash");
    assert.throws(() => core.delegate(null, "antigravity", "fixture", "same-key", undefined, { model: "different" }), /different arguments/);
    assert.equal((await core.wait(null, task.id)).state, "completed");
  } finally { await core.close(); }
});
