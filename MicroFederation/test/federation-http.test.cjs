'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createFederationProtocol } = require('../federation-protocol.cjs');
const { createFederationHttpServer } = require('../federation-http-server.cjs');
const { createFederationHttpClient } = require('../federation-http-client.cjs');
const { TaskLedger } = require('../task-ledger.cjs');
const { createGovernedRuntime } = require('../governed-runtime.cjs');
const { createSharedTaskLedgerAdapter } = require('../shared-task-ledger-adapter.cjs');
const { createOperatorApprovalAuthority } = require('../operator-approval.cjs');

const SECRET = 'heavenzfire-http-integration-secret-32-bytes-minimum';
const APPROVED_AT = '2026-11-04T00:00:00.000Z';
let now = Date.parse('2026-11-04T12:00:00.000Z');
let nonceCounter = 0;
const clock = () => now;
const nonce = () => (++nonceCounter).toString(16).padStart(64, '0');

function protocolPair() {
  const windows = createFederationProtocol({
    nodeId: 'windows-zdh', capabilities: ['task.submit', 'task.read'], clock, nonce,
    peers: [{ nodeId: 'android-a67l', secret: SECRET, approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['task.submit', 'task.read'] }]
  });
  const android = createFederationProtocol({
    nodeId: 'android-a67l', capabilities: ['task.submit', 'task.read'], clock, nonce,
    peers: [{ nodeId: 'windows-zdh', secret: SECRET, approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['task.submit', 'task.read'] }]
  });
  return { windows, android };
}

async function withServer(t, options = {}) {
  const { windows, android } = protocolPair();
  const accepted = new Map();
  let calls = 0;
  const taskAdapter = {
    async createFromCanonical(record, { approvalProof }) {
      calls++;
      if (record.status !== 'approved' || record.approvalState !== 'approved' || approvalProof !== 'signed-operator-proof') {
        throw new Error('trusted approval denied');
      }
      const prior = accepted.get(record.taskId);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(record)) throw new Error('task ID conflict');
        return { id: record.taskId, status: 'queued' };
      }
      accepted.set(record.taskId, record);
      return { id: record.taskId, status: 'queued' };
    }
  };
  const server = createFederationHttpServer({
    protocol: windows, taskAdapter, host: '127.0.0.1', port: 0, clock,
    ...options
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = createFederationHttpClient({
    protocol: android, peerNodeId: 'windows-zdh',
    baseUrl: 'http://127.0.0.1:' + address.port
  });
  return { client, server, accepted, calls, getCalls: () => calls, windows, android, address };
}

function approvedRecord(taskId = 'hf-task-http-001') {
  return {
    schema: 'heavenzfire.shared-task.v1',
    taskId,
    source: 'federation-http-test',
    goal: 'Return a bounded read-only result',
    status: 'approved',
    approvalState: 'approved',
    evidence: [{ kind: 'approval', summary: 'Operator approved bounded task', actor: 'operator-zdh', observedAt: new Date(now).toISOString() }],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metadata: {}
  };
}

test('HTTP federation handshake and task submission work over a loopback endpoint', async t => {
  const f = await withServer(t);
  const session = await f.client.handshake();
  assert.equal(session.state, 'AUTHENTICATED');
  assert.deepEqual(session.grantedCapabilities, ['task.read', 'task.submit']);
  const result = await f.client.submitTask(approvedRecord(), 'signed-operator-proof');
  assert.equal(result.ok, true);
  assert.equal(result.status, 202);
  assert.equal(result.taskId, 'hf-task-http-001');
  assert.equal(f.accepted.size, 1);
});

test('task submission is refused before handshake and duplicate delivery is idempotent', async t => {
  const f = await withServer(t);
  await assert.rejects(f.client.submitTask(approvedRecord(), 'signed-operator-proof'), /handshake is required/);
  await f.client.handshake();
  const record = approvedRecord('hf-task-duplicate-001');
  const first = await f.client.submitTask(record, 'signed-operator-proof');
  const second = await f.client.submitTask(record, 'signed-operator-proof');
  assert.equal(first.taskId, second.taskId);
  assert.equal(f.accepted.size, 1);
  assert.equal(f.getCalls(), 2);
});

test('server rejects a forged message source/target binding', async t => {
  const f = await withServer(t);
  await f.client.handshake();
  const body = f.android.signPeerMessage('windows-zdh', {
    protocol: 'heavenzfire.federation.v1',
    type: 'task_submit',
    sessionNonce: f.client.getSession().nonce,
    taskRecord: approvedRecord('hf-task-forged-001'),
    approvalProof: 'signed-operator-proof'
  });
  const forged = { ...body, to: 'another-node' };
  const response = await fetch('http://127.0.0.1:' + f.address.port + '/v1/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forged)
  });
  assert.equal(response.status, 401);
  assert.equal(f.accepted.size, 0);
});

test('server refuses an expired authenticated session', async t => {
  const f = await withServer(t);
  await f.client.handshake();
  now += 301000;
  await assert.rejects(f.client.submitTask(approvedRecord('hf-task-expired-001'), 'signed-operator-proof'), /session_missing_or_expired/);
});

test('server cannot bind to a non-loopback interface and client rejects remote URLs', async () => {
  const { windows } = protocolPair();
  assert.throws(() => createFederationHttpServer({
    protocol: windows, taskAdapter: { createFromCanonical: async () => ({}) },
    host: '0.0.0.0', port: 18100
  }), /127.0.0.1 only/);
  assert.throws(() => createFederationHttpClient({
    protocol: protocolPair().android, peerNodeId: 'windows-zdh', baseUrl: 'http://100.96.1.10:18100'
  }), /loopback URLs only/);
});

test('unapproved or incorrectly keyed peers cannot complete the handshake', async t => {
  const { windows } = protocolPair();
  const badClientProtocol = createFederationProtocol({
    nodeId: 'android-rogue', capabilities: ['task.submit'], clock, nonce,
    peers: [{ nodeId: 'windows-zdh', secret: 'wrong-secret-that-is-at-least-32-bytes', approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['task.submit'] }]
  });
  const server = createFederationHttpServer({
    protocol: windows, taskAdapter: { createFromCanonical: async () => ({}) }, port: 0, clock
  });
  const address = await server.listen();
  t.after(() => server.close());
  const client = createFederationHttpClient({
    protocol: badClientProtocol, peerNodeId: 'windows-zdh',
    baseUrl: 'http://127.0.0.1:' + address.port
  });
  await assert.rejects(client.handshake(), /federation request failed/);
});


test('loopback federation performs an approved task round-trip through the governed ledger', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hf-federation-roundtrip-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const ledger = await new TaskLedger(path.join(directory, 'tasks.json')).open();
  const taskContract = {
    SCHEMA: 'heavenzfire.shared-task.v1',
    validateTaskRecord(record) {
      if (!record || record.schema !== this.SCHEMA || typeof record.taskId !== 'string' ||
          typeof record.source !== 'string' || typeof record.goal !== 'string' ||
          !['proposed', 'approved', 'running', 'completed', 'failed', 'review_required', 'rejected'].includes(record.status) ||
          !['pending', 'approved', 'rejected'].includes(record.approvalState) || !Array.isArray(record.evidence)) {
        throw new Error('invalid canonical task record');
      }
      if (['approved', 'running', 'completed'].includes(record.status) && record.approvalState !== 'approved') {
        throw new Error('execution status requires explicit approval state');
      }
      return true;
    }
  };
  const authority = createOperatorApprovalAuthority({
    secret: 'heavenzfire-roundtrip-operator-key-32-bytes',
    clock,
    nonce: () => crypto.randomBytes(32).toString('hex')
  });
  const taskRecord = {
    schema: taskContract.SCHEMA,
    taskId: 'hf-live-shape-roundtrip-001',
    source: 'android-termux',
    goal: 'Return the exact text HF_FEDERATION_TASK_OK',
    status: 'approved',
    approvalState: 'approved',
    evidence: [{
      kind: 'approval',
      summary: 'Operator approved this bounded round-trip test',
      actor: 'operator-zdh',
      observedAt: new Date(now).toISOString()
    }],
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    metadata: { agentId: 'agent-shared', grantId: 'grant-shared', role: 'research' }
  };
  let executions = 0;
  const taskAdapter = createSharedTaskLedgerAdapter({
    ledger,
    contract: taskContract,
    verifyApproval: authority.verifyApproval,
    verifyAttestation: authority.verifyAttestation,
    execute: async ({ canonicalTaskId, prompt }) => {
      executions++;
      return { canonicalTaskId, output: 'HF_FEDERATION_TASK_OK', prompt };
    },
    clock
  });
  const { windows, android } = protocolPair();
  const server = createFederationHttpServer({ protocol: windows, taskAdapter, port: 0, clock });
  const address = await server.listen();
  t.after(() => server.close());
  const client = createFederationHttpClient({
    protocol: android, peerNodeId: 'windows-zdh',
    baseUrl: 'http://127.0.0.1:' + address.port
  });
  const approvalProof = authority.createProof(taskRecord, { actor: 'operator-zdh' });
  await client.handshake();
  const accepted = await client.submitTask(taskRecord, approvalProof);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.taskId, taskRecord.taskId);
  const runtime = createGovernedRuntime({
    ledger,
    workerId: 'windows-governed-worker',
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter: taskAdapter
  });
  const completed = await runtime.runOnce({ now: now });
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.result.output, 'HF_FEDERATION_TASK_OK');
  assert.equal(executions, 1);
  const projection = await taskAdapter.projectToCanonical(taskRecord.taskId);
  assert.equal(projection.canonicalRecord.status, 'completed');
  assert.equal(projection.ledger.status, 'succeeded');
});
