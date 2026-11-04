'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTask, createSandbox, createRootConductor } = require('./micro-federation.cjs');

test('failed builders are excluded from artifact consensus and cannot create a false match', async () => {
  const task = makeTask({
    id: 'builder-failure-consensus',
    payload: { operation: 'build', acceptance: { type: 'string-equals', expected: 'artifact:v1' } }
  });
  const worker = async ({ role }) => {
    if (role === 'builder') throw new Error('deterministic builder crash');
    return { vote: 1, role };
  };
  const sandboxes = [
    createSandbox({ id: 'failure-A', worker }),
    createSandbox({ id: 'failure-B', worker })
  ];
  let verifierCalls = 0;
  const root = createRootConductor({
    sandboxes,
    externalVerifier: async () => {
      verifierCalls += 1;
      return { ok: true, resultHash: 'not-a-valid-builder-receipt' };
    }
  });

  const result = await root.route(task);

  assert.equal(result.accepted, false, 'failed builders must never be accepted');
  assert.equal(result.rootDecision, 'quarantined');
  assert.equal(result.artifactsAgree, false,
    'two identical failure records are not an artifact consensus');
  assert.equal(verifierCalls, 0,
    'external artifact verification must not run for missing/failed builder artifacts');
  assert.ok(result.sandboxResults.every(s => s.outputs.builder?.error === 'deterministic builder crash'));
  assert.ok(result.sandboxResults.every(s => s.decision.outcome !== 'approve'),
    'a sandbox with a failed required builder must not report approval');
});
