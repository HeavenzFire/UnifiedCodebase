'use strict';

const path = require('node:path');
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const { CapabilityStore } = require('../../MicroFederation/capability-store.cjs');

async function main() {
  const [agentId, grantId, taskId, ttlMinutesRaw = '60'] = process.argv.slice(2);
  if (!agentId || !grantId || !taskId) {
    throw new Error('Usage: node scripts/rd/grant-federation-task.cjs <agent-id> <grant-id> <task-id> [ttl-minutes]');
  }
  const ttlMinutes = Number(ttlMinutesRaw);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < 1 || ttlMinutes > 1440) {
    throw new Error('ttl-minutes must be an integer from 1 to 1440');
  }
  const file = process.env.HF_CAPABILITY_STORE_PATH ||
    path.join(require('node:os').homedir(), '.heavenzfire', 'federation', 'capabilities.json');
  const expiresAt = Date.now() + ttlMinutes * 60000;
  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    stdout.write(JSON.stringify({
      action: 'GRANT_CAPABILITY',
      agentId,
      grantId,
      taskId,
      capabilities: ['shared-task.v1'],
      expiresAt: new Date(expiresAt).toISOString()
    }, null, 2) + '\n');
    const confirmation = await rl.question('Type GRANT ' + grantId + ' to commit this task-scoped capability: ');
    if (confirmation !== 'GRANT ' + grantId) throw new Error('operator confirmation did not match; no grant written');
  } finally {
    rl.close();
  }
  const store = await new CapabilityStore(file).open();
  const grant = await store.grant({
    agentId,
    grantId,
    taskId,
    capabilities: ['shared-task.v1'],
    expiresAt
  });
  stdout.write(JSON.stringify({
    state: 'CAPABILITY_GRANTED',
    grantId: grant.grantId,
    taskId: grant.taskId,
    capabilities: grant.capabilities,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    store: file
  }) + '\n');
}

main().catch(error => {
  process.stderr.write('CAPABILITY_GRANT_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
