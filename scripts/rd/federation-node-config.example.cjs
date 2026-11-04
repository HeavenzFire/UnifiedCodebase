'use strict';

// Copy this file outside the repository and point HF_FEDERATION_NODE_CONFIG
// at the copy. Peer and operator secrets must remain in local environment
// variables or an OS-protected secret store; never commit them.
const path = require('node:path');
const os = require('node:os');
const root = process.env.HF_UNIFIEDCODEBASE_ROOT;
if (!root) throw new Error('HF_UNIFIEDCODEBASE_ROOT is required');

const { TaskLedger } = require(path.join(root, 'MicroFederation/task-ledger.cjs'));
const { createOperatorApprovalAuthority } = require(path.join(root, 'MicroFederation/operator-approval.cjs'));

const contractPath = process.env.HF_SHARED_TASK_CONTRACT_MODULE;
const capabilityGatePath = process.env.HF_CAPABILITY_GATE_MODULE;
const peersJson = process.env.HF_FEDERATION_PEERS_JSON;
if (!contractPath || !capabilityGatePath || !peersJson) {
  throw new Error('Set HF_SHARED_TASK_CONTRACT_MODULE, HF_CAPABILITY_GATE_MODULE, and HF_FEDERATION_PEERS_JSON');
}
if (!process.env.HF_OPERATOR_APPROVAL_SECRET || Buffer.byteLength(process.env.HF_OPERATOR_APPROVAL_SECRET, 'utf8') < 32) {
  throw new Error('HF_OPERATOR_APPROVAL_SECRET must contain at least 32 UTF-8 bytes');
}

const contract = require(path.resolve(contractPath));
const capabilityGate = require(path.resolve(capabilityGatePath));
if (!capabilityGate || typeof capabilityGate.authorize !== 'function') {
  throw new Error('capability gate module must export authorize(input)');
}
const approvalAuthority = createOperatorApprovalAuthority({ secret: process.env.HF_OPERATOR_APPROVAL_SECRET });

module.exports = {
  nodeId: process.env.HF_NODE_ID || 'windows-zdh',
  peers: JSON.parse(peersJson),
  ledger: new TaskLedger(process.env.HF_LEDGER_PATH || path.join(os.homedir(), '.heavenzfire', 'federation', 'task-ledger.json')),
  contract,
  verifyApproval: approvalAuthority.verifyApproval,
  verifyAttestation: approvalAuthority.verifyAttestation,
  capabilityGate,
  inferenceBaseUrl: process.env.HF_INFERENCE_BASE_URL || 'http://127.0.0.1:11820',
  inferenceModel: process.env.HF_INFERENCE_MODEL || 'heavenzfire-qwen-0.5b',
  workerId: process.env.HF_WORKER_ID || 'windows-zdh-worker',
  host: '127.0.0.1',
  port: Number(process.env.HF_FEDERATION_PORT || 18100),
  leaseMs: 120000,
  pollMs: 1000,
  onWorkerError(error) {
    process.stderr.write('FEDERATION_WORKER_ERROR: ' + String(error && error.message || error).slice(0, 512) + '\n');
  }
};
