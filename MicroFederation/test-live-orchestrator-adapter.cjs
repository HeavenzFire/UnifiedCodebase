'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveOrchestratorAdapter } = require('./live-orchestrator-adapter.cjs');

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(body); } };
}

test('adapter retries only transient HTTP 5xx and reports attempts', async () => {
  let calls = 0;
  const adapter = new LiveOrchestratorAdapter({
    fetchImpl: async () => (++calls < 3 ? response(503, { ok: false, error: 'busy' }) :
      response(200, { ok: true, model: 'qwen-local', response: 'ready' })),
    sleep: async () => {},
    retryBaseMs: 1
  });
  const result = await adapter.run({ taskId: 't-1', role: 'planner', prompt: 'hello' });
  assert.equal(calls, 3);
  assert.equal(result.attempts, 3);
  assert.equal(result.response, 'ready');
});

test('adapter does not retry client errors and caps exhausted 5xx retries', async () => {
  let clientCalls = 0;
  const client = new LiveOrchestratorAdapter({
    fetchImpl: async () => { clientCalls++; return response(400, { ok: false, error: 'bad request' }); },
    sleep: async () => {}
  });
  await assert.rejects(client.run({ taskId: 't-2', role: 'planner', prompt: 'hello' }), /HTTP 400/);
  assert.equal(clientCalls, 1);

  let serverCalls = 0;
  const server = new LiveOrchestratorAdapter({
    fetchImpl: async () => { serverCalls++; return response(503, { ok: false, error: 'busy' }); },
    sleep: async () => {}
  });
  await assert.rejects(server.run({ taskId: 't-3', role: 'planner', prompt: 'hello' }), /HTTP 503/);
  assert.equal(serverCalls, 3);
});

test('adapter forwards AbortSignal and stops inference when caller cancels', async () => {
  const controller = new AbortController();
  let receivedSignal;
  const adapter = new LiveOrchestratorAdapter({
    fetchImpl: async (_url, options) => {
      receivedSignal = options.signal;
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      });
    },
    timeoutMs: 5000
  });
  const pending = adapter.run({ taskId: 't-4', role: 'planner', prompt: 'hello', signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve));
  controller.abort('operator cancelled');
  await assert.rejects(pending, error => error.name === 'AbortError' && /operator cancelled/.test(error.message));
  assert.ok(receivedSignal);
  assert.equal(receivedSignal.aborted, true);
});

test('adapter serializes calls through its queue', async () => {
  let active = 0, maxActive = 0;
  const adapter = new LiveOrchestratorAdapter({
    fetchImpl: async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 5));
      active--;
      return response(200, { ok: true, response: 'ok' });
    }
  });
  await Promise.all([
    adapter.run({ taskId: 't-5', role: 'planner', prompt: 'one' }),
    adapter.run({ taskId: 't-6', role: 'architect', prompt: 'two' })
  ]);
  assert.equal(maxActive, 1);
});


test('adapter rejects remote, HTTPS, and credential-bearing endpoints', () => {
  assert.throws(() => new LiveOrchestratorAdapter({ endpoint: 'https://api.example.com/task' }), /loopback/);
  assert.throws(() => new LiveOrchestratorAdapter({ endpoint: 'http://192.168.1.2:8788/task' }), /loopback/);
  assert.throws(() => new LiveOrchestratorAdapter({ endpoint: 'http://user:pass@127.0.0.1:8788/task' }), /loopback/);
});
