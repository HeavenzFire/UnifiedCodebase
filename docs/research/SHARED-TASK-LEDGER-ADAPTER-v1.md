# Shared-task ledger adapter v1

## Scope

`MicroFederation/shared-task-ledger-adapter.cjs` bridges the injected canonical `heavenzfire.shared-task.v1` contract to the existing `heavenzfire.task-ledger.v1` TaskLedger. The canonical contract is imported from the Unified Field checkout; this repository does not fork it.

## API

`createSharedTaskLedgerAdapter({ ledger, contract, verifyApproval, verifyAttestation, execute, clock })`

- `createFromCanonical(record, { approvalProof, requiredCapabilities, maxAttempts, idempotencyKey })`: validates the canonical record; admits only `status=approved` and `approvalState=approved`; requires attributable `kind=approval` evidence; and asks a trusted HMAC proof verifier to validate the exact record hash, task ID, approver, expiry, and signature. It preserves the canonical task ID as the ledger ID and idempotency key. It requires canonical `metadata.agentId` and `metadata.grantId`, and always adds `shared-task.v1` to the task's required capabilities.
- `authorizeExecution(ledgerTask)`: revalidates the canonical record, identity, approval evidence, stored signed attestation, and exact record hash immediately before execution.
- `run({ taskId, role, prompt, signal })`: is called by `GovernedRuntime` only after the ledger claim/start lifecycle and capability gate. It rechecks the approval attestation and exact prompt/role/source binding, then invokes the injected bounded execution callback. There is no independent `claimNextApproved` or standalone worker path.
- `projectToCanonical(taskOrId)`: returns a canonical status projection and a separate ledger evidence envelope. It does not write to the canonical store.

## Lifecycle mapping

| Ledger state | Canonical state | Meaning |
|---|---|---|
| queued | approved | admitted but not started |
| claimed / running | running | execution claimed or active |
| succeeded | completed | terminal success |
| failed | failed | terminal failure |
| cancelled | unsupported | canonical v1 has no cancelled state; projection fails explicitly |

The ledger envelope preserves attempts, idempotency key, payload hash, events, evidence, result, and error. A cancelled task is not silently mapped to rejected or review-required.

## Approval proof

`operator-approval.cjs` creates and verifies HMAC-signed operator proofs. Proofs bind the canonical task ID, exact canonical record hash, approver identity, evidence reference, issue/expiry times, and nonce. The signing secret is read from the local process environment and is never stored in the ledger. The ledger stores only the signed attestation fields required for later re-verification.

## Capability boundary

The receiving runtime uses the existing `CapabilityStore` and `CapabilityGate`. A task-scoped grant must match the record's `agentId`, `grantId`, and `taskId`, and must include `shared-task.v1`. High-impact capabilities remain denied unless a separate trusted approval provider is configured. The optional bootstrap grant is explicit, validated, and audited by the CapabilityStore.

## Limits

The adapter does not create approval, write back to the canonical task store, or provide distributed locking. The TaskLedger is a single-process JSON ledger. The HTTP service is loopback-only and is intended to be reached through an operator-managed SSH local forward. The local inference adapter returns text/data only; it does not execute model-generated commands.
