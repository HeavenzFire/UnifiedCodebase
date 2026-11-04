'use strict';

const crypto = require('node:crypto');
const { recordHash } = require('./shared-task-ledger-adapter.cjs');

const SCHEMA = 'heavenzfire.operator-approval.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function hmac(secret, body) {
  return crypto.createHmac('sha256', secret).update(canonical(body)).digest('hex');
}
function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}
function evidenceRef(item) {
  return 'sha256:' + crypto.createHash('sha256').update(canonical(item)).digest('hex');
}

function createApprovalVerifier({ secret = process.env.HF_APPROVAL_HMAC_SECRET, clock = () => Date.now(), nonce = () => crypto.randomBytes(32).toString('hex') } = {}) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('HF_APPROVAL_HMAC_SECRET must contain at least 32 UTF-8 bytes');
  if (typeof clock !== 'function' || typeof nonce !== 'function') throw new Error('clock and nonce must be functions');

  function createApprovalProof(record, { approver, expiresInMs = 60000 } = {}) {
    if (!record || record.schema !== 'heavenzfire.shared-task.v1' || record.status !== 'approved' || record.approvalState !== 'approved') {
      throw new Error('only an approved canonical shared-task record can receive an approval proof');
    }
    if (typeof approver !== 'string' || !ID.test(approver)) throw new Error('approver identity is invalid');
    if (!Number.isInteger(expiresInMs) || expiresInMs < 1000 || expiresInMs > 300000) throw new Error('approval proof lifetime must be 1000..300000 ms');
    const evidence = (record.evidence || []).find(item => item && item.kind === 'approval' && item.actor === approver);
    if (!evidence) throw new Error('canonical approval evidence for this operator is required');
    const now = clock();
    if (!Number.isFinite(now)) throw new Error('clock returned an invalid timestamp');
    const proofNonce = nonce();
    if (typeof proofNonce !== 'string' || !/^[a-f0-9]{64}$/.test(proofNonce)) throw new Error('nonce source must return 32-byte lowercase hex');
    const body = {
      schema: SCHEMA,
      taskId: record.taskId,
      approver,
      evidenceRef: evidenceRef(evidence),
      recordHash: recordHash(record),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + expiresInMs).toISOString(),
      proofIssuedAt: now,
      proofExpiresAt: now + expiresInMs,
      proofNonce
    };
    const signature = hmac(secret, body);
    return Object.freeze({ ...body, signature, proofSignature: signature });
  }

  function verifyApproval({ record, approvalProof, recordHash: expectedHash }) {
    if (!approvalProof || typeof approvalProof !== 'object' || Array.isArray(approvalProof)) return { ok: false };
    const { signature, proofSignature, ...body } = approvalProof;
    const now = clock();
    if (!Number.isFinite(now) || body.schema !== SCHEMA || body.taskId !== record.taskId ||
        body.recordHash !== expectedHash || recordHash(record) !== expectedHash ||
        typeof body.approver !== 'string' || !ID.test(body.approver) ||
        !Number.isFinite(body.proofIssuedAt) || !Number.isFinite(body.proofExpiresAt) ||
        body.proofIssuedAt > now + 30000 || body.proofExpiresAt <= now ||
        body.proofExpiresAt - body.proofIssuedAt > 300000 ||
        typeof body.proofNonce !== 'string' || !/^[a-f0-9]{64}$/.test(body.proofNonce) ||
        typeof body.issuedAt !== 'string' || !Number.isFinite(Date.parse(body.issuedAt)) ||
        typeof body.expiresAt !== 'string' || !Number.isFinite(Date.parse(body.expiresAt))) return { ok: false };
    const evidence = (record.evidence || []).find(item =>
      item && item.kind === 'approval' && item.actor === body.approver && evidenceRef(item) === body.evidenceRef
    );
    if (!evidence) return { ok: false };
    const expectedSignature = hmac(secret, body);
    if (!equalHex(signature, expectedSignature) || !equalHex(proofSignature, expectedSignature)) return { ok: false };
    return {
      ok: true,
      ...body,
      signature,
      proofSignature,
      verifiedAt: new Date(now).toISOString()
    };
  }

  function verifyAttestation({ record, attestation }) {
    if (!attestation || typeof attestation !== 'object' || attestation.taskId !== record.taskId ||
        attestation.recordHash !== recordHash(record) || attestation.proofExpiresAt <= clock()) return { ok: false };
    const {
      schema, taskId, approver, evidenceRef: ref, recordHash: hash,
      issuedAt, expiresAt, proofIssuedAt, proofExpiresAt, proofNonce
    } = attestation;
    const body = {
      schema, taskId, approver, evidenceRef: ref, recordHash: hash,
      issuedAt, expiresAt, proofIssuedAt, proofExpiresAt, proofNonce
    };
    const expected = hmac(secret, body);
    return { ok: equalHex(attestation.signature, expected) && equalHex(attestation.proofSignature, expected) };
  }

  return Object.freeze({ createApprovalProof, verifyApproval, verifyAttestation });
}

module.exports = { SCHEMA, createApprovalVerifier, evidenceRef };
