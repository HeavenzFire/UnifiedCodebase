'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createFileApprovalNonceStore } = require('./approval-nonce-store.cjs');
const { createApprovalGate, canonicalApprovalPayload } = require('./approval-gate.cjs');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hf-approval-nonce-'));
}

test('nonce consumption survives store and approval-gate reconstruction', () => {
  const directory = tempDirectory();
  const pair = crypto.generateKeyPairSync('ed25519');
  const now = 1000;
  const unsigned = {
    version: 1, issuer: 'human-review-board', approvedTaskId: 'task-1',
    approvedNodeId: 'deploy', approvedAction: 'deployment.apply',
    approvedSubject: 'staging', issuedAt: now, expiresAt: now + 5000, nonce: 'nonce-persisted'
  };
  const approval = {
    ...unsigned,
    signature: crypto.sign(null, Buffer.from(canonicalApprovalPayload(unsigned)), pair.privateKey).toString('base64url')
  };
  const firstGate = createApprovalGate({
    trustedIssuers: { 'human-review-board': pair.publicKey },
    clock: () => now,
    nonceStore: createFileApprovalNonceStore({ directory, clock: () => now })
  });
  const secondGate = createApprovalGate({
    trustedIssuers: { 'human-review-board': pair.publicKey },
    clock: () => now,
    nonceStore: createFileApprovalNonceStore({ directory, clock: () => now })
  });
  const scope = { approval, taskId: 'task-1', nodeId: 'deploy', action: 'deployment.apply', subject: 'staging' };
  assert.equal(firstGate.verify(scope).ok, true);
  assert.deepEqual(secondGate.verify(scope), { ok: false, reason: 'approval_replayed' });
});

test('exclusive file creation rejects the same nonce across independent processes', async () => {
  const directory = tempDirectory();
  const modulePath = path.join(__dirname, 'approval-nonce-store.cjs');
  const script = [
    "const { createFileApprovalNonceStore } = require(process.argv[1]);",
    "const store = createFileApprovalNonceStore({ directory: process.argv[2] });",
    "process.stdout.write(JSON.stringify(store.consume({ issuer: 'issuer', nonce: 'shared-nonce', expiresAt: Date.now() + 60000 })));"
  ].join('');
  function runChild() {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script, modulePath, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr || 'child failed')));
    });
  }
  const results = await Promise.all([runChild(), runChild()]);
  assert.equal(results.filter(result => result.ok === true).length, 1);
  assert.equal(results.filter(result => result.reason === 'approval_replayed').length, 1);
});

test('expired nonce files are pruned before a new approval is admitted', () => {
  const directory = tempDirectory();
  const first = createFileApprovalNonceStore({ directory, clock: () => 1000 });
  assert.equal(first.consume({ issuer: 'issuer', nonce: 'nonce', expiresAt: 1500, now: 1000 }).ok, true);
  const afterExpiry = createFileApprovalNonceStore({ directory, clock: () => 1501 });
  assert.equal(afterExpiry.consume({ issuer: 'issuer', nonce: 'nonce', expiresAt: 2500, now: 1501 }).ok, true);
});

test('store refuses new nonces when its configured entry bound is reached', () => {
  const directory = tempDirectory();
  const store = createFileApprovalNonceStore({ directory, maxEntries: 1, clock: () => 1000 });
  assert.equal(store.consume({ issuer: 'issuer', nonce: 'one', expiresAt: 5000, now: 1000 }).ok, true);
  assert.deepEqual(store.consume({ issuer: 'issuer', nonce: 'two', expiresAt: 5000, now: 1000 }), {
    ok: false, reason: 'approval_replay_cache_full'
  });
});

test('store requires an absolute directory and bounded capacity', () => {
  assert.throws(() => createFileApprovalNonceStore({ directory: 'relative/path' }), /absolute path/);
  assert.throws(() => createFileApprovalNonceStore({ directory: os.tmpdir(), maxEntries: 0 }), /maxEntries/);
});


test('POSIX nonce directory and records are owner-only', t => {
  if (process.platform === 'win32') return t.skip('Windows ACLs are enforced by deployment policy, not POSIX mode bits.');
  const directory = tempDirectory();
  const store = createFileApprovalNonceStore({ directory, clock: () => 1000 });
  assert.equal(store.consume({ issuer: 'issuer', nonce: 'permission-check', expiresAt: 5000, now: 1000 }).ok, true);
  assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
  const record = fs.readdirSync(directory)[0];
  assert.equal(fs.statSync(path.join(directory, record)).mode & 0o777, 0o600);
});
