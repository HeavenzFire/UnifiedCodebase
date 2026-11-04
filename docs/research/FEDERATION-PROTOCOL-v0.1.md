# Federation protocol core v0.1

This module is a transport-independent protocol core. It does not open sockets, execute commands, access files, or expose local inference services.

## Enrollment and trust

Each side must be provisioned with the same per-peer secret (at least 32 UTF-8 bytes) and an explicit enrollment record: `approved: true`, a valid `approvedAt`, and a capability allowlist. Secrets belong only in an operator-managed local secret store; never commit them. Revocation blocks new handshakes in the current process. Durable identity storage, key rotation, and cross-process revocation are not implemented in v0.1.

## Handshake

1. Initiator creates a signed `heavenzfire.federation.v1` hello with a 256-bit nonce, target identity, requested capability scopes, issue time, and a 10-second expiry.
2. Receiver authenticates HMAC-SHA256, checks identity/approval, clock skew, expiry, replay cache, and capability allowlist.
3. Receiver returns a signed acknowledgement echoing the initiating nonce and granting only the requested, mutually authorized capabilities.
4. Initiator verifies signature, identities, protocol version, nonce echo, expiry, and granted scopes.

The replay cache is in-memory and bounded (4,096 entries / five-minute retention); it is not a distributed replay database. The HMAC key is a symmetric bootstrap mechanism, not public-key identity or non-repudiation. Transport confidentiality and peer routing remain the responsibility of the private overlay/SSH adapter.

## Explicit limits

- No remote shell, filesystem API, inference proxy, task executor, or listener is included.
- No distributed locking, durable sessions, heartbeat service, or offline replay is claimed.
- Canonical task approval/evidence mapping remains blocked on the separate issue #19 adapter; this module does not manufacture approval.
- This is a deterministic protocol core for isolated tests and the next integration stage, not a production deployment.


## Loopback HTTP transport binding

`MicroFederation/federation-http-server.cjs` and `federation-http-client.cjs` provide a narrow HTTP binding intended to be reached only through an operator-managed SSH local-forward tunnel.

- Server binding is hard-restricted to `127.0.0.1`; attempts to bind to `0.0.0.0` fail at construction.
- Client accepts loopback HTTP URLs only; remote hosts and HTTPS URLs are rejected. HTTP is acceptable here only inside the SSH-encrypted tunnel.
- `GET /health` reports local process health without exposing peer topology.
- `POST /v1/handshake` accepts the authenticated hello and stores a bounded, process-local session.
- `POST /v1/tasks` requires a live session with `task.submit`, verifies an HMAC-signed message bound to the session nonce, and forwards the canonical record plus approval proof to the fail-closed task adapter.
- The raw approval proof is passed only to the trusted host verifier; it is not logged or persisted by the transport.
- The task adapter remains responsible for validating canonical approval evidence and idempotent ledger admission.

The HTTP transport is still a library component; it does not start itself, configure SSH, provision peer secrets, create Windows services, or modify firewall rules. The task adapter's approval callbacks must be implemented by a trusted host application. The session store is process-local, so restart requires a new handshake. This transport does not provide a worker execution loop or a completed task-result return path.

Tests exercise loopback binding, handshake, authenticated task submission, capability denial, forged-message rejection, and explicit approval-proof forwarding on Node 20 and Node 22.
