# Federation protocol and loopback transport v0.1

**Protocol:** `heavenzfire.federation.v1`  
**Transport:** HTTP over an operator-managed SSH local-forward tunnel  
**Listener:** loopback only (`127.0.0.1`)

## Trust and enrollment

Each node has an operator-approved peer enrollment containing the peer node ID, a per-peer HMAC-SHA256 secret (minimum 32 UTF-8 bytes), an approval timestamp, and an explicit capability allowlist. This is symmetric bootstrap authentication, not asymmetric identity or non-repudiation. Secrets are supplied from local environment/secret storage and are never committed.

The handshake hello has a 256-bit nonce and a 10-second expiry. The receiver validates peer enrollment, signature, protocol, target identity, clock skew, capability allowlist, and replay state. The signed acknowledgement echoes the hello nonce and grants only the requested mutually authorized capabilities. A successful session is bounded to five minutes. Handshake replay state and active sessions are process-local and bounded.

Peer-signed task messages bind the source and target node IDs and the authenticated session nonce. The receiver verifies the HMAC and session scope before accepting a task message. Duplicate task delivery is made idempotent by the canonical task ID and durable ledger input hash; it is not a distributed exactly-once guarantee.

## HTTP binding

- `MicroFederation/federation-http-server.cjs` binds only to `127.0.0.1`; construction with a non-loopback host fails.
- `MicroFederation/federation-http-client.cjs` accepts numeric loopback HTTP URLs only. Remote IPs, host aliases, URL credentials, paths, queries, fragments, and HTTPS are rejected. HTTP is used only inside the SSH-encrypted tunnel.
- `GET /health` reports local process health.
- `POST /v1/handshake` authenticates and stores a bounded process-local session.
- `POST /v1/tasks` requires `task.submit`, validates a peer-signed message, and passes the canonical record and signed operator approval proof to the host task adapter.
- `POST /v1/tasks/get` requires `task.read` and returns a canonical projection plus the ledger evidence envelope.

The HTTP service does not open firewall ports, create SSH tunnels, execute shell commands, or expose the local inference facade.

## Approval and execution

The receiving adapter requires:
1. a canonical `heavenzfire.shared-task.v1` record in `approved` / `approved` state;
2. exactly attributable approval evidence;
3. a valid HMAC operator proof bound to the exact canonical record hash and task ID;
4. a task-scoped `shared-task.v1` capability grant for the record's agent ID and grant ID;
5. a governed worker invocation through `GovernedRuntime`.

The adapter re-verifies the stored approval attestation immediately before inference. The local inference adapter calls only the configured loopback OpenAI-compatible endpoint. Model output is returned as data; it is never interpreted as shell commands or filesystem operations.

## Explicit limits

- Peer and operator approval secrets are symmetric HMAC keys; asymmetric identity, key rotation, and hardware-backed storage are not implemented.
- Active sessions and handshake replay state are in-memory; restart requires a new handshake.
- TaskLedger is a file-backed, single-process ledger. No distributed locks, cross-process multi-writer safety, heartbeat protocol, offline replay, or cross-node lease transfer are claimed.
- Cancellation currently has no lossless canonical-v1 mapping and is rejected by the projection rather than silently reclassified.
- CI loopback integration tests do not prove the physical Windows/Android devices have been launched or enrolled. Live acceptance remains an operator-run step.
- No arbitrary remote shell, remote filesystem, model-generated command execution, or public listener is included.
