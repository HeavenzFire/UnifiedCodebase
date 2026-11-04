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
  pollMs = 1000,
  onWorkerError = () => {}
}) {
  if (!capabilityGate || typeof capabilityGate.authorize !== 'function') {
    throw new Error('trusted capabilityGate.authorize() is required for governed federation execution');
  }

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
    execute: args => inference.run({
      taskId: args.taskId,
      role: args.role,
      prompt: args.prompt
    })
  });
  const worker = createGovernedRuntime({
    ledger,
    adapter: taskAdapter,
    capabilityGate,
    workerId,
    leaseMs,
    pollMs,
    onError: onWorkerError
  });
  const server = createFederationHttpServer({ protocol, taskAdapter, host, port });

  let started = false;

  async function start() {
    if (started) throw new Error('federation runtime is already started');
    const address = await server.listen();
    worker.start();
    started = true;
    return Object.freeze({
      state: 'READY',
      nodeId,
      bind: address.host,
      port: address.port,
      protocol: 'heavenzfire.federation.v1',
      inference: inference.baseUrl,
      worker: worker.status()
    });
  }

  async function stop() {
    if (!started) return;
    await worker.stop();
    await server.close();
    started = false;
  }

  return Object.freeze({ protocol, taskAdapter, worker, server, start, stop });
}

module.exports = { createFederationRuntime };
