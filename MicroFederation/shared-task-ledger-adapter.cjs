'use strict';

// Versioned, fail-closed bridge from heavenzfire.shared-task.v1 to the
// process-local MicroFederation task ledger. No approval is inferred.
const crypto = require('node:crypto');

const ADAPTER_SCHEMA = 'heavenzfire.shared-task-ledger-adapter.v1';
const CANONICAL_SCHEMA = 'heavenzfire.shared-task.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

function recordHash(record) {
  return crypto.createHash('sha256').update(canonical(record)).digest('hex');
}

function requireEvidence(record) {
  const evidence = record.evidence.filter(item =>
    item && item.kind === 'approval' &&
    typeof item.summary === 'string' && item.summary.trim() &&
    typeof item.actor === 'string' && ID.test(item.actor) &&
    typeof item.observedAt === 'string' && Number.isFinite(Date.parse(item.observedAt))
  );
  if (evidence.length === 0) throw new Error('canonical record lacks attributable approval evidence');
  return evidence;
}

function validateApprovalResult(result, hash, evidence) {
  if (!result || result.ok !== true) throw new Error('trusted approval verifier denied execution');
  if (typeof result.approver !== 'string' || !ID.test(result.approver)) throw new Error('approval verifier did not identify an approver');
  if (typeof result.evidenceRef !== 'string' || !result.evidenceRef.trim() || result.evidenceRef.length > 512) {
    throw new Error('approval verifier did not return a bounded evidence reference');
  }
  if (!evidence.some(item => item.actor === result.approver)) throw new Error('verified approver does not match canonical approval evidence');
  if (typeof result.verifiedAt !== 'string' || !Number.isFinite(Date.parse(result.verifiedAt))) {
    throw new Error('approval verifier returned an invalid verification time');
  }
  if (result.recordHash !== hash) throw new Error('approval verifier attested a different canonical record');
  return Object.freeze({
    approver: result.approver,
    evidenceRef: result.evidenceRef,
    verifiedAt: result.verifiedAt,
    recordHash: hash
  });
}

function ledgerStatusToCanonical(status) {
  switch (status) {
    case 'queued': return 'approved';
    case 'claimed':
    case 'running': return 'running';
    case 'succeeded': return 'completed';
    case 'failed': return 'failed';
    default: throw new Error('ledger status has no lossless canonical mapping: ' + status);
  }
}

function createSharedTaskLedgerAdapter({ ledger, contract, verifyApproval, verifyAttestation, clock = () => Date.now() }) {
  if (!ledger || typeof ledger.create !== 'function' || typeof ledger.get !== 'function' ||
      typeof ledger.claimNext !== 'function' || typeof ledger.releaseClaim !== 'function') {
    throw new Error('compatible task ledger is required');
  }
  if (!contract || typeof contract.validateTaskRecord !== 'function' || contract.SCHEMA !== CANONICAL_SCHEMA) {
    throw new Error('canonical shared-task contract module is required');
  }
  if (typeof verifyApproval !== 'function' || typeof verifyAttestation !== 'function') {
    throw new Error('trusted verifyApproval and verifyAttestation callbacks are required');
  }
  if (typeof clock !== 'function') throw new Error('clock must be a function');

  async function createFromCanonical(record, { approvalProof, requiredCapabilities = [], maxAttempts = 3, idempotencyKey = record && record.taskId } = {}) {
    contract.validateTaskRecord(record);
    if (record.schema !== CANONICAL_SCHEMA) throw new Error('unsupported canonical task schema');
    if (record.status !== 'approved' || record.approvalState !== 'approved') {
      throw new Error('only explicitly approved canonical tasks may enter the execution ledger');
    }
    const approvalEvidence = requireEvidence(record);
    const hash = recordHash(record);
    const verified = await verifyApproval({ record, approvalProof, recordHash: hash });
    const attestation = validateApprovalResult(verified, hash, approvalEvidence);
    const now = clock();
    if (!Number.isFinite(now)) throw new Error('clock returned an invalid timestamp');

    const metadata = {
      heavenzfireSharedTaskAdapter: {
        schema: ADAPTER_SCHEMA,
        canonicalRecord: record,
        approvalAttestation: attestation
      }
    };
    return ledger.create({
      id: record.taskId,
      payload: { prompt: record.goal, source: record.source },
      requiredCapabilities,
      maxAttempts,
      idempotencyKey,
      metadata
    }, { now });
  }

  async function authorizeExecution(task) {
    if (!task || typeof task !== 'object' || !ID.test(task.id || '')) throw new Error('ledger task is malformed');
    const envelope = task.metadata && task.metadata.heavenzfireSharedTaskAdapter;
    if (!envelope || envelope.schema !== ADAPTER_SCHEMA) throw new Error('task was not created by the canonical adapter');
    const record = envelope.canonicalRecord;
    contract.validateTaskRecord(record);
    if (record.schema !== CANONICAL_SCHEMA || record.taskId !== task.id ||
        record.status !== 'approved' || record.approvalState !== 'approved') {
      throw new Error('canonical approval state or task identity is invalid');
    }
    const evidence = requireEvidence(record);
    const hash = recordHash(record);
    const attestation = envelope.approvalAttestation;
    if (!attestation || attestation.recordHash !== hash ||
        !evidence.some(item => item.actor === attestation.approver) ||
        typeof attestation.evidenceRef !== 'string' || !attestation.evidenceRef.trim() ||
        typeof attestation.verifiedAt !== 'string' || !Number.isFinite(Date.parse(attestation.verifiedAt))) {
      throw new Error('stored approval attestation is malformed or does not match the canonical record');
    }
    const result = await verifyAttestation({ record, attestation });
    if (!result || result.ok !== true) throw new Error('trusted approval attestation verification failed');
    return Object.freeze({ authorized: true, taskId: task.id, approver: attestation.approver, evidenceRef: attestation.evidenceRef, recordHash: hash });
  }

  async function claimNextApproved(workerId, options = {}) {
    const task = await ledger.claimNext(workerId, options);
    if (!task) return { status: 'idle' };
    try {
      const authorization = await authorizeExecution(task);
      return { status: 'claimed', task, authorization };
    } catch (error) {
      await ledger.releaseClaim(task.id, workerId, {
        now: Number.isFinite(options.now) ? options.now : clock(),
        reason: 'canonical approval gate denied: ' + String(error.message || error).slice(0, 400)
      });
      return { status: 'blocked', taskId: task.id, reason: String(error.message || error) };
    }
  }

  async function projectToCanonical(taskOrId) {
    const task = typeof taskOrId === 'string' ? await ledger.get(taskOrId) : taskOrId;
    if (!task) return null;
    const envelope = task.metadata && task.metadata.heavenzfireSharedTaskAdapter;
    if (!envelope || envelope.schema !== ADAPTER_SCHEMA) throw new Error('task has no canonical adapter envelope');
    const record = envelope.canonicalRecord;
    contract.validateTaskRecord(record);
    if (record.taskId !== task.id) throw new Error('canonical task identity does not match ledger identity');
    const status = ledgerStatusToCanonical(task.status);
    const projected = {
      schema: record.schema,
      taskId: record.taskId,
      source: record.source,
      goal: record.goal,
      status,
      approvalState: 'approved',
      evidence: record.evidence.slice(),
      createdAt: record.createdAt,
      updatedAt: task.updatedAt,
      metadata: record.metadata
    };
    contract.validateTaskRecord(projected);
    return Object.freeze({
      schema: ADAPTER_SCHEMA,
      canonicalRecord: projected,
      ledger: {
        status: task.status,
        attempts: task.attempts,
        maxAttempts: task.maxAttempts,
        idempotencyKey: task.idempotencyKey,
        payloadHash: task.payloadHash,
        events: task.events,
        evidence: task.evidence,
        result: task.result,
        error: task.error
      }
    });
  }

  return Object.freeze({ createFromCanonical, authorizeExecution, claimNextApproved, projectToCanonical });
}

module.exports = { ADAPTER_SCHEMA, createSharedTaskLedgerAdapter, recordHash };
