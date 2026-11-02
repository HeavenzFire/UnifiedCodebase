'use strict';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * Single-process supervised worker for the durable TaskLedger.
 * Capability-bearing tasks fail closed unless a configured CapabilityGate
 * authorizes every declared capability before the adapter is invoked.
 */
function createGovernedRuntime({
  ledger, adapter, capabilityGate = null, workerId,
  leaseMs = 120000, pollMs = 1000, retryDelayMs = 1000,
  clock = () => Date.now(), onError = () => {}
} = {}) {
  if (!ledger || !['claimNext', 'start', 'releaseClaim', 'complete', 'fail'].every(k => typeof ledger[k] === 'function')) {
    throw Error('a compatible durable TaskLedger is required');
  }
  if (!adapter || typeof adapter.run !== 'function') throw Error('an orchestrator adapter with run() is required');
  if (typeof workerId !== 'string' || !ID.test(workerId)) throw Error('workerId is invalid');
  if (!Number.isInteger(leaseMs) || leaseMs < 1000 || leaseMs > 3600000) throw Error('leaseMs must be 1000..3600000');
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60000) throw Error('pollMs must be 250..60000');
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0 || retryDelayMs > 86400000) throw Error('retryDelayMs must be 0..86400000');
  if (typeof clock !== 'function' || typeof onError !== 'function') throw Error('clock and onError must be functions');

  let running = false;
  let stopping = false;
  let timer = null;
  let inFlight = null;
  let completed = 0;
  let failed = 0;
  let blocked = 0;
  let lastError = null;

  async function authorize(task) {
    const required = Array.isArray(task.requiredCapabilities) ? task.requiredCapabilities : [];
    if (!required.length) return;
    if (!capabilityGate || typeof capabilityGate.authorize !== 'function') {
      throw Object.assign(Error('capability gate is not configured; refusing capability-bearing task'), { policyDenied: true });
    }
    const metadata = task.metadata || {};
    if (typeof metadata.agentId !== 'string' || typeof metadata.grantId !== 'string') {
      throw Object.assign(Error('capability-bearing task requires agentId and grantId metadata'), { policyDenied: true });
    }
    for (const capability of required) {
      const decision = await capabilityGate.authorize({
        agentId: metadata.agentId,
        grantId: metadata.grantId,
        taskId: task.id,
        capability,
        action: metadata.action || capability,
        approvalRequestId: metadata.approvalRequestId || null
      });
      if (!decision || decision.allow !== true) {
        throw Object.assign(Error('capability denied: ' + capability + ' (' + (decision && decision.reason || 'no authorization') + ')'), { policyDenied: true });
      }
    }
  }

  async function runOnce({ now = clock() } = {}) {
    const claimed = await ledger.claimNext(workerId, { now, leaseMs });
    if (!claimed) return { status: 'idle' };
    let started = false;
    try {
      await ledger.start(claimed.id, workerId, { now });
      started = true;
      await authorize(claimed);
      const payload = claimed.payload;
      if (!payload || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
        throw Object.assign(Error('task payload must contain a non-empty prompt'), { policyDenied: true });
      }
      const result = await adapter.run({
        taskId: claimed.id,
        role: payload.role || 'worker',
        prompt: payload.prompt
      });
      const saved = await ledger.complete(claimed.id, workerId, result, {
        now: clock(), evidenceRef: 'governed-runtime:' + claimed.id
      });
      completed++;
      return { status: 'succeeded', taskId: saved.id, result: saved.result };
    } catch (error) {
      const message = String(error && error.message || error).slice(0, 2048);
      const policyDenied = error && error.policyDenied === true;
      let saved;
      try {
        saved = started
          ? await ledger.fail(claimed.id, workerId, message, {
              now: clock(), retryable: !policyDenied, retryDelayMs
            })
          : await ledger.releaseClaim(claimed.id, workerId, {
              now: clock(), retryDelayMs, reason: message
            });
      } catch (ledgerError) {
        lastError = String(ledgerError && ledgerError.message || ledgerError);
        return { status: 'lease-lost', taskId: claimed.id, error: message, ledgerError: lastError };
      }
      if (policyDenied) blocked++;
      else failed++;
      return {
        status: policyDenied ? 'blocked' : saved.status === 'queued' ? 'retry-scheduled' : 'failed',
        taskId: claimed.id, error: message, ledgerStatus: saved.status
      };
    }
  }

  async function cycle() {
    if (stopping || inFlight) return;
    inFlight = runOnce().catch(error => {
      lastError = String(error && error.message || error);
      try { onError(error); } catch {}
      return { status: 'worker-error', error: lastError };
    }).finally(() => { inFlight = null; });
    await inFlight;
    if (!stopping) timer = setTimeout(cycle, pollMs);
  }

  return Object.freeze({
    runOnce,
    start() {
      if (running) return this.status();
      running = true;
      stopping = false;
      void cycle();
      return this.status();
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight;
      running = false;
      return this.status();
    },
    status() {
      return { running, stopping, workerId, completed, failed, blocked, inFlight: !!inFlight, lastError };
    }
  });
}

module.exports = { createGovernedRuntime };
