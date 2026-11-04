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
    capabilities: ['task.submit', 'task.read'],
    peers: [{
      nodeId: peerNodeId,
      secret,
      approved: true,
      approvedAt,
      allowedCapabilities: ['task.submit', 'task.read']
    }]
  });
  const client = createFederationHttpClient({ protocol, peerNodeId, baseUrl });
  const session = await client.handshake(['task.submit', 'task.read']);
  if (session.state !== 'AUTHENTICATED' ||
      !session.grantedCapabilities.includes('task.submit') ||
      !session.grantedCapabilities.includes('task.read')) {
    throw new Error('peer handshake did not grant task.submit and task.read');
  }
  const receipt = await client.submitTask(pack.record, pack.approvalProof);
  if (receipt.ok !== true || receipt.taskId !== pack.record.taskId) throw new Error('task submission receipt did not match the approved task');
  process.stdout.write(JSON.stringify({ state: 'TASK_SUBMITTED', peer: peerNodeId, protocol: session.protocol,
    taskId: receipt.taskId, ledgerStatus: receipt.status, accepted: true }) + '\n');

  const deadline = Date.now() + 50000;
  while (Date.now() < deadline) {
    const response = await client.getTask(receipt.taskId);
    const projection = response.projection;
    const canonicalStatus = projection && projection.canonicalRecord && projection.canonicalRecord.status;
    const ledger = projection && projection.ledger;
    if (canonicalStatus === 'completed' && ledger && ledger.status === 'succeeded') {
      process.stdout.write(JSON.stringify({ state: 'TASK_COMPLETED', taskId: receipt.taskId,
        canonicalStatus, ledgerStatus: ledger.status, result: ledger.result }) + '\\n');
      return;
    }
    if (canonicalStatus === 'failed' || (ledger && ledger.status === 'failed')) {
      throw new Error('governed worker failed task: ' + String(ledger && ledger.error || 'unspecified failure'));
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('task did not complete within 50 seconds; inspect the Windows worker ledger before retrying');
}

main().catch(error => {
  process.stderr.write('FEDERATION_SUBMIT_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
