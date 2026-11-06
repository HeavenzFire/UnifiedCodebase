'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createOperatorApprovalAuthority } = require('../../MicroFederation/operator-approval.cjs');

async function writePrivateJson(file, value) {
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = target + '.' + process.pid + '.tmp';
  let handle;
  try {
    handle = await fs.open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, target);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temp).catch(() => {});
    throw error;
  }
}

async function main() {
  const [inputPath, outputPath, actor, summaryArg] = process.argv.slice(2);
  if (!inputPath || !outputPath || !actor) {
    throw new Error('Usage: node scripts/rd/approve-federation-task.cjs <proposed-record.json> <approval-package.json> <operator-id> [approval-summary]');
  }
  const contractPath = process.env.HF_SHARED_TASK_CONTRACT_MODULE;
  const secret = process.env.HF_OPERATOR_APPROVAL_SECRET;
  if (!contractPath) throw new Error('HF_SHARED_TASK_CONTRACT_MODULE is required');
  if (typeof secret !== 'string' || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('HF_OPERATOR_APPROVAL_SECRET must contain at least 32 UTF-8 bytes');
  }
  const contract = require(path.resolve(contractPath));
  if (!contract || typeof contract.validateTaskRecord !== 'function' ||
      typeof contract.transitionTask !== 'function' || contract.SCHEMA !== 'heavenzfire.shared-task.v1') {
    throw new Error('canonical shared-task contract module is invalid');
  }
  const record = JSON.parse(await fs.readFile(path.resolve(inputPath), 'utf8'));
  contract.validateTaskRecord(record);
  let approved = record;
  if (record.status === 'proposed' && record.approvalState === 'pending') {
    approved = contract.transitionTask(record, 'approved', {
      approvalState: 'approved',
      actor,
      evidenceItem: {
        kind: 'approval',
        summary: summaryArg || 'Operator approved bounded cross-device task submission',
        sourceUrl: null
      }
    });
  } else if (record.status !== 'approved' || record.approvalState !== 'approved') {
    throw new Error('task must be proposed/pending or already approved');
  }
  if (!approved.metadata || typeof approved.metadata.agentId !== 'string' ||
      typeof approved.metadata.grantId !== 'string') {
    throw new Error('canonical task metadata.agentId and metadata.grantId must be set before approval');
  }
  const authority = createOperatorApprovalAuthority({ secret });
  const approvalProof = authority.createProof(approved, {
    actor,
    ttlMs: Number(process.env.HF_APPROVAL_TTL_MS || 3600000)
  });
  await writePrivateJson(outputPath, { record: approved, approvalProof });
  process.stdout.write(JSON.stringify({
    state: 'APPROVED_PACKAGE_WRITTEN',
    taskId: approved.taskId,
    actor,
    output: path.resolve(outputPath),
    proofExpiresAt: new Date(approvalProof.expiresAt).toISOString()
  }) + '\n');
}

main().catch(error => {
  process.stderr.write('APPROVAL_PACKAGE_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
