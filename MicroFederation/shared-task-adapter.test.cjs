'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('./task-ledger.cjs');
const { createSharedTaskAdapter } = require('./shared-task-adapter.cjs');
const { createGovernedRuntime } = require('./governed-runtime.cjs');
const { CapabilityStore } = require('./capability-store.cjs');
const { CapabilityGate } = require('./adaptive-control-plane.cjs');

function canonical(status = 'proposed') {
  return {
    schema: 'heavenzfire.shared-task.v1',
    taskId: 'rd-task-001',
    source: 'github',
    goal: 'Inspect a bounded research task and return evidence-backed findings.',
    status,
    approvalState: status === 'approved' ? 'approved' : 'pending',
    evidence: [],
    metadata: { role: 'research', agentId: 'agent-shared', grantId: 'grant-shared' }
  };
}
function contract() {
  return { validateTaskRecord(record) {
    assert.equal(record.schema, 'heavenzfire.shared-task.v1');
    assert.ok(record.taskId && record.source && record.goal);
    assert.ok(Array.isArray(record.evidence));
    return true;
  }};
}
function memoryLedger() {
  const tasks = new Map();
  return {
    tasks,
    async create(input) {
      if (tasks.has(input.id)) {
        const old = tasks.get(input.id);
        assert.deepEqual(old.input, input);
        return old;
      }
      const task = { id: input.id, input, metadata: input.metadata,
        payload: input.payload, status: 'queued' };
      tasks.set(input.id, task);
      return task;
    },
    async claimNext(workerId) {
      const task = [...tasks.values()].find(t => t.status === 'queued');
      if (!task) return null;
      task.status = 'claimed'; task.owner = workerId; task.leaseUntil = Date.now() + 60000;
      return task;
    },
    async start(id, workerId) {
      const task = tasks.get(id);
      assert.equal(task.owner, workerId);
      task.status = 'running';
      return task;
    },
    async releaseClaim(id, workerId, options) {
      const task = tasks.get(id);
      assert.equal(task.owner, workerId);
      task.status = 'failed';
      task.error = options.reason;
      return task;
    },
    async complete(id, workerId, result, options) {
      const task = tasks.get(id);
      assert.equal(task.status, 'running');
      assert.equal(task.owner, workerId);
      task.status = 'succeeded'; task.result = result; task.evidenceRef = options.evidenceRef;
      return task;
    },
    async fail(id, workerId, error, options) {
      const task = tasks.get(id);
      assert.equal(task.status, 'running');
      assert.equal(task.owner, workerId);
      task.status = 'failed'; task.error = error; task.retryable = options.retryable;
      return task;
    },
    async get(id) { return tasks.get(id) || null; }
  };
}

async function runGovernedOnce(ledger, adapter, workerId = 'adapter-test-worker') {
  const runtime = createGovernedRuntime({
    ledger, workerId,
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter
  });
  return runtime.runOnce();
}

const attestation = {
  verified: true, actor: 'trusted-approver',
  evidenceRef: 'approval-event:abc123',
  verifiedAt: '2026-11-01T00:00:00.000Z'
};

test('proposal is recorded as proposal-only and never enters executable ledger', async () => {
  const ledger = memoryLedger();
  let verifierCalls = 0;
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => { verifierCalls++; return attestation; },
    loadCanonicalTask: async () => canonical('proposed'),
    execute: async () => { throw new Error('must not execute'); }
  });
  const result = await adapter.propose(canonical('proposed'));
  assert.equal(result.status, 'proposal_only');
  assert.equal(result.queued, false);
  assert.equal(ledger.tasks.size, 0);
  assert.equal(verifierCalls, 0);
});

test('provider or caller claim cannot substitute for trusted approval attestation', async () => {
  const ledger = memoryLedger();
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => ({ verified: false, actor: 'forged', evidenceRef: 'fake' }),
    loadCanonicalTask: async () => canonical('approved'),
    execute: async () => ({ ok: true })
  });
  await assert.rejects(adapter.enqueueApproved(canonical('approved')), /trusted approval verification failed/);
  assert.equal(ledger.tasks.size, 0);
});

test('approved canonical record is enqueued and re-verified immediately before execution', async () => {
  const ledger = memoryLedger();
  let verifyCalls = 0;
  let executions = 0;
  const record = canonical('approved');
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => { verifyCalls++; return attestation; },
    loadCanonicalTask: async id => {
      assert.equal(id, record.taskId);
      return record;
    },
    execute: async input => {
      executions++;
      assert.equal(input.canonicalTaskId, record.taskId);
      assert.equal(input.prompt, record.goal);
      return { finding: 'evidence-backed', limitations: ['bounded test'] };
    }
  });
  const queued = await adapter.enqueueApproved(record);
  assert.equal(queued.status, 'queued');
  assert.equal(verifyCalls, 1);
  const result = await runGovernedOnce(ledger, adapter, 'rd-worker-1');
  assert.equal(result.status, 'succeeded');
  assert.equal(executions, 1);
  assert.equal(verifyCalls, 2);
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).status, 'succeeded');
});

test('durable TaskLedger integration persists and executes an approved task', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hf-shared-task-adapter-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledger = new TaskLedger(path.join(directory, 'tasks.json'));
  await ledger.open();
  const record = canonical('approved');
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => record,
    execute: async input => ({
      canonicalTaskId: input.canonicalTaskId,
      prompt: input.prompt,
      result: 'durable-ledger-integration-ok'
    })
  });

  const queued = await adapter.enqueueApproved(record);
  const result = await runGovernedOnce(ledger, adapter, 'rd-worker-durable');
  const persisted = await ledger.get(queued.ledgerTaskId);

  assert.equal(result.status, 'succeeded');
  assert.equal(persisted.status, 'succeeded');
  assert.equal(persisted.metadata.canonicalRecordSha256.length, 64);
  assert.equal(persisted.result.result, 'durable-ledger-integration-ok');
  assert.equal(persisted.evidence.length, 1);
});


test('maximum-length canonical task IDs map to a ledger-safe deterministic ID', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hf-shared-task-long-id-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledger = new TaskLedger(path.join(directory, 'tasks.json'));
  await ledger.open();
  const record = canonical('approved');
  record.taskId = 'x'.repeat(128);
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => attestation,
    loadCanonicalTask: async id => {
      assert.equal(id, record.taskId);
      return record;
    },
    execute: async input => ({ canonicalTaskId: input.canonicalTaskId, ok: true })
  });

  const first = await adapter.enqueueApproved(record);
  const second = await adapter.enqueueApproved(record);
  assert.equal(first.ledgerTaskId, second.ledgerTaskId);
  assert.ok(first.ledgerTaskId.length <= 128);
  assert.match(first.ledgerTaskId, /^shared:[a-f0-9]{64}$/);
  const persisted = await ledger.get(first.ledgerTaskId);
  assert.equal(persisted.metadata.canonicalTaskId, record.taskId);
});

test('canonical task content drift blocks execution even when approval evidence is unchanged', async () => {
  const ledger = memoryLedger();
  const approved = canonical('approved');
  const changed = { ...approved, goal: approved.goal + ' altered after approval' };
  let executions = 0;
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => changed,
    execute: async () => { executions++; return { ok: true }; }
  });

  const queued = await adapter.enqueueApproved(approved);
  const result = await runGovernedOnce(ledger, adapter, 'rd-worker-content-drift');

  assert.equal(result.status, 'blocked');
  assert.match(result.error, /content changed after enqueue/);
  assert.equal(executions, 0);
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).status, 'failed');
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).retryable, false);
});

test('changed approval evidence blocks execution and is not retried', async () => {
  const ledger = memoryLedger();
  let executions = 0;
  let verifyCalls = 0;
  const record = canonical('approved');
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => {
      verifyCalls++;
      return verifyCalls === 1 ? attestation : { ...attestation, evidenceRef: 'approval-event:changed' };
    },
    loadCanonicalTask: async () => record,
    execute: async () => { executions++; return { ok: true }; }
  });
  const queued = await adapter.enqueueApproved(record);
  const result = await runGovernedOnce(ledger, adapter, 'rd-worker-2');
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /changed after enqueue/);
  assert.equal(executions, 0);
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).status, 'failed');
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).retryable, false);
});


test('governed supervisor owns lifecycle while shared adapter re-verifies approval before execution', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hf-shared-governed-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json')).open();
  const record = canonical('approved');
  record.metadata = { role: 'research', agentId: 'agent-shared', grantId: 'grant-shared' };
  let verificationCalls = 0;
  let executionCalls = 0;
  const shared = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => { verificationCalls++; return attestation; },
    loadCanonicalTask: async () => record,
    execute: async input => { executionCalls++; return { accepted: true, canonicalTaskId: input.canonicalTaskId }; }
  });
  const queued = await shared.enqueueApproved(record);
  const capabilityStore = await new CapabilityStore(path.join(directory, 'capabilities.json')).open();
  await capabilityStore.grant({
    grantId: 'grant-shared', agentId: 'agent-shared', taskId: queued.ledgerTaskId,
    capabilities: ['shared-task.v1'], expiresAt: Date.now() + 60000
  });
  const capabilityGate = new CapabilityGate({
    capabilityStore,
    approvalVerifier: async () => ({ verified: false })
  });
  const runtime = createGovernedRuntime({
    ledger, workerId: 'governed-shared-worker',
    capabilityGate,
    adapter: shared
  });

  const result = await runtime.runOnce();
  const persisted = await ledger.get(queued.ledgerTaskId);
  assert.equal(result.status, 'succeeded');
  assert.equal(persisted.status, 'succeeded');
  assert.equal(executionCalls, 1);
  assert.equal(verificationCalls, 2);
  assert.equal(persisted.events.filter(event => event.type === 'task.started').length, 1);
  assert.equal(persisted.events.filter(event => event.type === 'task.succeeded').length, 1);
});

test('governed capability denial blocks shared execution before adapter work', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hf-shared-governed-deny-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json')).open();
  const record = canonical('approved');
  record.metadata = { role: 'research', agentId: 'agent-shared', grantId: 'grant-shared' };
  let executionCalls = 0;
  const shared = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => record,
    execute: async () => { executionCalls++; return { unexpected: true }; }
  });
  const queued = await shared.enqueueApproved(record);
  const runtime = createGovernedRuntime({
    ledger, workerId: 'governed-shared-deny',
    capabilityGate: { async authorize() { return { allow: false, reason: 'grant_revoked' }; } },
    adapter: shared
  });
  const result = await runtime.runOnce();
  const persisted = await ledger.get(queued.ledgerTaskId);
  assert.equal(result.status, 'blocked');
  assert.equal(persisted.status, 'failed');
  assert.equal(executionCalls, 0);
});

test('governed shared adapter rejects canonical content drift without executing', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hf-shared-governed-drift-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json')).open();
  const approved = canonical('approved');
  approved.metadata = { role: 'research', agentId: 'agent-shared', grantId: 'grant-shared' };
  const changed = { ...approved, goal: approved.goal + ' changed after approval' };
  let executionCalls = 0;
  const shared = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => changed,
    execute: async () => { executionCalls++; return { unexpected: true }; }
  });
  const queued = await shared.enqueueApproved(approved);
  const runtime = createGovernedRuntime({
    ledger, workerId: 'governed-shared-drift',
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter: shared
  });
  const result = await runtime.runOnce();
  const persisted = await ledger.get(queued.ledgerTaskId);
  assert.equal(result.status, 'blocked');
  assert.equal(persisted.status, 'failed');
  assert.match(persisted.error, /content changed after enqueue/);
  assert.equal(executionCalls, 0);
});


test('governed shared adapter rejects changed trusted approval evidence before execution', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'hf-shared-governed-approval-drift-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json')).open();
  const record = canonical('approved');
  record.metadata = { role: 'research', agentId: 'agent-shared', grantId: 'grant-shared' };
  let verifyCalls = 0;
  let executionCalls = 0;
  const shared = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => {
      verifyCalls++;
      return verifyCalls === 1 ? attestation : { ...attestation, evidenceRef: 'approval-event:replaced' };
    },
    loadCanonicalTask: async () => record,
    execute: async () => { executionCalls++; return { unexpected: true }; }
  });
  const queued = await shared.enqueueApproved(record);
  const runtime = createGovernedRuntime({
    ledger, workerId: 'governed-shared-approval-drift',
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter: shared
  });
  const result = await runtime.runOnce();
  const persisted = await ledger.get(queued.ledgerTaskId);
  assert.equal(result.status, 'blocked');
  assert.equal(persisted.status, 'failed');
  assert.match(persisted.error, /approval evidence changed after enqueue/);
  assert.equal(executionCalls, 0);
  assert.equal(verifyCalls, 2);
});


test('adapter exposes no ungated runOnce worker path', () => {
  const ledger = memoryLedger();
  const adapter = createSharedTaskAdapter({
    ledger, contract: contract(),
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => canonical('approved'),
    execute: async () => ({ ok: true })
  });
  assert.equal(typeof adapter.runOne, 'undefined');
});

test('projects only authoritative ledger lifecycle into canonical task status with evidence', async () => {
  const canonicalContract = contract();
  canonicalContract.transitionTask = (record, nextStatus, { evidenceItem, actor = 'system' } = {}) => {
    const allowed = {
      approved: ['running', 'review_required'],
      running: ['completed', 'failed', 'review_required']
    };
    if (!allowed[record.status] || !allowed[record.status].includes(nextStatus)) {
      throw new Error('invalid task transition: ' + record.status + ' -> ' + nextStatus);
    }
    const updated = {
      ...record, status: nextStatus,
      approvalState: 'approved',
      updatedAt: new Date().toISOString(),
      evidence: record.evidence.slice()
    };
    if (evidenceItem) updated.evidence.push({
      ...evidenceItem, actor, observedAt: updated.updatedAt
    });
    return updated;
  };
  const ledger = memoryLedger();
  const approved = canonical('approved');
  const adapter = createSharedTaskAdapter({
    ledger, contract: canonicalContract,
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => approved,
    execute: async () => ({ ok: true })
  });
  const queued = await adapter.enqueueApproved(approved);
  const stored = ledger.tasks.get(queued.ledgerTaskId);

  // A forged caller object cannot override the durable ledger status.
  const forged = await adapter.projectLedgerState(approved, {
    id: queued.ledgerTaskId,
    status: 'succeeded',
    owner: 'forged-actor',
    metadata: { adapter: 'heavenzfire.shared-task.v1', canonicalTaskId: approved.taskId }
  });
  assert.equal(forged.status, 'unchanged');
  assert.equal(forged.canonicalRecord.status, 'approved');

  stored.status = 'running';
  stored.owner = 'worker:windows';
  stored.events = [{ type: 'task.started', actor: 'worker:windows' }];
  const running = await adapter.projectLedgerState(approved, { id: queued.ledgerTaskId });
  assert.equal(running.status, 'projected');
  assert.equal(running.canonicalRecord.status, 'running');
  assert.equal(running.canonicalRecord.evidence.at(-1).actor, 'worker:windows');

  stored.status = 'succeeded';
  stored.owner = null;
  stored.events.push({ type: 'task.succeeded', actor: 'worker:windows' });
  const completed = await adapter.projectLedgerState(running.canonicalRecord, queued.ledgerTaskId);
  assert.equal(completed.canonicalRecord.status, 'completed');
  assert.equal(completed.canonicalRecord.approvalState, 'approved');
});

test('maps authoritative cancellation to review_required and rejects forged or mismatched records', async () => {
  const canonicalContract = contract();
  canonicalContract.transitionTask = (record, nextStatus, { evidenceItem, actor = 'system' } = {}) => ({
    ...record, status: nextStatus, approvalState: 'approved',
    evidence: evidenceItem ? [...record.evidence, { ...evidenceItem, actor }] : record.evidence
  });
  const ledger = memoryLedger();
  const approved = canonical('approved');
  const adapter = createSharedTaskAdapter({
    ledger, contract: canonicalContract,
    verifyApproval: async () => attestation,
    loadCanonicalTask: async () => approved,
    execute: async () => ({ ok: true })
  });
  const queued = await adapter.enqueueApproved(approved);
  const stored = ledger.tasks.get(queued.ledgerTaskId);
  stored.status = 'cancelled';
  stored.owner = null;
  stored.events = [{ type: 'task.cancelled', actor: 'operator:zdh' }];

  const cancelled = await adapter.projectLedgerState(approved, { id: queued.ledgerTaskId });
  assert.equal(cancelled.canonicalRecord.status, 'review_required');
  assert.equal(cancelled.canonicalRecord.approvalState, 'approved');
  assert.equal(cancelled.canonicalRecord.evidence.at(-1).actor, 'operator:zdh');

  await assert.rejects(adapter.projectLedgerState(approved, {
    id: queued.ledgerTaskId, status: 'succeeded',
    metadata: { canonicalTaskId: approved.taskId }
  }), /unsupported ledger lifecycle status/);
  await assert.rejects(adapter.projectLedgerState(approved, {
    id: 'shared:' + 'b'.repeat(64)
  }), /does not match canonical task identity/);
  await assert.rejects(adapter.projectLedgerState({
    ...approved, goal: approved.goal + ' tampered'
  }, queued.ledgerTaskId), /content changed after enqueue/);
});
