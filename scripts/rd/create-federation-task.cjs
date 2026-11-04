'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

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
  const [outputPath, agentId, grantId, ...goalParts] = process.argv.slice(2);
  const goal = goalParts.join(' ').trim();
  const contractPath = process.env.HF_SHARED_TASK_CONTRACT_MODULE;
  if (!outputPath || !agentId || !grantId || !goal) {
    throw new Error('Usage: node scripts/rd/create-federation-task.cjs <record.json> <agent-id> <grant-id> <goal>');
  }
  if (!contractPath) throw new Error('HF_SHARED_TASK_CONTRACT_MODULE is required');
  const contract = require(path.resolve(contractPath));
  if (!contract || typeof contract.createTaskRecord !== 'function' ||
      typeof contract.validateTaskRecord !== 'function' || contract.SCHEMA !== 'heavenzfire.shared-task.v1') {
    throw new Error('canonical shared-task contract module is invalid');
  }
  const record = contract.createTaskRecord({
    taskId: process.env.HF_TASK_ID || undefined,
    source: process.env.HF_TASK_SOURCE || 'android-termux',
    goal,
    metadata: {
      agentId,
      grantId,
      role: process.env.HF_TASK_ROLE || 'research',
      action: 'shared-task.execute'
    }
  });
  contract.validateTaskRecord(record);
  await writePrivateJson(outputPath, record);
  process.stdout.write(JSON.stringify({
    state: 'PROPOSED_TASK_CREATED',
    taskId: record.taskId,
    status: record.status,
    approvalState: record.approvalState,
    output: path.resolve(outputPath)
  }) + '\n');
}

main().catch(error => {
  process.stderr.write('FEDERATION_TASK_CREATE_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
