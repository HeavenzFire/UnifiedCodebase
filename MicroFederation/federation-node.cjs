'use strict';

const path = require('node:path');

async function main() {
  const configPath = process.env.HF_FEDERATION_NODE_CONFIG;
  if (!configPath) throw new Error('HF_FEDERATION_NODE_CONFIG must point to an operator-managed local config module');
  const config = require(path.resolve(configPath));
  if (!config || typeof config !== 'object') throw new Error('federation config must export an options object');
  const { createFederationRuntime } = require('./federation-runtime.cjs');
  const runtime = createFederationRuntime(config);
  const ready = await runtime.start();
  process.stdout.write(JSON.stringify(ready) + '\n');

  let stopping = false;
  const shutdown = async signal => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(JSON.stringify({ state: 'STOPPING', signal }) + '\n');
    await runtime.stop();
    process.exitCode = 0;
  };
  process.once('SIGINT', () => { shutdown('SIGINT').catch(error => { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; }); });
  process.once('SIGTERM', () => { shutdown('SIGTERM').catch(error => { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; }); });
}

main().catch(error => {
  process.stderr.write('FEDERATION_START_FAILED: ' + String(error.message || error) + '\n');
  process.exitCode = 1;
});
