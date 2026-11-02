# Orchestrator worker cancellation and timeout contract

## API

`createOrchestratorTaskWorker(...).runOnce({ signal })` accepts an optional standard `AbortSignal`. The worker passes a worker-owned signal to `adapter.run({ taskId, role, prompt, signal })`.

Adapters that perform network, provider, model, or other asynchronous work must propagate this signal to the underlying operation and stop promptly when it is aborted. An adapter that ignores the signal is non-cooperative; the worker cannot forcibly terminate its code or an external operation.

## State behavior

- A signal already aborted before claim returns `cancelled-before-claim` and leaves the queued task unchanged.
- Cancellation after claim records the TaskLedger `cancelled` terminal state and does not schedule a retry.
- A worker timeout aborts the adapter signal and records a non-retryable `failed` task. It does not automatically retry because the worker cannot know whether the adapter completed an external side effect before stopping or ignoring cancellation.
- Timeout and cancellation results include `executionMayContinue: true`. This is deliberately conservative: it means the worker has not independently proved that the adapter or downstream operation stopped.
- Ordinary adapter errors retain the existing bounded retry policy. Adapters must use idempotency keys and reconciliation where retries could repeat external effects.

## Identity and trust limits

The recorded `workerId` is an audit label, not authenticated human identity or approval evidence. A caller-provided AbortSignal is a cancellation request, not authorization to perform another action. This module does not grant capabilities, approve tasks, execute shell commands, or establish a remote worker connection.

The TaskLedger currently serializes mutations within one Node.js process. This change does not add multi-process or distributed locking, lease renewal, or proof of exactly-once side effects.

## Verification

Run:

```sh
node --check MicroFederation/ledger-orchestrator-worker.cjs
node --test MicroFederation/test-ledger-orchestrator-worker.cjs
```

The deterministic tests cover signal delivery, caller cancellation, pre-aborted requests, timeout abort, non-retry after timeout, ordinary bounded retry, invalid payloads, and lease-loss reporting. They do not prove that arbitrary third-party adapters honor AbortSignal.
