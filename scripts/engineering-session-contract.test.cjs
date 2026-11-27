'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  validateEngineeringSession,
  validateEngineeringSessions,
  parseEngineeringSessionJsonl,
  summarizeEngineeringSessions
} = require('./engineering-session-contract.cjs');

const SHA = 'a'.repeat(40);

function baseRecord(overrides = {}) {
  return {
    schema_version: '1.0',
    session_id: 'session-20261127-001',
    task_ref: 'issue-52-session-log-integrity-01',
    change_ref: 'change-issue-52-session-log-integrity-01',
    workstream: 'benchmark',
    recorded_at_utc: '2026-11-27T03:00:00Z',
    started_at_utc: null,
    ended_at_utc: null,
    outcome: 'blocked',
    result_kind: 'blocker',
    risk_class: 'routine',
    human_active_minutes: null,
    ai_tool_elapsed_minutes: null,
    rework_minutes: null,
    first_pass_gate_pass: null,
    contributor_ref: null,
    commit_sha: null,
    acceptance: null,
    ...overrides
  };
}

function acceptedCapability(overrides = {}) {
  const record = baseRecord({
    outcome: 'accepted',
    result_kind: 'capability',
    human_active_minutes: 45,
    ai_tool_elapsed_minutes: 12,
    rework_minutes: 5,
    first_pass_gate_pass: false,
    contributor_ref: 'actor_1111111111111111',
    commit_sha: SHA,
    acceptance: {
      ci_run_url: 'https://github.com/HeavenzFire/UnifiedCodebase/actions/runs/123456789',
      ci_head_sha: SHA,
      ci_conclusion: 'success',
      review_url: 'https://github.com/HeavenzFire/UnifiedCodebase/pull/52#pullrequestreview-123456789',
      reviewed_sha: SHA,
      review_state: 'APPROVED',
      reviewer_ref: 'actor_2222222222222222'
    }
  });
  return { ...record, ...overrides };
}

test('accepts a blocked session with unknown time values explicitly null', () => {
  const result = validateEngineeringSession(baseRecord());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('timestamps do not infer human or tool time', () => {
  const record = baseRecord({
    started_at_utc: '2026-11-27T02:00:00Z',
    ended_at_utc: '2026-11-27T03:00:00Z'
  });
  const summary = summarizeEngineeringSessions([record]);
  assert.equal(summary.humanActiveMinutes.recordedTotal, 0);
  assert.equal(summary.humanActiveMinutes.missingSessions, 1);
  assert.equal(summary.humanActiveMinutes.complete, false);
  assert.equal(summary.aiToolElapsedMinutes.recordedTotal, 0);
  assert.equal(summary.aiToolElapsedMinutes.missingSessions, 1);
});

test('accepts structurally consistent accepted-capability evidence', () => {
  const result = validateEngineeringSession(acceptedCapability());
  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test('requires acceptance evidence for an accepted capability', () => {
  const result = validateEngineeringSession(baseRecord({ outcome: 'accepted', result_kind: 'capability' }));
  assert.ok(result.errors.includes('accepted_capability_requires_acceptance'));
});

test('requires CI and review to bind to the exact artifact commit', () => {
  const record = acceptedCapability();
  record.acceptance.ci_head_sha = 'b'.repeat(40);
  record.acceptance.reviewed_sha = 'c'.repeat(40);
  const result = validateEngineeringSession(record);
  assert.ok(result.errors.includes('acceptance_ci_sha_mismatch'));
  assert.ok(result.errors.includes('acceptance_review_sha_mismatch'));
});

test('rejects an unsuccessful CI conclusion', () => {
  const record = acceptedCapability();
  record.acceptance.ci_conclusion = 'failure';
  assert.ok(validateEngineeringSession(record).errors.includes('acceptance_ci_not_success'));
});

test('rejects a review that is not approved', () => {
  const record = acceptedCapability();
  record.acceptance.review_state = 'COMMENTED';
  assert.ok(validateEngineeringSession(record).errors.includes('acceptance_review_not_approved'));
});

test('rejects self-review using the same contributor and reviewer reference', () => {
  const record = acceptedCapability();
  record.acceptance.reviewer_ref = record.contributor_ref;
  assert.ok(validateEngineeringSession(record).errors.includes('acceptance_reviewer_not_independent'));
});

test('rejects non-canonical CI and review URLs, including query strings', () => {
  const ciRecord = acceptedCapability();
  ciRecord.acceptance.ci_run_url += '?token=synthetic';
  assert.ok(validateEngineeringSession(ciRecord).errors.includes('acceptance_invalid_ci_url'));

  const reviewRecord = acceptedCapability();
  reviewRecord.acceptance.review_url += '?email=synthetic';
  assert.ok(validateEngineeringSession(reviewRecord).errors.includes('acceptance_invalid_review_url'));
});

test('rejects unknown top-level and nested fields', () => {
  const record = acceptedCapability({ notes: 'must not be stored' });
  record.acceptance.approvedBy = 'untrusted';
  const result = validateEngineeringSession(record);
  assert.ok(result.errors.includes('unknown_property'));
  assert.ok(result.errors.includes('acceptance_unknown_property'));
});

test('rejects identifying contributor references instead of opaque actor references', () => {
  const record = acceptedCapability({ contributor_ref: 'person@example.com' });
  assert.ok(validateEngineeringSession(record).errors.includes('invalid_contributor_ref'));
});

test('rejects invalid and non-UTC timestamps', () => {
  const invalidDate = baseRecord({ recorded_at_utc: '2026-02-30T03:00:00Z' });
  assert.ok(validateEngineeringSession(invalidDate).errors.includes('invalid_recorded_at_utc'));

  const localTime = baseRecord({ recorded_at_utc: '2026-11-27T03:00:00-06:00' });
  assert.ok(validateEngineeringSession(localTime).errors.includes('invalid_recorded_at_utc'));
});

test('rejects an end timestamp earlier than the start timestamp', () => {
  const record = baseRecord({
    started_at_utc: '2026-11-27T03:00:00Z',
    ended_at_utc: '2026-11-27T02:59:59Z'
  });
  assert.ok(validateEngineeringSession(record).errors.includes('end_before_start'));
});

test('bounds human time, tool time, and rework time', () => {
  const negative = baseRecord({ human_active_minutes: -1 });
  assert.ok(validateEngineeringSession(negative).errors.includes('invalid_human_active_minutes'));

  const tooLarge = baseRecord({ ai_tool_elapsed_minutes: 10081 });
  assert.ok(validateEngineeringSession(tooLarge).errors.includes('invalid_ai_tool_elapsed_minutes'));

  const infinite = baseRecord({ rework_minutes: Infinity, human_active_minutes: 10 });
  assert.ok(validateEngineeringSession(infinite).errors.includes('invalid_rework_minutes'));
});

test('rework must be an explicit subset of recorded human active time', () => {
  const noHumanTime = baseRecord({ rework_minutes: 1 });
  assert.ok(validateEngineeringSession(noHumanTime).errors.includes('rework_requires_human_time'));

  const exceeds = baseRecord({ human_active_minutes: 10, rework_minutes: 11 });
  assert.ok(validateEngineeringSession(exceeds).errors.includes('rework_exceeds_human_time'));
});

test('allows distinct session identifiers for separate sessions on one change', () => {
  const first = baseRecord();
  const second = baseRecord({ session_id: 'session-20261127-002', task_ref: 'issue-52-followup' });
  const result = validateEngineeringSessions([first, second]);
  assert.equal(result.valid, true);
});

test('rejects inconsistent first-pass status for sessions in the same change', () => {
  const first = baseRecord({ first_pass_gate_pass: true });
  const second = baseRecord({ session_id: 'session-20261127-002', first_pass_gate_pass: false });
  const result = validateEngineeringSessions([first, second]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === 'conflicting_first_pass_status_for_change'));
});

test('rejects duplicate session identifiers in a log', () => {
  const first = baseRecord();
  const second = baseRecord({ task_ref: 'issue-52-followup' });
  const result = validateEngineeringSessions([first, second]);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.code === 'duplicate_session_id'));
});

test('reports malformed JSONL without echoing the source line', () => {
  const result = parseEngineeringSessionJsonl('{"private":"synthetic@example.com"}\nnot-json\n');
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(item => item.line === 2 && item.code === 'invalid_json'));
  assert.ok(result.errors.some(item => item.line === 1 && item.code === 'unknown_property'));
  assert.equal(JSON.stringify(result.errors).includes('synthetic@example.com'), false);
});

test('aggregates only explicit times and withholds incomplete ratios', () => {
  const records = [
    baseRecord({
      session_id: 'session-20261127-002',
      outcome: 'revised',
      result_kind: 'test',
      human_active_minutes: 60,
      ai_tool_elapsed_minutes: 20,
      rework_minutes: 15,
      first_pass_gate_pass: null
    }),
    baseRecord({
      session_id: 'session-20261127-003',
      human_active_minutes: null,
      ai_tool_elapsed_minutes: 10,
      rework_minutes: null,
      first_pass_gate_pass: null
    })
  ];
  const summary = summarizeEngineeringSessions(records);
  assert.equal(summary.humanActiveMinutes.recordedTotal, 60);
  assert.equal(summary.humanActiveMinutes.missingSessions, 1);
  assert.equal(summary.aiToolElapsedMinutes.recordedTotal, 30);
  assert.equal(summary.rework.ratio, null);
  assert.equal(summary.firstPass.yield, null);
  assert.equal(summary.acceptanceEvidenceMode, 'structural_only_not_authenticated');
  assert.equal(summary.independentlyVerifiedAcceptedCapabilities, null);
  assert.equal(Object.prototype.hasOwnProperty.call(summary, 'contributor_ref'), false);
});

test('computes first-pass yield per change, not per session', () => {
  const first = baseRecord({
    session_id: 'session-20261127-004',
    change_ref: 'change-alpha',
    outcome: 'accepted',
    result_kind: 'documentation',
    human_active_minutes: 40,
    ai_tool_elapsed_minutes: 8,
    rework_minutes: 0,
    first_pass_gate_pass: true
  });
  const second = baseRecord({
    session_id: 'session-20261127-005',
    change_ref: 'change-alpha',
    outcome: 'revised',
    result_kind: 'test',
    human_active_minutes: 20,
    ai_tool_elapsed_minutes: 10,
    rework_minutes: 5,
    first_pass_gate_pass: true
  });
  const third = baseRecord({
    session_id: 'session-20261127-006',
    change_ref: 'change-beta',
    outcome: 'revised',
    result_kind: 'test',
    human_active_minutes: 60,
    ai_tool_elapsed_minutes: 10,
    rework_minutes: 20,
    first_pass_gate_pass: false
  });
  const summary = summarizeEngineeringSessions([first, second, third]);
  assert.equal(summary.changeCount, 2);
  assert.equal(summary.firstPass.passed, 1);
  assert.equal(summary.firstPass.failed, 1);
  assert.equal(summary.firstPass.yield, 0.5);
  assert.equal(summary.rework.ratio, 25 / 120);
  assert.equal(summary.rework.complete, true);
});

test('summary counts accepted capability claims as structural claims, not verified outcomes', () => {
  const first = acceptedCapability();
  const second = acceptedCapability({ session_id: 'session-20261127-007', outcome: 'revised' });
  const summary = summarizeEngineeringSessions([first, second]);
  assert.equal(summary.structurallyEligibleAcceptedCapabilityClaims, 1);
  assert.equal(summary.independentlyVerifiedAcceptedCapabilities, null);
  assert.equal(summary.acceptanceEvidenceMode, 'structural_only_not_authenticated');
});

test('JSON Schema is strict and requires explicit nullable time fields', () => {
  const schemaPath = path.join(__dirname, '..', 'schemas', 'engineering-session.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.ok(schema.required.includes('human_active_minutes'));
  assert.ok(schema.required.includes('ai_tool_elapsed_minutes'));
  assert.ok(schema.required.includes('started_at_utc'));
  assert.ok(schema.required.includes('ended_at_utc'));
  assert.ok(schema.required.includes('change_ref'));
  assert.ok(schema.allOf.some(rule => rule.then && rule.then.properties && rule.then.properties.acceptance));
});

test('CLI reads a private JSONL path and emits aggregate-only output', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-session-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'private-session-log.jsonl');
  const record = baseRecord({ human_active_minutes: 25, ai_tool_elapsed_minutes: 5 });
  fs.writeFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 });
  const script = path.join(__dirname, 'engineering-session-contract.cjs');
  const run = spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /"sessionCount": 1/);
  assert.equal(run.stdout.includes(record.session_id), false);
  assert.equal(run.stdout.includes('contributor_ref'), false);
});
