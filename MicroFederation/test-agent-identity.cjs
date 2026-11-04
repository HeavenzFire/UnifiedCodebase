'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  createAgentIdentity,
  createFabricIdentityPolicies
} = require('./agent-identity.cjs');

function fixture(options = {}) {
  const { privateKey, publicKey } = options.keyPair || crypto.generateKeyPairSync('ed25519');
  let now = 1_800_000_000_000;
  const revoked = new Set();
  const issuer = options.issuer || 'heavenzfire-test-issuer';
  const keyId = options.keyId || 'test-key-1';
  const audience = options.audience || 'unified-field-fabric';
  const identity = createAgentIdentity({
    issuer, keyId, privateKey,
    trustedIssuers: { [issuer]: { [keyId]: publicKey } },
    audience,
    clock: () => now,
    maxTtlSeconds: 300,
    isRevoked: async jti => revoked.has(jti)
  });
  return {
    identity, revoked,
    setNow(value) { now = value; },
    token(overrides = {}) {
      return identity.issue({
        agentId: 'agent-1',
        grantId: 'grant-1',
        taskId: 'task-1',
        capabilities: ['artifact.build', 'fabric.submit'],
        ...overrides
      });
    }
  };
}

test('issues and verifies a scoped Ed25519 agent token', async () => {
  const f = fixture();
  const token = f.token();
  const result = await f.identity.verify(token, {
    expectedSubject: 'agent-1',
    expectedTaskId: 'task-1',
    requiredCapability: 'artifact.build'
  });
  assert.equal(result.ok, true);
  assert.equal(result.claims.iss, 'heavenzfire-test-issuer');
  assert.equal(result.claims.grantId, 'grant-1');
  assert.equal(result.claims.aud, 'unified-field-fabric');
});

test('rejects wrong subject, task, audience and missing capability', async () => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const f = fixture({ keyPair });
  const token = f.token();
  assert.equal((await f.identity.verify(token, { expectedSubject: 'agent-2' })).reason, 'subject_mismatch');
  assert.equal((await f.identity.verify(token, { expectedTaskId: 'task-2' })).reason, 'task_scope_mismatch');
  assert.equal((await f.identity.verify(token, { expectedNodeId: 'build' })).reason, 'node_scope_mismatch');
  assert.equal((await f.identity.verify(token, { requiredCapability: 'repo.merge' })).reason, 'capability_not_in_token');
  const wrongAudience = fixture({ audience: 'different-service', keyPair });
  assert.equal((await wrongAudience.identity.verify(token)).reason, 'audience_mismatch');
});

test('rejects modified payloads, signatures, malformed and non-canonical tokens', async () => {
  const f = fixture();
  const token = f.token();
  const [header, payload, signature] = token.split('.');
  const changed = Buffer.from(JSON.stringify({
    iss: 'heavenzfire-test-issuer', sub: 'agent-2', aud: 'unified-field-fabric',
    iat: 1800000000, exp: 1800000300, jti: crypto.randomUUID(),
    grantId: 'grant-1', taskId: 'task-1', capabilities: ['artifact.build', 'fabric.submit']
  })).toString('base64url');
  assert.equal((await f.identity.verify(header + '.' + changed + '.' + signature)).ok, false);
  assert.equal((await f.identity.verify(header + '.' + payload + '.' + signature.slice(1))).ok, false);
  assert.equal((await f.identity.verify('not-a-token')).ok, false);
  assert.equal((await f.identity.verify(header + '.eyJ6IjoxLCJhIjoxfQ.' + signature)).ok, false);
});

test('enforces token expiry, future issue time and configured maximum lifetime', async () => {
  const f = fixture();
  const token = f.token({ ttlSeconds: 30 });
  f.setNow(1_800_000_031_000);
  assert.equal((await f.identity.verify(token)).reason, 'token_expired_or_time_invalid');
  f.setNow(1_800_000_100_000);
  const futureToken = f.token();
  f.setNow(1_800_000_000_000);
  assert.equal((await f.identity.verify(futureToken)).reason, 'token_expired_or_time_invalid');
  assert.throws(() => f.token({ ttlSeconds: 301 }), /configured token lifetime/);
});

test('fails closed when the revocation store reports revoked or unavailable', async () => {
  const f = fixture();
  const token = f.token();
  const claims = (await f.identity.verify(token)).claims;
  f.revoked.add(claims.jti);
  assert.equal((await f.identity.verify(token)).reason, 'token_revoked_or_revocation_unavailable');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const unavailable = createAgentIdentity({
    issuer: 'unavailable-issuer', keyId: 'key-1', privateKey,
    trustedIssuers: { 'unavailable-issuer': { 'key-1': publicKey } },
    audience: 'unified-field-fabric',
    isRevoked: async () => { throw Error('store down'); }
  });
  const unavailableToken = unavailable.issue({
    agentId: 'agent-1', grantId: 'grant-1', taskId: 'task-1', capabilities: ['fabric.submit']
  });
  assert.equal((await unavailable.verify(unavailableToken)).reason, 'revocation_check_unavailable');
});

test('rejects missing revocation store and non-Ed25519 keys', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => createAgentIdentity({
    issuer: 'issuer', keyId: 'key-1', privateKey,
    trustedIssuers: { issuer: { 'key-1': publicKey } }, audience: 'service'
  }), /revocation-store/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  assert.throws(() => createAgentIdentity({
    issuer: 'issuer', keyId: 'key-1', privateKey: rsa.privateKey,
    trustedIssuers: { issuer: { 'key-1': rsa.publicKey } }, audience: 'service',
    isRevoked: async () => false
  }), /Ed25519/);
});

test('fabric producer and worker policies bind signed identity to grants and task scope', async () => {
  const f = fixture();
  const calls = [];
  const capabilityGate = {
    async authorize(request) {
      calls.push(request);
      return request.agentId === 'agent-1' && request.grantId === 'grant-1'
        ? { allow: true, reason: 'test-grant' }
        : { allow: false, reason: 'grant-denied' };
    }
  };
  const workerToken = f.token({ nodeId: 'build', capabilities: ['artifact.build'] });
  const policies = createFabricIdentityPolicies({
    identity: f.identity,
    capabilityGate,
    getWorkerToken: async ({ peerId, nodeId }) => {
      assert.equal(peerId, 'agent-1');
      assert.equal(nodeId, 'build');
      return workerToken;
    }
  });
  const producerToken = f.token();
  const producer = await policies.authenticateProducer({
    principal: 'agent-1', producerProof: producerToken, taskId: 'task-1'
  });
  assert.equal(producer.ok, true);
  const worker = await policies.authorizeWorker({
    peerId: 'agent-1', taskId: 'task-1', nodeId: 'build', capability: 'artifact.build'
  });
  assert.equal(worker.ok, true);
  assert.equal(worker.taskId, 'task-1');
  assert.equal(worker.nodeId, 'build');
  assert.equal(worker.capability, 'artifact.build');
  assert.equal(worker.peerId, 'agent-1');
  assert.ok(worker.expiresAt > Date.now());
  assert.equal(calls.length, 2);
  assert.equal((await policies.authenticateProducer({
    principal: 'agent-2', producerProof: producerToken, taskId: 'task-1'
  })).ok, false);
  assert.equal((await policies.authorizeWorker({
    peerId: 'agent-1', taskId: 'task-2', nodeId: 'build', capability: 'artifact.build'
  })).ok, false);
  assert.equal((await policies.authorizeWorker({
    peerId: 'agent-1', taskId: 'task-1', nodeId: 'deploy', capability: 'artifact.build'
  })).reason, 'node_scope_mismatch');
  assert.equal((await policies.authorizeWorker({
    peerId: 'agent-1', taskId: 'task-1', capability: 'artifact.build'
  })).reason, 'worker_identity_missing');
});
