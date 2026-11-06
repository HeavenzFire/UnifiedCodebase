'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('./task-ledger.cjs');
const { createGovernedRuntime } = require('./governed-runtime.cjs');

async function makeLedger(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-governed-runtime-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new TaskLedger(path.join(root, 'tasks.json')).open();
}

test('executes a task and persists its result and evidence receipt', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({ id: 'runtime-ok', payload: { prompt: 'return token', role: 'verifier' } });
  let call;
  const runtime = createGovernedRuntime({
    ledger, workerId: 'runtime-worker',
    adapter: { async run(input) { call = input; return { response: 'HF_RUNTIME_OK' }; } }
  });
  const result = await runtime.runOnce();
  const saved = await ledger.get('runtime-ok');
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(call, { taskId: 'runtime-ok', role: 'verifier', prompt: 'return token' });
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.result.response, 'HF_RUNTIME_OK');
  assert.equal(saved.evidence[0].ref, 'governed-runtime:runtime-ok');
});

test('fails closed when a task declares capabilities but no gate is configured', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({
    id: 'runtime-denied', payload: { prompt: 'must not run' },
    requiredCapabilities: ['repo.merge'], maxAttempts: 3
  });
  let calls = 0;
  const runtime = createGovernedRuntime({
    ledger, workerId: 'runtime-worker',
    adapter: { async run() { calls++; return { ok: true }; } }
  });
  const result = await runtime.runOnce();
  const saved = await ledger.get('runtime-denied');
  assert.equal(result.status, 'blocked');
  assert.equal(saved.status, 'failed');
  assert.equal(saved.attempts, 1);
  assert.equal(calls, 0);
});

test('checks every declared capability before invoking the adapter', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({
    id: 'runtime-policy', payload: { prompt: 'must not run' },
    requiredCapabilities: ['artifact.write', 'repo.merge'],
    metadata: { agentId: 'agent-1', grantId: 'grant-1', approvalRequestId: 'approval-1' }
  });
  const seen = [];
  let calls = 0;
  const runtime = createGovernedRuntime({
    ledger, workerId: 'runtime-worker',
    capabilityGate: { async authorize(request) {
      seen.push(request);
      return { allow: request.capability === 'artifact.write', reason: 'test-policy' };
    } },
    adapter: { async run() { calls++; return { ok: true }; } }
  });
  const result = await runtime.runOnce();
  assert.equal(result.status, 'blocked');
  assert.deepEqual(seen.map(x => x.capability), ['artifact.write', 'repo.merge']);
  assert.equal(seen[0].agentId, 'agent-1');
  assert.equal(seen[0].grantId, 'grant-1');
  assert.equal(calls, 0);
});

test('retries transient adapter failures but does not retry policy denials', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({ id: 'runtime-retry', payload: { prompt: 'retry' }, maxAttempts: 2 });
  const runtime = createGovernedRuntime({
    ledger, workerId: 'runtime-worker', retryDelayMs: 0,
    adapter: { async run() { throw Error('temporary provider failure'); } }
  });
  const result = await runtime.runOnce();
  const saved = await ledger.get('runtime-retry');
  assert.equal(result.status, 'retry-scheduled');
  assert.equal(saved.status, 'queued');
  assert.equal(saved.attempts, 1);
});

test('supervisor starts one polling loop and stops cleanly', async t => {
  const ledger = await makeLedger(t);
  let calls = 0;
  const runtime = createGovernedRuntime({
    ledger, workerId: 'runtime-worker', pollMs: 250,
    adapter: { async run() { calls++; return { ok: true }; } }
  });
  runtime.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  const status = await runtime.stop();
  assert.equal(status.running, false);
  assert.equal(status.inFlight, false);
  assert.equal(calls, 0);
});

test('releases a claimed task immediately when ledger.start fails, then recovers it', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({ id: 'runtime-start-recovery', payload: { prompt: 'recover me' }, maxAttempts: 2 });
  const start = ledger.start.bind(ledger);
  let rejectOnce = true;
  ledger.start = async (...args) => {
    if (rejectOnce) { rejectOnce = false; throw Error('simulated start persistence failure'); }
    return start(...args);
  };
  let calls = 0;
  const runtime = createGovernedRuntime({
    ledger, workerId: 'runtime-worker', retryDelayMs: 0, clock: () => 9999,
    adapter: { async run() { calls++; return { recovered: true }; } }
  });
  const first = await runtime.runOnce({ now: 1000 });
  const afterFailure = await ledger.get('runtime-start-recovery');
  assert.equal(first.status, 'retry-scheduled');
  assert.equal(afterFailure.status, 'queued');
  assert.equal(afterFailure.owner, null);
  assert.equal(afterFailure.leaseUntil, null);
  assert.equal(afterFailure.events.at(-1).type, 'task.claim_released');
  assert.equal(calls, 0);
  const second = await runtime.runOnce({ now: 1001 });
  const afterRecovery = await ledger.get('runtime-start-recovery');
  assert.equal(second.status, 'succeeded');
  assert.equal(afterRecovery.status, 'succeeded');
  assert.equal(afterRecovery.attempts, 2);
  assert.equal(calls, 1);
});


test('worker claims only its configured capability class', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({ id: 'foreign-first', payload: { prompt: 'not for this worker' }, requiredCapabilities: ['fabric.v1'] });
  await ledger.create({ id: 'shared-second', payload: { prompt: 'shared task' }, requiredCapabilities: ['shared-task.v1'] });
  let executed = '';
  const runtime = createGovernedRuntime({
    ledger, workerId: 'shared-worker', requiredCapabilities: ['shared-task.v1'],
    adapter: { async run(input) { executed = input.taskId; return { ok: true }; } }
  });
  const result = await runtime.runOnce();
  assert.equal(result.taskId, 'shared-second');
  assert.equal(executed, 'shared-second');
  assert.equal((await ledger.get('foreign-first')).status, 'queued');
});

test('capability-filtered recovery does not mutate expired tasks owned by another class', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({ id: 'expired-shared', payload: { prompt: 'shared' }, requiredCapabilities: ['shared-task.v1'], maxAttempts: 1 });
  await ledger.create({ id: 'expired-fabric', payload: { prompt: 'fabric' }, requiredCapabilities: ['fabric.v1'], maxAttempts: 1 });
  await ledger.claimNext('shared-worker', { now: 1000, leaseMs: 1000 });
  await ledger.claimNext('fabric-worker', { now: 1000, leaseMs: 1000 });
  await ledger.claimNext('shared-worker', { now: 2000, leaseMs: 1000, requiredCapabilities: ['shared-task.v1'] });
  assert.equal((await ledger.get('expired-shared')).status, 'failed');
  assert.equal((await ledger.get('expired-fabric')).status, 'claimed');
});

test('stop during asynchronous authorization aborts and never invokes the adapter', async t => {
  const ledger = await makeLedger(t);
  await ledger.create({
    id: 'stop-auth-race', payload: { prompt: 'must not execute' },
    requiredCapabilities: ['shared-task.v1'],
    metadata: { agentId: 'agent-1', grantId: 'grant-1' }
  });
  let enterAuthorization;
  const entered = new Promise(resolve => { enterAuthorization = resolve; });
  let releaseAuthorization;
  let observedSignal;
  let calls = 0;
  const runtime = createGovernedRuntime({
    ledger, workerId: 'shared-worker', pollMs: 250,
    requiredCapabilities: ['shared-task.v1'],
    capabilityGate: { authorize(request) {
      observedSignal = request.signal;
      enterAuthorization();
      return new Promise(resolve => { releaseAuthorization = resolve; });
    } },
    adapter: { async run() { calls++; return { ok: true }; } }
  });
  runtime.start();
  await entered;
  const stopping = runtime.stop();
  releaseAuthorization({ allow: true });
  await stopping;
  assert.equal(observedSignal.aborted, true);
  assert.equal(calls, 0);
  assert.equal((await ledger.get('stop-auth-race')).status, 'queued');
});

