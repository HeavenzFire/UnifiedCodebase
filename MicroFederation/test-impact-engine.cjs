'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateOpportunity, rankOpportunities, compareOutcome } = require('./impact-engine.cjs');

const opportunity = (id, overrides = {}) => ({
  id,
  title: 'Reduce avoidable water loss',
  impact: { life_safety: 0, financial: 3, resource: 5 },
  evidenceQuality: 0.5,
  feasibility: 0.9,
  urgency: 0.5,
  evidence: [{ ref: 'https://example.org/utility-audit', level: 'source_supported', sha256: 'a'.repeat(64), retrievedAt: '2026-11-07T12:00:00Z' }],
  estimatedCost: { amount: 1000, currency: 'USD', period: 'pilot' },
  estimatedBenefit: { amount: 5000, currency: 'USD', period: 'annual' },
  ...overrides
});

test('scores deterministically and never authorizes automated execution', () => {
  const a = evaluateOpportunity(opportunity('water-loss'));
  const b = evaluateOpportunity(opportunity('water-loss'));
  assert.deepEqual(a, b);
  assert.equal(a.automatedExecutionAuthorized, false);
  assert.equal(a.requiresHumanApproval, false);
  assert.equal(a.strongestEvidence, 'source_supported');
  assert.equal(a.weakestEvidence, 'source_supported');
  assert.equal(a.evidenceQualityCap, 0.5);
  assert.ok(a.score > 0 && a.score <= 100);
});

test('life-safety opportunities always require human approval and safe pilot design', () => {
  const result = evaluateOpportunity(opportunity('heat-risk', {
    impact: { life_safety: 5, financial: 1, resource: 1 },
    evidenceQuality: 0,
    feasibility: 0,
    urgency: 1
  }));
  assert.equal(result.requiresHumanApproval, true);
  assert.equal(result.nextStep, 'human_review_and_safe_pilot_design');
  assert.equal(result.automatedExecutionAuthorized, false);
});

test('caps evidence quality at the weakest verification level in the evidence bundle', () => {
  assert.throws(() => evaluateOpportunity(opportunity('unverified-overclaim', {
    evidenceQuality: 1,
    evidence: [{ ref: 'https://example.org/unverified', level: 'unverified' }]
  })), /evidence bundle cap of 0/);

  assert.throws(() => evaluateOpportunity(opportunity('source-overclaim', {
    evidenceQuality: 0.51
  })), /evidence bundle cap of 0.5/);

  const reproduced = evaluateOpportunity(opportunity('reproduced', {
    evidenceQuality: 1,
    evidence: [{ ref: 'https://example.org/reproduced', level: 'independently_reproduced' }]
  }));
  assert.equal(reproduced.evidenceQualityCap, 1);
  assert.equal(reproduced.weakestEvidence, 'independently_reproduced');

  assert.throws(() => evaluateOpportunity(opportunity('mixed-evidence-overclaim', {
    evidenceQuality: 0.1,
    evidence: [
      { ref: 'https://example.org/reproduced', level: 'independently_reproduced' },
      { ref: 'https://example.org/unverified', level: 'unverified' }
    ]
  })), /evidence bundle cap of 0/);
});

test('ranks highest score first and breaks ties by stable id', () => {
  const low = opportunity('z-low', { impact: { life_safety: 0, financial: 0, resource: 1 } });
  const high = opportunity('a-high', {
    impact: { life_safety: 5, financial: 5, resource: 5 },
    evidenceQuality: 1,
    feasibility: 1,
    urgency: 1,
    evidence: [{ ref: 'https://example.org/reproduced', level: 'independently_reproduced' }]
  });
  const ranked = rankOpportunities([low, high]);
  assert.equal(ranked[0].id, 'a-high');
  assert.equal(rankOpportunities([low, opportunity('b-low', { impact: low.impact })])[0].id, 'b-low');
});

test('rejects malformed scores, absent evidence, unknown fields and duplicate IDs', () => {
  assert.throws(() => evaluateOpportunity(opportunity('bad', { feasibility: 1.1 })), /feasibility/);
  assert.throws(() => evaluateOpportunity(opportunity('no-evidence', { evidence: [] })), /evidence/);
  assert.throws(() => evaluateOpportunity(opportunity('unknown', { apiKey: 'nope' })), /unsupported field/);
  assert.throws(() => rankOpportunities([opportunity('same'), opportunity('same')]), /duplicate/);
});

test('does not confuse a measured delta with verified savings', () => {
  const result = compareOutcome({
    baseline: { value: 100, unit: 'kWh/day' },
    observed: { value: 80, unit: 'kWh/day' }
  });
  assert.equal(result.absoluteImprovement, 20);
  assert.equal(result.percentImprovement, 20);
  assert.equal(result.improved, true);
  assert.equal(result.verified, false);
});

test('rejects incompatible measurement units and invalid direction', () => {
  assert.throws(() => compareOutcome({ baseline: { value: 1, unit: 'USD' }, observed: { value: 2, unit: 'kWh' } }), /units must match/);
  assert.throws(() => compareOutcome({ baseline: { value: 1, unit: 'x' }, observed: { value: 2, unit: 'x' }, direction: 'unknown' }), /direction/);
});
