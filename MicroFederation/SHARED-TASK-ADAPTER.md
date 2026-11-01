# Governed shared-task adapter

## Purpose

`shared-task-adapter.cjs` is the narrow boundary between the canonical
`heavenzfire.shared-task.v1` contract and the durable MicroFederation
`TaskLedger`. It is intentionally dependency-injected so the adapter does
not duplicate or silently drift from the canonical contract implementation.

## Approval and execution rules

- A canonical `proposed` or `review_required` record is proposal-only. It is
  never inserted into the executable ledger.
- Enqueue requires canonical status `approved`, approval state `approved`,
  and a successful `verifyApproval(record)` result.
- The verifier must consult the authoritative approval store or validate a
  cryptographic approval. A boolean or approval field supplied by a model,
  provider, task payload, or untrusted caller is not sufficient.
- The verifier must return an attributable actor and immutable evidence
  reference. The adapter records both in ledger metadata.
- Canonical task IDs are mapped to a fixed-length `shared:` plus SHA-256 ledger
  ID, preserving the original ID in metadata and payload while respecting the
  TaskLedger's 128-character identifier limit.
- Immediately before execution, the adapter reloads the canonical record and
  verifies approval again. If the actor or evidence reference changed, the
  task is failed closed and is not retried automatically.
- The adapter never executes shell commands. The injected `execute` function
  is the explicit capability boundary owned by the host application.

## Host integration

The host supplies:
- the canonical contract module's `validateTaskRecord`;
- the durable MicroFederation `TaskLedger`;
- `verifyApproval(record)`, backed by trusted approval evidence;
- `loadCanonicalTask(taskId)`, reading the authoritative record;
- `execute(task)`, an explicitly configured worker/provider adapter.

Use `enqueueApproved(record)` only after trusted verification is configured.
Use `propose(record)` for proposal intake. Run workers with unique worker IDs
and bounded leases. Do not wire an untrusted provider directly to
`verifyApproval` or grant the worker unrestricted shell execution.

## Verification

Run:

```sh
node --check MicroFederation/shared-task-adapter.cjs
node --test MicroFederation/shared-task-adapter.test.cjs
```

The GitHub Actions workflow runs these deterministic checks on Node 20 and 22.
These tests validate the adapter boundary with injected test doubles; they do
not establish a production approval store, cross-process ledger locking,
provider integration, deployment, or a live multi-host execution path.

## R&D governance

Every future integration change must preserve the canonical task ID, explicit
approval provenance, idempotency, bounded retries, cancellation, and evidence
references. Changes to these invariants require a contract test and independent
security review before merge. A green CI result is necessary but not sufficient
for approval or deployment.
