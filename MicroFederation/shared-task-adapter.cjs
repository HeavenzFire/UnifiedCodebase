'use strict';

const { createHash } = require('node:crypto');

/**
 * Governed adapter between heavenzfire.shared-task.v1 and the durable
 * MicroFederation TaskLedger.
 *
 * This module never treats a proposal, provider response, ledger status, or
 * caller-supplied boolean as approval. The host must inject an approval
 * verifier backed by its trusted approval store/signature policy.
 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_PROMPT = 12000;

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new TypeError(name + ' must be a function');
}
function requireText(value, name, max = 512) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(name + ' must be non-empty text (max ' + max + ')');
  }
  return value.trim();
}
function safeMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const encoded = JSON.stringify(value);
  if (encoded === undefined || encoded.length > 8192) throw new Error('task metadata is invalid or too large');
  return JSON.parse(encoded);
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonicalJson(value[key])
  ).join(',') + '}';
}
function canonicalRecordSha256(record) {
  return createHash('sha256').update(canonicalJson(record), 'utf8').digest('hex');
}
function validateRecord(record, contract) {
  if (!contract || typeof contract.validateTaskRecord !== 'function') {
    throw new TypeError('canonical shared-task contract is required');
  }
  contract.validateTaskRecord(record);
  if (!record || record.schema !== 'heavenzfire.shared-task.v1') throw new Error('unsupported canonical task schema');
  if (!ID.test(record.taskId || '')) throw new Error('canonical taskId is invalid for ledger mapping');
  requireText(record.source, 'canonical source', 128);
  requireText(record.goal, 'canonical goal', MAX_PROMPT);
  if (!Array.isArray(record.evidence)) throw new Error('canonical evidence must be an array');
  return record;
}
function validateAttestation(attestation) {
  if (!attestation || attestation.verified !== true) throw new Error('trusted approval verification failed');
  return Object.freeze({
    actor: requireText(attestation.actor, 'verified approval actor', 128),
    evidenceRef: requireText(attestation.evidenceRef, 'verified approval evidenceRef', 512),
    verifiedAt: requireText(attestation.verifiedAt || new Date().toISOString(), 'verifiedAt', 64)
  });
}

function createSharedTaskAdapter({ ledger, contract, verifyApproval, loadCanonicalTask, execute }) {
  if (!ledger || typeof ledger.create !== 'function' ||
      typeof ledger.claimNext !== 'function' || typeof ledger.start !== 'function' ||
      typeof ledger.complete !== 'function' || typeof ledger.fail !== 'function' ||
      typeof ledger.get !== 'function') {
    throw new TypeError('a compatible durable TaskLedger is required');
  }
  requireFunction(verifyApproval, 'verifyApproval');
  requireFunction(loadCanonicalTask, 'loadCanonicalTask');
  requireFunction(execute, 'execute');
  if (!contract || typeof contract.validateTaskRecord !== 'function') {
    throw new TypeError('canonical shared-task contract is required');
  }

  async function verify(record) {
    validateRecord(record, contract);
    if (record.status !== 'approved' || record.approvalState !== 'approved') {
      throw new Error('task is not explicitly approved in the canonical contract');
    }
    // This trusted callback must verify an attributable approval event against
    // the authoritative approval store or signature; never trust task payload.
    return validateAttestation(await verifyApproval(record));
  }

  async function propose(record) {
    validateRecord(record, contract);
    return Object.freeze({
      status: 'proposal_only',
      taskId: record.taskId,
      queued: false,
      reason: 'Proposals are not executable. Explicit canonical approval and trusted verification are required.'
    });
  }

  async function enqueueApproved(record) {
    const attestation = await verify(record);
    const metadata = safeMetadata(record.metadata);
    const ledgerId = 'shared:' + record.taskId;
    const task = await ledger.create({
      id: ledgerId,
      idempotencyKey: ledgerId,
      requiredCapabilities: ['shared-task.v1'],
      maxAttempts: 3,
      metadata: {
        adapter: 'heavenzfire.shared-task.v1',
        canonicalTaskId: record.taskId,
        canonicalSchema: record.schema,
        canonicalRecordSha256: canonicalRecordSha256(record),
        approvalActor: attestation.actor,
        approvalEvidenceRef: attestation.evidenceRef,
        approvalVerifiedAt: attestation.verifiedAt
      },
      payload: {
        prompt: record.goal,
        role: typeof metadata.role === 'string' && metadata.role.length <= 64 ? metadata.role : 'research',
        source: record.source,
        canonicalTaskId: record.taskId,
        approvalEvidenceRef: attestation.evidenceRef
      }
    });
    return Object.freeze({ status: 'queued', taskId: record.taskId, ledgerTaskId: task.id });
  }

  async function runOne({ workerId, now = Date.now(), leaseMs = 120000 } = {}) {
    requireText(workerId, 'workerId', 128);
    const claimed = await ledger.claimNext(workerId, { now, leaseMs });
    if (!claimed) return { status: 'idle' };
    await ledger.start(claimed.id, workerId, { now });

    try {
      const canonicalId = claimed.metadata && claimed.metadata.canonicalTaskId;
      if (!canonicalId) throw new Error('ledger task is missing canonical task identity');
      const record = await loadCanonicalTask(canonicalId);
      if (canonicalRecordSha256(record) !== claimed.metadata.canonicalRecordSha256) {
        throw new Error('canonical task content changed after enqueue; refusing execution');
      }
      const attestation = await verify(record);
      if (attestation.actor !== claimed.metadata.approvalActor ||
          attestation.evidenceRef !== claimed.metadata.approvalEvidenceRef) {
        throw new Error('canonical approval evidence changed after enqueue; refusing execution');
      }
      const result = await execute({
        taskId: claimed.id,
        canonicalTaskId: canonicalId,
        role: claimed.payload.role,
        prompt: claimed.payload.prompt,
        canonicalRecord: record
      });
      const completed = await ledger.complete(claimed.id, workerId, result, {
        now: Date.now(),
        evidenceRef: 'shared-task:' + canonicalId + ':' + attestation.evidenceRef
      });
      return { status: 'succeeded', taskId: completed.id, result: completed.result };
    } catch (error) {
      const message = String(error && error.message || error).slice(0, 2048);
      const failed = await ledger.fail(claimed.id, workerId, message, {
        now: Date.now(), retryable: false, retryDelayMs: 0
      });
      return { status: 'blocked', taskId: claimed.id, error: message, ledgerStatus: failed.status };
    }
  }

  return Object.freeze({ propose, enqueueApproved, runOne });
}

module.exports = { createSharedTaskAdapter };
