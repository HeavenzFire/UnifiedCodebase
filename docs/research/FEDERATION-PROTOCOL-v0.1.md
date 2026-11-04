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
