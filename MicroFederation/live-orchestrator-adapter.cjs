'use strict';

// Adapter for the existing HeavenzFire orchestrator. It serializes model work,
// propagates worker cancellation, and retries only explicit transient HTTP 5xx responses.
class LiveOrchestratorAdapter {
  constructor({
    endpoint = 'http://127.0.0.1:8788/task',
    timeoutMs = 120000,
    maxRetries = 2,
    retryBaseMs = 100,
    fetchImpl = globalThis.fetch,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  } = {}) {
    if (typeof endpoint !== 'string' || !/^https?:\/\//i.test(endpoint)) throw Error('endpoint must be an HTTP(S) URL');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw Error('timeoutMs must be a positive integer');
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 5) throw Error('maxRetries must be 0..5');
    if (!Number.isInteger(retryBaseMs) || retryBaseMs < 0 || retryBaseMs > 10000) throw Error('retryBaseMs must be 0..10000');
    if (typeof fetchImpl !== 'function' || typeof sleep !== 'function') throw Error('fetchImpl and sleep must be functions');
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.retryBaseMs = retryBaseMs;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.queue = Promise.resolve();
  }

  run({ taskId, role, prompt, signal }) {
    if (!taskId || !role || typeof prompt !== 'string' || !prompt.trim()) {
      return Promise.reject(Error('taskId, role and prompt are required'));
    }
    if (signal !== undefined && signal !== null &&
        (typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function')) {
      return Promise.reject(Error('signal must be an AbortSignal'));
    }

    const operation = async () => {
      const started = Date.now();
      for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
        if (signal && signal.aborted) {
          const error = Error(String(signal.reason || 'orchestrator task cancelled'));
          error.name = 'AbortError';
          throw error;
        }

        const controller = new AbortController();
        let timedOut = false;
        const onAbort = () => controller.abort(signal.reason);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        const timeoutId = setTimeout(() => {
          timedOut = true;
          const error = Error('orchestrator request timed out');
          error.name = 'TimeoutError';
          controller.abort(error);
        }, this.timeoutMs);

        try {
          const response = await this.fetchImpl(this.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prompt }),
            signal: controller.signal
          });
          const raw = await response.text();

          if (response.status >= 500 && response.status <= 599 && attempt < this.maxRetries) {
            await this.sleep(this.retryBaseMs * (2 ** attempt));
            continue;
          }

          let data;
          try { data = JSON.parse(raw); }
          catch { throw Error('Orchestrator returned non-JSON HTTP ' + response.status); }
          if (!response.ok || data.ok !== true) {
            throw Error('Orchestrator task failed HTTP ' + response.status + ': ' + (data.error || raw.slice(0, 200)));
          }
          return {
            taskId, role, model: data.model || null, response: data.response || '',
            elapsedMs: data.elapsed_ms ?? Date.now() - started,
            totalDurationNs: data.total_duration_ns || null,
            httpStatus: response.status, attempts: attempt + 1,
            completedAt: new Date().toISOString()
          };
        } catch (error) {
          if (signal && signal.aborted) {
            const cancelled = Error(String(signal.reason || 'orchestrator task cancelled'));
            cancelled.name = 'AbortError';
            throw cancelled;
          }
          if (timedOut) {
            const timeout = Error('orchestrator request timed out');
            timeout.name = 'TimeoutError';
            throw timeout;
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
          if (signal) signal.removeEventListener('abort', onAbort);
        }
      }
      throw Error('orchestrator retry loop exited unexpectedly');
    };

    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

module.exports = { LiveOrchestratorAdapter };
