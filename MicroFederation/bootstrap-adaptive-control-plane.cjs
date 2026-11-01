'use strict';
const path = require('node:path');
const os = require('node:os');
const { TaskLedger } = require('./task-ledger.cjs');
const { CapabilityStore } = require('./capability-store.cjs');
const { createAdaptiveControlPlane } = require('./adaptive-control-plane.cjs');

async function main() {
  const root = path.join(os.homedir(), '.heavenzfire', 'adaptive-control-plane');
  const stateDir = process.env.HF_ADAPTIVE_STATE_DIR || root;
  const ledgerFile = process.env.HF_TASK_LEDGER_PATH || path.join(stateDir, 'task-ledger.json');
  const capabilityFile = process.env.HF_CAPABILITY_STORE_PATH || path.join(stateDir, 'capabilities.json');
  const ledger = await new TaskLedger(ledgerFile).open();
  const capabilityStore = await new CapabilityStore(capabilityFile).open();
  const plane = createAdaptiveControlPlane({
    stateDir,
    ledger,
    capabilityStore,
    approvalVerifier: async () => ({ verified: false }),
    profiles: {
      research: { memoryMb: 128, cpuCores: 0.25 },
      code: { memoryMb: 512, cpuCores: 1 },
      inference: { memoryMb: 1024, cpuCores: 1, gpuMb: 1024 },
      remote: { memoryMb: 64, cpuCores: 0.1 }
    }
  });
  await plane.initialize();
  const report = await plane.telemetry({});
  const status = await plane.status();
  process.stdout.write(JSON.stringify({
    result: 'HEAVENZFIRE_ADAPTIVE_CONTROL_PLANE_READY',
    stateDir, ledgerFile, capabilityFile,
    telemetry: report.snapshot,
    capacity: report.capacity,
    scheduler: status.scheduler,
    safety: {
      workersStarted: false,
      modelTasksEnqueued: false,
      credentialsLoaded: false,
      privilegedActions: 'fail-closed; trusted approval verifier not configured'
    }
  }, null, 2) + '\n');
}

main().catch(error => {
  process.stderr.write('ADAPTIVE_CONTROL_PLANE_BOOTSTRAP_FAILED: ' + String(error && error.stack || error) + '\n');
  process.exitCode = 1;
});
