'use strict';

const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { CapabilityStore } = require('../../MicroFederation/capability-store.cjs');

async function main() {
  const [agentId, grantId, taskId] = process.argv.slice(2);
  if (!agentId || !grantId || !taskId) {
    throw new Error('Usage: node scripts/rd/verify-federation-grant.cjs <agent-id> <grant-id> <task-id>');
  }
  const bootstrap = process.env.HF_FEDERATION_BOOTSTRAP_GRANT_JSON
    ? JSON.parse(process.env.HF_FEDERATION_BOOTSTRAP_GRANT_JSON)
    : process.env.HF_FEDERATION_BOOTSTRAP_GRANT_FILE
      ? JSON.parse(fs.readFileSync(path.resolve(process.env.HF_FEDERATION_BOOTSTRAP_GRANT_FILE), 'utf8'))
      : null;
  let grant;
  let source;
  if (bootstrap) {
    grant = bootstrap;
    source = 'bootstrap-config';
  } else {
    const file = process.env.HF_CAPABILITY_STORE_PATH ||
      path.join(os.homedir(), '.heavenzfire', 'federation', 'capabilities.json');
    const store = await new CapabilityStore(file).open();
    grant = await store.get(grantId);
    source = file;
  }
  if (!grant) throw new Error('task-scoped capability grant was not found');
  if (grant.agentId !== agentId || grant.grantId !== grantId || grant.taskId !== taskId ||
      grant.revoked === true || !Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now() ||
      !Array.isArray(grant.capabilities) || !grant.capabilities.includes('shared-task.v1')) {
    throw new Error('capability grant is expired, revoked, mismatched, or missing shared-task.v1');
  }
  process.stdout.write(JSON.stringify({
    state: 'CAPABILITY_GRANT_VALID',
    grantId,
    agentId,
    taskId,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    capabilities: grant.capabilities,
    source
  }) + '\n');
}

main().catch(error => {
  process.stderr.write('CAPABILITY_GRANT_CHECK_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
