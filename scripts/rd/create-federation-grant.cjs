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
  const [packagePath, outputPath, lifetimeArg] = process.argv.slice(2);
  if (!packagePath || !outputPath) {
    throw new Error('Usage: node scripts/rd/create-federation-grant.cjs <approval-package.json> <grant.json> [lifetime-minutes]');
  }
  const lifetimeMinutes = lifetimeArg === undefined ? 60 : Number(lifetimeArg);
  if (!Number.isInteger(lifetimeMinutes) || lifetimeMinutes < 1 || lifetimeMinutes > 1440) {
    throw new Error('lifetime-minutes must be 1..1440');
  }
  const pack = JSON.parse(await fs.readFile(path.resolve(packagePath), 'utf8'));
  const record = pack && pack.record;
  if (!record || record.status !== 'approved' || record.approvalState !== 'approved') {
    throw new Error('approval package must contain an approved canonical task record');
  }
  const metadata = record.metadata || {};
  if (typeof metadata.agentId !== 'string' || !metadata.agentId ||
      typeof metadata.grantId !== 'string' || !metadata.grantId) {
    throw new Error('canonical record metadata.agentId and metadata.grantId are required');
  }
  const grant = {
    grantId: metadata.grantId,
    agentId: metadata.agentId,
    taskId: record.taskId,
    capabilities: ['shared-task.v1'],
    expiresAt: Date.now() + lifetimeMinutes * 60000
  };
  await writePrivateJson(outputPath, grant);
  process.stdout.write(JSON.stringify({
    state: 'SCOPED_CAPABILITY_GRANT_WRITTEN',
    taskId: grant.taskId,
    agentId: grant.agentId,
    grantId: grant.grantId,
    capabilities: grant.capabilities,
    expiresAt: new Date(grant.expiresAt).toISOString(),
    output: path.resolve(outputPath)
  }) + '\n');
}

main().catch(error => {
  process.stderr.write('FEDERATION_GRANT_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
