'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createLocalInferenceEngine, validateBackendUrl, validateBindHost, isLoopbackHostHeader, validateChatRequest } = require('./local-inference-engine.cjs');

async function startServer(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: 'http://127.0.0.1:' + server.address().port,
    close: () => new Promise(resolve => server.close(resolve)) };
}

test('backend and bind targets are restricted to loopback', () => {
  assert.equal(validateBackendUrl('http://127.0.0.1:11800').hostname, '127.0.0.1');
  assert.throws(() => validateBackendUrl('https://example.com'), /plain HTTP loopback/);
  assert.throws(() => validateBackendUrl('http://user:pass@127.0.0.1:11800'), /plain HTTP loopback/);
  assert.throws(() => validateBackendUrl('http://127.0.0.1:11800/?token=x'), /plain HTTP loopback/);
  assert.throws(() => validateBindHost('0.0.0.0'), /loopback only/);
  assert.equal(isLoopbackHostHeader('127.0.0.1:11820'), true);
  assert.equal(isLoopbackHostHeader('localhost:11820'), true);
  assert.equal(isLoopbackHostHeader('[::1]:11820'), true);
  assert.equal(isLoopbackHostHeader('127.0.0.1.evil:11820'), false);
  assert.equal(isLoopbackHostHeader('user@127.0.0.1:11820'), false);
});

test('chat request schema enforces bounded roles, messages and tokens', () => {
  assert.equal(validateChatRequest({ messages: [{ role: 'user', content: 'hello' }] }).messages.length, 1);
  assert.throws(() => validateChatRequest({ messages: [] }), /1\.\.128/);
  assert.throws(() => validateChatRequest({ messages: [{ role: 'root', content: 'hello' }] }), /supported role/);
  assert.throws(() => validateChatRequest({ messages: [{ role: 'user', content: 'hello' }], max_tokens: 99999 }), /1 to 4096/);
});

test('health and model discovery are served through the local facade', async t => {
  const backend = await startServer((req, res) => {
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"status":"ok"}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":[{"id":"qwen-local"}]}'); }
    res.writeHead(404); res.end();
  });
  const engine = createLocalInferenceEngine({ backendUrl: backend.url, port: 0 });
  t.after(async () => { await engine.close(); await backend.close(); });
  const address = await engine.listen();
  const base = 'http://127.0.0.1:' + address.port;
  const health = await fetch(base + '/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).engine, 'heavenzfire-local-inference');
  const models = await fetch(base + '/v1/models');
  assert.deepEqual(await models.json(), { data: [{ id: 'qwen-local' }] });
});

test('chat completions proxy JSON and preserve streaming responses', async t => {
  const backend = await startServer(async (req, res) => {
    if (req.url !== '/v1/chat/completions') { res.writeHead(404); return res.end(); }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"choices":[{"delta":{"content":"local"}}]}\n\ndata: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'chatcmpl-test', choices: [{ message: { role: 'assistant', content: 'local answer' } }] }));
    }
  });
  const engine = createLocalInferenceEngine({ backendUrl: backend.url, port: 0 });
  t.after(async () => { await engine.close(); await backend.close(); });
  const address = await engine.listen();
  const base = 'http://127.0.0.1:' + address.port;
  const payload = { model: 'qwen-local', messages: [{ role: 'user', content: 'hello' }] };
  const normal = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await normal.json()).choices[0].message.content, 'local answer');
  const streamed = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...payload, stream: true }) });
  assert.match(await streamed.text(), /data: \[DONE\]/);
});

test('invalid requests and non-loopback browser origins are rejected', async t => {
  const backend = await startServer((req, res) => { res.writeHead(200); res.end('{"status":"ok"}'); });
  const engine = createLocalInferenceEngine({ backendUrl: backend.url, port: 0 });
  t.after(async () => { await engine.close(); await backend.close(); });
  const address = await engine.listen();
  const base = 'http://127.0.0.1:' + address.port;
  const invalid = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"messages":[]}' });
  assert.equal(invalid.status, 400);
  const origin = await fetch(base + '/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(origin.status, 403);
});
