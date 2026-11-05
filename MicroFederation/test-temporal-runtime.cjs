'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TemporalRuntime, SNAPSHOT_SCHEMA } = require('./temporal-runtime.cjs');

test('advances virtual time and executes events in stable timestamp/sequence order', () => {
  const seen = [];
  const runtime = new TemporalRuntime({
    handlers: {
      record(payload, context) { seen.push([payload.label, context.now, context.sequence]); }
    }
  });
  runtime.scheduleAt(5, 'record', { label: 'first' });
  runtime.scheduleAt(5, 'record', { label: 'second' });
  runtime.scheduleAt(2, 'record', { label: 'earlier' });

  const result = runtime.advanceTo(10);
  assert.deepEqual(seen.map(row => row[0]), ['earlier', 'first', 'second']);
  assert.deepEqual(seen.map(row => row[1]), [2, 5, 5]);
  assert.deepEqual(result, { now: 10, executed: 3, pending: 0 });
});

test('supports relative scheduling and cancellation', () => {
  const seen = [];
  const runtime = new TemporalRuntime({
    startAt: 10,
    handlers: { record(payload) { seen.push(payload.value); } }
  });
  const cancelled = runtime.scheduleIn(2, 'record', { value: 'cancelled' });
  runtime.scheduleIn(3, 'record', { value: 'kept' });
  assert.equal(runtime.cancel(cancelled), true);
  assert.equal(runtime.cancel(cancelled), false);
  assert.deepEqual(runtime.advanceBy(3), { now: 13, executed: 1, pending: 0 });
  assert.deepEqual(seen, ['kept']);
});

test('handlers can enqueue deterministic follow-up events in the same advance', () => {
  const seen = [];
  const runtime = new TemporalRuntime({
    handlers: {
      chain(payload) {
        seen.push(payload.depth);
        if (payload.depth < 3) runtime.scheduleIn(1, 'chain', { depth: payload.depth + 1 });
      }
    }
  });
  runtime.scheduleAt(0, 'chain', { depth: 1 });
  const result = runtime.advanceTo(5);
  assert.deepEqual(seen, [1, 2, 3]);
  assert.equal(result.executed, 3);
});

test('snapshot and restore reproduce pending event order and virtual state', () => {
  const seen = [];
  const handlers = { record(payload) { seen.push(payload.value); } };
  const first = new TemporalRuntime({ startAt: 4, handlers });
  first.scheduleAt(7, 'record', { value: 'a' });
  first.scheduleAt(7, 'record', { value: 'b' });
  const snapshot = first.snapshot();

  assert.equal(snapshot.schema, SNAPSHOT_SCHEMA);
  const restored = new TemporalRuntime({ handlers, snapshot });
  assert.deepEqual(restored.advanceTo(8), { now: 8, executed: 2, pending: 0 });
  assert.deepEqual(seen, ['a', 'b']);
});

test('rejects invalid time, unknown handlers, and non-JSON payloads', () => {
  const runtime = new TemporalRuntime({ handlers: { noop() {} } });
  assert.throws(() => runtime.advanceTo(-1), /non-negative/);
  assert.throws(() => runtime.scheduleAt(0, 'missing'), /unregistered handler/);
  assert.throws(() => runtime.scheduleAt(0, 'noop', { value: undefined }), /JSON-serializable/);
  assert.throws(() => runtime.scheduleIn(Infinity, 'noop'), /finite/);
});

test('rejects backwards time, reentrant advancement, and asynchronous handlers', () => {
  let runtime;
  runtime = new TemporalRuntime({
    handlers: {
      nested() { assert.throws(() => runtime.advanceTo(2), /reentrant/); },
      asyncHandler: async function () {}
    }
  });
  runtime.scheduleAt(1, 'nested');
  runtime.advanceTo(1);
  assert.throws(() => runtime.advanceTo(0), /backwards/);

  const asyncRuntime = new TemporalRuntime({ handlers: { asyncHandler: async function () {} } });
  asyncRuntime.scheduleAt(0, 'asyncHandler');
  assert.throws(() => asyncRuntime.advanceTo(0), /must be synchronous/);
});

test('enforces per-advance event budget without dropping the next event', () => {
  const runtime = new TemporalRuntime({ handlers: { noop() {} } });
  runtime.scheduleAt(1, 'noop');
  runtime.scheduleAt(2, 'noop');
  assert.throws(() => runtime.advanceTo(3, { maxEvents: 1 }), /execution limit/);
  assert.equal(runtime.now, 1);
  assert.equal(runtime.pendingCount, 1);
  assert.deepEqual(runtime.advanceTo(3), { now: 3, executed: 1, pending: 0 });
});

test('rejects malformed or incompatible snapshots', () => {
  const handlers = { noop() {} };
  const runtime = new TemporalRuntime({ handlers });
  assert.throws(() => runtime.restore({ schema: 'wrong' }), /unsupported/);
  assert.throws(() => runtime.restore({
    schema: SNAPSHOT_SCHEMA, now: 2, nextSequence: 2,
    events: [{ id: 'event-00000001', at: 1, sequence: 1, handler: 'noop', payload: null }]
  }), /virtual past/);
  assert.throws(() => runtime.restore({
    schema: SNAPSHOT_SCHEMA, now: 0, nextSequence: 2,
    events: [{ id: 'event-00000001', at: 1, sequence: 1, handler: 'absent', payload: null }]
  }), /unregistered handler/);
});
