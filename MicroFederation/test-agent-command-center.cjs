'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { AgentMessageStore, createCommandCenterServer, DEFAULT_ROLES } = require('./agent-command-center.cjs');
const { CapabilityFabric } = require('./capability-fabric.cjs');

async function stateDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-agent-command-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function rawRequest(port, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: route, method: 'GET', headers }, response => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode }));
    });
    req.on('error', reject);
    req.end();
  });
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


test('rejects DNS-rebinding hosts, foreign origins, and credential-bearing prompts', async t => {
  const app = createCommandCenterServer({ stateDirectory: await stateDir(t), adapter: { run: async () => ({ response: 'ok' }) } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + address.port;
  const hostAttack = await rawRequest(address.port, '/api/agents', { Host: 'evil.example' });
  assert.equal(hostAttack.status, 403);
  const originAttack = await fetch(base + '/api/agents', { headers: { origin: 'http://evil.example' } });
  assert.equal(originAttack.status, 403);
  const secretPrompt = await request(base, '/api/message', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'planner', content: 'credential ghp_' + 'A'.repeat(40) })
  });
  assert.equal(secretPrompt.status, 400);
  const bearerPrompt = await request(base, '/api/message', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: 'planner', content: 'Authorization: Bearer ' + 'A'.repeat(32) }) });
  assert.equal(bearerPrompt.status, 400);
});

test('message journal enforces its configured event bound', async t => {
  const dir = await stateDir(t);
  const store = await new AgentMessageStore(path.join(dir, 'bounded.jsonl'), { maxEvents: 1 }).open();
  await store.appendMessage({ from: 'user', to: 'planner', conversationId: 'planner', kind: 'direct', content: 'one' });
  await assert.rejects(store.appendMessage({ from: 'user', to: 'planner', conversationId: 'planner', kind: 'direct', content: 'two' }), /event bound/);
});


test('serves the local UI with restrictive security headers', async t => {
  const app = createCommandCenterServer({ stateDirectory: await stateDir(t), adapter: { run: async () => ({ response: 'ok' }) } });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(() => app.close());
  const response = await fetch('http://127.0.0.1:' + address.port + '/');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('POSIX message journal uses owner-only directory and file permissions', async t => {
  if (process.platform === 'win32') return t.skip('Windows ACLs are deployment-controlled.');
  const dir = await stateDir(t);
  const file = path.join(dir, 'private.jsonl');
  const store = await new AgentMessageStore(file).open();
  await store.appendMessage({ from: 'user', to: 'planner', conversationId: 'planner', kind: 'direct', content: 'private' });
  assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test('refuses a symlink as the persistent message journal', async t => {
  if (process.platform === 'win32') return t.skip('Symlink creation requires elevated or developer-mode Windows permissions.');
  const dir = await stateDir(t);
  const target = path.join(dir, 'target.jsonl');
  const link = path.join(dir, 'messages.jsonl');
  await fs.writeFile(target, '');
  await fs.symlink(target, link);
  await assert.rejects(new AgentMessageStore(link).open(), /regular non-symlink/);
});

test('remediation endpoint is opt-in and delegates numeric issue IDs to the injected pipeline', async t => {
  const dir = await stateDir(t);
  const seen = [];
  const app = createCommandCenterServer({ stateDirectory: dir, adapter: { run: async () => ({ response: 'ok' }) },
    remediationPipeline: { async process(id) { seen.push(id); return { issueId: id, status: 'blocked', reason: 'fixture' }; } } });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + address.port;
  const result = await request(base, '/api/remediation/issues/123456', { method: 'POST' });
  assert.equal(result.status, 202);
  assert.equal(result.body.issueId, '123456');
  assert.deepEqual(seen, ['123456']);
  const invalid = await fetch(base + '/api/remediation/issues/not-a-number', { method: 'POST' });
  assert.equal(invalid.status, 404);
});
test('remediation endpoint fails closed when no pipeline is configured', async t => {
  const app = createCommandCenterServer({ stateDirectory: await stateDir(t), adapter: { run: async () => ({ response: 'ok' }) } });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const result = await request('http://127.0.0.1:' + address.port, '/api/remediation/issues/123456', { method: 'POST' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'remediation_pipeline_not_configured');
});


test('Command Center exposes capability inventory and dependency plans without activating adapters', async t => {
  const dir = await stateDir(t);
  let activated = 0;
  const capabilityFabric = new CapabilityFabric({
    definitions: [
      { id: 'runtime.core', version: '1.0.0', description: 'Local runtime' },
      { id: 'browser.bridge', version: '1.0.0', description: 'Browser bridge', dependencies: ['runtime.core'] }
    ],
    adapters: {
      'runtime.core': async () => { activated++; },
      'browser.bridge': async () => { activated++; }
    }
  });
  const app = createCommandCenterServer({
    stateDirectory: dir,
    adapter: { run: async () => ({ response: 'ok' }) },
    capabilityFabric
  });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + address.port;
  const inventory = await request(base, '/api/capabilities');
  assert.equal(inventory.status, 200);
  assert.equal(inventory.body.capabilities.length, 2);
  const plan = await request(base, '/api/capabilities/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: ['browser.bridge'] })
  });
  assert.equal(plan.status, 200);
  assert.deepEqual(plan.body.order, ['runtime.core', 'browser.bridge']);
  assert.equal(activated, 0);
  const unknown = await request(base, '/api/capabilities/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: ['not.registered'] })
  });
  assert.equal(unknown.status, 400);
});

test('capability endpoints fail closed when no fabric is injected', async t => {
  const app = createCommandCenterServer({ stateDirectory: await stateDir(t), adapter: { run: async () => ({ response: 'ok' }) } });
  t.after(() => app.close().catch(() => {}));
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const base = 'http://127.0.0.1:' + address.port;
  assert.equal((await request(base, '/api/capabilities')).status, 503);
  const result = await request(base, '/api/capabilities/plan', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities: ['x'] })
  });
  assert.equal(result.status, 503);
});
