#!/usr/bin/env node
const { createInterface } = require('node:readline');
const assert = require('node:assert/strict');
const scenario = process.env.ORCH_ACP_FIXTURE_CASE || 'success';
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let token, promptId;
// After a denied operation a real agent answers without it and ends the turn.
const finishAfterDenial = () => {
  send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } });
  send({ id: promptId, result: { stopReason: 'end_turn' } });
};
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line), { id, method, params } = message;
  try {
    if (method === 'initialize') {
      assert.equal(params.protocolVersion, 1); assert.equal(params.clientCapabilities.terminal, false);
      assert.equal(params.clientCapabilities.fs.writeTextFile, false);
      return send({ id, result: { protocolVersion: scenario === 'version' ? 2 : 1, agentInfo: { name: scenario === 'identity' ? 'another-agent' : 'antigravity-acp', version: '1.4.5' }, agentCapabilities: { mcpCapabilities: { http: scenario !== 'no-http' } } } });
    }
    if (method === 'authenticate') { assert.equal(params.methodId, 'oauth-personal'); return send({ id, result: {} }); }
    if (method === 'session/new') {
      assert.equal(params.mcpServers.length, 1); assert.deepEqual(params._meta.antigravity.disabledTools, ['run_workflow']);
      const server = params.mcpServers[0]; assert.equal(server.type, 'http'); assert.equal(server.name, 'pi_orchestrator');
      assert.equal(server.url, 'http://127.0.0.1:12345/mcp');
      token = server.headers[0].value; assert.equal(token, 'Bearer fixture-private-token');
      assert.ok(!process.argv.join(' ').includes(token));
      if (scenario === 'auth') return send({ id, error: { code: -32000, message: 'private provider error must not escape' } });
      // Measured in Antigravity 1.4.5: notifications can precede the session/new response.
      if (scenario === 'early-update' || scenario === 'early-foreign') send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: scenario === 'early-foreign' ? 'foreign' : 'fixture-session', update: { sessionUpdate: 'usage_update', used: 0, size: 1048576 } } });
      return send({ id, result: { sessionId: scenario === 'no-session' ? '' : 'fixture-session', modes: { availableModes: scenario === 'no-plan' ? [] : [{ id: 'default' }] } } });
    }
    if (method === 'session/set_mode') {
      assert.equal(params.sessionId, 'fixture-session'); assert.equal(params.modeId, 'default');
      return send({ id, result: {} });
    }
    if (method === 'session/prompt') {
      promptId = id;
      assert.equal(params.sessionId, 'fixture-session'); assert.equal(params.prompt[0].text, 'fixture prompt', 'Antigravity receives the task verbatim (no answer-format suffix)');
      if (scenario.startsWith('yolo-')) {
        const permission = { id: 'yolo-approval', method: 'session/request_permission', params: {
          sessionId: scenario === 'yolo-foreign' ? 'foreign' : 'fixture-session',
          toolCall: { toolCallId: scenario === 'yolo-question' ? 'interaction_1' : 'native-command', title: 'Fixture execution' },
          options: [{ optionId: 'once', kind: scenario === 'yolo-persistent' ? 'allow_always' : 'allow_once' }] } };
        if (scenario === 'yolo-invalid-options') permission.params.options.push({ optionId: 'once', kind: 'allow_once' });
        if (scenario === 'yolo-late') {
          const rows = [
            { method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } },
            { id: promptId, result: { stopReason: 'end_turn' } }, permission,
          ];
          process.stdout.write(rows.map((row) => JSON.stringify({ jsonrpc: '2.0', ...row })).join('\n') + '\n');
          return;
        }
        if (scenario === 'yolo-invalid-id') permission.id = { invalid: true };
        send(permission);
        if (scenario === 'yolo-duplicate') send(permission);
        return;
      }
      if (scenario.startsWith('bridge-')) {
        const tool = scenario === 'bridge-unknown-tool' ? 'write' : 'delegate';
        return send({ id: 'bridge-approval', method: 'session/request_permission', params: {
          sessionId: scenario === 'bridge-foreign-session' ? 'foreign' : 'fixture-session',
          toolCall: { toolCallId: scenario === 'bridge-question' ? 'interaction_2' : 'tool-bridge', title: scenario === 'bridge-title-spoof' ? 'another_tool' : `pi_orchestrator_${tool}`,
            _meta: { is_mcp_tool_call: scenario !== 'bridge-no-mcp', mcp: { server: scenario === 'bridge-foreign-server' ? 'external' : 'pi_orchestrator', tool } } },
          options: [{ optionId: 'once', kind: scenario === 'bridge-only-always' ? 'allow_always' : 'allow_once' }] } });
      }
      if (scenario === 'many-denials') { for (let n = 1; n <= 9; n++) send({ id: `deny-${n}`, method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: `tool-${n}` }, options: [{ optionId: 'allow', kind: 'allow_once' }] } }); return; }
      if (scenario === 'hang') return;
      if (scenario === 'early-exit') return process.exit(0);
      if (scenario.startsWith('human-')) return send({ id: 'human-1', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: scenario === 'human-question' ? 'interaction_1' : 'operation-1', title: 'Fixture human request', rawInput: { operation: 'fixture only' } }, options: [{ optionId: 'once', name: 'Answer or approve once', kind: 'allow_once' }, { optionId: 'always', name: 'Always approve', kind: 'allow_always' }] } });
      if (scenario === 'permission' || scenario === 'question') return send({ id: 'permission-1', method: 'session/request_permission', params: { sessionId: 'fixture-session', toolCall: { toolCallId: scenario === 'question' ? 'interaction_1' : 'tool-1' }, options: [{ optionId: 'allow', kind: 'allow_once' }] } });
      if (scenario === 'client-write') return send({ id: 'write-1', method: 'fs/write_text_file', params: { path: '/never-write', content: 'no' } });
      send({ method: 'session/update', params: { sessionId: scenario === 'wrong-session' ? 'foreign-session' : 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: scenario === 'oversize' ? 'x'.repeat(20001) : 'fixture answer' } } } });
      if (scenario === 'malformed') return process.stdout.write('{not JSON}\n');
      send({ id, result: { stopReason: scenario === 'bad-stop' ? 'max_tokens' : 'end_turn' } });
      if (scenario === 'duplicate') send({ id, result: { stopReason: 'end_turn' } });
      if (scenario === 'trailing') process.stdout.write('invalid tail\n');
      return;
    }
    if (id === 'yolo-approval') {
      if (['yolo-success', 'yolo-duplicate'].includes(scenario)) {
        assert.equal(message.result.outcome.outcome, 'selected'); assert.equal(message.result.outcome.optionId, 'once');
        send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      } else { assert.equal(message.result.outcome.outcome, 'cancelled'); finishAfterDenial(); }
    }
    if (id === 'bridge-approval') {
      assert.equal(message.result.outcome.outcome, scenario === 'bridge-success' ? 'selected' : 'cancelled');
      if (scenario === 'bridge-success') {
        assert.equal(message.result.outcome.optionId, 'once');
        send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      } else finishAfterDenial();
    }
    if (id === 'human-1') {
      assert.equal(message.result.outcome.outcome, scenario === 'human-deny' ? 'cancelled' : 'selected');
      if (scenario !== 'human-deny') {
        assert.equal(message.result.outcome.optionId, 'once');
        send({ method: 'session/update', params: { sessionId: 'fixture-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'fixture answer' } } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      } else finishAfterDenial();
    }
    if (id === 'permission-1') { assert.equal(message.result.outcome.outcome, 'cancelled'); finishAfterDenial(); }
    if (id === 'write-1') assert.equal(message.error.code, -32601);
  } catch { process.stderr.write('Fixture contract assertion failed\n'); process.exit(2); }
});
