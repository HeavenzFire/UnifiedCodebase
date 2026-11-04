'use strict';
const http = require('node:http');
const { URL } = require('node:url');

const ENGINE_NAME = 'heavenzfire-local-inference';
const DEFAULT_BACKEND = 'http://127.0.0.1:11800';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 11820;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES = 128;
const MAX_CONTENT_CHARS = 200000;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

function isLoopback(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(hostname).toLowerCase());
}
function validateBackendUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw Error('backendUrl must be a valid URL'); }
  if (parsed.protocol !== 'http:' || !isLoopback(parsed.hostname) ||
      parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw Error('backendUrl must be plain HTTP loopback without credentials, query, or fragment');
  }
  return parsed;
}
function validateBindHost(host) {
  if (!isLoopback(host)) throw Error('Local inference engine must bind to loopback only');
  return host;
}
function json(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8',
    'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(body);
}
async function readJson(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) { const error = Error('request body exceeds configured byte limit'); error.statusCode = 413; throw error; }
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { const error = Error('request body must be valid JSON'); error.statusCode = 400; throw error; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const error = Error('request body must be a JSON object'); error.statusCode = 400; throw error;
  }
  return parsed;
}
function validateChatRequest(body) {
  if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > MAX_MESSAGES)
    throw Error('messages must contain 1..' + MAX_MESSAGES + ' entries');
  if (body.model !== undefined && (typeof body.model !== 'string' || !body.model.trim() || body.model.length > 128))
    throw Error('model must be a non-empty string of at most 128 characters');
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw Error('stream must be boolean');
  if (body.max_tokens !== undefined && (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 4096))
    throw Error('max_tokens must be an integer from 1 to 4096');
  let total = 0;
  for (const message of body.messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message) || !ROLES.has(message.role))
      throw Error('each message must have a supported role');
    const content = message.content;
    if (typeof content !== 'string' && !Array.isArray(content))
      throw Error('message content must be text or a content-parts array');
    total += typeof content === 'string' ? content.length : JSON.stringify(content).length;
    if (total > MAX_CONTENT_CHARS) throw Error('combined message content exceeds configured character limit');
  }
  return body;
}
function createLocalInferenceEngine({
  backendUrl = process.env.HEAVENZFIRE_INFERENCE_BACKEND || DEFAULT_BACKEND,
  host = process.env.HEAVENZFIRE_INFERENCE_HOST || DEFAULT_HOST,
  port = Number(process.env.HEAVENZFIRE_INFERENCE_PORT || DEFAULT_PORT),
  fetchImpl = globalThis.fetch,
  timeoutMs = 120000
} = {}) {
  const backend = validateBackendUrl(backendUrl);
  validateBindHost(host);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('port must be an integer from 0 to 65535');
  if (typeof fetchImpl !== 'function') throw Error('fetch implementation is required');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw Error('timeoutMs must be 1000..600000');

  async function upstream(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(Error('local inference backend timed out')), timeoutMs);
    if (options.signal) {
      if (options.signal.aborted) controller.abort(options.signal.reason);
      else options.signal.addEventListener('abort', () => controller.abort(options.signal.reason), { once: true });
    }
    try { return await fetchImpl(new URL(path, backend.origin), { ...options, redirect: 'error', signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  }

  const server = http.createServer(async (req, res) => {
    const hostHeader = String(req.headers.host || '').split(':')[0].replace(/^\[|\]$/g, '');
    if (!isLoopback(hostHeader)) return json(res, 403, { error: 'loopback Host header required' });
    const origin = req.headers.origin;
    if (origin) {
      let parsedOrigin;
      try { parsedOrigin = new URL(origin); } catch { return json(res, 403, { error: 'invalid Origin header' }); }
      if (!isLoopback(parsedOrigin.hostname)) return json(res, 403, { error: 'loopback Origin required' });
    }
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
      try {
        const response = await upstream('/health');
        const text = await response.text();
        let details = null;
        try { details = JSON.parse(text); } catch {}
        const ready = response.ok && (!details || ['ok', 'healthy'].includes(details.status));
        return json(res, ready ? 200 : 503, { engine: ENGINE_NAME, status: ready ? 'ok' : 'degraded',
          backend: 'llama.cpp-compatible', backendStatus: response.status, details });
      } catch (error) {
        return json(res, 503, { engine: ENGINE_NAME, status: 'degraded',
          backend: 'llama.cpp-compatible', error: error.message });
      }
    }
    if (req.method === 'GET' && pathname === '/v1/models') {
      try {
        const response = await upstream('/v1/models');
        const body = await response.text();
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store' });
        return res.end(body);
      } catch (error) {
        return json(res, 502, { error: { message: 'local model discovery failed: ' + error.message, type: 'upstream_error' } });
      }
    }
    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      let body;
      try { body = validateChatRequest(await readJson(req)); }
      catch (error) { return json(res, error.statusCode || 400, { error: { message: error.message, type: 'invalid_request_error' } }); }
      const controller = new AbortController();
      res.on('close', () => { if (!res.writableEnded) controller.abort(Error('client disconnected')); });
      try {
        const response = await upstream('/v1/chat/completions', { method: 'POST',
          headers: { 'content-type': 'application/json', accept: body.stream ? 'text/event-stream' : 'application/json' },
          body: JSON.stringify(body), signal: controller.signal });
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') || 'application/json',
          'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        if (!response.body) return res.end();
        for await (const chunk of response.body) {
          if (!res.write(Buffer.from(chunk))) await new Promise(resolve => res.once('drain', resolve));
        }
        return res.end();
      } catch (error) {
        if (!res.headersSent) return json(res, 502, { error: { message: 'local inference request failed: ' + error.message, type: 'upstream_error' } });
        return res.destroy(error);
      }
    }
    return json(res, 404, { error: { message: 'route not found', type: 'not_found' } });
  });

  return {
    server, host, port, backendUrl: backend.origin,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(server.address()); };
        server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
      });
    },
    close() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
  };
}
if (require.main === module) {
  const engine = createLocalInferenceEngine();
  engine.listen().then(address => process.stdout.write(JSON.stringify({
    event: 'listening', engine: ENGINE_NAME, address: address.address, port: address.port, backend: engine.backendUrl
  }) + '\n')).catch(error => { process.stderr.write('local inference engine failed to start: ' + error.message + '\n'); process.exitCode = 1; });
}
module.exports = { createLocalInferenceEngine, validateBackendUrl, validateBindHost, validateChatRequest, MAX_BODY_BYTES };
