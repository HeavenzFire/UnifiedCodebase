'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTask, createSandbox, createRootConductor, hash } = require('./micro-federation.cjs');

function buildTwoSandboxPair(answerFor) {
  const worker = async ({ role, task }) => {
    const value = answerFor(task.payload);
    const artifact = role === 'builder' ? { result: value, expression: task.payload.expression } : null;
    return { vote: 1, role, artifact };
  };
  const sandboxes = [
    createSandbox({ id: 'semantic-A', worker }),
    createSandbox({ id: 'semantic-B', worker })
  ];
  const externalVerifier = async ({ task, result }) => {
    const artifact = result.outputs.builder && result.outputs.builder.artifact;
    // Verifier checks receipt identity only; the root must enforce the task's acceptance contract.
    return { ok: !!artifact, resultHash: hash(artifact), check: 'artifact-receipt-present' };
  };
  return createRootConductor({ sandboxes, externalVerifier });
}

test('accepts two-sandbox task only when both builders satisfy deterministic acceptance', async () => {
  const task = makeTask({
    id: 'centropic-math-19x23',
    payload: { expression: '19 * 23', acceptance: { type: 'number-equals', expected: 437 } },
    requiredCapabilities: ['task.execute'],
    deadlineMs: 30000
  });
  const root = buildTwoSandboxPair(() => 19 * 23);
  const result = await root.route(task);
  assert.equal(result.accepted, true);
  assert.equal(result.rootDecision, 'accepted');
  assert.equal(result.sandboxResults.length, 2);
  assert.ok(result.sandboxResults.every(s => s.decision.outcome === 'approve'));
  assert.ok(result.independentVerification.every(v => v.ok === true));
  assert.equal(result.allAcceptancePassed, true);
  assert.ok(result.acceptanceChecks.every(v => v.ok === true));
  assert.ok(result.traceHeads.every(t => /^[a-f0-9]{64}$/.test(t.traceHead)));
});

test('quarantines unanimous but semantically incorrect sandbox outputs', async () => {
  const task = makeTask({
    id: 'centropic-math-19x23-wrong',
    payload: { expression: '19 * 23', acceptance: { type: 'number-equals', expected: 437 } },
    requiredCapabilities: ['task.execute'],
    deadlineMs: 30000
  });
  const root = buildTwoSandboxPair(() => 438);
  const result = await root.route(task);
  assert.equal(result.sandboxResults.every(s => s.decision.outcome === 'approve'), true);
  assert.equal(result.artifactsAgree, true);
  assert.equal(result.independentVerification.every(v => v.ok === true), true);
  assert.equal(result.allAcceptancePassed, false);
  assert.ok(result.acceptanceChecks.every(v => v.ok === false));
  assert.equal(result.accepted, false);
  assert.equal(result.rootDecision, 'quarantined');
});
