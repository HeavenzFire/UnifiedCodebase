'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  deriveCapacity, BudgetLedger, CandidateRepository, AdaptiveScheduler,
  DockerSandbox, CredentialBroker, CapabilityGate, createAdaptiveControlPlane
} = require('./adaptive-control-plane.cjs');
const { TaskLedger } = require('./task-ledger.cjs');
const { CapabilityStore } = require('./capability-store.cjs');

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-adaptive-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
function snapshot({ memory = 4096, cpu = 5, gpu = 0, providers = [] } = {}) {
  return {
    capturedAt: new Date().toISOString(),
    host: { cpuCount: cpu },
    memory: { availableMb: memory, reservedMb: 512 },
    gpu: { available: gpu > 0, devices: gpu > 0 ? [{ freeMb: gpu }] : [] },
    providers
  };
}

test('capacity is telemetry-derived and expands/contracts without an architectural agent ceiling', () => {
  const profiles = { light: { memoryMb: 512, cpuCores: 1 }, gpu: { memoryMb: 512, cpuCores: 1, gpuMb: 1024 } };
  const high = deriveCapacity(snapshot({ memory: 8704, cpu: 9, gpu: 4096 }), profiles);
  const low = deriveCapacity(snapshot({ memory: 900, cpu: 2, gpu: 0 }), profiles);
  assert.equal(high.light.slots, 8);
  assert.equal(high.gpu.slots, 4);
  assert.equal(low.light.slots, 0);
  assert.equal(low.gpu.slots, 0);
});

test('provider telemetry participates in capacity and exhausted provider routes stop receiving work', () => {
  const profiles = { remote: { memoryMb: 64, cpuCores: 0.1, provider: 'provider-a' } };
  const available = deriveCapacity(snapshot({ providers: [{ id: 'provider-a', available: true, remainingRequests: 7 }] }), profiles);
  const exhausted = deriveCapacity(snapshot({ providers: [{ id: 'provider-a', available: true, remainingRequests: 0 }] }), profiles);
  assert.equal(available.remote.slots, 7);
  assert.equal(exhausted.remote.slots, 0);
});

test('scheduler admits work according to the latest resource snapshot', async t => {
  let memory = 4096;
  const scheduler = new AdaptiveScheduler({
    profiles: { worker: { memoryMb: 512, cpuCores: 1 } },
    telemetry: async () => snapshot({ memory, cpu: 5 })
  });
  await scheduler.refresh();
  assert.equal(scheduler.stats().capacity.worker.slots, 4);
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) =>
    scheduler.run('worker', async () => i)));
  assert.deepEqual(results, [0, 1, 2, 3]);
  memory = 900;
  await scheduler.refresh();
  assert.equal(scheduler.stats().capacity.worker.slots, 0);
  await assert.rejects(scheduler.run('worker', async () => true), /no current execution capacity/);
});

test('budget allocations persist, account measured usage, and reject overspend', async t => {
  const file = path.join(await tempDir(t), 'budgets.json');
  const ledger = await new BudgetLedger(file).open();
  await ledger.allocate('research-1', { tokens: 100, currencyMicros: 500000, computeMs: 60000, networkBytes: 1000 });
  await ledger.consume('research-1', 'tokens', 40);
  await assert.rejects(ledger.consume('research-1', 'tokens', 61), /budget exhausted/);
  const restored = await new BudgetLedger(file).open();
  assert.equal((await restored.get('research-1')).remaining.tokens, 60);
  assert.equal((await restored.get('research-1')).consumed.tokens, 40);
});

test('candidate objects are content-addressed and mutation lineage is retained', async t => {
  const repo = await new CandidateRepository(path.join(await tempDir(t), 'candidates')).open();
  const parent = await repo.put({ type: 'code', generation: 0, hypothesis: 'baseline', content: 'A' });
  const child = await repo.put({ type: 'code', generation: 1, parentIds: [parent.id], hypothesis: 'mutation', content: 'B' });
  const same = await repo.put({ type: 'code', generation: 0, hypothesis: 'baseline', content: 'A' });
  assert.equal(same.id, parent.id);
  assert.equal((await repo.get(child.id)).content.content, 'B');
  assert.deepEqual((await repo.list()).map(x => x.id).sort(), [parent.id, child.id].sort());
});

test('candidate content hash is checked when read back', async t => {
  const root = path.join(await tempDir(t), 'candidates');
  const repo = await new CandidateRepository(root).open();
  const record = await repo.put({ type: 'prompt', content: 'original' });
  await fs.writeFile(path.join(root, 'objects', record.id + '.json'), '{"content":"tampered"}\n');
  await assert.rejects(repo.get(record.id), /hash mismatch/);
});

test('Docker sandbox requires a pinned image and an explicit workspace root', async t => {
  assert.throws(() => new DockerSandbox({ image: 'node:latest', workspaceRoot: process.cwd() }), /pinned/);
  assert.throws(() => new DockerSandbox({ image: 'node:22.14.0-bookworm-slim@sha256:' + 'a'.repeat(64) }), /workspaceRoot/);
  const sandbox = new DockerSandbox({
    image: 'node:22.14.0-bookworm-slim@sha256:' + 'a'.repeat(64),
    workspaceRoot: await tempDir(t)
  });
  assert.equal(sandbox.image.includes('@sha256:'), true);
});

test('credential broker keeps raw credentials server-side and enforces HTTPS path allowlists', async t => {
  const old = process.env.HF_TEST_PROVIDER_TOKEN;
  process.env.HF_TEST_PROVIDER_TOKEN = 'super-secret-test-token';
  t.after(() => {
    if (old === undefined) delete process.env.HF_TEST_PROVIDER_TOKEN;
    else process.env.HF_TEST_PROVIDER_TOKEN = old;
  });
  let observed;
  const broker = new CredentialBroker({
    providers: {
      test: { baseUrl: 'https://api.example.test', credentialEnv: 'HF_TEST_PROVIDER_TOKEN',
        headerName: 'authorization', prefix: 'Bearer ', allowedPaths: ['/v1/models'] }
    },
    fetchImpl: async (url, options) => {
      observed = { url: String(url), authorization: options.headers.authorization, redirect: options.redirect };
      return { ok: true, status: 200, text: async () => 'response included super-secret-test-token' };
    }
  });
  const result = await broker.request({ providerId: 'test', path: '/v1/models' });
  assert.equal(observed.authorization, 'Bearer super-secret-test-token');
  assert.equal(observed.redirect, 'error');
  assert.equal(result.body.includes('super-secret-test-token'), false);
  await assert.rejects(broker.request({ providerId: 'test', path: '/v1/admin' }), /not allowlisted/);
  await assert.rejects(broker.request({ providerId: 'test', path: '/../secrets' }), /invalid/);
  await assert.rejects(broker.request({ providerId: 'test', path: '/v1/%2e%2e/admin' }), /normalization|not allowlisted|invalid/);
  await assert.rejects(broker.request({ providerId: 'test', path: '/v1/models%2F..%2Fadmin' }), /invalid/);
  await assert.rejects(broker.request({ providerId: 'test', path: '/v1\\\\models' }), /invalid/);
  const queried = await broker.request({ providerId: 'test', path: '/v1/models?limit=1' });
  assert.equal(queried.ok, true);
});

test('capability gate requires independent trusted approval for high-impact actions', async () => {
  const store = { authorize: async () => ({ ok: true, grantId: 'g1' }) };
  const denied = new CapabilityGate({ capabilityStore: store, approvalVerifier: async () => ({ verified: false }) });
  const request = { grantId: 'g1', agentId: 'agent-1', taskId: 'task-1', capability: 'repo.merge', action: 'merge' };
  assert.equal((await denied.authorize(request)).allow, false);
  const allowed = new CapabilityGate({
    capabilityStore: store,
    approvalVerifier: async () => ({ verified: true, evidenceRef: 'approval:event:123' })
  });
  const result = await allowed.authorize(request);
  assert.equal(result.allow, true);
  assert.equal(result.approvalEvidenceRef, 'approval:event:123');
});

test('integrated control plane initializes against existing MicroFederation ledger', async t => {
  const root = await tempDir(t);
  const ledger = await new TaskLedger(path.join(root, 'tasks.json')).open();
  const plane = createAdaptiveControlPlane({ stateDir: path.join(root, 'adaptive'), ledger });
  await plane.initialize();
  const task = await plane.enqueue({ id: 'task-adaptive-1', payload: { prompt: 'inspect' } });
  assert.equal(task.status, 'queued');
  assert.equal((await plane.status()).initialized, true);
});

test('budgeted evolutionary loop retains candidates and stops when its allocated token budget is consumed', async t => {
  const root = await tempDir(t);
  const ledger = await new TaskLedger(path.join(root, 'tasks.json')).open();
  const plane = createAdaptiveControlPlane({ stateDir: path.join(root, 'adaptive'), ledger });
  await plane.initialize();
  await plane.budgets.allocate('evolution-1', { tokens: 10, currencyMicros: 0, computeMs: 0, networkBytes: 0 });
  const result = await plane.runEvolution({
    taskId: 'evolution-1',
    generator: async ({ generation, parents }) => ({
      candidate: { type: 'prompt', generation, parentIds: parents, content: 'candidate-' + generation },
      usage: { tokens: 5 }
    }),
    evaluator: async () => ({ fitness: { correctness: 1 }, verification: { status: 'test-passed' } })
  });
  assert.equal(result.generations, 2);
  assert.equal(result.remainingBudget.remaining.tokens, 0);
  assert.equal((await plane.candidates.list()).length, 2);
});

test('evolution refuses to run without an explicit budget', async t => {
  const root = await tempDir(t);
  const ledger = await new TaskLedger(path.join(root, 'tasks.json')).open();
  const plane = createAdaptiveControlPlane({ stateDir: path.join(root, 'adaptive'), ledger });
  await plane.initialize();
  await assert.rejects(plane.runEvolution({
    taskId: 'no-budget',
    generator: async () => ({ candidate: {}, usage: { tokens: 1 } }),
    evaluator: async () => ({})
  }), /no allocated budget/);
});

test('evolution rejects generators that do not report measured usage', async t => {
  const root = await tempDir(t);
  const ledger = await new TaskLedger(path.join(root, 'tasks.json')).open();
  const plane = createAdaptiveControlPlane({ stateDir: path.join(root, 'adaptive'), ledger });
  await plane.initialize();
  await plane.budgets.allocate('bad-metering', { tokens: 10 });
  await assert.rejects(plane.runEvolution({
    taskId: 'bad-metering',
    generator: async () => ({ candidate: { content: 'x' }, usage: {} }),
    evaluator: async () => ({})
  }), /non-zero measured usage/);
});

test('existing CapabilityStore is the authority and no caller boolean can forge approval', async t => {
  const root = await tempDir(t);
  const store = await new CapabilityStore(path.join(root, 'capabilities.json')).open();
  await store.grant({
    grantId: 'grant-adaptive', agentId: 'agent-adaptive', taskId: 'task-adaptive',
    capabilities: ['artifact.write', 'repo.merge'], expiresAt: Date.now() + 60000
  });
  const plane = createAdaptiveControlPlane({
    stateDir: path.join(root, 'adaptive'),
    ledger: await new TaskLedger(path.join(root, 'tasks.json')).open(),
    capabilityStore: store,
    approvalVerifier: async request => request.approvalRequestId === 'verified-approval'
      ? { verified: true, evidenceRef: 'trusted-approval:1' } : { verified: false }
  });
  await plane.initialize();
  const base = { grantId: 'grant-adaptive', agentId: 'agent-adaptive', taskId: 'task-adaptive',
    capability: 'repo.merge', action: 'merge' };
  assert.equal((await plane.authorizeAction({ ...base, humanApproval: true })).allow, false);
  assert.equal((await plane.authorizeAction({ ...base, approvalRequestId: 'verified-approval' })).allow, true);
});

test('telemetry monitor is explicitly started and can be stopped', async t => {
  const root = await tempDir(t);
  const plane = createAdaptiveControlPlane({
    stateDir: path.join(root, 'adaptive'),
    ledger: await new TaskLedger(path.join(root, 'tasks.json')).open(),
    profiles: { worker: { memoryMb: 64, cpuCores: 0.1 } }
  });
  await plane.initialize();
  const monitor = plane.startTelemetry({ intervalMs: 250 });
  await new Promise(resolve => setTimeout(resolve, 30));
  monitor.stop();
  assert.equal(monitor.stopped, true);
});
