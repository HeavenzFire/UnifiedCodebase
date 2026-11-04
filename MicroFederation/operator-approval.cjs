'use strict';

const crypto = require('node:crypto');
const { recordHash } = require('./shared-task-ledger-adapter.cjs');

const SCHEMA = 'heavenzfire.operator-approval.v1';
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 30000;
const NONCE = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function sign(secret, body) {
  return crypto.createHmac('sha256', secret).update(canonical(body)).digest('hex');
}
function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function approvalEvidence(record, actor) {
  return Array.isArray(record && record.evidence) && record.evidence.some(item =>
    item && item.kind === 'approval' && item.actor === actor &&
    typeof item.summary === 'string' && item.summary.trim() &&
    typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt))
  );
}

function createOperatorApprovalAuthority({ secret, clock = () => Date.now(), nonce = () => crypto.randomBytes(32).toString('hex') } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('operator approval HMAC secret must contain at least 32 UTF-8 bytes');
  }
  if (typeof clock !== 'function' || typeof nonce !== 'function') throw new Error('clock and nonce must be functions');

  function createProof(record, { actor, ttlMs = MAX_TTL_MS } = {}) {
    if (!record || record.schema !== 'heavenzfire.shared-task.v1' ||
        record.status !== 'approved' || record.approvalState !== 'approved') {
      throw new Error('only an approved canonical task can receive an operator proof');
    }
    if (typeof actor !== 'string' || !ID.test(actor) || !approvalEvidence(record, actor)) {
      throw new Error('operator must match attributable canonical approval evidence');
    }
    if (!Number.isInteger(ttlMs) || ttlMs < 60000 || ttlMs > MAX_TTL_MS) throw new Error('approval proof ttlMs must be 60000..86400000');
    const issuedAt = clock();
    if (!Number.isFinite(issuedAt)) throw new Error('clock returned an invalid timestamp');
    const body = {
      schema: SCHEMA,
      taskId: record.taskId,
      actor,
      recordHash: recordHash(record),
      evidenceRef: 'approval:' + record.taskId + ':' + nonce(),
      issuedAt,
      expiresAt: issuedAt + ttlMs,
      nonce: nonce()
    };
    if (!NONCE.test(body.nonce)) throw new Error('nonce source must return 32-byte lowercase hex');
    return Object.freeze({ ...body, signature: sign(secret, body) });
  }

  function validateProof(record, proof, expectedHash) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) throw new Error('operator approval proof is required');
    const { signature, ...body } = proof;
    if (body.schema !== SCHEMA || body.taskId !== record.taskId || body.recordHash !== expectedHash ||
        !ID.test(body.actor || '') || !approvalEvidence(record, body.actor) ||
        typeof body.evidenceRef !== 'string' || !body.evidenceRef.trim() || body.evidenceRef.length > 512 ||
        !NONCE.test(body.nonce || '') || !Number.isFinite(body.issuedAt) || !Number.isFinite(body.expiresAt) ||
        body.expiresAt <= body.issuedAt || body.expiresAt - body.issuedAt > MAX_TTL_MS) {
      throw new Error('operator approval proof claims are invalid');
    }
    const now = clock();
    if (!Number.isFinite(now) || body.issuedAt > now + CLOCK_SKEW_MS ||
        body.issuedAt < now - MAX_TTL_MS - CLOCK_SKEW_MS || body.expiresAt <= now) {
      throw new Error('operator approval proof is expired or outside clock policy');
    }
    if (!equalHex(signature, sign(secret, body))) throw new Error('operator approval proof signature is invalid');
    return body;
  }

  async function verifyApproval({ record, approvalProof, recordHash: expectedHash }) {
    const body = validateProof(record, approvalProof, expectedHash);
    return {
      ok: true,
      approver: body.actor,
      evidenceRef: body.evidenceRef,
      verifiedAt: new Date(clock()).toISOString(),
      recordHash: expectedHash,
      proofIssuedAt: body.issuedAt,
      proofExpiresAt: body.expiresAt,
      proofNonce: body.nonce,
      proofSignature: approvalProof.signature
    };
  }

  async function verifyAttestation({ record, attestation }) {
    const proof = {
      schema: SCHEMA,
      taskId: record.taskId,
      actor: attestation && attestation.approver,
      recordHash: attestation && attestation.recordHash,
      evidenceRef: attestation && attestation.evidenceRef,
      issuedAt: attestation && attestation.proofIssuedAt,
      expiresAt: attestation && attestation.proofExpiresAt,
      nonce: attestation && attestation.proofNonce
    };
    try {
      const body = validateProof(record, { ...proof, signature: attestation && attestation.proofSignature }, recordHash(record));
      return { ok: true, approver: body.actor, evidenceRef: body.evidenceRef };
    } catch {
      return { ok: false };
    }
  }

  return Object.freeze({ createProof, verifyApproval, verifyAttestation });
}

module.exports = { SCHEMA, createOperatorApprovalAuthority, MAX_TTL_MS };
