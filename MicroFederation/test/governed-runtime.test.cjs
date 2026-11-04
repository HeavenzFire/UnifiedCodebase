'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createGovernedRuntime } = require('../governed-runtime.cjs');

function fakeLedger() {
  const task = {
    id: 'hf-stop-task-001',
    status: 'queued',
    owner: null,
    payload: { role: 'research', prompt: 'bounded task' },
    metadata: {},
    requiredCapabilities: [],
    attempts: 0
  };
  return {
    task,
    async claimNext(workerId) {
      if (task.status !== 'queued') return null;
      task.status = 'claimed';
      task.owner = workerId;
      task.attempts++;
      return { ...task };
    },
    async start(id, workerId) {
      assert.equal(id, task.id);
      assert.equal(task.owner, workerId);
      task.status = 'running';
      return { ...task };
    },
    async releaseClaim(id, workerId, options) {
      assert.equal(task.owner, workerId);
      task.status = 'queued';
      task.owner = null;
      task.lastError = options.reason;
      return { ...task };
    },
    async complete() {
      throw new Error('complete must not be called for an aborted task');
    },
    async fail(id, workerId, error, options) {
      assert.equal(task.owner, workerId);
      task.status = options.retryable ? 'queued' : 'failed';
      task.owner = null;
      task.lastError = error.message;
      return { ...task };
    },
    async get() { return { ...task }; }
  };
}

test('graceful stop aborts in-flight adapter work and releases task for retry', async () => {
  const ledger = fakeLedger();
  let observedSignal;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const adapter = {
    async run({ signal }) {
      observedSignal = signal;
      signalStarted();
      return new Promise((resolve, reject) => {
        if (signal.aborted) {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          return;
        }
        signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    }
  };
  const worker = createGovernedRuntime({
    ledger,
    workerId: 'windows-zdh-worker',
    capabilityGate: { async authorize() { return { allow: true }; } },
    adapter,
    pollMs: 5000,
    retryDelayMs: 1000
  });
  worker.start();
  await started;
  const stopped = await worker.stop();
  assert.equal(observedSignal.aborted, true);
  assert.equal(ledger.task.status, 'queued');
  assert.equal(stopped.state, 'STOPPED');
});
