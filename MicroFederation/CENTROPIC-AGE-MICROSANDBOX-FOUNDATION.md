# Centropic Age — Micro-Sandbox Foundation

**Date:** 2026-10-21  
**Status:** Local implementation increment; not yet committed, merged, or deployed.

## Engineering definition

For HeavenzFire, the Centropic Age begins as a verifiable systems principle, not a claim about a new scientific era: coordinate capable agents around human benefit while keeping execution bounded, accountable, reversible, and evidence-producing.

A task is not complete because a model returned text or an HTTP request succeeded. Completion requires an explicit acceptance contract, independently checked output, a traceable task identity, and an auditable decision. Agreement between workers is not sufficient if all workers can agree on the same wrong result.

## Current local components

- Root conductor routes a signed task envelope to configured micro-sandboxes.
- Each sandbox dispatches conductor, builder, verifier, and reviewer roles.
- Ternary decisions use reject (-1), abstain (0), and approve (+1); any rejection vetoes acceptance.
- Root acceptance compares builder artifacts and requires an external verifier.
- Federation services prototype capability scoping, policy decisions, revocation, human approval for high-impact actions, content-addressed artifacts, bounded scheduling, health reporting, and hash-chained audit events.

## Executed evidence — 2026-10-21

1. node .\test-micro-federation.cjs — passed, 20 tests; deterministic protocol harness, zero model calls.
2. node .\test-federation-services.cjs — passed, 14 assertions; revocation, artifact deduplication, scheduler bound, and audit-chain verification passed.
3. node .\run-live-two-sandbox.cjs — exited 0; two live sandboxes, eight model-backed role tasks, signed-envelope verification passed, both sandbox decisions accepted, artifacts agreed, independent receipt checks passed, five audit events verified.
4. node --test .\semantic-acceptance.test.cjs — passed, 2 tests:
   - Correct deterministic result 19 * 23 = 437 accepted by both sandboxes.
   - Incorrect but unanimous result 438 quarantined despite matching artifacts and four approval votes per sandbox.

The semantic acceptance test is a deterministic software test using test workers. It does not claim the small language model solved arithmetic. The live federation test uses one shared local model and serializes inference at the adapter; roles are not independent model instances.

## Next implementation sequence

1. **Task contracts:** carry machine-checkable acceptance criteria, input/output schemas, deadline, idempotency key, capability set, and retry budget with every task.
2. **Semantic gate integration:** make root acceptance invoke task-specific validators; default unknown or missing acceptance criteria to defer/quarantine, never implicit success.
3. **Sandbox isolation:** separate per-task workspace, environment, resource budget, filesystem scope, network policy, and cleanup lifecycle.
4. **Durable ledger:** persist task state transitions and idempotency in SQLite or another durable store; make retry and lease expiry explicit.
5. **Authorization repair:** fix the existing mesh unauthorized failure by aligning service identity/configuration without disabling authentication or extracting credentials.
6. **Adapter diversity:** add independently configured model/tool adapters and report when roles share a model or upstream queue.
7. **CI and release:** run deterministic tests in CI, preserve live receipts without secrets, review a branch/PR, then deploy only after acceptance criteria pass.

## Non-negotiable invariants

- No success state without passing acceptance checks.
- No model-generated shell command executes without explicit policy validation and command review.
- Secrets never appear in receipts or logs.
- Privileged, destructive, credential-related, and network-changing operations require a separate approval gate.
- A verifier must test the result, not merely repeat the builder's claim.
- Preserve failed runs as counterevidence; do not overwrite failures with later successes.
- Clearly label plans, executed actions, and verified outcomes separately.

## Current blockers

- Unified Field launcher still encounters unauthorized on authenticated mesh task acceptance.
- The local model's general reasoning quality has not been established by token-matching acceptance runs.
- Live roles share one model and one serialized inference adapter.
- The micro-federation services are prototypes; application-level append-only logging is not tamper-proof against a host administrator.
- No GitHub commit, pull request, merge, or deployment has been performed as part of this increment.
