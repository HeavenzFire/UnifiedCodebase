'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOperatorApprovalAuthority } = require('../operator-approval.cjs');
const { recordHash } = require('../shared-task-ledger-adapter.cjs');

let now = Date.parse('2026-11-06T12:00:00.000Z');
let counter = 0;
const clock = () => now;
const nonce = () => (++counter).toString(16).padStart(64, '0');

function approvedRecord() {
  return {
    schema: 'heavenzfire.shared-task.v1',
    taskId: 'approval-test-task',
    source: 'operator-approval-test',
    goal: 'Return a bounded read-only result',
    status: 'approved',
    approvalState: 'approved',
    evidence: [{
      kind: 'approval',
      summary: 'Operator approved the exact bounded task',
      actor: 'operator-test',
      observedAt: new Date(now).toISOString()
    }],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metadata: { agentId: 'agent-test', grantId: 'grant-test' }
  };
}

test('approval proof binds actor, task identity, canonical hash, expiry, and signature', async () => {
  const authority = createOperatorApprovalAuthority({
    secret: 'test-only-operator-approval-secret-32-bytes',
    clock,
    nonce
  });
  const record = approvedRecord();
  const proof = authority.createProof(record, { actor: 'operator-test', ttlMs: 60000 });
  const verified = await authority.verifyApproval({
    record,
    approvalProof: proof,
    recordHash: recordHash(record)
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.approver, 'operator-test');
  assert.equal(verified.recordHash, recordHash(record));
  assert.equal(verified.proofNonce, proof.nonce);
  assert.equal((await authority.verifyAttestation({ record, attestation: {
    schema: 'heavenzfire.operator-approval.v1',
    taskId: record.taskId,
    approver: verified.approver,
    evidenceRef: verified.evidenceRef,
    verifiedAt: verified.verifiedAt,
    recordHash: verified.recordHash,
    proofIssuedAt: verified.proofIssuedAt,
    proofExpiresAt: verified.proofExpiresAt,
    proofNonce: verified.proofNonce,
    proofSignature: verified.proofSignature
  }})).ok, true);
});

test('approval proof cannot be transferred to changed task content or another task ID', async () => {
  const authority = createOperatorApprovalAuthority({
    secret: 'test-only-operator-approval-secret-32-bytes',
    clock,
    nonce
  });
  const record = approvedRecord();
  const proof = authority.createProof(record, { actor: 'operator-test' });
  const changed = { ...record, goal: 'Different task content' };
  await assert.rejects(authority.verifyApproval({
    record: changed,
    approvalProof: proof,
    recordHash: recordHash(changed)
  }), /claims are invalid/);
  const otherTask = { ...record, taskId: 'other-task' };
  await assert.rejects(authority.verifyApproval({
    record: otherTask,
    approvalProof: proof,
    recordHash: recordHash(otherTask)
  }), /claims are invalid/);
});

test('expired approval proof is denied', async () => {
  const authority = createOperatorApprovalAuthority({
    secret: 'test-only-operator-approval-secret-32-bytes',
    clock,
    nonce
  });
  const record = approvedRecord();
  const proof = authority.createProof(record, { actor: 'operator-test', ttlMs: 60000 });
  now += 60001;
  await assert.rejects(authority.verifyApproval({
    record,
    approvalProof: proof,
    recordHash: recordHash(record)
  }), /expired or outside clock policy/);
});
