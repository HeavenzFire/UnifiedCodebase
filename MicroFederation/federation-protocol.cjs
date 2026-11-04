'use strict';

// HeavenzFire Cross-Device Federation protocol core v0.1.
// Transport is supplied by the caller (SSH/private overlay); this module never opens sockets.
const crypto = require('node:crypto');

const PROTOCOL = 'heavenzfire.federation.v1';
const NONCE = /^[a-f0-9]{64}$/;
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9._-]{0,63}$/;
const MAX_CLOCK_SKEW_MS = 30000;
const MAX_HANDSHAKE_TTL_MS = 30000;
const REPLAY_TTL_MS = 300000;
const MAX_REPLAY_ENTRIES = 4096;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function signature(secret, value) {
  return crypto.createHmac('sha256', secret).update(canonical(value)).digest('hex');
}

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

function validateCapabilities(value, field) {
  if (!Array.isArray(value) || value.length > 32 || value.some(x => typeof x !== 'string' || !CAPABILITY.test(x))) {
    throw new Error(field + ' must be an array of up to 32 capability slugs');
  }
  return [...new Set(value)].sort();
}

function signed(secret, body) {
  return Object.freeze({ ...body, signature: signature(secret, body) });
}

function verifySignature(secret, message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  const { signature: supplied, ...body } = message;
  return safeEqualHex(supplied, signature(secret, body));
}

function createFederationProtocol({ nodeId, capabilities = [], peers = [], clock = () => Date.now(), nonce = () => crypto.randomBytes(32).toString('hex') }) {
  if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) throw new Error('nodeId is invalid');
  if (typeof clock !== 'function' || typeof nonce !== 'function') throw new Error('clock and nonce must be functions');
  const localCapabilities = validateCapabilities(capabilities, 'capabilities');
  const peerMap = new Map();
  const replay = new Map();

  for (const peer of peers) {
    if (!peer || typeof peer !== 'object' || !NODE_ID.test(peer.nodeId || '') || peer.nodeId === nodeId) throw new Error('peer nodeId is invalid');
    if (typeof peer.secret !== 'string' || Buffer.byteLength(peer.secret, 'utf8') < 32) throw new Error('peer secret must contain at least 32 UTF-8 bytes');
    if (peer.approved !== true || typeof peer.approvedAt !== 'string' || !Number.isFinite(Date.parse(peer.approvedAt))) throw new Error('peer requires an explicit operator-approved enrollment record');
    if (peerMap.has(peer.nodeId)) throw new Error('duplicate peer identity');
    peerMap.set(peer.nodeId, Object.freeze({
      nodeId: peer.nodeId,
      secret: peer.secret,
      allowedCapabilities: validateCapabilities(peer.allowedCapabilities || [], 'peer.allowedCapabilities'),
      approved: true,
      approvedAt: peer.approvedAt,
      revokedAt: peer.revokedAt || null
    }));
  }

  function getActivePeer(id) {
    const peer = peerMap.get(id);
    if (!peer) throw new Error('unknown peer identity');
    if (!peer.approved || peer.revokedAt) throw new Error('peer enrollment is revoked or not approved');
    return peer;
  }

  function pruneReplay(now) {
    for (const [key, expiresAt] of replay) if (expiresAt <= now) replay.delete(key);
    while (replay.size > MAX_REPLAY_ENTRIES) replay.delete(replay.keys().next().value);
  }

  function createHello(targetNodeId, requestedCapabilities = []) {
    const peer = getActivePeer(targetNodeId);
    const requested = validateCapabilities(requestedCapabilities, 'requestedCapabilities');
    if (requested.some(cap => !localCapabilities.includes(cap))) throw new Error('requested capability is not declared locally');
    const now = clock();
    if (!Number.isFinite(now)) throw new Error('clock returned an invalid timestamp');
    const body = {
      protocol: PROTOCOL,
      type: 'hello',
      from: nodeId,
      to: peer.nodeId,
      nonce: nonce(),
      requestedCapabilities: requested,
      issuedAt: now,
      expiresAt: now + 10000
    };
    if (!NONCE.test(body.nonce)) throw new Error('nonce source must return 32-byte lowercase hex');
    return signed(peer.secret, body);
  }

  function acceptHello(hello) {
    if (!hello || typeof hello !== 'object' || Array.isArray(hello)) throw new Error('hello must be an object');
    const peer = getActivePeer(hello.from);
    if (!verifySignature(peer.secret, hello)) throw new Error('hello authentication failed');
    if (hello.protocol !== PROTOCOL || hello.type !== 'hello' || hello.to !== nodeId) throw new Error('protocol or target mismatch');
    if (!NONCE.test(hello.nonce)) throw new Error('hello nonce is invalid');
    const now = clock();
    if (!Number.isFinite(hello.issuedAt) || !Number.isFinite(hello.expiresAt) ||
        hello.issuedAt > now + MAX_CLOCK_SKEW_MS || hello.issuedAt < now - MAX_CLOCK_SKEW_MS ||
        hello.expiresAt <= now || hello.expiresAt - hello.issuedAt > MAX_HANDSHAKE_TTL_MS) {
      throw new Error('hello is expired or outside clock-skew policy');
    }
    pruneReplay(now);
    const replayKey = peer.nodeId + ':' + hello.nonce;
    if (replay.has(replayKey)) throw new Error('replayed handshake nonce');
    replay.set(replayKey, hello.expiresAt + REPLAY_TTL_MS);
    const requested = validateCapabilities(hello.requestedCapabilities, 'hello.requestedCapabilities');
    const allowed = new Set(peer.allowedCapabilities);
    const local = new Set(localCapabilities);
    const granted = requested.filter(cap => allowed.has(cap) && local.has(cap));
    if (granted.length !== requested.length) throw new Error('requested capability is not authorized by enrollment');
    const ackBody = {
      protocol: PROTOCOL,
      type: 'hello_ack',
      from: nodeId,
      to: peer.nodeId,
      echoNonce: hello.nonce,
      nonce: nonce(),
      grantedCapabilities: granted,
      issuedAt: now,
      expiresAt: Math.min(hello.expiresAt, now + 60000)
    };
    if (!NONCE.test(ackBody.nonce)) throw new Error('nonce source must return 32-byte lowercase hex');
    return signed(peer.secret, ackBody);
  }

  function verifyAck(ack, expectedPeerId, hello) {
    const peer = getActivePeer(expectedPeerId);
    if (!verifySignature(peer.secret, ack)) throw new Error('ack authentication failed');
    if (ack.protocol !== PROTOCOL || ack.type !== 'hello_ack' || ack.from !== peer.nodeId || ack.to !== nodeId) throw new Error('ack identity or protocol mismatch');
    if (!hello || hello.protocol !== PROTOCOL || hello.from !== nodeId || hello.to !== peer.nodeId || ack.echoNonce !== hello.nonce) throw new Error('ack nonce echo mismatch');
    if (!NONCE.test(ack.nonce)) throw new Error('ack nonce is invalid');
    const now = clock();
    if (!Number.isFinite(ack.issuedAt) || !Number.isFinite(ack.expiresAt) ||
        ack.issuedAt > now + MAX_CLOCK_SKEW_MS || ack.issuedAt < now - MAX_CLOCK_SKEW_MS || ack.expiresAt <= now) {
      throw new Error('ack is expired or outside clock-skew policy');
    }
    const granted = validateCapabilities(ack.grantedCapabilities, 'ack.grantedCapabilities');
    const requested = new Set(hello.requestedCapabilities);
    if (granted.some(cap => !requested.has(cap))) throw new Error('peer granted an unrequested capability');
    return Object.freeze({
      state: 'AUTHENTICATED',
      protocol: PROTOCOL,
      localNodeId: nodeId,
      peerNodeId: peer.nodeId,
      grantedCapabilities: granted,
      sessionExpiresAt: ack.expiresAt
    });
  }

  function signPeerMessage(targetNodeId, body) {
    const peer = getActivePeer(targetNodeId);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.prototype.hasOwnProperty.call(body, 'signature')) {
      throw new Error('peer message body must be an unsigned object');
    }
    return signed(peer.secret, body);
  }

  function verifyPeerMessage(sourceNodeId, message) {
    const peer = getActivePeer(sourceNodeId);
    return verifySignature(peer.secret, message);
  }

  function revokePeer(peerNodeId, revokedAt = new Date(clock()).toISOString()) {
    const peer = peerMap.get(peerNodeId);
    if (!peer) throw new Error('unknown peer identity');
    peerMap.set(peerNodeId, Object.freeze({ ...peer, revokedAt }));
    return Object.freeze({ nodeId: peerNodeId, state: 'REVOKED', revokedAt });
  }

  return Object.freeze({ nodeId, capabilities: Object.freeze(localCapabilities), createHello, acceptHello, verifyAck, signPeerMessage, verifyPeerMessage, revokePeer });
}

module.exports = { PROTOCOL, createFederationProtocol };
