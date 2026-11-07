# HeavenzFire Unified Field — Cross-Device Federation R&D v0.1

**Status:** ACTIVE — loopback federation runtime implemented; physical two-device acceptance pending  
**Date:** 2026-11-04  
**Tracking issue:** [UnifiedCodebase #46](https://github.com/HeavenzFire/UnifiedCodebase/issues/46)  
**Related foundations:** [PR #41 — Project/Node Registry + Agent Command Center](https://github.com/HeavenzFire/UnifiedCodebase/pull/41), [PR #45 — Local Inference Engine](https://github.com/HeavenzFire/UnifiedCodebase/pull/45)

## 1. Mission

Design and verify a secure, local-first federation layer connecting authorized HeavenzFire Windows, Android/Termux, and Linux nodes. Federation must reuse the existing registry, task contracts, local inference services, and private overlay transport. It must not create a second orchestrator or expose loopback services directly to the network.

This document is the source-of-truth R&D plan. The branch now contains a loopback-only HTTP gateway/client, authenticated peer handshake, signed operator approval, canonical-task ledger adapter, capability-gated worker, and local inference adapter. CI exercises the local round-trip; the physical Windows/Android pair has not yet been launched through this runtime.

## 2. Verified baseline — 2026-11-04

Operator-provided live terminal evidence establishes:

- Windows local inference backend at `127.0.0.1:11800` returned healthy.
- The local facade at `127.0.0.1:11820` returned `status=ok` and backend HTTP 200.
- Model discovery returned `heavenzfire-qwen-0.5b`.
- A local completion returned `HEAVENZFIRE_INFERENCE_OK`.
- Android Termux reached the Windows node through the private Tailscale mesh and authenticated with the configured SSH key.
- An SSH-executed PowerShell health query returned the healthy facade response.
- An SSH-executed chat completion returned exactly `HF_REMOTE_OK`, with 4 completion tokens and remote exit code 0.

These checks prove a working SSH-mediated remote invocation path for the tested session. They do **not** prove a production node-enrollment protocol, durable task handoff, distributed leases, reconnect replay, revocation, or secure general-purpose remote execution.

The facade remained bound to loopback; the inference port was not opened to the mesh. The SSH post-quantum key-exchange warning remains an explicit transport-hardening item, not a failure of the successful session.

## 3. Existing foundations and dependency status

| Foundation | Evidence | Status / dependency |
|---|---|---|
| Local inference facade | PR #45 and live operator smoke tests | Live host path verified; source health-check correction is currently local-only and must be committed/retested before PR #45 can be considered complete |
| Project/node registry and Command Center | PR #41 | Draft PR; inspect and review before depending on its API as a merged mainline contract |
| Canonical shared-task contract | Unified Field source referenced by issue #19 | Inspect exact current mainline schema before writing an adapter |
| Cross-device federation | Issue #46 | This R&D workstream |

No unmerged PR is treated as part of `main` merely because its design or tests exist.

## 4. Proposed protocol boundaries

### 4.1 Node identity and enrollment

- Each installation generates or receives a unique node identity.
- Enrollment is initiated by an operator and requires explicit approval on the receiving node.
- Identity credentials are scoped to node-to-node protocol operations; they are not shell credentials.
- Enrollment records protocol version, node ID, an operator-approved per-peer HMAC secret reference, declared capabilities, allowed peer IDs, creation time, and revocation state. Current v0.1 uses symmetric HMAC bootstrap credentials, not public-key fingerprints.
- Private keys never enter Git, task records, logs, prompts, or telemetry.

### 4.2 Transport

- The implemented transport is HTTP bound only to `127.0.0.1`, reached through an operator-managed SSH local-forward tunnel over the private overlay.
- Preserve local service bindings on loopback; do not open the federation or inference ports to the mesh/public interface.
- Remote requests terminate at a narrow federation gateway; they do not connect directly to inference, registry, or Command Center listeners.
- Transport reachability and cryptographic peer authentication remain separate states and must be reported separately.

### 4.3 Handshake

A protocol handshake must exchange and verify:
1. protocol version;
2. node identity and peer authorization;
3. capability declaration and requested scopes;
4. fresh cryptographic nonce;
5. bounded timeout and session expiry.

The implemented peer authenticates the handshake with HMAC-SHA256 and echoes the nonce and protocol version. Hello expiry is 10 seconds and authenticated sessions are bounded to five minutes. A successful TCP connection, SSH login, registry record, or HTTP 200 alone is not a federation handshake.

### 4.4 Task handoff

- Use the injected canonical `heavenzfire.shared-task.v1` contract. The adapter requires approved state plus attributable approval evidence and preserves the canonical task ID as the ledger ID/idempotency key.
- Require authenticated caller identity, a task-bound HMAC operator approval proof, and a task-scoped `shared-task.v1` capability grant.
- Reject unknown states, expired sessions/proofs, forged approval claims, task identity mismatch, and unrecognized capability requests. Duplicate delivery of the same canonical record is idempotent at the local ledger.
- Never infer approval from an agent response, model output, provider status, task status, or transport identity.
- No arbitrary remote shell or unrestricted filesystem operation is part of the initial protocol.

### 4.5 Reliability and lifecycle

- Heartbeats carry bounded liveness and optional coarse resource telemetry.
- Leases have explicit expiry; a disconnected node cannot retain an indefinitely valid execution lease.
- Retries are bounded and idempotent. Non-idempotent actions require a fresh authorization decision.
- Reconnect replay is ordered, deduplicated, and audited.
- Revocation invalidates the node's ability to establish new sessions and accept tasks.
- Clock skew is handled using server-issued expiries and bounded tolerance rather than trusting node wall clocks.

## 5. Capability state model

Every node/capability pair must report one of these evidence-backed states:

- `NOT_CONFIGURED`
- `CONFIGURED`
- `TRANSPORT_REACHABLE`
- `AUTHENTICATED`
- `SMOKE_TESTED`
- `CAPABILITY_TESTED`
- `DEGRADED`
- `OFFLINE`
- `REVOKED`

A state transition requires the corresponding evidence reference and timestamp. Do not collapse these states into a generic `CONNECTED` label.

## 6. Research work packages

### R0 — Source-of-truth inspection

- Inspect PR #41 registry/node APIs, lifecycle semantics, persistence, locking, and review state.
- Inspect the canonical shared-task contract and issue #19 adapter requirements.
- Inspect the current mainline task ledger and existing transport/health contracts.
- Produce a dependency map and identify schema mismatches before implementation.

**Acceptance:** file paths, source revisions, API contracts, and unmerged dependencies are documented with exact evidence.

### R1 — Threat model and protocol specification

- Define assets, trust boundaries, attacker capabilities, identity lifecycle, key rotation, revocation, replay protection, and audit requirements.
- Specify handshake and node enrollment messages.
- Specify capability scopes and least-privilege authorization.
- Specify failure behavior for offline, stale, revoked, and partially authenticated nodes.

**Acceptance:** versioned protocol document with positive and adversarial examples; no credentials or private topology in artifacts.

### R2 — Deterministic protocol core

- Implement pure validation and state-transition functions before network integration.
- Add deterministic tests for enrollment approval, invalid identity, replay, expiry, capability escalation, revocation, clock skew, duplicate delivery, and forged approval evidence.
- Keep transport and persistence behind narrow adapters.

**Acceptance:** tests run without real devices or credentials; all invalid or ambiguous states fail closed.

### R3 — Local integration adapters

- Add opt-in Windows PowerShell 5.1, Termux, and Linux preflight/handshake clients.
- Inspect first; do not install packages, alter firewall rules, expose ports, modify startup services, or change SSH keys as part of bootstrap.
- Require explicit enrollment approval and report each capability state separately.

**Acceptance:** local mock-node integration tests pass; live tests are separate and operator-authorized.

### R4 — Live device acceptance

- Enroll each device individually with explicit operator approval.
- Verify handshake nonce/version echo, authenticated peer identity, heartbeat expiry, task handoff, cancellation, duplicate suppression, reconnect, and revocation.
- Keep local inference and control services loopback-only.

**Acceptance:** evidence records include task IDs, protocol version, test commands, exit codes, timestamps, and redacted evidence references. No sensitive IPs, private hostnames, keys, or raw personal telemetry are committed.

## 7. Security invariants

1. No arbitrary remote shell.
2. No unrestricted remote filesystem access.
3. No direct network exposure of loopback inference or control services.
4. No credentials in source, issues, task records, prompts, or logs.
5. No model-generated command executes without inspection and explicit operator authorization.
6. No privileged, destructive, credential, repository-write, deployment, or external-exposure action without explicit approval.
7. No merge or deployment based only on green CI; independent review and live acceptance remain required.
8. Every consequential operation is attributable, idempotency-aware, bounded, and auditable.

## 8. First implementation target

After R0/R1, implement the smallest reusable protocol core in an isolated branch:

- versioned handshake schema;
- node identity/capability validation;
- nonce replay protection;
- explicit enrollment approval record;
- capability-state transition validator;
- deterministic tests.

Do not begin with a general remote command executor, distributed shell, or broad agent autonomy.

## 9. Task record

- `task_id`: `HF-RD-FEDERATION-2026-11-04-R0`
- `created_utc`: `2026-11-04T20:27:00Z`
- `objective`: establish source-backed architecture and acceptance criteria for secure cross-device federation
- `scope`: R0 source inspection and R1 protocol/threat-model specification
- `dependencies`: UnifiedCodebase issue #46; review of PR #41; inspection of canonical shared-task contract and issue #19
- `risk_class`: security-sensitive design; read-only research phase
- `status`: LOOPBACK_IMPLEMENTATION_COMPLETE_PENDING_LIVE_ACCEPTANCE
- `idempotency_key`: `hf-rd-federation-r0-2026-11-04`
- `evidence_refs`: PR #41; PR #45; issue #19; issue #46; operator-provided live SSH and inference test output dated 2026-11-04
- `target_commit_sha`: mainline base selected when this branch was created
- `attempts`: 1
- `last_error`: none
- `next_action`: run Node 20/22 deterministic protocol tests in CI, then add an operator-approved transport adapter and live handshake

## 10. Decision gate

This R&D branch now contains the initial runnable implementation and deterministic loopback integration tests. It is not yet accepted as a live deployment. Do not merge or deploy until the latest Node 20/22 CI run is green, code review is complete, and the physical Windows/Android handshake plus approved task round-trip has been captured.


## 11. Implemented federation runtime — branch work

**Protocol:** `heavenzfire.federation.v1`  
**Transport:** loopback HTTP over SSH local forwarding  
**Node entry point:** `MicroFederation/federation-node.cjs`  
**Runtime:** `MicroFederation/federation-runtime.cjs`  
**Approval:** `MicroFederation/operator-approval.cjs`  
**Task adapter:** `MicroFederation/shared-task-ledger-adapter.cjs`  
**Worker:** existing `MicroFederation/governed-runtime.cjs`  
**Inference:** `MicroFederation/openai-local-inference-adapter.cjs`

Implemented on this branch:

- HMAC-authenticated hello/ack with nonce echo, identity binding, capability allowlists, expiry, replay rejection, and bounded five-minute sessions.
- Loopback-only HTTP server/client with `task.submit` and `task.read` scopes; client rejects non-loopback destinations.
- Signed operator approval proof bound to canonical task ID, exact record hash, actor, evidence reference, nonce, and expiry.
- Canonical shared-task admission to TaskLedger with stable task ID, idempotency, and approval re-verification immediately before execution.
- Task-scoped capability gate using the existing CapabilityStore and CapabilityGate; no un-gated worker path.
- Governed worker calling the local OpenAI-compatible inference facade; model output remains data and is never executed as commands.
- Explicit one-task bootstrap capability grant, with audit event in CapabilityStore.
- Windows node config, Android submit CLI, approval-package CLI, scoped-grant helper, and launch documentation.
- Loopback HTTP and full task-round-trip integration tests added to the Node 20/22 CI workflow.

**Security boundaries:** no remote shell, unrestricted filesystem, network-exposed listener, direct inference exposure, or model-generated command execution. HMAC secrets remain external to the repository. TaskLedger and session state remain process-local/single-writer.

**Not yet proven:** the actual Windows service has not been launched from this branch; the Android SSH tunnel has not yet been used by the new HTTP client; a physical task has not yet been observed reaching ledger `succeeded`. CI fixtures are not live-device evidence.

## 12. Immediate acceptance sequence

1. Verify the latest Node 20 and Node 22 workflow run for the entire federation suite, including HTTP transport and full task round-trip.
2. Review the changed runtime, approval, and capability code; keep the PR draft until review and CI are complete.
3. Pull the branch on Windows and Termux; configure peer and operator secrets locally, never in Git.
4. On Windows, configure the canonical contract path, task-scoped bootstrap grant, capability store, and loopback inference endpoint; launch `federation-node.cjs`.
5. On Android, establish the SSH local-forward tunnel to Windows loopback, run the approval package and submit CLI, and verify the returned task ID.
6. On Windows, verify ledger status `succeeded`, then verify the task projection reports canonical `completed` and ledger `succeeded`.
7. Repeat the same task to prove idempotency; then test invalid proof, missing grant, expired session, and unauthorized capability rejection.
8. Capture redacted command output and exit codes in a live acceptance report. Do not commit secrets, private IPs, raw proofs, or hostnames.

The implementation is ready for this bounded live acceptance run, not for broad mesh deployment or production multi-writer use.
