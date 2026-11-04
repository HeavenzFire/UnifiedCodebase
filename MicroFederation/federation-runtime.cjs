'use strict';

const { createFederationProtocol } = require('./federation-protocol.cjs');
const { createSharedTaskLedgerAdapter } = require('./shared-task-ledger-adapter.cjs');
const { createFederationHttpServer } = require('./federation-http-server.cjs');
const { createOpenAICompatibleInferenceAdapter } = require('./openai-local-inference-adapter.cjs');
const { createGovernedRuntime } = require('./governed-runtime.cjs');

function createFederationRuntime({
  nodeId,
  peers,
  ledger,
  contract,
  verifyApproval,
  verifyAttestation,
  capabilityGate,
  inferenceBaseUrl = 'http://127.0.0.1:11820',
  inferenceModel = 'heavenzfire-qwen-0.5b',
  workerId = nodeId + '-worker',
  host = '127.0.0.1',
  port = 18100,
  leaseMs = 120000,
  pollMs = 500,
  clock = () => Date.now(),
  onWorkerError = () => {}
} = {}) {
  if (!capabilityGate || typeof capabilityGate.authorize !== 'function') {
    throw new Error('a configured capability gate is required; refusing to start an ungated worker');
  }
  if (!ledger || typeof ledger.open !== 'function') throw new Error('a durable TaskLedger is required');
  if (typeof onWorkerError !== 'function') throw new Error('onWorkerError must be a function');

  const protocol = createFederationProtocol({
    nodeId,
    capabilities: ['task.submit', 'task.read'],
    peers
  });
  const inference = createOpenAICompatibleInferenceAdapter({
    baseUrl: inferenceBaseUrl,
    model: inferenceModel
  });
  const taskAdapter = createSharedTaskLedgerAdapter({
    ledger,
    contract,
    verifyApproval,
    verifyAttestation,
    execute: inference.run,
    clock
  });
  const worker = createGovernedRuntime({
    ledger,
    adapter: taskAdapter,
    capabilityGate,
    workerId,
    leaseMs,
    pollMs,
    clock,
    onError: onWorkerError
  });
  const server = createFederationHttpServer({
    protocol,
    taskAdapter,
    host,
    port,
    clock
  });

  let started = false;

  async function start() {
    if (started) throw new Error('federation runtime is already started');
    await ledger.open();
    if (capabilityGate.store && typeof capabilityGate.store.open === 'function') {
      await capabilityGate.store.open();
    }
    const address = await server.listen();
    const workerState = worker.start();
    started = true;
    return Object.freeze({
      state: 'READY',
      nodeId,
      bind: address.host,
      port: address.port,
      protocol: 'heavenzfire.federation.v1',
      inference: inference.baseUrl,
      model: inference.model,
      workerId,
      worker: workerState
    });
  }

  async function stop() {
    if (!started) return Object.freeze({ state: 'STOPPED' });
    const workerState = await worker.stop();
    await server.close();
    started = false;
    return Object.freeze({ state: 'STOPPED', worker: workerState });
  }

  function status() {
    return Object.freeze({
      state: started ? 'READY' : 'STOPPED',
      nodeId,
      worker: worker.status(),
      sessions: server.sessionCount()
    });
  }

  return Object.freeze({ protocol, taskAdapter, inference, worker, server, start, stop, status });
}

module.exports = { createFederationRuntime };
