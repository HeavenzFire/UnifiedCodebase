'use strict';

const SNAPSHOT_SCHEMA = 'heavenzfire.temporal-runtime.snapshot.v1';
const MAX_EVENTS_PER_ADVANCE = 100000;

function assertPlainJson(value, label, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(label + ' contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') {
    throw new TypeError(label + ' must contain only JSON values');
  }
  if (seen.has(value)) throw new TypeError(label + ' must not contain circular references');

  const prototype = Object.getPrototypeOf(value);
  const isArray = Array.isArray(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(label + ' must contain only plain objects and arrays');
  }

  seen.add(value);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some(key => typeof key === 'symbol')) {
    throw new TypeError(label + ' must not contain symbol keys');
  }

  if (isArray) {
    // JSON arrays must be dense and may not carry custom/non-index properties.
    // Check key count first so a very large sparse array is rejected without
    // iterating over its potentially enormous length.
    if (ownKeys.length !== value.length + 1) {
      throw new TypeError(label + ' arrays must be dense and contain no extra properties');
    }
    for (const key of ownKeys) {
      if (key === 'length') continue;
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= value.length || String(index) !== key) {
        throw new TypeError(label + ' arrays must contain only indexed elements');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(label + ' must not contain accessors or non-enumerable values');
      }
      assertPlainJson(descriptor.value, label, seen);
    }
  } else {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new TypeError(label + ' must contain only enumerable data properties');
      }
      assertPlainJson(descriptor.value, label, seen);
    }
  }
  seen.delete(value);
}

function cloneJson(value, label = 'value') {
  assertPlainJson(value, label);
  return JSON.parse(JSON.stringify(value));
}

function finiteTime(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(label + ' must be a finite non-negative number');
  }
  return value;
}

class TemporalRuntime {
  constructor(options = {}) {
    this.now = finiteTime(options.startAt === undefined ? 0 : options.startAt, 'startAt');
    this.nextSequence = 1;
    this.events = [];
    this.cancelled = new Set();
    this.handlers = new Map();
    this.running = false;

    const handlers = options.handlers || {};
    for (const [name, handler] of Object.entries(handlers)) {
      this.registerHandler(name, handler);
    }

    if (options.snapshot) this.restore(options.snapshot);
  }

  registerHandler(name, handler) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(name)) {
      throw new TypeError('handler name must be a stable identifier');
    }
    if (typeof handler !== 'function') throw new TypeError('handler must be a function');
    if (this.handlers.has(name)) throw new Error('handler already registered: ' + name);
    this.handlers.set(name, handler);
    return this;
  }

  scheduleAt(at, handler, payload = null) {
    finiteTime(at, 'event time');
    if (at < this.now) throw new RangeError('cannot schedule an event in the virtual past');
    if (!this.handlers.has(handler)) throw new Error('unregistered handler: ' + handler);

    const event = {
      id: 'event-' + String(this.nextSequence).padStart(8, '0'),
      at,
      sequence: this.nextSequence,
      handler,
      payload: cloneJson(payload, 'event payload')
    };
    this.nextSequence += 1;
    this.events.push(event);
    this.events.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
    return event.id;
  }

  scheduleIn(delay, handler, payload = null) {
    finiteTime(delay, 'delay');
    return this.scheduleAt(this.now + delay, handler, payload);
  }

  cancel(eventId) {
    if (typeof eventId !== 'string') throw new TypeError('eventId must be a string');
    const exists = this.events.some(event => event.id === eventId);
    if (!exists || this.cancelled.has(eventId)) return false;
    this.cancelled.add(eventId);
    return true;
  }

  advanceBy(delta, options = {}) {
    finiteTime(delta, 'delta');
    return this.advanceTo(this.now + delta, options);
  }

  advanceTo(targetTime, options = {}) {
    finiteTime(targetTime, 'targetTime');
    if (targetTime < this.now) throw new RangeError('virtual time cannot move backwards');
    if (this.running) throw new Error('reentrant time advancement is not allowed');

    const maxEvents = options.maxEvents === undefined ? MAX_EVENTS_PER_ADVANCE : options.maxEvents;
    if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > MAX_EVENTS_PER_ADVANCE) {
      throw new RangeError('maxEvents must be an integer from 1 to ' + MAX_EVENTS_PER_ADVANCE);
    }

    this.running = true;
    let executed = 0;
    try {
      while (this.events.length > 0 && this.events[0].at <= targetTime) {
        const event = this.events.shift();
        if (this.cancelled.delete(event.id)) continue;
        if (executed >= maxEvents) {
          this.events.unshift(event);
          throw new Error('event execution limit reached; advance again with a larger budget');
        }

        this.now = event.at;
        executed += 1;
        const handler = this.handlers.get(event.handler);
        if (!handler) throw new Error('missing handler during replay: ' + event.handler);
        const result = handler(cloneJson(event.payload), {
          now: this.now,
          eventId: event.id,
          sequence: event.sequence,
          runtime: this
        });
        if (result && typeof result.then === 'function') {
          throw new TypeError('temporal handlers must be synchronous for deterministic replay');
        }
      }
      this.now = targetTime;
      return { now: this.now, executed, pending: this.pendingCount };
    } finally {
      this.running = false;
    }
  }

  snapshot() {
    return {
      schema: SNAPSHOT_SCHEMA,
      now: this.now,
      nextSequence: this.nextSequence,
      events: this.events
        .filter(event => !this.cancelled.has(event.id))
        .map(event => cloneJson(event))
    };
  }

  restore(snapshot) {
    if (this.running) throw new Error('cannot restore while the runtime is advancing');
    if (!snapshot || snapshot.schema !== SNAPSHOT_SCHEMA) {
      throw new TypeError('unsupported temporal snapshot schema');
    }

    const now = finiteTime(snapshot.now, 'snapshot.now');
    if (!Number.isInteger(snapshot.nextSequence) || snapshot.nextSequence < 1) {
      throw new TypeError('snapshot.nextSequence must be a positive integer');
    }
    if (!Array.isArray(snapshot.events)) throw new TypeError('snapshot.events must be an array');

    const ids = new Set();
    const sequences = new Set();
    const events = snapshot.events.map((source, index) => {
      if (!source || typeof source !== 'object') throw new TypeError('invalid event at index ' + index);
      const at = finiteTime(source.at, 'event.at');
      if (at < now) throw new RangeError('snapshot contains an event in the virtual past');
      if (!Number.isInteger(source.sequence) || source.sequence < 1) {
        throw new TypeError('invalid event sequence');
      }
      const expectedId = 'event-' + String(source.sequence).padStart(8, '0');
      if (source.id !== expectedId) throw new TypeError('event id does not match its sequence');
      if (ids.has(source.id) || sequences.has(source.sequence)) {
        throw new TypeError('duplicate event identity or sequence');
      }
      if (typeof source.handler !== 'string' || !this.handlers.has(source.handler)) {
        throw new Error('snapshot requires unregistered handler: ' + source.handler);
      }
      ids.add(source.id);
      sequences.add(source.sequence);
      return {
        id: source.id,
        at,
        sequence: source.sequence,
        handler: source.handler,
        payload: cloneJson(source.payload, 'snapshot event payload')
      };
    });

    if (events.some(event => event.sequence >= snapshot.nextSequence)) {
      throw new RangeError('snapshot.nextSequence must exceed every pending event sequence');
    }
    events.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
    this.now = now;
    this.nextSequence = snapshot.nextSequence;
    this.events = events;
    this.cancelled.clear();
    return this;
  }

  get pendingCount() {
    return this.events.filter(event => !this.cancelled.has(event.id)).length;
  }
}

module.exports = {
  TemporalRuntime,
  SNAPSHOT_SCHEMA,
  MAX_EVENTS_PER_ADVANCE
};
