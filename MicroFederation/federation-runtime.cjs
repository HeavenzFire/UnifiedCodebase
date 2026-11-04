'use strict';

const { createFederationProtocol } = require('./federation-protocol.cjs');
const { createSharedTaskLedgerAdapter } = require('./shared-task-ledger-adapter.cjs');
const { createFederationHttpServer } = require('./federation-http-server.cjs');
const { createOpenAICompatibleInferenceAdapter } = require('./openai-local-inference-adapter.cjs');
const { createOrchestratorTaskWorker } = require('./ledger-orchestrator-worker.cjs');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function createFederationRuntime({
  nodeId,
  peers,
  ledger,
  contract,
  verifyApproval,
  verifyAttestation,
  inferenceBaseUrl = 'http://127.0.0.1:11820',
  inferenceModel = 'heavenzfire-qwen-0.5b',
  workerId = nodeId + '-worker',
  host = '127.0.0.1',
  port = 18100,
  leaseMs = 120000,
  pollMs = 500,
  onWorkerError = () => {}
}) {
  const protocol = createFederationProtocol({
    nodeId,
    capabilities: ['task.submit', 'task.read'],
    peers
  });
  const taskAdapter = createSharedTaskLedgerAdapter({
    ledger, contract, verifyApproval, verifyAttestation
  });
  const inference = createOpenAICompatibleInferenceAdapter({
    baseUrl: inferenceBaseUrl,
    model: inferenceModel
  });

  const gatedLedger = {
    claimNext: async (id, options) => {
      const result = await taskAdapter.claimNextApproved(id, options);
      return result.status === 'claimed' ? result.task : null;
    },
    start: ledger.start.bind(ledger),
    complete: ledger.complete.bind(ledger),
    fail: ledger.fail.bind(ledger),
    cancel: ledger.cancel.bind(ledger),
    get: ledger.get.bind(ledger)
  };
  const worker = createOrchestratorTaskWorker({
    ledger: gatedLedger,
    adapter: inference,
    workerId,
    leaseMs
  });
  const server = createFederationHttpServer({ protocol, taskAdapter, host, port });

  let started = false;
  let stopping = false;
  let loopPromise = null;

  async function workerLoop() {
    while (!stopping) {
      try {
        const result = await worker.runOnce();
        if (result.status === 'idle' || result.status === 'lease-lost' || result.status === 'blocked') {
          await sleep(pollMs);
        }
      } catch (error) {
        try { onWorkerError(error); } catch {}
        await sleep(pollMs);
      }
    }
  }

  async function start() {
    if (started) throw new Error('federation runtime is already started');
    const address = await server.listen();
    started = true;
    stopping = false;
    loopPromise = workerLoop();
    return Object.freeze({
      state: 'READY',
      nodeId,
      bind: address.host,
      port: address.port,
      protocol: 'heavenzfire.federation.v1',
      inference: inference.baseUrl,
      workerId
    });
  }

  async function stop() {
    if (!started) return;
    stopping = true;
    if (loopPromise) await loopPromise;
    await server.close();
    started = false;
  }

  return Object.freeze({ protocol, taskAdapter, server, worker, start, stop });
}

module.exports = { createFederationRuntime };
