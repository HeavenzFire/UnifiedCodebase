'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PROTOCOL, createFederationProtocol } = require('../federation-protocol.cjs');

const SECRET = 'heavenzfire-test-shared-secret-32-bytes-minimum';
const APPROVED_AT = '2026-11-04T00:00:00.000Z';
let time = Date.parse('2026-11-04T12:00:00.000Z');
let counter = 0;
const clock = () => time;
const nonce = () => (++counter).toString(16).padStart(64, '0');

function pair() {
  const a = createFederationProtocol({
    nodeId: 'windows-zdh', capabilities: ['inference.invoke', 'task.receive'], clock, nonce,
    peers: [{ nodeId: 'android-a67l', secret: SECRET, approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['inference.invoke', 'task.receive'] }]
  });
  const b = createFederationProtocol({
    nodeId: 'android-a67l', capabilities: ['inference.invoke', 'task.receive'], clock, nonce,
    peers: [{ nodeId: 'windows-zdh', secret: SECRET, approved: true, approvedAt: APPROVED_AT, allowedCapabilities: ['inference.invoke', 'task.receive'] }]
  });
  return { a, b };
}

test('authenticated handshake echoes nonce and negotiates only requested capabilities', () => {
  const { a, b } = pair();
  const hello = a.createHello('android-a67l', ['inference.invoke']);
  const ack = b.acceptHello(hello);
  const session = a.verifyAck(ack, 'android-a67l', hello);
  assert.equal(session.state, 'AUTHENTICATED');
  assert.equal(session.protocol, PROTOCOL);
  assert.deepEqual(session.grantedCapabilities, ['inference.invoke']);
});

test('rejects a forged message signature', () => {
  const { a, b } = pair();
  const hello = a.createHello('android-a67l', ['inference.invoke']);
  assert.throws(() => b.acceptHello({ ...hello, from: 'attacker' }), /authentication failed/);
});

test('rejects a replayed handshake nonce', () => {
  const { a, b } = pair();
  const hello = a.createHello('android-a67l', ['inference.invoke']);
  b.acceptHello(hello);
  assert.throws(() => b.acceptHello(hello), /replayed handshake nonce/);
});

test('rejects expired and excessive-lifetime handshakes', () => {
  const { a, b } = pair();
  const hello = a.createHello('android-a67l', ['inference.invoke']);
  time += 11000;
  assert.throws(() => b.acceptHello(hello), /expired/);
});

test('rejects capability escalation at the receiving node', () => {
  const { a, b } = pair();
  const hello = a.createHello('android-a67l', ['inference.invoke']);
  const escalated = { ...hello, requestedCapabilities: ['task.admin'] };
  const { signature, ...body } = escalated;
  const crypto = require('node:crypto');
  escalated.signature = crypto.createHmac('sha256', SECRET).update((function canonical(v) {
    if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
    return JSON.stringify(v);
  })(body)).digest('hex');
  assert.throws(() => b.acceptHello(escalated), /not authorized/);
});

test('rejects unapproved and revoked peers', () => {
  assert.throws(() => createFederationProtocol({
    nodeId: 'windows-zdh', capabilities: [], clock, nonce,
    peers: [{ nodeId: 'android-a67l', secret: SECRET, approved: false, approvedAt: APPROVED_AT }]
  }), /explicit operator-approved/);
  const { a } = pair();
  a.revokePeer('android-a67l');
  assert.throws(() => a.createHello('android-a67l'), /revoked/);
});

test('rejects an ack that does not echo the initiating nonce', () => {
  const { a, b } = pair();
  const hello = a.createHello('android-a67l', ['inference.invoke']);
  const ack = b.acceptHello(hello);
  assert.throws(() => a.verifyAck({ ...ack, echoNonce: 'f'.repeat(64) }, 'android-a67l', hello), /ack authentication failed/);
});
