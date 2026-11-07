'use strict';

// Deterministic prioritization only. This module does not diagnose, dispatch,
// allocate funds, change infrastructure, or authorize real-world interventions.
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CATEGORIES = new Set(['life_safety', 'financial', 'resource']);
const EVIDENCE_LEVELS = new Set(['unverified', 'source_supported', 'independently_reproduced']);
const WEIGHTS = Object.freeze({ life_safety: 0.5, financial: 0.3, resource: 0.2 });
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw Error(label + ' contains unsupported field: ' + key);
}
function scoreBand(score) {
  if (score >= 75) return 'priority_review';
  if (score >= 50) return 'standard_review';
  return 'backlog';
}
function validateOpportunity(input) {
  if (!isRecord(input)) throw Error('opportunity must be an object');
  assertOnlyKeys(input, new Set(['id', 'title', 'description', 'impact', 'evidenceQuality', 'feasibility', 'urgency', 'evidence', 'estimatedCost', 'estimatedBenefit', 'requiresHumanApproval']), 'opportunity');
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw Error('opportunity id is invalid');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200) throw Error('opportunity title is required and must be <= 200 characters');
  if (input.description !== undefined && (typeof input.description !== 'string' || input.description.length > 4000)) throw Error('description must be a string <= 4000 characters');
  if (!isRecord(input.impact)) throw Error('impact must be an object');
  assertOnlyKeys(input.impact, new Set(CATEGORIES), 'impact');
  for (const category of CATEGORIES) {
    const value = input.impact[category];
    if (!Number.isFinite(value) || value < 0 || value > 5) throw Error('impact.' + category + ' must be between 0 and 5');
  }
  for (const key of ['evidenceQuality', 'feasibility', 'urgency']) {
    if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 1) throw Error(key + ' must be between 0 and 1');
  }
  if (!Array.isArray(input.evidence) || input.evidence.length < 1 || input.evidence.length > 50) throw Error('evidence must contain 1..50 evidence references');
  for (const item of input.evidence) {
    if (!isRecord(item)) throw Error('each evidence item must be an object');
    assertOnlyKeys(item, new Set(['ref', 'level', 'sha256', 'retrievedAt']), 'evidence item');
    if (typeof item.ref !== 'string' || !item.ref.trim() || item.ref.length > 2048) throw Error('evidence ref is required');
    if (!EVIDENCE_LEVELS.has(item.level)) throw Error('evidence level is invalid');
    if (item.sha256 !== undefined && (typeof item.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(item.sha256))) throw Error('evidence sha256 must be a 64-character hex digest');
    if (item.retrievedAt !== undefined && (typeof item.retrievedAt !== 'string' || !Number.isFinite(Date.parse(item.retrievedAt)))) throw Error('evidence retrievedAt must be a date-time string');
  }
  for (const key of ['estimatedCost', 'estimatedBenefit']) {
    const value = input[key];
    if (value !== undefined && value !== null) {
      if (!isRecord(value)) throw Error(key + ' must be an object');
      assertOnlyKeys(value, new Set(['amount', 'currency', 'unit', 'period']), key);
      if (!Number.isFinite(value.amount) || value.amount < 0) throw Error(key + '.amount must be a non-negative number');
      if (typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) throw Error(key + '.currency must be a 3-letter currency code');
      if (value.unit !== undefined && (typeof value.unit !== 'string' || value.unit.length > 80)) throw Error(key + '.unit must be <= 80 characters');
      if (value.period !== undefined && (typeof value.period !== 'string' || value.period.length > 80)) throw Error(key + '.period must be <= 80 characters');
    }
  }
  if (input.requiresHumanApproval !== undefined && typeof input.requiresHumanApproval !== 'boolean') throw Error('requiresHumanApproval must be boolean');
  return input;
}

function evaluateOpportunity(input) {
  const item = validateOpportunity(input);
  const impactScore = Object.keys(WEIGHTS).reduce((sum, key) => sum + (item.impact[key] / 5) * WEIGHTS[key], 0) * 100;
  const evidenceMultiplier = 0.5 + 0.5 * item.evidenceQuality;
  const feasibilityMultiplier = 0.5 + 0.5 * item.feasibility;
  const urgencyMultiplier = 0.8 + 0.2 * item.urgency;
  const score = Math.round(clamp(impactScore * evidenceMultiplier * feasibilityMultiplier * urgencyMultiplier, 0, 100) * 100) / 100;
  const strongestEvidence = item.evidence.some(x => x.level === 'independently_reproduced')
    ? 'independently_reproduced'
    : item.evidence.some(x => x.level === 'source_supported') ? 'source_supported' : 'unverified';
  const lifeSafety = item.impact.life_safety > 0;
  return Object.freeze({
    id: item.id,
    title: item.title,
    score,
    band: scoreBand(score),
    impactScore: Math.round(impactScore * 100) / 100,
    evidenceMultiplier: Math.round(evidenceMultiplier * 10000) / 10000,
    feasibilityMultiplier: Math.round(feasibilityMultiplier * 10000) / 10000,
    urgencyMultiplier: Math.round(urgencyMultiplier * 10000) / 10000,
    strongestEvidence,
    evidenceCount: item.evidence.length,
    estimatedCost: item.estimatedCost || null,
    estimatedBenefit: item.estimatedBenefit || null,
    nextStep: lifeSafety ? 'human_review_and_safe_pilot_design' : score >= 50 ? 'human_review_and_bounded_pilot_design' : 'gather_evidence_and_reassess',
    requiresHumanApproval: lifeSafety || item.requiresHumanApproval === true,
    automatedExecutionAuthorized: false
  });
}

function rankOpportunities(items) {
  if (!Array.isArray(items)) throw Error('opportunities must be an array');
  const ids = new Set();
  const evaluated = items.map(item => {
    const result = evaluateOpportunity(item);
    if (ids.has(result.id)) throw Error('duplicate opportunity id: ' + result.id);
    ids.add(result.id);
    return result;
  });
  return evaluated.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

function compareOutcome({ baseline, observed, direction = 'lower_is_better' } = {}) {
  for (const [label, metric] of [['baseline', baseline], ['observed', observed]]) {
    if (!isRecord(metric) || !Number.isFinite(metric.value) || metric.value < 0 || typeof metric.unit !== 'string' || !metric.unit.trim()) {
      throw Error(label + ' must contain a non-negative value and unit');
    }
  }
  if (baseline.unit !== observed.unit) throw Error('baseline and observed units must match');
  if (!['lower_is_better', 'higher_is_better'].includes(direction)) throw Error('direction is invalid');
  const delta = observed.value - baseline.value;
  const improvement = direction === 'lower_is_better' ? -delta : delta;
  const percent = baseline.value === 0 ? null : Math.round((improvement / baseline.value) * 10000) / 100;
  return Object.freeze({
    baseline: { value: baseline.value, unit: baseline.unit },
    observed: { value: observed.value, unit: observed.unit },
    absoluteImprovement: Math.round(improvement * 10000) / 10000,
    percentImprovement: percent,
    improved: improvement > 0,
    verified: false,
    verificationStatus: 'measurement_only_requires_independent_evidence'
  });
}

module.exports = { evaluateOpportunity, rankOpportunities, compareOutcome, validateOpportunity, WEIGHTS };
