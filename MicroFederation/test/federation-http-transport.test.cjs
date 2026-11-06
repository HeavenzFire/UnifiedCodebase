'use strict';

const nodeTest = require('node:test');
const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);
const assert = require('node:assert/strict');
const { createFederationProtocol } = require('../federation-protocol.cjs');
const { createFederationHttpServer } = require('../federation-http-server.cjs');
const { createFederationHttpClient } = require('../federation-http-client.cjs');

const SECRET = 'cross-device-test-secret-with-at-least-32-bytes';
const APPROVED_AT = '2026-11-04T00:00:00.000Z';
let nonceCounter = 0;
const nonce = () => (++nonceCounter).toString(16).padStart(64, '0');
const clock = () => Date.parse('2026-11-04T12:00:00.000Z');

function protocolPair({ serverCapabilities = ['task.submit', 'task.read'], clientCapabilities = ['task.submit', 'task.read'], secret = SECRET } = {}) {
  const server = createFederationProtocol({
    nodeId: 'windows-zdh', capabilities: serverCapabilities, clock, nonce,
    peers: [{ nodeId: 'android-a67l', secret, approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['task.submit', 'task.read'] }]
  });
  const client = createFederationProtocol({
    nodeId: 'android-a67l', capabilities: clientCapabilities, clock, nonce,
    peers: [{ nodeId: 'windows-zdh', secret, approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['task.submit', 'task.read'] }]
  });
  return { server, client };
}

async function startServer(options = {}) {
  const pair = protocolPair(options);
  const received = [];
  const taskAdapter = {
    async createFromCanonical(record, opts) {
      received.push({ record, opts });
      if (opts.approvalProof !== 'explicit-test-approval') throw new Error('approval denied');
      return { id: record.taskId, status: 'queued' };
    },
    async projectToCanonical(taskId) {
      const item = received.find(entry => entry.record.taskId === taskId);
      return item ? { schema: 'heavenzfire.shared-task-ledger-adapter.v1', canonicalRecord: item.record, ledger: { status: 'queued' } } : null;
    }
  };
  const runtime = createFederationHttpServer({
    protocol: pair.server,
    taskAdapter,
    clock,
    port: 0,
    authorizeTaskRead: async ({ peerId, taskId }) => ({
      allow: peerId === 'android-a67l' && taskId === record.taskId
    })
  });
  const address = await runtime.listen();
  const client = createFederationHttpClient({
    protocol: pair.client,
    peerNodeId: 'windows-zdh',
    baseUrl: 'http://127.0.0.1:' + address.port
  });
  return { serverProtocol: pair.server, clientProtocol: pair.client, runtime, client, address, received };
}

const record = {
  schema: 'heavenzfire.shared-task.v1',
  taskId: 'remote-task-001',
  source: 'android-command-center',
  goal: 'Return the exact bounded acknowledgement HF_REMOTE_TASK_OK',
  status: 'approved',
  approvalState: 'approved',
  evidence: [{ kind: 'approval', summary: 'Explicit test approval', actor: 'operator-zdh', observedAt: APPROVED_AT }],
  createdAt: APPROVED_AT,
  updatedAt: APPROVED_AT,
  metadata: { test: true }
};

test('HTTP binding listens on loopback only and exposes health without publishing service externally', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  const response = await fetch('http://127.0.0.1:' + f.address.port + '/health');
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.bind, '127.0.0.1');
  assert.throws(() => createFederationHttpServer({ protocol: f.server, taskAdapter: { createFromCanonical() {} }, host: '0.0.0.0' }), /127.0.0.1 only/);
});

test('authenticated handshake permits a signed task submit only with task.submit capability', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  await f.client.handshake(['task.submit']);
  const result = await f.client.submitTask(record, 'explicit-test-approval');
  assert.equal(result.ok, true);
  assert.equal(result.taskId, record.taskId);
  assert.equal(result.status, 'queued');
  assert.equal(f.received.length, 1);
});

test('task submission requires a handshake and negotiated capability', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  await assert.rejects(f.client.submitTask(record, 'explicit-test-approval'), /handshake is required/);
  await f.client.handshake([]);
  await assert.rejects(f.client.submitTask(record, 'explicit-test-approval'), /lacks task.submit/);
  assert.equal(f.received.length, 0);
});

test('server rejects unsigned or tampered task messages', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  await f.client.handshake(['task.submit']);
  const session = f.client.getSession();
  const forged = {
    protocol: 'heavenzfire.federation.v1', type: 'task_submit',
    sessionNonce: session.nonce, taskRecord: record, approvalProof: 'explicit-test-approval',
    signature: '0'.repeat(64)
  };
  const response = await fetch('http://127.0.0.1:' + f.address.port + '/v1/tasks', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(forged)
  });
  assert.equal(response.status, 401);
  assert.equal(f.received.length, 0);
});

test('task submission still passes explicit approval proof to the canonical adapter', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  await f.client.handshake(['task.submit']);
  await assert.rejects(f.client.submitTask(record, 'not-approved'), /approval denied/);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0].opts.approvalProof, 'not-approved');
});


test('authenticated task.read returns a canonical projection after submission', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  await f.client.handshake(['task.submit', 'task.read']);
  await f.client.submitTask(record, 'explicit-test-approval');
  const result = await f.client.getTask(record.taskId);
  assert.equal(result.ok, true);
  assert.equal(result.projection.canonicalRecord.taskId, record.taskId);
  assert.equal(result.projection.ledger.status, 'queued');
});

test('task retrieval is denied without task.read capability', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  await f.client.handshake(['task.submit']);
  await assert.rejects(f.client.getTask(record.taskId), /lacks task.read/);
});

test('client refuses non-loopback and non-HTTP endpoints', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  assert.throws(() => createFederationHttpClient({
    protocol: f.clientProtocol, peerNodeId: 'windows-zdh', baseUrl: 'http://192.0.2.1:18100'
  }), /loopback URLs only/);
  assert.throws(() => createFederationHttpClient({
    protocol: f.clientProtocol, peerNodeId: 'windows-zdh', baseUrl: 'https://127.0.0.1:18100'
  }), /must use HTTP inside the SSH tunnel/);
});

test('client disables redirects for signed federation payloads', async () => {
  const pair = protocolPair();
  let requestOptions;
  const client = createFederationHttpClient({
    protocol: pair.client,
    peerNodeId: 'windows-zdh',
    baseUrl: 'http://127.0.0.1:18100',
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(JSON.stringify({ ok: false, error: 'test-denied' }), {
        status: 400,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  await assert.rejects(client.handshake(['task.submit']), /test-denied/);
  assert.equal(requestOptions.redirect, 'error');
  assert.equal(requestOptions.cache, 'no-store');
});

test('client rejects localhost aliases and credential-bearing loopback URLs', async t => {
  const f = await startServer(); t.after(() => f.runtime.close());
  assert.throws(() => createFederationHttpClient({
    protocol: f.client, peerNodeId: 'windows-zdh', baseUrl: 'http://localhost:18100'
  }), /numeric loopback URLs only/);
  assert.throws(() => createFederationHttpClient({
    protocol: f.client, peerNodeId: 'windows-zdh', baseUrl: 'http://user:pass@127.0.0.1:18100'
  }), /credentials are not allowed/);
});
