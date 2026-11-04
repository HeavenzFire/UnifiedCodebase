'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CapabilityFabric, createGapiCompatibilityOverride } = require('./capability-fabric.cjs');

const definitions = [
  { id: 'core.runtime', version: '1.0.0', description: 'Runtime base' },
  { id: 'browser.bridge', version: '1.0.0', description: 'Browser adapter', dependencies: ['core.runtime'] },
  { id: 'drive.connector', version: '1.0.0', description: 'Drive connector', dependencies: ['browser.bridge'], origin: 'https://www.googleapis.com' }
];

test('resolves dependencies before dependants and reports missing adapters', () => {
  const fabric = new CapabilityFabric({ definitions, allowedOrigins: ['https://www.googleapis.com'] });
  const plan = fabric.plan(['drive.connector']);
  assert.deepEqual(plan.order, ['core.runtime', 'browser.bridge', 'drive.connector']);
  assert.equal(plan.capabilities[0].adapterAvailable, false);
});

test('rejects untrusted origins, duplicate ids, malformed definitions and cycles', () => {
  assert.throws(() => new CapabilityFabric({ definitions, allowedOrigins: [] }), /not allowlisted/);
  assert.throws(() => new CapabilityFabric({ definitions: [definitions[0], definitions[0]] }), /already registered/);
  assert.throws(() => new CapabilityFabric({ definitions: [{ id: 'bad', version: '1', description: 'bad' }] }), /version/);
  assert.throws(() => new CapabilityFabric({ definitions: [
    { id: 'alpha', version: '1.0.0', description: 'A', dependencies: ['beta'] },
    { id: 'beta', version: '1.0.0', description: 'B', dependencies: ['alpha'] }
  ] }).resolve(['alpha']), /cycle/);
});

test('loads idempotently and rolls back newly loaded dependencies after failure', async () => {
  const calls = [];
  const core = async () => { calls.push('core'); };
  core.dispose = async () => { calls.push('dispose-core'); };
  const fabric = new CapabilityFabric({
    definitions: definitions.slice(0, 2),
    adapters: {
      'core.runtime': core,
      'browser.bridge': async () => { calls.push('browser'); throw Error('boot failure'); }
    }
  });
  await assert.rejects(fabric.load(['browser.bridge']), /boot failure/);
  assert.deepEqual(calls, ['core', 'browser', 'dispose-core']);
  assert.equal(fabric.list()[0].state, 'registered');
  assert.equal(fabric.list()[1].state, 'failed');
  await assert.rejects(fabric.load(['browser.bridge']), /boot failure/);
});

test('GAPI override routes hf modules locally and delegates Google modules unchanged', async () => {
  const calls = [];
  const gapi = { load(features, options) {
    calls.push(features);
    if (options && options.callback) options.callback();
  } };
  const fabric = new CapabilityFabric({
    definitions: [{ id: 'core.runtime', version: '1.0.0', description: 'Local core' }],
    adapters: { 'core.runtime': async () => { calls.push('local:core'); } }
  });
  const bridge = createGapiCompatibilityOverride({ gapi, fabric });
  const uninstall = bridge.install();
  let callbackCount = 0;
  const result = await gapi.load('hf.core.runtime:client:auth2', { callback: () => { callbackCount++; } });
  assert.deepEqual(calls, ['client:auth2', 'local:core']);
  assert.deepEqual(result, { local: ['core.runtime'], remote: ['client', 'auth2'] });
  assert.equal(callbackCount, 1);
  assert.equal(uninstall(), true);
  assert.equal(gapi.load === bridge.load, false);
});

test('override delegates non-local requests and refuses to overwrite a later patch', async () => {
  let delegated = '';
  const gapi = { load(features) { delegated = features; } };
  const fabric = new CapabilityFabric({ definitions: [{ id: 'core', version: '1.0.0', description: 'Core' }], adapters: { core: async () => {} } });
  const bridge = createGapiCompatibilityOverride({ gapi, fabric });
  const uninstall = bridge.install();
  gapi.load('client:auth2');
  assert.equal(delegated, 'client:auth2');
  gapi.load = () => {};
  assert.throws(() => uninstall(), /refusing to overwrite/);
});


test('high-impact capabilities require a trusted host approval verifier', async () => {
  const definition = { id: 'external.bridge', version: '1.0.0', description: 'External bridge', riskClass: 'external_network' };
  const fabric = new CapabilityFabric({ definitions: [definition], adapters: { 'external.bridge': async () => {} } });
  await assert.rejects(fabric.load(['external.bridge']), /explicit host approval required/);
  const denied = new CapabilityFabric({
    definitions: [definition],
    adapters: { 'external.bridge': async () => {} },
    approvalVerifier: async () => false
  });
  await assert.rejects(denied.load(['external.bridge']), /explicit host approval required/);
  const approved = new CapabilityFabric({
    definitions: [definition],
    adapters: { 'external.bridge': async () => {} },
    approvalVerifier: async ({ capability }) => capability.id === 'external.bridge'
  });
  const result = await approved.load(['external.bridge']);
  assert.equal(result.states[0].state, 'ready');
});
