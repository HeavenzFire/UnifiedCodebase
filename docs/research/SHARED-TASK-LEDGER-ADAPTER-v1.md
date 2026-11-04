# Shared-task ledger adapter v1

## Scope

`MicroFederation/shared-task-ledger-adapter.cjs` bridges the canonical `heavenzfire.shared-task.v1` contract to the existing process-local `heavenzfire.task-ledger.v1`. The canonical contract module is injected by the caller; this repository does not fork or modify it.

## API

`createSharedTaskLedgerAdapter({ ledger, contract, verifyApproval, verifyAttestation, clock })`

- `createFromCanonical(record, { approvalProof, requiredCapabilities, maxAttempts, idempotencyKey })`: validates the canonical record, accepts only `status=approved` and `approvalState=approved`, requires attributable `kind=approval` evidence, and asks a trusted caller-supplied verifier to validate the explicit approval proof. The verifier must return `{ ok:true, approver, evidenceRef, verifiedAt, recordHash }`; the approver must match an evidence actor and the hash must match the exact canonical record. The raw proof is never persisted.
- `authorizeExecution(ledgerTask)`: revalidates the stored canonical record, identity, approval evidence, record hash, and trusted stored-attestation verifier. It fails closed.
- `claimNextApproved(workerId, options)`: claims through the existing ledger, then checks authorization before returning a claim. On denial it releases the claim and returns `blocked`; callers must not execute blocked tasks.
- `projectToCanonical(taskOrId)`: returns a versioned projection containing the canonical record plus an explicit ledger envelope. Ledger events/results/evidence remain in that envelope rather than being silently discarded.

## Status mapping

| Ledger | Canonical | Rule |
|---|---|---|
| queued | approved | Only adapter-admitted approved records enter the ledger |
| claimed | running | A worker has claimed the task |
| running | running | Execution is active |
| succeeded | completed | Ledger completion maps to canonical completion |
| failed | failed | Terminal failure |
| cancelled | unsupported | Canonical v1 has no cancelled status; projection fails explicitly |

The adapter preserves the stable `taskId`, original canonical evidence, and original canonical metadata. Ledger lifecycle details are returned separately under `ledger`; no unsupported canonical status is invented.

## Trust boundary and limitations

Approval is not inferred from a ledger status, agent payload, model output, or provider response. The trusted approval verifier and attestation verifier must be supplied by the host application and must bind operator identity, proof, task hash, and evidence reference. The test verifier is a deterministic fixture only and is not production identity infrastructure.

The ledger remains file-backed and process-local. This adapter does not provide distributed locking, cross-process atomicity, durable peer identity, transport security, remote execution, or production deployment. Use one ledger writer per file until a separately tested concurrency design exists.
