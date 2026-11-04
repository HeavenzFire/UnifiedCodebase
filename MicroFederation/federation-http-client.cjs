'use strict';

const { PROTOCOL } = require('./federation-protocol.cjs');

function assertLoopbackUrl(value) {
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('federation client accepts loopback URLs only; use an SSH local-forward endpoint');
  }
  if (url.protocol !== 'http:') throw new Error('federation loopback endpoint must use HTTP inside the SSH tunnel');
  return url;
}

function createFederationHttpClient({ protocol, peerNodeId, baseUrl, fetchImpl = globalThis.fetch }) {
  if (!protocol || typeof protocol.createHello !== 'function' || typeof protocol.verifyAck !== 'function' ||
      typeof protocol.signPeerMessage !== 'function') throw new Error('configured federation protocol instance is required');
  if (typeof peerNodeId !== 'string' || !peerNodeId) throw new Error('peerNodeId is required');
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  const base = assertLoopbackUrl(baseUrl);
  let session = null;

  async function post(path, body) {
    const url = new URL(path, base);
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json();
    if (!response.ok || data.ok !== true) throw new Error('federation request failed (' + response.status + '): ' + String(data.error || 'unknown_error'));
    return data;
  }

  async function handshake(capabilities = ['task.submit']) {
    const hello = protocol.createHello(peerNodeId, capabilities);
    const result = await post('/v1/handshake', hello);
    const authenticated = protocol.verifyAck(result.ack, peerNodeId, hello);
    session = Object.freeze({ nonce: hello.nonce, authenticated });
    return authenticated;
  }

  async function submitTask(taskRecord, approvalProof) {
    if (!session) throw new Error('federation handshake is required before task submission');
    if (!session.authenticated.grantedCapabilities.includes('task.submit')) throw new Error('authenticated session lacks task.submit capability');
    const body = protocol.signPeerMessage(peerNodeId, {
      protocol: PROTOCOL,
      type: 'task_submit',
      sessionNonce: session.nonce,
      taskRecord,
      approvalProof
    });
    return post('/v1/tasks', body);
  }

  return Object.freeze({ handshake, submitTask, getSession: () => session });
}

module.exports = { createFederationHttpClient };
