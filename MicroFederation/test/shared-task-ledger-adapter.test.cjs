'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('../task-ledger.cjs');
const { createGovernedRuntime } = require('../governed-runtime.cjs');
const { createSharedTaskLedgerAdapter, recordHash } = require('../shared-task-ledger-adapter.cjs');

const contract = {
  SCHEMA: 'heavenzfire.shared-task.v1',
  validateTaskRecord(record) {
    if (!record || record.schema !== this.SCHEMA || typeof record.taskId !== 'string' ||
        typeof record.source !== 'string' || typeof record.goal !== 'string' ||
        !['proposed','approved','running','completed','failed','review_required','rejected'].includes(record.status) ||
        !['pending','approved','rejected'].includes(record.approvalState) || !Array.isArray(record.evidence)) {
      throw new Error('invalid canonical task record');
    }
    if (['approved','running','completed'].includes(record.status) && record.approvalState !== 'approved') {
      throw new Error('execution status requires explicit approval state');
    }
    for (const item of record.evidence) {
      if (!item || typeof item.kind !== 'string' || typeof item.summary !== 'string') throw new Error('invalid evidence item');
    }
    return true;
  }
};

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-shared-task-'));
  const ledger = await new TaskLedger(path.join(dir, 'ledger.json')).open();
  let now = Date.parse('2026-11-04T12:00:00.000Z');
  let attestationChecks = 0;
  let executions = 0;
  const clock = () => now;
  const verifyApproval = async ({ record, approvalProof, recordHash: hash }) => {
    if (approvalProof !== 'operator-confirmed') return { ok: false };
    return {
      ok: true, approver: 'operator-zdh', evidenceRef: 'approval:' + record.taskId,
      verifiedAt: new Date(now).toISOString(), recordHash: hash
    };
  };
  const verifyAttestation = async ({ record, attestation }) => {
    attestationChecks++;
    return { ok: attestation.recordHash === recordHash(record) && attestation.approver === 'operator-zdh' && attestation.evidenceRef === 'approval:' + record.taskId };
  };
  const execute = async ({ canonicalTaskId, prompt }) => {
    executions++;
    return { ok: true, canonicalTaskId, prompt, result: 'HF_FEDERATION_TASK_OK' };
  };
  const adapter = createSharedTaskLedgerAdapter({ ledger, contract, verifyApproval, verifyAttestation, execute, clock });
  const record = {
    schema: contract.SCHEMA, taskId: 'task-001', source: 'command-center',
    goal: 'Return the exact text HF_FEDERATION_TASK_OK',
    status: 'approved', approvalState: 'approved',
    evidence: [{
      kind: 'approval', summary: 'Operator explicitly approved this bounded test task',
      observedAt: new Date(now).toISOString(), actor: 'operator-zdh'
    }],
    createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    metadata: { purpose: 'adapter-test', agentId: 'agent-shared', grantId: 'grant-shared', role: 'research' }
  };
  return { dir, ledger, adapter, record, setNow: value => { now = value; }, now: () => now,
    getAttestationChecks: () => attestationChecks, getExecutions: () => executions };
}

test('approved canonical record maps into ledger and projects back without losing identity or approval evidence', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const created = await f.adapter.createFromCanonical(f.record, { approvalProof: 'operator-confirmed' });
  assert.equal(created.id, f.record.taskId);
  assert.equal(created.status, 'queued');
  const projected = await f.adapter.projectToCanonical(created);
  assert.equal(projected.canonicalRecord.taskId, f.record.taskId);
  assert.equal(projected.canonicalRecord.status, 'approved');
  assert.deepEqual(projected.canonicalRecord.evidence, f.record.evidence);
  assert.equal(projected.ledger.status, 'queued');
  assert.equal(projected.schema, 'heavenzfire.shared-task-ledger-adapter.v1');
});

test('pending and proposed canonical tasks are never admitted', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const pending = { ...f.record, status: 'proposed', approvalState: 'pending' };
  await assert.rejects(f.adapter.createFromCanonical(pending, { approvalProof: 'operator-confirmed' }), /only explicitly approved/);
  assert.equal((await f.ledger.list()).length, 0);
});

test('missing, forged, or mismatched approval proof fails closed', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  await assert.rejects(f.adapter.createFromCanonical(f.record), /denied/);
  await assert.rejects(f.adapter.createFromCanonical(f.record, { approvalProof: 'forged' }), /denied/);
  const wrongActor = { ...f.record, evidence: [{ ...f.record.evidence[0], actor: 'other-user' }] };
  await assert.rejects(f.adapter.createFromCanonical(wrongActor, { approvalProof: 'operator-confirmed' }), /does not match/);
  assert.equal((await f.ledger.list()).length, 0);
});

test('GovernedRuntime owns execution and adapter rechecks the trusted attestation', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  await f.adapter.createFromCanonical(f.record, { approvalProof: 'operator-confirmed' });
  const runtime = createGovernedRuntime({
    ledger: f.ledger,
    workerId: 'worker-zdh',
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter: f.adapter
  });
  const result = await runtime.runOnce({ now: f.now() });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.result.result, 'HF_FEDERATION_TASK_OK');
  assert.equal(f.getAttestationChecks(), 1);
  assert.equal(f.getExecutions(), 1);
  assert.equal((await f.ledger.get(f.record.taskId)).status, 'succeeded');
});

test('tampered approval metadata is blocked by the governed runtime before execution', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const created = await f.adapter.createFromCanonical(f.record, { approvalProof: 'operator-confirmed' });
  const raw = f.ledger.tasks.find(task => task.id === created.id);
  raw.metadata.heavenzfireSharedTaskAdapter.approvalAttestation.recordHash = '0'.repeat(64);
  await f.ledger._persist(f.ledger.tasks);
  const runtime = createGovernedRuntime({
    ledger: f.ledger,
    workerId: 'worker-zdh',
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter: f.adapter
  });
  const result = await runtime.runOnce({ now: f.now() });
  assert.equal(result.status, 'blocked');
  assert.match(result.error, /attestation/);
  assert.equal(f.getExecutions(), 0);
  assert.equal((await f.ledger.get(created.id)).status, 'failed');
});

test('idempotent delivery returns the same task and rejects conflicting duplicate input', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const first = await f.adapter.createFromCanonical(f.record, { approvalProof: 'operator-confirmed' });
  f.setNow(f.now() + 5000);
  const second = await f.adapter.createFromCanonical(f.record, { approvalProof: 'operator-confirmed' });
  assert.equal(second.id, first.id);
  const changed = { ...f.record, goal: 'different goal' };
  await assert.rejects(f.adapter.createFromCanonical(changed, { approvalProof: 'operator-confirmed' }), /already exists with a different or untrusted canonical record/);
});

test('unsupported cancelled state is explicit rather than silently mapped', async t => {
  const f = await fixture(); t.after(() => fs.rm(f.dir, { recursive: true, force: true }));
  const created = await f.adapter.createFromCanonical(f.record, { approvalProof: 'operator-confirmed' });
  const cancelled = { ...created, status: 'cancelled' };
  await assert.rejects(f.adapter.projectToCanonical(cancelled), /no lossless canonical mapping: cancelled/);
});
