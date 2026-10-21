# HeavenzFire Unified Field — Integration Roadmap

## North star
A local-first, evidence-preserving research and coordination platform that connects existing HeavenzFire projects through small, testable adapters. It does not claim that every repository is already integrated.

## Architecture layers
1. Entry point: Enter-UnifiedField.ps1; Windows PowerShell 5.1 compatible.
2. Provider routing: unified-field/provider-router.mjs; local Ollama by default, optional explicit remote adapters.
3. Service adapters: health, model, repository, browser, voice, and research connectors; each reports observed status and permissions.
4. Evidence plane: source provenance, hashes, correction history, and human review.
5. Guardian extensions: evidence intake and funding-integrity reconciliation, initially read-only.
6. Governance plane: least privilege, explicit approval for external actions, privacy controls, and audit events.
7. Verification: unit tests, contract tests, end-to-end checks, and CI.

## Provider policy
- Default provider is local Ollama at 127.0.0.1:11434.
- Remote providers are opt-in and require their own provider-specific environment variable.
- Credentialed remote endpoints must use HTTPS, may not embed URL credentials/query parameters/fragments, and disable HTTP redirects; unsafe endpoint configuration is rejected before fetch.
- No silent fallback from failed remote calls to local inference or vice versa.
- The selected provider and model are included in result metadata.
- Secrets and prompt contents are not logged by the router.
- Supported IDs: ollama, openai, mistral, gemini.

## Public-interest safeguards
The system can collect, compare, and explain records relevant to public spending and service delivery. It cannot itself establish criminal intent, decide legal liability, redirect money, or end armed conflicts. Findings must distinguish source facts, calculations, inference, uncertainty, and human-reviewed conclusions.

## Integration sequence
Phase 1: provider router, PowerShell entry point, unit tests, CI.
Phase 2: read-only service health manifest and consistent model configuration.
Phase 3: evidence ledger with provenance and correction history.
Phase 4: funding reconciliation using synthetic fixtures and public records.
Phase 5: repository inventory and staged adapters, one project at a time.
Phase 6: reviewable pull requests and reproducible release artifacts.

## Repository inventory (metadata snapshot, not code audit)
- `docs/repository-inventory.snapshot.json` records 276 repositories surfaced by the connected GitHub installation search for `user:HeavenzFire` on 2026-10-20.
- This is the visible search result set, not a guarantee that every owned repository is accessible through the connection. Entries default to `unassessed`; source code and integration are not inferred from names.
- `integrations/validate-repository-inventory.mjs` validates the snapshot structure, unique repository identities, and safe default status. CI tests this validator.
- `docs/REPOSITORY-INTEGRATION-INVENTORY.md` defines status transitions and the per-repository review gate. Next work is a source-level audit of high-priority repositories, starting with Sovereign Node, public transparency/audit, and child-safety candidates.

## Source-level integration triage
- `docs/INITIAL-SOURCE-INTEGRATION-REVIEW.md` records exact commit/blob references for initial review of Sovereign Node, Verifier Mesh, Public Transparency Portal, and Audit of the State.
- Sovereign Node is restricted to a loopback-only read-only health adapter until unauthenticated routes and WebSocket access are reviewed; its current node list is hard-coded and must not be represented as a live mesh.
- Verifier Mesh passes caller-provided case text to a remote Gemini API; no case-data integration is enabled pending privacy and authorization review.
- Public Transparency Portal claims remain unverified until tied to primary sources and reproducible calculations. Audit of the State requires source inspection beyond its starter-level root files.
- These are static-source findings only; the applications were not installed or executed in this review.

## Shared task proposal bridge (integration verified)
- `integrations/task-lifecycle.mjs` defines the lifecycle contract; `integrations/durable-task-lifecycle.mjs` persists snapshots and audit events in an append-only, SHA-256 hash-chained JSONL log and replays state on restart.
- `integrations/shared-task-proposal-adapter.mjs` maps a local task into `heavenzfire.shared-task.v1` and submits only to an explicit HTTP loopback inbox endpoint at `127.0.0.1:<port>/api/tasks`.
- The adapter sends only `status: proposed` and `approvalState: pending`; it does not approve, dispatch, or execute tasks.
- Proposal serialization uses the task's stable timestamps so retries of an unchanged task are idempotent; a conflicting payload reusing the same ID is rejected by the inbox.
- `integrations/governed-task-lifecycle.mjs` adds a separate durable approval journal. Transitions to `running` require a recorded approval with a caller-supplied actor label and reason; the module does not authenticate that actor. The approval is consumed before the transition, so a persistence failure requires fresh approval rather than silently proceeding. Both journals fail closed after write errors.
- Automated tests cover lifecycle transitions, defensive snapshots, durable restart replay, hash-chain tamper detection, approval persistence/revocation/consumption, endpoint restrictions, contract mapping, and response validation.
- Cross-repository GitHub Actions run 39522915367 passed 21 tests, including live HTTP delivery to the actual inbox server, duplicate delivery, conflicting duplicate rejection, and persistence across an inbox process restart. The integration test checks out the adapter from the UnifiedCodebase feature branch.
- UnifiedCodebase GitHub Actions run 39523706121 passed 59 tests, including durable lifecycle replay and explicit approval-gate suites.
- Remaining work: the proposal adapter is not wired into the PowerShell launcher or a worker; no task execution is enabled through the shared inbox. JSONL persistence assumes a single writer and is tamper-evident, not tamper-proof. The approval gate is a host API boundary, not an operating-system sandbox; production integration must ensure callers cannot bypass it.

## Acceptance gates
- Unit tests pass on a clean Node.js LTS runtime.
- Provider failures never trigger an unrequested provider switch.
- No API keys or sensitive user data appear in committed files or logs.
- Every extension has schemas, tests, permission scope, and documented failure states.
- Human review remains mandatory for consequential actions affecting people, funds, or legal claims.
