'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('./task-ledger.cjs');
const { createPixelMesh } = require('./pixel-mesh.cjs');
const { createUnifiedFieldFabric } = require('./unified-field-fabric.cjs');
const { createAgentIdentity, createFabricIdentityPolicies } = require('./agent-identity.cjs');

function identityFixture() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const issuer = 'heavenzfire-integration-issuer';
  const keyId = 'integration-key';
  const identity = createAgentIdentity({
    issuer, keyId, privateKey,
    trustedIssuers: { [issuer]: { [keyId]: publicKey } },
    audience: 'unified-field-fabric',
    isRevoked: async () => false
  });
  return identity;
}

test('signed producer and node-bound worker tokens authorize the actual Unified Field fabric', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-agent-identity-fabric-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = identityFixture();
  const taskId = 'identity-fabric-task';

  const producerToken = identity.issue({
    agentId: 'producer-agent',
    grantId: 'producer-grant',
    taskId,
    capabilities: ['fabric.submit']
  });
  const workerToken = identity.issue({
    agentId: 'worker-agent',
    grantId: 'worker-grant',
    taskId,
    nodeId: 'build',
    capabilities: ['artifact.build']
  });

  const capabilityGate = {
    async authorize(request) {
      return request.agentId === 'producer-agent' && request.grantId === 'producer-grant' &&
        request.capability === 'fabric.submit'
        ? { allow: true }
        : request.agentId === 'worker-agent' && request.grantId === 'worker-grant' &&
          request.nodeId === 'build' && request.capability === 'artifact.build'
          ? { allow: true }
          : { allow: false, reason: 'grant_scope_denied' };
    }
  };
  const policies = createFabricIdentityPolicies({
    identity,
    capabilityGate,
    getWorkerToken: async ({ peerId, taskId: requestedTask, nodeId, capability }) => {
      assert.equal(peerId, 'worker-agent');
      assert.equal(requestedTask, taskId);
      assert.equal(nodeId, 'build');
      assert.equal(capability, 'artifact.build');
      return workerToken;
    }
  });

  const ledger = await new TaskLedger(path.join(directory, 'tasks.json'), {
    authenticateProducer: policies.authenticateProducer
  }).open();
  const mesh = createPixelMesh();
  mesh.register({ peerId: 'worker-agent', capabilities: ['artifact.build'], capacity: 1 });
  const fabric = createUnifiedFieldFabric({
    ledger,
    mesh,
    authorizeWorker: policies.authorizeWorker,
    workerAdapters: { 'worker-agent': async () => ({ artifact: 'built', verifiedBy: 'test-adapter' }) }
  });

  await fabric.submit({
    id: taskId,
    workflowId: 'identity-bound-workflow',
    nodes: { build: { capability: 'artifact.build' } },
    principal: 'producer-agent',
    producerProof: producerToken
  });
  const result = await fabric.runOne();
  assert.equal(result.status, 'succeeded');
  assert.equal((await ledger.get(taskId)).status, 'succeeded');

  const stored = await ledger.get(taskId);
  assert.equal(stored.metadata.provenance.subject, 'producer-agent');
  assert.equal(JSON.stringify(stored).includes(producerToken), false);
  assert.equal(JSON.stringify(stored).includes(workerToken), false);
});

test('worker token bound to a different DAG node cannot execute that node', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-agent-identity-node-scope-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = identityFixture();
  const taskId = 'identity-node-mismatch';
  const producerToken = identity.issue({
    agentId: 'producer-agent', grantId: 'producer-grant', taskId,
    capabilities: ['fabric.submit']
  });
  const workerToken = identity.issue({
    agentId: 'worker-agent', grantId: 'worker-grant', taskId,
    nodeId: 'build', capabilities: ['artifact.build']
  });
  const policies = createFabricIdentityPolicies({
    identity,
    capabilityGate: { authorize: async () => ({ allow: true }) },
    getWorkerToken: async () => workerToken
  });
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json'), {
    authenticateProducer: policies.authenticateProducer
  }).open();
  const mesh = createPixelMesh();
  mesh.register({ peerId: 'worker-agent', capabilities: ['artifact.build'], capacity: 1 });
  const fabric = createUnifiedFieldFabric({
    ledger, mesh, authorizeWorker: policies.authorizeWorker,
    workerAdapters: { 'worker-agent': async () => ({ shouldNotRun: true }) }
  });
  await fabric.submit({
    id: taskId, workflowId: 'wrong-node-workflow',
    nodes: { deploy: { capability: 'artifact.build' } },
    principal: 'producer-agent', producerProof: producerToken
  });
  const result = await fabric.runOne();
  assert.equal(result.status, 'failed');
  assert.equal((await ledger.get(taskId)).status, 'failed');
  assert.equal(result.error.includes('no independently authorized worker'), true);
});

test('producer without fabric.submit capability cannot enqueue protected fabric work', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-agent-identity-producer-scope-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = identityFixture();
  const taskId = 'identity-producer-denied';
  const token = identity.issue({
    agentId: 'producer-agent', grantId: 'read-only-grant', taskId,
    capabilities: ['artifact.read']
  });
  const policies = createFabricIdentityPolicies({
    identity,
    capabilityGate: { authorize: async () => ({ allow: true }) },
    getWorkerToken: async () => null
  });
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json'), {
    authenticateProducer: policies.authenticateProducer
  }).open();
  const fabric = createUnifiedFieldFabric({
    ledger, mesh: createPixelMesh(), authorizeWorker: policies.authorizeWorker,
    workerAdapters: {}
  });
  await assert.rejects(fabric.submit({
    id: taskId, workflowId: 'denied-producer-workflow',
    nodes: { build: { capability: 'artifact.build' } },
    principal: 'producer-agent', producerProof: token
  }), /producer/);
});
