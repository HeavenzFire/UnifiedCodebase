'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createFederationProtocol } = require('../../MicroFederation/federation-protocol.cjs');
const { createFederationHttpClient } = require('../../MicroFederation/federation-http-client.cjs');

async function main() {
  const [packagePath] = process.argv.slice(2);
  if (!packagePath) throw new Error('Usage: node scripts/rd/submit-federation-task.cjs <approval-package.json>');
  const nodeId = process.env.HF_FEDERATION_NODE_ID || 'android-a67l';
  const peerNodeId = process.env.HF_FEDERATION_PEER_ID || 'windows-zdh';
  const secret = process.env.HF_FEDERATION_PEER_SECRET;
  const approvedAt = process.env.HF_FEDERATION_PEER_APPROVED_AT;
  const baseUrl = process.env.HF_FEDERATION_BASE_URL || 'http://127.0.0.1:18100';
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('HF_FEDERATION_PEER_SECRET must contain at least 32 UTF-8 bytes');
  }
  if (process.env.HF_FEDERATION_PEER_APPROVED !== 'true') {
    throw new Error('HF_FEDERATION_PEER_APPROVED=true is required for explicit local peer enrollment');
  }
  if (!approvedAt || !Number.isFinite(Date.parse(approvedAt))) {
    throw new Error('HF_FEDERATION_PEER_APPROVED_AT must be a valid ISO timestamp');
  }
  const pack = JSON.parse(await fs.readFile(path.resolve(packagePath), 'utf8'));
  if (!pack || !pack.record || !pack.approvalProof) throw new Error('approval package must contain record and approvalProof');
  if (pack.record.status !== 'approved' || pack.record.approvalState !== 'approved') {
    throw new Error('only an explicitly approved canonical task can be submitted');
  }

  const protocol = createFederationProtocol({
    nodeId,
    capabilities: ['task.submit'],
    peers: [{
      nodeId: peerNodeId,
      secret,
      approved: true,
      approvedAt,
      allowedCapabilities: ['task.submit']
    }]
  });
  const client = createFederationHttpClient({ protocol, peerNodeId, baseUrl });
  const session = await client.handshake(['task.submit']);
  if (session.state !== 'AUTHENTICATED' || !session.grantedCapabilities.includes('task.submit')) {
    throw new Error('peer handshake did not grant task.submit');
  }
  const receipt = await client.submitTask(pack.record, pack.approvalProof);
  process.stdout.write(JSON.stringify({
    state: 'TASK_SUBMITTED',
    peer: peerNodeId,
    protocol: session.protocol,
    taskId: receipt.taskId,
    ledgerStatus: receipt.status,
    accepted: receipt.ok === true
  }) + '\n');
}

main().catch(error => {
  process.stderr.write('FEDERATION_SUBMIT_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
