import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeAdapter, claudeBudget } from "../src/adapters/claude.ts";
import { RuntimeProcess } from "../src/adapters/process.ts";
import { RuntimeCleanupError, type RuntimeProcessInfo, type TaskView } from "../src/types.ts";

for (const [mode, expected] of [
  ["success", null], ["yolo", null], ["throwing-observer", null], ["thinking", null],
  ["missing-bridge", /bridge is not connected/], ["disconnected-bridge", /bridge is not connected/],
  ["wrong-session", /initialized session/], ["missing-session", /session initialization/],
  ["no-init", /initialized session/], ["duplicate-init", /session initialization/],
  ["denied-tool", null], ["native-failure", /fixture unsuccessful/],
  ["invalid-text", /no text result/], ["invalid-content", /assistant content/],
  ["control-request", /interactive control requests/], ["duplicate-result", /duplicate results/],
  ["trailing-garbage", /JSONL/], ["early-abort", /early fixture abort/],
  ["cleanup-failure", /cleanup could not be confirmed/],
] as const) {
  test(`Claude restricted protocol, credential cleanup and observed exit: ${mode}`, { skip: process.platform === "win32" }, async (t) => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-claude-fixture-"));
    const executable = join(cwd, "fixture.cjs");
    const marker = join(cwd, "config-path.txt");
    await writeFile(executable, `#!/usr/bin/env node
const assert=require('node:assert/strict'), fs=require('node:fs'), path=require('node:path');
const mode=${JSON.stringify(mode)}, args=process.argv.slice(2);
const option=(name)=>args[args.indexOf(name)+1];
if(mode==='thinking') {assert.equal(option('--model'),'sonnet');assert.equal(option('--effort'),'high');} else assert.ok(!args.includes('--effort'));
assert.ok(args.includes('--strict-mcp-config'));
assert.ok(!args.includes('--restricted'),'--restricted would remove Bash; the sandbox bounds it instead');
const sandbox=JSON.parse(option('--settings')).sandbox;
assert.equal(sandbox.enabled,true);assert.deepEqual(sandbox.network,{allowedDomains:[],strictAllowlist:true});assert.equal(sandbox.failIfUnavailable,true);assert.equal(sandbox.allowUnsandboxedCommands,false);
const settings=JSON.parse(option('--settings')), home=require('node:os').homedir();
for(const secret of [path.join(home,'.ssh'),path.join(home,'.pi/agent/auth.json')]) {
  assert.ok(sandbox.filesystem.denyRead.includes(secret),'Bash cannot read credential stores');
  assert.ok(settings.permissions.deny.includes('Read(/'+secret+')')&&settings.permissions.deny.includes('Read(/'+secret+'/**)'),'Read/Grep/Glob cannot read credential stores');
}
if(mode==='yolo') assert.equal(sandbox.filesystem.denyWrite,undefined,'YOLO may write inside its task directory');
else assert.deepEqual(sandbox.filesystem.denyWrite.map((p)=>fs.realpathSync(p)),[process.cwd()],'restricted Bash cannot write the task directory');
assert.equal(args.includes('--dangerously-skip-permissions'),mode==='yolo');
assert.equal(option('--tools'),mode==='yolo'?'Read,Glob,Grep,Bash,Write,Edit':'Read,Glob,Grep,Bash');
assert.equal(option('--permission-mode'),mode==='yolo'?'bypassPermissions':'dontAsk');
if(mode==='yolo') assert.ok(!option('--append-system-prompt').includes('Do not modify files'));
assert.equal(option('--permission-prompts'),'none');
assert.equal(option('--setting-sources'),'');
assert.equal(option('--max-turns'),'40');
assert.equal(option('--max-budget-usd'),'1.00');
assert.equal(JSON.parse(option('--settings')).disableAllHooks,true);
assert.ok(!args.some(a=>a.includes('fixture-private-token')||a.includes('Bearer ')));
const configPath=option('--mcp-config'), config=JSON.parse(fs.readFileSync(configPath,'utf8'));
assert.equal(config.mcpServers.pi_orchestrator.headers.Authorization,'Bearer fixture-private-token');
assert.equal(config.mcpServers.pi_orchestrator.timeout,660000,'long MCP waits are not cut by the client');
assert.equal(fs.statSync(configPath).mode & 0o777,0o600);
assert.equal(fs.statSync(path.dirname(configPath)).mode & 0o777,0o700);
fs.writeFileSync(${JSON.stringify(marker)},configPath,{mode:0o600});
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const input=JSON.parse(line);
 assert.equal(input.type,'user');assert.equal(input.message.content,'fixture prompt');
 const init={type:'system',subtype:'init',session_id:'fixture-session',model:'claude-fixture-model',mcp_servers:[{name:'pi_orchestrator',status:'connected'}]};
 const result={type:'result',subtype:'success',is_error:false,session_id:'fixture-session',result:'fixture result'};
 if(mode==='missing-bridge') init.mcp_servers=[];
 if(mode==='disconnected-bridge') init.mcp_servers[0].status='failed';
 if(mode==='missing-session') init.session_id='';
 if(mode==='wrong-session') result.session_id='foreign-session';
 if(mode==='denied-tool') result.permission_denials=[{tool_name:'Write'}];
 if(mode==='native-failure') {result.subtype='error_max_turns';result.is_error=true;result.errors=['fixture unsuccessful'];}
 if(mode==='invalid-text') result.result=123;
 if(mode==='success') {result.usage={input_tokens:120,cache_read_input_tokens:3000,cache_creation_input_tokens:500,output_tokens:80};result.total_cost_usd=0.0421;}
 const rows=[];
 if(mode!=='no-init') rows.push(init);
 if(mode==='duplicate-init') rows.push(init);
 if(mode==='native-failure') rows.push({type:'assistant',session_id:'fixture-session',message:{content:[{type:'text',text:'half done'},{type:'tool_use',name:'Read'}]}});
 if(mode==='invalid-content') rows.push({type:'assistant',session_id:'fixture-session',message:{content:{}}});
 if(mode==='control-request') rows.push({type:'control_request',request_id:'question',request:{subtype:'can_use_tool'}});
 rows.push(result);
 if(mode==='duplicate-result') rows.push(result);
 process.stdout.write(rows.map(m=>JSON.stringify(m)).join('\\n')+'\\n'+(mode==='trailing-garbage'?'private-fixture-not-json\\n':''));
});
`, { mode: 0o700 });
    if (mode === "cleanup-failure") {
      const original = RuntimeProcess.prototype.stop;
      t.mock.method(RuntimeProcess.prototype, "stop", async function (this: RuntimeProcess) {
        await original.call(this);
        throw new RuntimeCleanupError(new Error("fixture cleanup failure"));
      });
    }
    const observations: RuntimeProcessInfo[] = [];
    const sessions: string[] = [];
    const usages: unknown[] = [];
    const partials: string[] = [];
    const models: unknown[] = [];
    const controller = new AbortController();
    const watchdog = setTimeout(() => controller.abort(new Error("Fixture protocol deadline")), 15_000);
    const task: TaskView = { id: "task", title: "fixture", attemptId: "attempt", parentId: null, engine: "claude", depth: 1, state: "running", cwd, createdAt: new Date().toISOString() };
    try {
      if (mode === "yolo") task.permissionMode = "yolo";
      if (mode === "thinking") task.selection = { model: "sonnet", thinking: "high" };
      const running = new ClaudeAdapter(executable).run({ task, prompt: "fixture prompt", signal: controller.signal,
        mcp: { url: "http://127.0.0.1:12345/mcp", token: "fixture-private-token" },
        session: (id) => { sessions.push(id); }, activity() {}, usage: (value) => { usages.push(value); }, partial: (text) => { partials.push(text); }, modelState: (state) => { models.push(state.model); }, process: (info) => {
          observations.push(info);
          if (mode === "early-abort" && !info.exitedAt) controller.abort(new Error("early fixture abort"));
          if (mode === "throwing-observer") throw new Error("fixture observer failure");
        },
      });
      if (expected) {
        await assert.rejects(running, expected);
        // A turn/budget limit keeps the text Claude already wrote for the core to publish.
        if (mode === "native-failure") assert.deepEqual(partials, ["half done"]);
      } else {
        const text = await running;
        if (mode === "denied-tool") assert.match(text, /^fixture result\n\n\[Aviso del orquestador: Claude intentó herramientas no autorizadas \(Write\)/);
        else assert.equal(text, "fixture result");
        assert.deepEqual(sessions, ["fixture-session"]);
        assert.deepEqual(models, ["claude-fixture-model"], "the model the CLI resolved is recorded");
        // Cache reads/creations count as input; cost is the CLI's own estimate.
        if (mode === "success") assert.deepEqual(usages, [{ inputTokens: 3620, cachedInputTokens: 3000, outputTokens: 80, costUsd: 0.0421 }]);
      }
      assert.ok(observations.at(-1)?.exitedAt, "Exit must be observed before the adapter settles");
      if (mode !== "early-abort") {
        const configPath = await readFile(marker, "utf8");
        await assert.rejects(stat(dirname(configPath)), { code: "ENOENT" });
      }
    } finally { clearTimeout(watchdog); await rm(cwd, { recursive: true, force: true }); }
  });
}

test("the Claude spend cap is configurable and fails closed", () => {
  assert.equal(claudeBudget({}), "1.00");
  assert.equal(claudeBudget({ PI_ORCHESTRATOR_CLAUDE_MAX_BUDGET_USD: "2.5" }), "2.50");
  for (const bad of ["0", "-1", "1e3", "abc", "101", "1.234"]) assert.throws(() => claudeBudget({ PI_ORCHESTRATOR_CLAUDE_MAX_BUDGET_USD: bad }), /Invalid/);
});
