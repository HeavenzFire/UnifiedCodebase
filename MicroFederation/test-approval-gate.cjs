'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApprovalGate, canonicalApprovalPayload } = require('./approval-gate.cjs');

function fixture() {
  const pair = crypto.generateKeyPairSync('ed25519');
  const now = 1000;
  const unsigned = {
    version: 1,
    issuer: 'human-review-board',
    approvedTaskId: 'task-1',
    approvedNodeId: 'deploy',
    approvedAction: 'deployment.apply',
    approvedSubject: 'staging',
    issuedAt: now,
    expiresAt: now + 5000,
    nonce: 'nonce-1'
  };
  const approval = {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalApprovalPayload(unsigned)), pair.privateKey).toString('base64url')
  };
  return { pair, now, approval };
}

test('only trusted issuer signatures authorize exact task, node, action and subject', () => {
  const { pair, now, approval } = fixture();
  const gate = createApprovalGate({ trustedIssuers: { 'human-review-board': pair.publicKey }, clock: () => now });
  assert.equal(gate.verify({ approval, taskId: 'task-1', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' }).ok, true);
  assert.equal(gate.verify({ approval, taskId: 'task-2', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' }).reason, 'approval_scope_mismatch');
  const untrusted = createApprovalGate({ trustedIssuers: {}, clock: () => now });
  assert.equal(untrusted.verify({ approval, taskId: 'task-1', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' }).reason, 'untrusted_approval_issuer');
});

test('rejects non-canonical base64url signatures and oversized signature fields', () => {
  const { pair, now, approval } = fixture();
  const gate = createApprovalGate({ trustedIssuers: { 'human-review-board': pair.publicKey }, clock: () => now });
  const padded = { ...approval, signature: approval.signature + '=' };
  assert.equal(gate.verify({ approval: padded, taskId: 'task-1', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' }).reason, 'approval_signature_invalid');
  const oversized = { ...approval, signature: 'a'.repeat(513) };
  assert.equal(gate.verify({ approval: oversized, taskId: 'task-1', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' }).reason, 'approval_malformed');
});

test('fails closed when the injected durable replay store throws or is asynchronous', () => {
  const { pair, now, approval } = fixture();
  const scope = { approval, taskId: 'task-1', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' };
  const throwing = createApprovalGate({
    trustedIssuers: { 'human-review-board': pair.publicKey },
    clock: () => now,
    nonceStore: { consume() { throw new Error('disk unavailable'); } }
  });
  assert.equal(throwing.verify(scope).reason, 'approval_replay_store_unavailable');
  const asynchronous = createApprovalGate({
    trustedIssuers: { 'human-review-board': pair.publicKey },
    clock: () => now,
    nonceStore: { consume() { return Promise.resolve({ ok: true }); } }
  });
  assert.equal(asynchronous.verify(scope).reason, 'approval_replay_store_unavailable');
});
