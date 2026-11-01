'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSharedTaskAdapter } = require('./shared-task-adapter.cjs');

function canonical(status = 'proposed') {
  return {
    schema: 'heavenzfire.shared-task.v1',
    taskId: 'rd-task-001',
    source: 'github',
    goal: 'Inspect a bounded research task and return evidence-backed findings.',
    status,
    approvalState: status === 'approved' ? 'approved' : 'pending',
    evidence: [],
    metadata: { role: 'research' }
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
  const result = await adapter.runOne({ workerId: 'rd-worker-1' });
  assert.equal(result.status, 'succeeded');
  assert.equal(executions, 1);
  assert.equal(verifyCalls, 2);
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).status, 'succeeded');
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
  const result = await adapter.runOne({ workerId: 'rd-worker-2' });
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /changed after enqueue/);
  assert.equal(executions, 0);
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).status, 'failed');
  assert.equal(ledger.tasks.get(queued.ledgerTaskId).retryable, false);
});
