'use strict';

const fs = require('node:fs');

const TOP_LEVEL_KEYS = [
  'schema_version','session_id','task_ref','change_ref','workstream','recorded_at_utc',
  'started_at_utc','ended_at_utc','outcome','result_kind','risk_class',
  'human_active_minutes','ai_tool_elapsed_minutes','rework_minutes',
  'first_pass_gate_pass','contributor_ref','commit_sha','acceptance'
];
const ACCEPTANCE_KEYS = [
  'ci_run_url','ci_head_sha','ci_conclusion','review_url',
  'reviewed_sha','review_state','reviewer_ref'
];
const OUTCOMES = new Set(['accepted','revised','blocked','abandoned']);
const RESULT_KINDS = new Set(['capability','documentation','test','research','blocker']);
const RISK_CLASSES = new Set(['routine','privacy_sensitive','security_sensitive','production_facing','research_only']);
const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const ACTOR_PATTERN = /^actor_[a-f0-9]{16,64}$/;
const SESSION_PATTERN = /^[a-z0-9][a-z0-9-]{2,79}$/;
const REF_PATTERN = /^[a-z0-9][a-z0-9._-]{2,119}$/;
const WORKSTREAM_PATTERN = /^[a-z0-9][a-z0-9._-]{2,79}$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isUtcTimestamp(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/);
  if (!match) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const millis = (match[3] || '').padEnd(3, '0');
  return new Date(parsed).toISOString() === match[1] + 'T' + match[2] + '.' + millis + 'Z';
}

function isBoundedNumber(value, maximum) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= maximum;
}

function isGitHubActionsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.search === '' && url.hash === '' &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/[0-9]+$/.test(url.pathname);
  } catch {
    return false;
  }
}

function isGitHubReviewUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' &&
      url.search === '' &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+$/.test(url.pathname) &&
      /^#pullrequestreview-[0-9]+$/.test(url.hash);
  } catch {
    return false;
  }
}

function validateAcceptance(acceptance, record, errors) {
  if (!isPlainObject(acceptance)) {
    errors.push('acceptance_not_object');
    return;
  }
  for (const key of Object.keys(acceptance)) {
    if (!ACCEPTANCE_KEYS.includes(key)) errors.push('acceptance_unknown_property');
  }
  for (const key of ACCEPTANCE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(acceptance, key)) errors.push('acceptance_missing_' + key);
  }
  if (!isGitHubActionsUrl(acceptance.ci_run_url)) errors.push('acceptance_invalid_ci_url');
  if (typeof acceptance.ci_head_sha !== 'string' || !SHA_PATTERN.test(acceptance.ci_head_sha)) errors.push('acceptance_invalid_ci_sha');
  if (acceptance.ci_conclusion !== 'success') errors.push('acceptance_ci_not_success');
  if (!isGitHubReviewUrl(acceptance.review_url)) errors.push('acceptance_invalid_review_url');
  if (typeof acceptance.reviewed_sha !== 'string' || !SHA_PATTERN.test(acceptance.reviewed_sha)) errors.push('acceptance_invalid_review_sha');
  if (acceptance.review_state !== 'APPROVED') errors.push('acceptance_review_not_approved');
  if (typeof acceptance.reviewer_ref !== 'string' || !ACTOR_PATTERN.test(acceptance.reviewer_ref)) errors.push('acceptance_invalid_reviewer_ref');

  if (typeof record.commit_sha !== 'string' || !SHA_PATTERN.test(record.commit_sha)) {
    errors.push('acceptance_commit_sha_required');
  } else {
    if (acceptance.ci_head_sha !== record.commit_sha) errors.push('acceptance_ci_sha_mismatch');
    if (acceptance.reviewed_sha !== record.commit_sha) errors.push('acceptance_review_sha_mismatch');
  }
  if (typeof record.contributor_ref !== 'string' || !ACTOR_PATTERN.test(record.contributor_ref)) {
    errors.push('acceptance_contributor_ref_required');
  } else if (acceptance.reviewer_ref === record.contributor_ref) {
    errors.push('acceptance_reviewer_not_independent');
  }
}

function validateEngineeringSession(record) {
  const errors = [];
  if (!isPlainObject(record)) return { valid: false, errors: ['record_not_object'] };

  for (const key of Object.keys(record)) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push('unknown_property');
  }
  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) errors.push('missing_' + key);
  }

  if (record.schema_version !== '1.0') errors.push('unsupported_schema_version');
  if (typeof record.session_id !== 'string' || !SESSION_PATTERN.test(record.session_id)) errors.push('invalid_session_id');
  if (typeof record.task_ref !== 'string' || !REF_PATTERN.test(record.task_ref)) errors.push('invalid_task_ref');
  if (typeof record.change_ref !== 'string' || !REF_PATTERN.test(record.change_ref)) errors.push('invalid_change_ref');
  if (typeof record.workstream !== 'string' || !WORKSTREAM_PATTERN.test(record.workstream)) errors.push('invalid_workstream');
  if (!isUtcTimestamp(record.recorded_at_utc)) errors.push('invalid_recorded_at_utc');

  for (const key of ['started_at_utc','ended_at_utc']) {
    if (record[key] !== null && !isUtcTimestamp(record[key])) errors.push('invalid_' + key);
  }
  if (typeof record.started_at_utc === 'string' && typeof record.ended_at_utc === 'string' &&
      Date.parse(record.ended_at_utc) < Date.parse(record.started_at_utc)) errors.push('end_before_start');

  if (!OUTCOMES.has(record.outcome)) errors.push('invalid_outcome');
  if (!RESULT_KINDS.has(record.result_kind)) errors.push('invalid_result_kind');
  if (!RISK_CLASSES.has(record.risk_class)) errors.push('invalid_risk_class');

  if (record.human_active_minutes !== null && !isBoundedNumber(record.human_active_minutes, 1440)) errors.push('invalid_human_active_minutes');
  if (record.ai_tool_elapsed_minutes !== null && !isBoundedNumber(record.ai_tool_elapsed_minutes, 10080)) errors.push('invalid_ai_tool_elapsed_minutes');
  if (record.rework_minutes !== null && !isBoundedNumber(record.rework_minutes, 1440)) errors.push('invalid_rework_minutes');
  if (typeof record.rework_minutes === 'number' && typeof record.human_active_minutes !== 'number') {
    errors.push('rework_requires_human_time');
  } else if (typeof record.rework_minutes === 'number' && record.rework_minutes > record.human_active_minutes) {
    errors.push('rework_exceeds_human_time');
  }
  if (record.first_pass_gate_pass !== null && typeof record.first_pass_gate_pass !== 'boolean') errors.push('invalid_first_pass_gate_pass');

  if (record.contributor_ref !== null &&
      (typeof record.contributor_ref !== 'string' || !ACTOR_PATTERN.test(record.contributor_ref))) errors.push('invalid_contributor_ref');
  if (record.commit_sha !== null &&
      (typeof record.commit_sha !== 'string' || !SHA_PATTERN.test(record.commit_sha))) errors.push('invalid_commit_sha');

  if (record.acceptance !== null && record.acceptance !== undefined) {
    validateAcceptance(record.acceptance, record, errors);
  } else if (record.result_kind === 'capability' && record.outcome === 'accepted') {
    errors.push('accepted_capability_requires_acceptance');
  }

  return { valid: errors.length === 0, errors: Array.from(new Set(errors)) };
}

function validateEngineeringSessions(records) {
  if (!Array.isArray(records)) return { valid: false, errors: [{ index: null, code: 'records_not_array' }] };
  const errors = [];
  const seen = new Set();
  const firstPassByChange = new Map();

  records.forEach((record, index) => {
    const result = validateEngineeringSession(record);
    for (const code of result.errors) errors.push({ index, code });
    if (!isPlainObject(record)) return;

    if (typeof record.session_id === 'string') {
      if (seen.has(record.session_id)) errors.push({ index, code: 'duplicate_session_id' });
      seen.add(record.session_id);
    }
    if (typeof record.change_ref === 'string' &&
        (record.first_pass_gate_pass === null || typeof record.first_pass_gate_pass === 'boolean')) {
      if (firstPassByChange.has(record.change_ref) && firstPassByChange.get(record.change_ref) !== record.first_pass_gate_pass) {
        errors.push({ index, code: 'conflicting_first_pass_status_for_change' });
      } else {
        firstPassByChange.set(record.change_ref, record.first_pass_gate_pass);
      }
    }
  });

  return { valid: errors.length === 0, errors };
}

function parseEngineeringSessionJsonl(source) {
  if (typeof source !== 'string') return { valid: false, records: [], errors: [{ line: null, code: 'source_not_string' }] };
  const records = [];
  const lineNumbers = [];
  const errors = [];
  source.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line));
      lineNumbers.push(index + 1);
    } catch {
      errors.push({ line: index + 1, code: 'invalid_json' });
    }
  });
  const validation = validateEngineeringSessions(records);
  for (const item of validation.errors) {
    errors.push({ line: item.index === null ? null : lineNumbers[item.index], code: item.code });
  }
  return { valid: errors.length === 0, records, errors };
}

function summarizeEngineeringSessions(records) {
  const validation = validateEngineeringSessions(records);
  if (!validation.valid) throw new Error('invalid_session_records:' + validation.errors.map(item => item.code).join(','));

  const count = records.length;
  const outcomeCounts = { accepted: 0, revised: 0, blocked: 0, abandoned: 0 };
  const resultKindCounts = { capability: 0, documentation: 0, test: 0, research: 0, blocker: 0 };
  const firstPassByChange = new Map();
  const acceptedCapabilityChanges = new Set();

  for (const record of records) {
    outcomeCounts[record.outcome] += 1;
    resultKindCounts[record.result_kind] += 1;
    if (typeof record.first_pass_gate_pass === 'boolean') firstPassByChange.set(record.change_ref, record.first_pass_gate_pass);
    if (record.outcome === 'accepted' && record.result_kind === 'capability' && record.acceptance !== null) {
      acceptedCapabilityChanges.add(record.change_ref);
    }
  }

  const humanKnown = records.filter(record => typeof record.human_active_minutes === 'number');
  const toolKnown = records.filter(record => typeof record.ai_tool_elapsed_minutes === 'number');
  const reworkKnown = records.filter(record => typeof record.rework_minutes === 'number');
  const humanTotal = humanKnown.reduce((sum, record) => sum + record.human_active_minutes, 0);
  const toolTotal = toolKnown.reduce((sum, record) => sum + record.ai_tool_elapsed_minutes, 0);
  const reworkTotal = reworkKnown.reduce((sum, record) => sum + record.rework_minutes, 0);
  const firstPassValues = Array.from(firstPassByChange.values());
  const firstPassPassed = firstPassValues.filter(value => value === true).length;
  const firstPassFailed = firstPassValues.filter(value => value === false).length;
  const changeCount = new Set(records.map(record => record.change_ref)).size;
  const firstPassUnknown = changeCount - firstPassPassed - firstPassFailed;
  const firstPassComplete = changeCount > 0 && firstPassUnknown === 0;
  const reworkComplete = count > 0 && reworkKnown.length === count && humanKnown.length === count;

  return {
    sessionCount: count,
    changeCount,
    outcomeCounts,
    resultKindCounts,
    humanActiveMinutes: {
      recordedTotal: humanTotal,
      knownSessions: humanKnown.length,
      missingSessions: count - humanKnown.length,
      complete: count > 0 && humanKnown.length === count
    },
    aiToolElapsedMinutes: {
      recordedTotal: toolTotal,
      knownSessions: toolKnown.length,
      missingSessions: count - toolKnown.length,
      complete: count > 0 && toolKnown.length === count
    },
    rework: {
      recordedTotalMinutes: reworkTotal,
      knownSessions: reworkKnown.length,
      ratio: reworkComplete && humanTotal > 0 ? reworkTotal / humanTotal : null,
      complete: reworkComplete
    },
    firstPass: {
      passed: firstPassPassed,
      failed: firstPassFailed,
      unknown: firstPassUnknown,
      yield: firstPassComplete ? firstPassPassed / changeCount : null,
      complete: firstPassComplete,
      denominator: changeCount
    },
    structurallyEligibleAcceptedCapabilityClaims: acceptedCapabilityChanges.size,
    acceptanceEvidenceMode: 'structural_only_not_authenticated',
    independentlyVerifiedAcceptedCapabilities: null
  };
}

function runCli() {
  const filePath = process.argv[2];
  if (!filePath || filePath === '--help') {
    process.stdout.write('Usage: node scripts/engineering-session-contract.cjs <private-session-log.jsonl>\n');
    process.exitCode = filePath === '--help' ? 0 : 2;
    return;
  }
  let source;
  try {
    source = fs.readFileSync(filePath, 'utf8');
  } catch {
    process.stderr.write('Unable to read the supplied session log.\n');
    process.exitCode = 2;
    return;
  }
  const parsed = parseEngineeringSessionJsonl(source);
  if (!parsed.valid) {
    process.stdout.write(JSON.stringify({ valid: false, errors: parsed.errors }, null, 2) + '\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(summarizeEngineeringSessions(parsed.records), null, 2) + '\n');
}

if (require.main === module) runCli();

module.exports = {
  validateEngineeringSession,
  validateEngineeringSessions,
  parseEngineeringSessionJsonl,
  summarizeEngineeringSessions
};
