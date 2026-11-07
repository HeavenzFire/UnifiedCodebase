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
  // Hash immutable approved task content, not lifecycle status or appended evidence.
  const snapshot = {
    schema: record.schema,
    taskId: record.taskId,
    source: record.source,
    goal: record.goal,
    approvalState: record.approvalState,
    metadata: safeMetadata(record.metadata)
  };
  return createHash('sha256').update(canonicalJson(snapshot), 'utf8').digest('hex');
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
    const ledgerId = 'shared:' + createHash('sha256').update(record.taskId, 'utf8').digest('hex');
    const task = await ledger.create({
      id: ledgerId,
      idempotencyKey: ledgerId,
      requiredCapabilities: ['shared-task.v1'],
      maxAttempts: 3,
      metadata: {
        adapter: 'heavenzfire.shared-task.v1',
        agentId: typeof metadata.agentId === 'string' ? metadata.agentId : null,
        grantId: typeof metadata.grantId === 'string' ? metadata.grantId : null,
        action: typeof metadata.action === 'string' ? metadata.action : 'shared-task.execute',
        approvalRequestId: typeof metadata.approvalRequestId === 'string' ? metadata.approvalRequestId : null,
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

  // GovernedRuntime owns claim/start/complete/fail. This adapter only
  // revalidates the canonical task and trusted approval, then performs work.
  async function run({ taskId, role, prompt } = {}) {
    requireText(taskId, 'ledger taskId', 128);
    const task = await ledger.get(taskId);
    if (!task || task.status !== 'running') {
      throw Object.assign(new Error('shared task must be running under the governed supervisor'), { policyDenied: true });
    }
    const metadata = task.metadata || {};
    if (metadata.adapter !== 'heavenzfire.shared-task.v1' ||
        typeof metadata.canonicalTaskId !== 'string' ||
        typeof metadata.canonicalRecordSha256 !== 'string') {
      throw Object.assign(new Error('ledger task is missing canonical shared-task metadata'), { policyDenied: true });
    }
    const record = await loadCanonicalTask(metadata.canonicalTaskId);
    try {
      validateRecord(record, contract);
      if (canonicalRecordSha256(record) !== metadata.canonicalRecordSha256) {
        throw new Error('canonical task content changed after enqueue; refusing execution');
      }
      const attestation = await verify(record);
      if (attestation.actor !== metadata.approvalActor ||
          attestation.evidenceRef !== metadata.approvalEvidenceRef) {
        throw new Error('canonical approval evidence changed after enqueue; refusing execution');
      }
      if (prompt !== task.payload.prompt || prompt !== record.goal ||
          role !== task.payload.role) {
        throw new Error('governed task payload does not match its approved canonical record');
      }
    } catch (error) {
      error.policyDenied = true;
      throw error;
    }
    return execute({
      taskId,
      canonicalTaskId: metadata.canonicalTaskId,
      role,
      prompt,
      canonicalRecord: record
    });
  }


  async function projectLedgerState(canonicalRecord, ledgerRecordRef) {
    validateRecord(canonicalRecord, contract);
    const ledgerTaskId = typeof ledgerRecordRef === 'string'
      ? ledgerRecordRef
      : ledgerRecordRef && ledgerRecordRef.id;
    requireText(ledgerTaskId, 'ledger task ID', 128);

    const expectedLedgerId = 'shared:' +
      createHash('sha256').update(canonicalRecord.taskId, 'utf8').digest('hex');
    if (ledgerTaskId !== expectedLedgerId) {
      throw new Error('ledger task ID does not match canonical task identity');
    }

    // Never trust caller-supplied status, owner, metadata, or events. Re-read
    // the authoritative ledger record and derive the projection from it.
    const authoritative = await ledger.get(ledgerTaskId);
    if (!authoritative || authoritative.id !== ledgerTaskId) {
      throw new Error('authoritative shared-task ledger record was not found');
    }
    const metadata = authoritative.metadata || {};
    if (metadata.adapter !== 'heavenzfire.shared-task.v1' ||
        metadata.canonicalTaskId !== canonicalRecord.taskId) {
      throw new Error('canonical and authoritative ledger task identities do not match');
    }
    if (metadata.canonicalRecordSha256 !== canonicalRecordSha256(canonicalRecord)) {
      throw new Error('canonical task content changed after enqueue; refusing lifecycle projection');
    }

    const mapping = {
      queued: 'approved',
      claimed: 'running',
      running: 'running',
      succeeded: 'completed',
      failed: 'failed',
      cancelled: 'review_required'
    };
    const target = mapping[authoritative.status];
    if (!target) throw new Error('unsupported ledger lifecycle status: ' + authoritative.status);
    if (canonicalRecord.approvalState !== 'approved' ||
        !['approved', 'running', 'completed', 'failed', 'review_required'].includes(canonicalRecord.status)) {
      throw new Error('canonical task is not in an approved lifecycle state');
    }
    if (target === 'approved') {
      if (canonicalRecord.status !== 'approved') throw new Error('queued ledger state conflicts with canonical state');
      return Object.freeze({ status: 'unchanged', canonicalRecord, ledgerStatus: authoritative.status });
    }
    if (canonicalRecord.status === target) {
      return Object.freeze({ status: 'unchanged', canonicalRecord, ledgerStatus: authoritative.status });
    }
    if (['completed', 'failed', 'review_required'].includes(canonicalRecord.status)) {
      throw new Error('terminal canonical state conflicts with ledger status');
    }

    const lastEvent = Array.isArray(authoritative.events)
      ? [...authoritative.events].reverse().find(event => event && typeof event.actor === 'string' && event.actor.trim())
      : null;
    const projectionActor = requireText(authoritative.owner || (lastEvent && lastEvent.actor),
      'authoritative ledger event actor', 128);
    const makeEvidence = summary => ({
      kind: 'ledger-lifecycle',
      summary,
      sourceUrl: null
    });
    let projected = canonicalRecord;
    const transition = (nextStatus, summary) => {
      if (typeof contract.transitionTask !== 'function') {
        throw new TypeError('canonical transitionTask function is required for lifecycle projection');
      }
      projected = contract.transitionTask(projected, nextStatus, {
        actor: projectionActor,
        evidenceItem: makeEvidence(summary)
      });
    };

    if (target === 'running') {
      if (projected.status === 'approved') transition('running', 'Ledger task ' + authoritative.status);
    } else if (target === 'completed') {
      if (projected.status === 'approved') transition('running', 'Ledger task entered execution');
      if (projected.status !== 'running') throw new Error('ledger success cannot follow canonical status ' + projected.status);
      transition('completed', 'Ledger task succeeded');
    } else if (target === 'failed') {
      if (projected.status === 'approved') transition('running', 'Ledger task entered execution');
      if (projected.status !== 'running') throw new Error('ledger failure cannot follow canonical status ' + projected.status);
      transition('failed', 'Ledger task failed');
    } else if (target === 'review_required') {
      if (!['approved', 'running'].includes(projected.status)) {
        throw new Error('ledger cancellation cannot follow canonical status ' + projected.status);
      }
      transition('review_required', 'Ledger task cancelled; operator review required');
    }

    return Object.freeze({ status: 'projected', canonicalRecord: projected, ledgerStatus: authoritative.status });
  }


  return Object.freeze({ propose, enqueueApproved, run, projectLedgerState });
}

module.exports = { createSharedTaskAdapter };
