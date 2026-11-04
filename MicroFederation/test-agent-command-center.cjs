'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AgentMessageStore, createCommandCenterServer, DEFAULT_ROLES } = require('./agent-command-center.cjs');

async function stateDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-agent-command-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
async function request(base, route, options) {
  const response = await fetch(base + route, options);
  return { status: response.status, body: await response.json() };
}

test('canonical 16-agent roster is complete, unique, and tool-free', () => {
  assert.equal(DEFAULT_ROLES.length, 16);
  assert.equal(new Set(DEFAULT_ROLES.map(role => role.id)).size, 16);
  for (const role of DEFAULT_ROLES) {
    assert.ok(role.name && role.role && role.voice && role.system, 'complete role contract: ' + role.id);
    assert.doesNotMatch(role.system, /execute shell|arbitrary filesystem|unrestricted browser/i);
  }
  assert.deepEqual(DEFAULT_ROLES.map(role => role.id), [
    'planner', 'architect', 'implementer', 'test-engineer', 'security-reviewer',
    'adversarial-reviewer', 'browser-integration', 'runtime-integrator',
    'reliability-engineer', 'data-integrity', 'privacy-reviewer', 'windows-operator',
    'network-reviewer', 'documentation', 'independent-verifier', 'synthesizer'
  ]);
});

test('message journal is append-only, hash-chained, and survives restart', async t => {
  const dir = await stateDir(t), file = path.join(dir, 'messages.jsonl');
  const store = await new AgentMessageStore(file).open();
  await store.appendMessage({ from: 'user', to: 'planner', conversationId: 'planner', kind: 'direct', content: 'Plan the work' });
  await store.appendMessage({ from: 'planner', to: 'user', conversationId: 'planner', kind: 'response', content: 'First step: define contracts' });
  const before = await fs.readFile(file, 'utf8');
  const reopened = await new AgentMessageStore(file).open();
  assert.equal((await reopened.thread('planner')).length, 2);
  assert.equal((await fs.readFile(file, 'utf8')), before);
  assert.equal((await reopened.all())[1].previousHash, (await reopened.all())[0].hash);
});

test('detects message journal tampering and fails closed', async t => {
  const dir = await stateDir(t), file = path.join(dir, 'messages.jsonl');
  const store = await new AgentMessageStore(file).open();
  await store.appendMessage({ from: 'user', to: 'architect', conversationId: 'architect', kind: 'direct', content: 'Review API' });
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  rows[0].content = 'tampered';
  await fs.writeFile(file, rows.map(JSON.stringify).join('\n') + '\n');
  await assert.rejects(new AgentMessageStore(file).open(), /hash chain invalid/);
});

test('local command center supports direct agent conversation and broadcast', async t => {
  const dir = await stateDir(t);
  const calls = [];
  const adapter = { async run(input) { calls.push(input); return { response: 'Verified response from ' + input.role, model: 'test-model', elapsedMs: 3 }; } };
  const app = createCommandCenterServer({ stateDirectory: dir, adapter });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + address.port;
  const agents = await request(base, '/api/agents');
  assert.equal(agents.status, 200);
  assert.equal(agents.body.agents.length, 16);
  assert.ok(agents.body.agents.some(a => a.id === 'independent-verifier'));
  const direct = await request(base, '/api/message', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'architect', content: 'Review the registry boundary' }) });
  assert.equal(direct.status, 200);
  assert.match(direct.body.response, /Architect/);
  const thread = await request(base, '/api/thread/architect');
  assert.equal(thread.body.messages.length, 2);
  const broadcast = await request(base, '/api/message', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'broadcast', content: 'Identify the top integration risk' }) });
  assert.equal(broadcast.status, 200);
  assert.equal(broadcast.body.responses.length, 16);
  assert.equal(calls.length, 17);
  const shared = await request(base, '/api/thread/broadcast');
  assert.equal(shared.body.messages.filter(m => m.kind === 'response').length, 16);
});

test('refuses non-loopback binding and oversized or unknown agent messages', async t => {
  const app = createCommandCenterServer({ stateDirectory: await stateDir(t), adapter: { run: async () => ({ response: 'ok' }) } });
  await assert.rejects(app.listen({ host: '0.0.0.0', port: 0 }), /loopback only/);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + address.port;
  assert.equal((await request(base, '/api/message', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'not-an-agent', content: 'hello' }) })).status, 404);
  assert.equal((await request(base, '/api/message', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'planner', content: 'x'.repeat(12001) }) })).status, 400);
});


test('command center exposes project and node registry CRUD through the same local service', async t => {
  const dir = await stateDir(t);
  const app = createCommandCenterServer({ stateDirectory: dir, adapter: { run: async () => ({ response: 'ok' }) } });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + address.port;
  const project = {
    id: 'unified-field', name: 'Unified Field',
    workspacePath: path.join(dir, 'workspace'),
    remoteUrl: 'https://github.com/HeavenzFire/UnifiedCodebase',
    branch: 'main', status: 'registered'
  };
  const registeredProject = await request(base, '/api/registry/projects', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(project)
  });
  assert.equal(registeredProject.status, 201);
  assert.equal(registeredProject.body.project.id, 'unified-field');

  const registeredNode = await request(base, '/api/registry/nodes', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'termux-a67l', label: 'Android Termux', platform: 'android', transport: 'tailscale',
      status: 'offline', capabilities: ['model.inference', 'task.execute'], metrics: {}
    })
  });
  assert.equal(registeredNode.status, 201);
  const heartbeat = await request(base, '/api/registry/nodes/termux-a67l/heartbeat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'online', capabilities: ['model.inference'], metrics: { cpuLoadPercent: 25 } })
  });
  assert.equal(heartbeat.status, 200);
  assert.equal(heartbeat.body.node.status, 'online');

  const manifest = await request(base, '/api/registry');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.body.revision, 3);
  assert.equal(manifest.body.projects.length, 1);
  assert.equal(manifest.body.nodes[0].lastSeenAt !== null, true);
});
