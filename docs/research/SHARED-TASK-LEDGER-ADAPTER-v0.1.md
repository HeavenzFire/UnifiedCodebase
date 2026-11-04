# Shared-task ledger adapter v0.1

**Module:** `MicroFederation/shared-task-adapter.cjs`  
**Tests:** `MicroFederation/shared-task-adapter.test.cjs`  
**Canonical contract:** `heavenzfire.shared-task.v1`  
**Ledger contract:** `heavenzfire.task-ledger.v1`

## Trust boundary

The adapter requires the canonical contract module, a trusted `verifyApproval(record)` callback, a canonical task loader, and an execution callback. The approval callback must independently verify the approval against the authoritative approval store or signature policy and return an attestation with `verified: true`, an attributable `actor`, an `evidenceRef`, and `verifiedAt`. The adapter does not accept approval booleans from task payloads, agent output, or ledger state.

The adapter stores the attestation metadata and a SHA-256 hash of the full canonical record. It does not persist approval proof material. Before execution it reloads the canonical task, validates it, checks the record hash, and re-verifies the same actor and evidence reference. Content or approval drift blocks execution.

## API

- `propose(record)`: validates and returns proposal-only state; never queues execution.
- `enqueueApproved(record)`: accepts only canonical `status=approved` and `approvalState=approved` records after trusted verification. It maps the canonical ID to a deterministic bounded ledger ID (`shared:` plus SHA-256) and retains the original canonical ID in ledger metadata and payload.
- `run({ taskId, role, prompt })`: execution adapter invoked by `GovernedRuntime` after ledger claim/start and capability authorization. There is deliberately no standalone `runOne` worker path; that would bypass the capability gate.
- `projectLedgerState(canonicalRecord, ledgerRecord, { actor })`: pure, deterministic lifecycle projection through the injected canonical `transitionTask` function. The caller must persist the returned canonical record using its trusted canonical store. This method does not write to the canonical store itself.

## Lifecycle mapping

| Ledger state | Canonical state | Semantics |
|---|---|---|
| queued | approved | no transition |
| claimed / running | running | execution has started |
| succeeded | completed | terminal success |
| failed | failed | terminal failure |
| cancelled | review_required | cancellation is not rejection |

A ledger success/failure observed while the canonical record is still approved is projected through the intermediate canonical `running` state to preserve the canonical state machine. Cancellation maps to `review_required`, never to rejection. Identity mismatch, missing canonical metadata, unknown statuses, non-approved records, and illegal transitions fail closed. Projection appends attributable lifecycle evidence using the canonical contract's own transition function.

## Execution and limitations

Use `createGovernedRuntime` as the only worker lifecycle owner. The adapter itself does not start a background service, open network sockets, or execute shell commands. The task ledger is a local JSON ledger whose write serialization is process-local; it is not a distributed queue or cross-process lock. Cross-device transport, canonical-store persistence, supervisor service management, and live-device acceptance remain separate integration/deployment steps.
