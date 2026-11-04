import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../src/adapters/codex.ts";
import type { RuntimeProcessInfo, TaskView } from "../src/types.ts";

for (const [mode, expected] of [
  ["yolo", null],
  ["completion-before-ack", null],
  ["item-fallback", null],
  ["thinking", null],
  ["unsupported-thinking", /reasoning effort is unavailable/],
  ["wrong-thread", /requested thread/],
  ["wrong-turn", /requested turn/],
  ["missing-thread", /no thread id/],
  ["missing-turn", /no turn id/],
  ["invalid-rpc", /RPC response/],
  ["premature-completion", /requested thread/],
  ["duplicate-completion", /duplicate turn completion/],
  ["trailing-garbage", /JSONL/],
  ["failed-turn", /fixture native failure/],
  ["invalid-text", /invalid result text/],
  [
    "mcp-leak",
    /MCP isolation could not be verified; inherited servers active: user-shell/,
  ],
  ["invalid-mcp-listing", /invalid MCP server listing/],
  ["invalid-config", /invalid configuration/],
] as const) {
  test(
    `Codex protocol correlation and cleanup: ${mode}`,
    { skip: process.platform === "win32" },
    async () => {
      const cwd = await mkdtemp(
        join(tmpdir(), "pi-orchestrator-codex-protocol-"),
      );
      const executable = join(cwd, "fixture.cjs");
      await writeFile(
        executable,
        `#!/usr/bin/env node
const mode=${JSON.stringify(mode)};
const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
const done={method:'turn/completed',params:{threadId:'fixture-thread',turn:{id:'fixture-turn',status:'completed',items:[{type:'agentMessage',text:'fixture result'}]}}};
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);
 if(q.method==='initialize') {
   if(mode==='invalid-rpc') send({id:q.id,result:{},error:{message:'ambiguous'}});
   else send({id:q.id,result:{}});
 }
 if(q.method==='model/list') send({id:q.id,result:{data:[{id:'chosen',model:'chosen',supportedReasoningEfforts:[{reasoningEffort:'high'}]}]}});
 if(q.method==='config/read') send({id:q.id,result:mode==='invalid-config'?{config:{mcp_servers:['user-shell']}}:{config:{mcp_servers:{'user-shell':{command:'sh'}}}}});
 if(q.method==='mcpServerStatus/list') {
   if(mode==='invalid-mcp-listing') send({id:q.id,result:{data:'nope'}});
   else send({id:q.id,result:{data:[{name:'user-shell',runtimeStatus:mode==='mcp-leak'?'connected':'disabled'}]}});
 }
 if(q.method==='thread/start') {
   require('node:assert/strict').equal(q.params.sandbox,mode==='yolo'?'workspace-write':'read-only');
   require('node:assert/strict').equal(q.params.approvalPolicy,'never');
   require('node:assert/strict').equal(q.params.ephemeral,false,'threads persist so they can be continued');
   require('node:assert/strict').equal(q.params.config['features.hooks'],false);
   if(mode==='yolo') require('node:assert/strict').ok(!q.params.developerInstructions.includes('Do not modify files'));
   require('node:assert/strict').equal(q.params.config.model_reasoning_effort,mode==='thinking'?'high':mode==='unsupported-thinking'?'invented':'medium');
   require('node:assert/strict').equal(q.params.config['mcp_servers.user-shell.enabled'],false);
   require('node:assert/strict').equal(q.params.config['mcp_servers.pi_orchestrator.tool_timeout_sec'],660);
   if(mode==='premature-completion') send(done);
   send({id:q.id,result:{model:'chosen',thread:mode==='missing-thread'?{}:{id:'fixture-thread'}}});
 }
 if(q.method==='turn/start') {
   if(mode==='thinking') require('node:assert/strict').equal(q.params.effort,'high');
   if(mode==='unsupported-thinking') throw new Error('unsupported effort must never start a turn');
   if(mode==='wrong-thread') done.params.threadId='foreign-thread';
   if(mode==='wrong-turn') done.params.turn.id='foreign-turn';
   if(mode==='failed-turn') {done.params.turn.status='failed';done.params.turn.error={message:'fixture native failure'};}
   if(mode==='invalid-text') done.params.turn.items[0].text=123;
   const ack={id:q.id,result:mode==='missing-turn'?{}:{turn:{id:'fixture-turn'}}};
   const rows=[];
   if(mode!=='completion-before-ack') rows.push(ack);
   if(mode==='item-fallback') {
     rows.push({method:'item/completed',params:{threadId:'fixture-thread',turnId:'fixture-turn',item:{type:'agentMessage',text:'fixture result'}}});
     done.params.turn.items=[];
   }
   rows.push(done);
   if(mode==='completion-before-ack') rows.push(ack);
   if(mode==='duplicate-completion') rows.push(done);
   process.stdout.write(rows.map(JSON.stringify).join('\\n')+'\\n'+(mode==='trailing-garbage'?'private-fixture-not-json\\n':''));
 }
});
`,
        { mode: 0o700 },
      );
      const observations: RuntimeProcessInfo[] = [];
      const partials: string[] = [];
      const controller = new AbortController();
      const watchdog = setTimeout(
        () => controller.abort(new Error("Fixture protocol deadline")),
        15_000,
      );
      const task: TaskView = {
        id: "task",
        title: "fixture",
        attemptId: "attempt",
        parentId: null,
        engine: "codex",
        depth: 1,
        state: "running",
        cwd,
        createdAt: new Date().toISOString(),
      };
      try {
        if (mode === "yolo") task.permissionMode = "yolo";
        if (mode === "thinking" || mode === "unsupported-thinking")
          task.selection = {
            model: "chosen",
            thinking: mode === "thinking" ? "high" : "invented",
          };
        const running = new CodexAdapter(executable).run({
          task,
          prompt: "fixture",
          signal: controller.signal,
          mcp: {
            url: "http://127.0.0.1:12345/mcp",
            token: "fixture-private-token",
          },
          session() {},
          activity() {},
          partial: (text) => {
            partials.push(text);
          },
          process: (info) => {
            observations.push(info);
          },
        });
        if (expected) await assert.rejects(running, expected);
        else assert.equal(await running, "fixture result");
        if (mode === "item-fallback")
          assert.deepEqual(
            partials,
            ["fixture result"],
            "completed agent messages are reported as partial text",
          );
        assert.ok(
          observations.at(-1)?.exitedAt,
          "Protocol failure or success must observe exit before settling",
        );
      } finally {
        clearTimeout(watchdog);
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );
}

test(
  "Codex handshake disables inherited hooks/notify at startup and thread scope; string-id native questions fail closed",
  { skip: process.platform === "win32" },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-codex-fixture-"));
    const executable = join(cwd, "codex-fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const assert = require('node:assert/strict');
const readline = require('node:readline');
const send = (message) => console.log(JSON.stringify(message));
const args = process.argv.slice(2);
assert.deepEqual(args, ['app-server','--listen','stdio://','--disable','hooks','-c','notify=[]']);
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({id:request.id,result:{}});
  if (request.method === 'thread/start') {
    assert.equal(request.params.approvalPolicy, 'never');
    assert.equal(request.params.sandbox, 'read-only');
    assert.equal(request.params.config['features.hooks'], false);
    assert.deepEqual(request.params.config.notify, []);
    const config = request.params.config;
    // Dotted keys only: a nested mcp_servers object makes Codex drop disables.
    assert.equal(config.mcp_servers, undefined);
    assert.equal(config['mcp_servers.pi_orchestrator.http_headers'].Authorization, 'Bearer fixture-private-token');
    assert.deepEqual(config['mcp_servers.pi_orchestrator.enabled_tools'], ['delegate','status','wait','cancel']);
    for (const tool of ['cancel','delegate','status','wait']) assert.equal(config['mcp_servers.pi_orchestrator.tools.' + tool + '.approval_mode'], 'approve');
    assert.notEqual(config['mcp_servers.pi_orchestrator.default_tools_approval_mode'], 'approve');
    // Inherited config-defined servers are disabled; plugin/app servers via features.
    assert.equal(config['mcp_servers.user-shell.enabled'], false);
    assert.equal(config['mcp_servers.pi_orchestrator.enabled'], undefined, 'the bridge itself is never disabled');
    assert.equal(config['features.plugins'], false);
    assert.equal(config['features.apps'], false);
    // The user's global effort is never inherited.
    assert.equal(config.model_reasoning_effort, 'medium');
    send({id:request.id,result:{thread:{id:'native-fixture-session'}}});
  }
  if (request.method === 'config/read') {
    assert.equal(require('node:fs').realpathSync(request.params.cwd), process.cwd());
    send({id:request.id,result:{config:{mcp_servers:{'user-shell':{command:'sh'},'pi_orchestrator':{url:'stale'}}}}});
  }
  if (request.method === 'mcpServerStatus/list') {
    assert.equal(request.params.threadId, 'native-fixture-session', 'only the small thread-scoped listing is requested');
    send({id:request.id,result:{data:[{name:'user-shell',runtimeStatus:'disabled'},{name:'pi_orchestrator',runtimeStatus:'starting'}]}});
  }
  if (request.method === 'turn/start') {
    send({id:request.id,result:{turn:{id:'fixture-turn'}}});
    send({id:'native-string-request',method:'item/tool/requestUserInput',params:{}});
  }
  if (request.id === 'native-string-request') {
    assert.equal(request.error.code,-32601);
    send({method:'thread/tokenUsage/updated',params:{threadId:'foreign-thread',turnId:'fixture-turn',tokenUsage:{total:{inputTokens:999999,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:999999}}}});
    send({method:'thread/tokenUsage/updated',params:{threadId:'native-fixture-session',turnId:'fixture-turn',tokenUsage:{total:{inputTokens:4200,cachedInputTokens:3000,outputTokens:150,reasoningOutputTokens:60,totalTokens:4350},last:{inputTokens:0,cachedInputTokens:0,outputTokens:0,reasoningOutputTokens:0,totalTokens:0}}}});
    send({method:'turn/completed',params:{threadId:'native-fixture-session',turn:{id:'fixture-turn',status:'completed',items:[{type:'agentMessage',text:'fixture passed'}]}}});
  }
});
`,
      { mode: 0o700 },
    );
    const task: TaskView = {
      id: "task",
      title: "fixture",
      attemptId: "attempt",
      parentId: null,
      engine: "codex",
      depth: 1,
      state: "running",
      cwd,
      createdAt: new Date().toISOString(),
    };
    const sessions: string[] = [],
      observations: RuntimeProcessInfo[] = [],
      usages: unknown[] = [];
    const controller = new AbortController();
    const watchdog = setTimeout(
      () => controller.abort(new Error("Fixture handshake did not settle")),
      5_000,
    );
    try {
      const result = await new CodexAdapter(executable).run({
        task,
        prompt: "fixture",
        signal: controller.signal,
        mcp: {
          url: "http://127.0.0.1:12345/mcp",
          token: "fixture-private-token",
        },
        session: (id) => {
          sessions.push(id);
        },
        process: (info) => {
          observations.push(info);
        },
        activity() {},
        usage: (value) => {
          usages.push(value);
        },
      });
      assert.equal(result, "fixture passed");
      assert.deepEqual(
        usages,
        [
          {
            inputTokens: 4200,
            cachedInputTokens: 3000,
            outputTokens: 150,
            reasoningTokens: 60,
          },
        ],
        "only this thread's cumulative usage is reported",
      );
      assert.deepEqual(sessions, ["native-fixture-session"]);
      assert.ok(observations.at(-1)?.exitedAt);
    } finally {
      clearTimeout(watchdog);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test(
  "Codex continues a persisted thread with thread/resume, the same isolation and a fresh bridge credential",
  { skip: process.platform === "win32" },
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pi-orchestrator-codex-resume-"));
    const executable = join(cwd, "fixture.cjs");
    await writeFile(
      executable,
      `#!/usr/bin/env node
const assert=require('node:assert/strict'); const send=(m)=>process.stdout.write(JSON.stringify(m)+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const q=JSON.parse(line);
 if(q.method==='initialize') send({id:q.id,result:{}});
 if(q.method==='config/read') send({id:q.id,result:{config:{mcp_servers:{'user-shell':{command:'sh'}}}}});
 if(q.method==='thread/start') throw new Error('a continuation must not start a new thread');
 if(q.method==='thread/resume') {
   assert.equal(q.params.threadId,'persisted-thread'); assert.equal(q.params.excludeTurns,true);
   assert.equal(q.params.sandbox,'read-only'); assert.equal(q.params.config['mcp_servers.user-shell.enabled'],false);
   assert.equal(q.params.config['mcp_servers.pi_orchestrator.http_headers'].Authorization,'Bearer fresh-token');
   send({id:q.id,result:{model:'m',thread:{id:'persisted-thread'}}});
 }
 if(q.method==='mcpServerStatus/list') send({id:q.id,result:{data:[{name:'user-shell',runtimeStatus:'disabled'}]}});
 if(q.method==='turn/start') { assert.equal(q.params.threadId,'persisted-thread'); send({id:q.id,result:{turn:{id:'t2'}}}); send({method:'turn/completed',params:{threadId:'persisted-thread',turn:{id:'t2',status:'completed',items:[{type:'agentMessage',text:'continued'}]}}}); }
});
`,
      { mode: 0o700 },
    );
    const task: TaskView = {
      id: "task",
      title: "follow-up",
      attemptId: "attempt-2",
      parentId: null,
      engine: "codex",
      depth: 1,
      state: "running",
      cwd,
      createdAt: new Date().toISOString(),
    };
    const sessions: string[] = [];
    const controller = new AbortController();
    const watchdog = setTimeout(
      () => controller.abort(new Error("Fixture resume deadline")),
      10_000,
    );
    try {
      const result = await new CodexAdapter(executable).run({
        task,
        prompt: "now explain",
        resumeSessionId: "persisted-thread",
        signal: controller.signal,
        mcp: { url: "http://127.0.0.1:12345/mcp", token: "fresh-token" },
        session: (id) => {
          sessions.push(id);
        },
        activity() {},
      });
      assert.equal(result, "continued");
      assert.deepEqual(sessions, ["persisted-thread"]);
    } finally {
      clearTimeout(watchdog);
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
