'use strict';

// Copy this file outside the repository and point HF_FEDERATION_NODE_CONFIG
// at the copy. Keep peer secrets and verifier code out of the repository.
const path = require('node:path');
const os = require('node:os');
const { TaskLedger } = require(path.join(process.env.HF_UNIFIEDCODEBASE_ROOT, 'MicroFederation/task-ledger.cjs'));

const contractPath = process.env.HF_SHARED_TASK_CONTRACT_MODULE;
const verifierPath = process.env.HF_APPROVAL_VERIFIER_MODULE;
const peersJson = process.env.HF_FEDERATION_PEERS_JSON;
if (!process.env.HF_UNIFIEDCODEBASE_ROOT || !contractPath || !verifierPath || !peersJson) {
  throw new Error('Set HF_UNIFIEDCODEBASE_ROOT, HF_SHARED_TASK_CONTRACT_MODULE, HF_APPROVAL_VERIFIER_MODULE, and HF_FEDERATION_PEERS_JSON');
}

const contract = require(path.resolve(contractPath));
const verifier = require(path.resolve(verifierPath));

module.exports = {
  nodeId: process.env.HF_NODE_ID || 'windows-zdh',
  peers: JSON.parse(peersJson),
  ledger: new TaskLedger(process.env.HF_LEDGER_PATH || path.join(os.homedir(), '.heavenzfire', 'federation', 'task-ledger.json')),
  contract,
  verifyApproval: verifier.verifyApproval,
  verifyAttestation: verifier.verifyAttestation,
  inferenceBaseUrl: process.env.HF_INFERENCE_BASE_URL || 'http://127.0.0.1:11820',
  inferenceModel: process.env.HF_INFERENCE_MODEL || 'heavenzfire-qwen-0.5b',
  workerId: process.env.HF_WORKER_ID || 'windows-zdh-worker',
  host: '127.0.0.1',
  port: Number(process.env.HF_FEDERATION_PORT || 18100),
  leaseMs: 120000,
  pollMs: 500,
  onWorkerError(error) {
    process.stderr.write('FEDERATION_WORKER_ERROR: ' + String(error && error.message || error).slice(0, 512) + '\n');
  }
};
