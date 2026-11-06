'use strict';

// Loopback-only HTTP binding. Reach it remotely only through an operator-managed SSH tunnel.
const http = require('node:http');
const { PROTOCOL } = require('./federation-protocol.cjs');

const MAX_BODY_BYTES = 256 * 1024;
const SESSION_CAP = 2048;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

function json(response, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': encoded.length,
    'cache-control': 'no-store',
    'connection': 'close',
    'x-content-type-options': 'nosniff'
  });
  response.end(encoded);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body exceeds limit'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON body must be an object');
        resolve(value);
      } catch (error) {
        reject(Object.assign(new Error('invalid JSON request body'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function createFederationHttpServer({ protocol, taskAdapter, authorizeTaskRead = async () => false, host = '127.0.0.1', port = 18100, clock = () => Date.now() }) {
  if (!protocol || typeof protocol.acceptHello !== 'function' || typeof protocol.verifyPeerMessage !== 'function') {
    throw new Error('configured federation protocol instance is required');
  }
  if (!taskAdapter || typeof taskAdapter.createFromCanonical !== 'function') {
    throw new Error('canonical shared-task adapter is required');
  }
  if (typeof authorizeTaskRead !== 'function') throw new Error('trusted task-read authorizer is required');
  if (host !== '127.0.0.1') throw new Error('federation HTTP server must bind to 127.0.0.1 only');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be 0..65535');
  if (typeof clock !== 'function') throw new Error('clock must be a function');

  const sessions = new Map();

  function pruneSessions(now) {
    for (const [nonce, session] of sessions) if (session.expiresAt <= now) sessions.delete(nonce);
    while (sessions.size > SESSION_CAP) sessions.delete(sessions.keys().next().value);
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (request.method === 'GET' && url.pathname === '/health') {
        return json(response, 200, { ok: true, service: 'heavenzfire-federation-http', protocol: PROTOCOL, bind: '127.0.0.1' });
      }
      if (request.method !== 'POST' || !['/v1/handshake', '/v1/tasks', '/v1/tasks/get'].includes(url.pathname)) {
        return json(response, 404, { ok: false, error: 'not_found' });
      }
      if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
        return json(response, 415, { ok: false, error: 'application_json_required' });
      }
      const body = await readJson(request);
      const now = clock();
      if (!Number.isFinite(now)) throw new Error('clock returned invalid timestamp');
      pruneSessions(now);

      if (url.pathname === '/v1/handshake') {
        const ack = protocol.acceptHello(body);
        sessions.set(body.nonce, {
          peerId: body.from,
          nonce: body.nonce,
          capabilities: ack.grantedCapabilities,
          expiresAt: ack.expiresAt
        });
        return json(response, 200, { ok: true, ack });
      }

      const session = sessions.get(body.sessionNonce);
      if (!session || session.expiresAt <= now) return json(response, 401, { ok: false, error: 'session_missing_or_expired' });
      if (!protocol.verifyPeerMessage(session.peerId, body)) return json(response, 401, { ok: false, error: 'message_authentication_failed' });
      if (body.protocol !== PROTOCOL || body.sessionNonce !== session.nonce) {
        return json(response, 400, { ok: false, error: 'invalid_session_message' });
      }
      if (url.pathname === '/v1/tasks') {
        if (!session.capabilities.includes('task.submit')) return json(response, 403, { ok: false, error: 'capability_denied' });
        if (body.type !== 'task_submit' || !body.taskRecord || typeof body.taskRecord !== 'object') {
          return json(response, 400, { ok: false, error: 'invalid_task_message' });
        }
        const created = await taskAdapter.createFromCanonical(body.taskRecord, { approvalProof: body.approvalProof });
        return json(response, 202, { ok: true, taskId: created.id, status: created.status });
      }
      if (!session.capabilities.includes('task.read')) return json(response, 403, { ok: false, error: 'capability_denied' });
      if (body.type !== 'task_get' || typeof body.taskId !== 'string' || typeof taskAdapter.projectToCanonical !== 'function') {
        return json(response, 400, { ok: false, error: 'invalid_task_query' });
      }
      const readDecision = await authorizeTaskRead(Object.freeze({
        peerId: session.peerId,
        taskId: body.taskId,
        session: Object.freeze({ capabilities: Object.freeze([...session.capabilities]), expiresAt: session.expiresAt })
      }));
      if (!readDecision || readDecision.allow !== true) return json(response, 403, { ok: false, error: 'task_read_denied' });
      const projection = await taskAdapter.projectToCanonical(body.taskId);
      if (!projection) return json(response, 404, { ok: false, error: 'task_not_found' });
      return json(response, 200, { ok: true, projection });
    } catch (error) {
      const status = Number.isInteger(error.statusCode) ? error.statusCode : 400;
      if (!response.headersSent) json(response, status, { ok: false, error: String(error.message || 'request_failed').slice(0, 512) });
      else response.destroy();
    }
  });

  return Object.freeze({
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        const onError = error => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const address = server.address();
      return Object.freeze({ host, port: address.port, service: 'heavenzfire-federation-http', protocol: PROTOCOL });
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        // Close remaining HTTP connections after the listener stops accepting
        // requests; explicit shutdown must not hang on remote keep-alive pools.
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        else if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      });
    },
    sessionCount() { return sessions.size; }
  });
}

module.exports = { createFederationHttpServer };
