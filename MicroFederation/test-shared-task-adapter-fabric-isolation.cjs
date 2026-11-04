'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { TaskLedger } = require('./task-ledger.cjs');
const { createSharedTaskAdapter } = require('./shared-task-adapter.cjs');
const { createUnifiedFieldFabric } = require('./unified-field-fabric.cjs');
const { createPixelMesh } = require('./pixel-mesh.cjs');

test('shared-task worker cannot claim a fabric task from the same durable ledger', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-shared-fabric-isolation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  const ledger = await new TaskLedger(path.join(directory, 'tasks.json'), {
    authenticateProducer: async ({ principal }) => ({ ok: true, issuer: 'test-issuer', subject: principal })
  }).open();

  const canonicalRecord = {
    schema: 'heavenzfire.shared-task.v1',
    taskId: 'canonical-shared-task',
    source: 'test-suite',
    goal: 'Run only the explicitly approved shared task.',
    status: 'approved',
    approvalState: 'approved',
    evidence: [],
    metadata: {}
  };
  const contract = {
    validateTaskRecord(record) {
      if (!record || record.schema !== 'heavenzfire.shared-task.v1') throw new Error('invalid shared-task contract');
    }
  };
  let sharedExecutions = 0;
  const shared = createSharedTaskAdapter({
    ledger,
    contract,
    verifyApproval: async () => ({
      verified: true,
      actor: 'test-human-reviewer',
      evidenceRef: 'approval:test-1',
      verifiedAt: '2026-11-04T00:00:00.000Z'
    }),
    loadCanonicalTask: async id => id === canonicalRecord.taskId ? canonicalRecord : null,
    execute: async () => { sharedExecutions++; return { shared: true }; }
  });
  await shared.enqueueApproved(canonicalRecord);

  const mesh = createPixelMesh();
  mesh.register({ peerId: 'fabric-worker', capabilities: ['artifact.build'], capacity: 1 });
  const fabric = createUnifiedFieldFabric({
    ledger,
    mesh,
    workerAdapters: { 'fabric-worker': async () => ({ fabric: true }) },
    authorizeWorker: async ({ taskId, nodeId, capability, peerId }) => ({
      ok: true, taskId, nodeId, capability, peerId,
      issuer: 'test-policy', grantId: 'test-grant', expiresAt: Date.now() + 60000
    })
  });
  await fabric.submit({
    id: 'fabric-task-isolated',
    workflowId: 'fabric-isolation-flow',
    nodes: { build: { capability: 'artifact.build' } },
    principal: 'test-producer',
    producerProof: 'fixture'
  });

  const sharedRun = await shared.runOne({ workerId: 'shared-task-worker' });
  assert.equal(sharedRun.status, 'succeeded');
  assert.equal(sharedExecutions, 1);
  assert.equal((await ledger.get('fabric-task-isolated')).status, 'queued');

  const fabricRun = await fabric.runOne();
  assert.equal(fabricRun.status, 'succeeded');
  assert.equal((await ledger.get('fabric-task-isolated')).status, 'succeeded');
});
