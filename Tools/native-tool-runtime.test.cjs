'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolRegistry, ToolRuntime } = require('./native-tool-runtime.cjs');

const schema = {
  type: 'object',
  properties: {
    text: { type: 'string', minLength: 1, maxLength: 100 },
    mode: { type: 'string', enum: ['summary', 'classify'] }
  },
  required: ['text', 'mode'],
  additionalProperties: false
};
const principal = { agentId: 'agent-test', grantId: 'grant-test', taskId: 'task-test' };
function fixture(options = {}) {
  const registry = new ToolRegistry();
  const events = [];
  let calls = 0;
  registry.register({
    id: 'text.inspect',
    version: '1.0.0',
    description: 'Inspect a bounded text input.',
    capability: 'research.inspect',
    inputSchema: schema,
    handler: async input => { calls++; return { length: input.text.length, mode: input.mode }; }
  });
  const runtime = new ToolRuntime({
    registry,
    authorize: options.authorize || (async () => ({ allow: true, reason: 'test-grant' })),
    recordEvidence: options.recordEvidence || (async event => events.push(event)),
    maxInputBytes: 4096,
    maxOutputBytes: 4096
  });
  return { registry, runtime, events, get calls() { return calls; } };
}

test('registry exposes metadata but never exposes executable handler references', () => {
  const { registry } = fixture();
  const listed = registry.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, 'text.inspect');
  assert.equal(Object.hasOwn(listed[0], 'handler'), false);
});

test('registry rejects duplicate IDs, unsupported fields and unbounded object schemas', () => {
  const { registry } = fixture();
  assert.throws(() => registry.register({
    id: 'text.inspect', version: '1.0.0', description: 'duplicate',
    capability: 'research.inspect', inputSchema: schema, handler: async () => ({})
  }), /already registered/);
  assert.throws(() => registry.register({
    id: 'tool.bad', version: '1.0.0', description: 'bad field',
    capability: 'research.inspect', inputSchema: schema, handler: async () => ({}), shell: true
  }), /unsupported tool field/);
  assert.throws(() => registry.register({
    id: 'tool.open', version: '1.0.0', description: 'open schema',
    capability: 'research.inspect',
    inputSchema: { type: 'object', properties: {}, additionalProperties: true },
    handler: async () => ({})
  }), /additionalProperties/);
});

test('input schema rejects missing fields, unknown fields, wrong types and invalid enums before execution', async () => {
  const f = fixture();
  await assert.rejects(f.runtime.execute({ toolId: 'text.inspect', input: { text: 'x' }, principal }), /validation failed/);
  await assert.rejects(f.runtime.execute({
    toolId: 'text.inspect', input: { text: 'x', mode: 'run', extra: true }, principal
  }), /validation failed/);
  assert.equal(f.calls, 0);
});

test('authorization is mandatory and denied calls never reach the handler', async () => {
  const f = fixture({ authorize: async () => ({ allow: false, reason: 'missing_grant' }) });
  await assert.rejects(f.runtime.execute({
    toolId: 'text.inspect', input: { text: 'hello', mode: 'summary' }, principal
  }), /denied: missing_grant/);
  assert.equal(f.calls, 0);
  assert.equal(f.events[0].status, 'denied');
});

test('successful execution records input/output digests and tool provenance', async () => {
  const f = fixture();
  const result = await f.runtime.execute({
    toolId: 'text.inspect', input: { text: 'hello', mode: 'summary' }, principal
  });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.output, { length: 5, mode: 'summary' });
  assert.match(result.evidence.inputHash, /^[a-f0-9]{64}$/);
  assert.match(result.evidence.outputHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(f.events.map(event => event.status), ['started', 'succeeded']);
  assert.equal(f.events[1].toolVersion, '1.0.0');
  assert.equal(Object.hasOwn(f.events[0], 'input'), false);
});

test('trusted approval evidence returned by the gate is attached to execution evidence', async () => {
  let request;
  const f = fixture({
    authorize: async value => {
      request = value;
      return { allow: true, approvalEvidenceRef: 'approval:trusted:42' };
    }
  });
  await f.runtime.execute({
    toolId: 'text.inspect', input: { text: 'hello', mode: 'summary' }, principal,
    approvalRequestId: 'approval-request-42'
  });
  assert.equal(request.approvalRequestId, 'approval-request-42');
  assert.equal(f.events[0].approvalEvidenceRef, 'approval:trusted:42');
});

test('handler failures are recorded and propagated without automatic retry', async () => {
  const registry = new ToolRegistry();
  const events = [];
  registry.register({
    id: 'test.failure', version: '1.0.0', description: 'Fail deterministically.',
    capability: 'test.execute', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => { throw Error('controlled failure'); }
  });
  const runtime = new ToolRuntime({
    registry, authorize: async () => ({ allow: true }),
    recordEvidence: async event => events.push(event)
  });
  await assert.rejects(runtime.execute({ toolId: 'test.failure', input: {}, principal }), /controlled failure/);
  assert.deepEqual(events.map(event => event.status), ['started', 'failed']);
});

test('timeouts abort cooperative handlers and are recorded', async () => {
  const registry = new ToolRegistry();
  const events = [];
  let aborted = false;
  registry.register({
    id: 'test.timeout', version: '1.0.0', description: 'Wait for cancellation.',
    capability: 'test.execute', timeoutMs: 20,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async (_input, context) => new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => { aborted = true; reject(Error('aborted')); }, { once: true });
    })
  });
  const runtime = new ToolRuntime({
    registry, authorize: async () => ({ allow: true }),
    recordEvidence: async event => events.push(event)
  });
  await assert.rejects(runtime.execute({ toolId: 'test.timeout', input: {}, principal }), /timed out/);
  assert.equal(aborted, true);
  assert.equal(events.at(-1).status, 'failed');
});

test('invalid principals and oversized inputs fail before authorization', async () => {
  let authorized = false;
  const f = fixture({ authorize: async () => { authorized = true; return { allow: true }; } });
  await assert.rejects(f.runtime.execute({
    toolId: 'text.inspect', input: { text: 'ok', mode: 'summary' }, principal: { agentId: 'bad id', grantId: 'grant-test' }
  }), /principal/);
  await assert.rejects(f.runtime.execute({
    toolId: 'text.inspect', input: { text: 'x'.repeat(5000), mode: 'summary' }, principal
  }), /maxInputBytes/);
  assert.equal(authorized, false);
});

test('evidence write failure before handler prevents tool execution', async () => {
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({
    id: 'test.evidence', version: '1.0.0', description: 'Requires evidence.',
    capability: 'test.execute', inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => { calls++; return { ok: true }; }
  });
  const runtime = new ToolRuntime({
    registry, authorize: async () => ({ allow: true }),
    recordEvidence: async () => { throw Error('evidence store unavailable'); }
  });
  await assert.rejects(runtime.execute({ toolId: 'test.evidence', input: {}, principal }), /evidence store unavailable/);
  assert.equal(calls, 0);
});
