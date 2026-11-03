import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Orchestrator } from "../src/orchestrator.ts";
import { CodexAdapter } from "../src/adapters/codex.ts";
import { capabilities, type RuntimeContext, type RuntimeControls } from "../src/types.ts";

test("steer is capability- and subtree-scoped, serialized, and revoked on cancel without exposing live controls in snapshots", async () => {
  const contexts = new Map<string, RuntimeContext>();
  let acknowledge!: () => void;
  const run = async (ctx: RuntimeContext) => {
    contexts.set(ctx.task.id, ctx);
    ctx.registerControls!({ steer: async () => { await new Promise<void>((resolve) => { acknowledge = resolve; }); } });
    await delay(60_000, undefined, { signal: ctx.signal }); return "unreachable";
  };
  const core = new Orchestrator({ cwd: process.cwd(), adapters: { codex: { capabilities: { ...capabilities, steer: true }, run } } });
  core.attachEndpoint("http://127.0.0.1:12345/mcp");
  try {
    const root = core.delegate(null, "codex", "root", "root");
    const other = core.delegate(null, "codex", "other", "other");
    assert.equal(core.controls(null, root.id).steerReady, false);
    await tick(); assert.equal(core.controls(null, root.id).steerReady, true);
    await assert.rejects(core.steer(other.id, root.id, "forbidden"), /outside/);
    const pending = core.steer(null, root.id, "private instructions");
    const rejected = assert.rejects(pending, /revoked/);
    await assert.rejects(core.steer(null, root.id, "duplicate"), /already pending/);
    await core.cancel(null, root.id);
    acknowledge(); await rejected;
    assert.equal(core.controls(null, root.id).steerReady, false);
    contexts.get(root.id)!.registerControls!({ steer: async () => {} });
    assert.equal(core.controls(null, root.id).steerReady, false);
    await assert.rejects(core.steer(null, root.id, "late"), /unavailable/);
    assert.ok(!JSON.stringify(core.list()).includes("private instructions"));
  } finally { await core.close(); }
});

for (const wrongTurn of [false, true]) {
  test(`Codex turn/steer uses native thread and expected turn; wrong-turn=${wrongTurn}`, { skip: process.platform === "win32" }, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "orch-steer-"));
    const executable = join(cwd, "fixture.cjs");
    await writeFile(executable, `#!/usr/bin/env node
const assert=require('node:assert/strict');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);
if(q.method==='initialize')send({id:q.id,result:{}});
if(q.method==='thread/start')send({id:q.id,result:{thread:{id:'thread'}}});
if(q.method==='config/read')send({id:q.id,result:{config:{}}});
if(q.method==='mcpServerStatus/list')send({id:q.id,result:{data:[]}});
if(q.method==='turn/start')send({id:q.id,result:{turn:{id:'turn'}}});
if(q.method==='turn/steer'){assert.equal(q.params.threadId,'thread');assert.equal(q.params.expectedTurnId,'turn');assert.equal(q.params.input[0].text,'new instruction');send({id:q.id,result:{turnId:${JSON.stringify(wrongTurn ? "foreign" : "turn")}}});setTimeout(()=>send({method:'turn/completed',params:{threadId:'thread',turn:{id:'turn',status:'completed',items:[{type:'agentMessage',text:'fixture done'}]}}}),25);}
});
`);
    await chmod(executable, 0o700);
    let steering: Promise<void> | undefined;
    let steeringCheck: Promise<unknown> | undefined;
    try {
      const controller = new AbortController();
      // Wall-clock watchdog, not a latency assertion (see RELIABILITY.md: 15 s under contention).
      const timer = setTimeout(() => controller.abort(), 15_000);
      try {
        const adapter = new CodexAdapter(executable);
        const result = await adapter.run({ task: { id: "fixture", attemptId: "attempt", engine: "codex", parentId: null, depth: 1, cwd, state: "running", title: "fixture", createdAt: new Date().toISOString() }, prompt: "original", signal: controller.signal, mcp: { url: "http://127.0.0.1:12345/mcp", token: "fixture" }, session() {}, activity() {},
          registerControls(controls: RuntimeControls | undefined) {
            if (!controls?.steer) return;
            steering = controls.steer("new instruction");
            steeringCheck = wrongTurn ? assert.rejects(steering, /different turn/) : steering;
          },
        });
        assert.equal(result, "fixture done"); assert.ok(steering); await steeringCheck;
      } finally { clearTimeout(timer); }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}
