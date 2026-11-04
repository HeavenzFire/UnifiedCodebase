# Cross-device federation protocol and runtime v0.1

## Implemented components

The protocol core is transport-independent. The repository also contains a bounded loopback HTTP binding and a governed local worker composition:

- `MicroFederation/federation-protocol.cjs`: HMAC-SHA256 authenticated hello/ack, explicit approved-peer enrollment, capability negotiation, nonce echo, expiry/clock-skew checks, bounded replay cache, and process-local revocation.
- `MicroFederation/federation-http-server.cjs` and `federation-http-client.cjs`: loopback-only task submission and status retrieval over an operator-managed SSH local-forward tunnel.
- `MicroFederation/shared-task-ledger-adapter.cjs`: maps `heavenzfire.shared-task.v1` records to the existing ledger; requires a trusted operator-approval verifier and revalidates the stored attestation before execution.
- `MicroFederation/operator-approval.cjs`: HMAC-bound, expiring operator approval proofs tied to the canonical task hash and attributable approval evidence.
- `MicroFederation/governed-runtime.cjs` and `adaptive-control-plane.cjs`: local worker lifecycle and capability-gate checks before task execution.
- `MicroFederation/openai-local-inference-adapter.cjs`: bounded OpenAI-compatible requests to a loopback inference endpoint.
- `MicroFederation/federation-runtime.cjs` and `federation-node.cjs`: compose the node service, task adapter, local inference worker, and governed runtime.

## Enrollment and handshake

Each side must be provisioned with the same per-peer secret (at least 32 UTF-8 bytes) and an explicit enrollment record: `approved: true`, a valid `approvedAt`, and a capability allowlist. Secrets must remain in an operator-managed local secret store and must never be committed.

The initiator sends a signed `heavenzfire.federation.v1` hello with a 256-bit nonce, target identity, requested scopes, issue time, and bounded expiry. The receiver validates the HMAC, peer enrollment, clock skew, expiry, replay cache, and capability allowlist, then returns a signed acknowledgement echoing the initiating nonce. The initiator verifies the acknowledgement and negotiated scopes.

The replay cache and authenticated sessions are process-local and bounded. The HMAC key is a symmetric bootstrap mechanism, not public-key identity or non-repudiation. Durable identity, key rotation, and cross-process revocation are not implemented in v0.1.

## Transport and task lifecycle

- The HTTP server binds only to `127.0.0.1`; attempts to bind to `0.0.0.0` fail.
- The client accepts numeric loopback HTTP URLs only, rejects URL credentials/aliases/paths/queries/redirects, and disables caching. Remote use must go through an SSH local-forward tunnel.
- `GET /health` reports local process health.
- `POST /v1/handshake` establishes a short-lived authenticated session.
- `POST /v1/tasks` requires `task.submit`, a valid session-bound HMAC, an explicitly approved canonical record, attributable approval evidence, and a valid operator approval proof.
- `POST /v1/tasks/get` requires `task.read` and returns the canonical projection plus ledger result/evidence.
- The local worker checks capability grants through `CapabilityGate`, revalidates the operator attestation, and calls only the configured loopback inference endpoint. It does not execute model-generated shell commands or grant remote shell/filesystem access.

The operator approval package and task-scoped capability grant are separate controls. A queued ledger record is not itself proof of approval or capability authorization. High-impact capabilities remain denied by the example node configuration until a separate trusted human-approval provider is configured.

## Status mapping

| Ledger state | Canonical state |
|---|---|
| queued | approved |
| claimed / running | running |
| succeeded | completed |
| failed | failed |
| cancelled | unsupported; projection fails explicitly |

Task identity and original canonical evidence are preserved. Ledger events, results, and evidence are returned in the adapter envelope rather than silently discarded.

## Explicit limitations

- The ledger and capability store are file-backed and process-local; this does not provide distributed locking, cross-process atomicity, or multi-host lease fencing.
- Sessions and replay protection are process-local; restart requires a new handshake.
- No heartbeat service, offline task queue synchronization, automatic reconnect, key rotation, post-quantum identity, or production identity provider is included.
- The HTTP service does not configure SSH, install packages, alter firewall rules, expose ports, or create startup services.
- The local inference adapter expects an OpenAI-compatible `/v1/chat/completions` endpoint; validate the exact model/backend response on the target Windows host before enabling worker execution.
- CI and local simulated integration tests do not prove that the user's Windows and Android devices have completed a live handshake or task round-trip.

## Verification

The CI matrix runs deterministic protocol, approval-adapter, HTTP transport, governed task round-trip, and local inference adapter tests on Node 20 and Node 22. Live device acceptance must be recorded separately after the Windows node is started, the Android SSH tunnel is established, and a bounded approved task completes end to end.
