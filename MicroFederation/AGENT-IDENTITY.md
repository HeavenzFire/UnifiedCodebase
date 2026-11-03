# HeavenzFire Agent Identity v0.1

## Purpose

agent-identity.cjs provides a dependency-free Ed25519 token issuer/verifier and adapters for the existing Unified Field fabric producer and worker authorization callbacks. It is an identity proof layer, not a replacement for CapabilityStore, CapabilityGate, the human approval gate, or the credential broker.

## Token contract

Tokens use a compact three-segment format with canonical JSON and an Ed25519 signature. The signed header contains alg=EdDSA, typ=HFA1, and kid. Claims contain:

- iss: trusted issuer identifier.
- sub: stable agent identity.
- aud: one exact service audience.
- iat / exp: issue and expiry time in Unix seconds.
- jti: unique token identifier.
- grantId / taskId: capability grant and task binding.
- capabilities: bounded, explicit capability slugs.

The default maximum lifetime is 300 seconds; the configured ceiling is 900 seconds. The verifier rejects invalid signatures, non-canonical encodings, untrusted issuer/key IDs, wrong audience, wrong subject, wrong task, missing capability, expired/future-issued tokens, and revoked tokens. The verifier never accepts a caller-supplied algorithm or public key.

## Authorization integration

createFabricIdentityPolicies() returns authenticateProducer and authorizeWorker callbacks for the Unified Field fabric. Each callback verifies the signed identity token and then calls the existing trusted CapabilityGate.authorize() with the token's agent identity, grant ID, task ID, and requested capability. A valid signature alone does not authorize an operation.

Producer proofs are passed as an out-of-band callback argument and are not copied into task payload or metadata. Worker tokens are obtained from an injected getWorkerToken provider; this module does not persist or distribute raw tokens.

## Key and revocation boundaries

Private signing keys are injected as a Node KeyObject or supported Node key input. The module does not read private keys from task data, environment variables, repository files, or logs. Production key custody, key rotation, secure provisioning, and durable revocation storage remain responsibilities of the host integration.

A revocation-store callback is mandatory. It must return exactly false for a token that is not revoked, true for a revoked token, and throw or return another value when the store cannot establish status. The verifier fails closed when revocation status is unavailable. The test suite uses an in-memory set only as a deterministic fixture; it is not a production revocation store.

## Limitations

- No HTTP listener, token transport, OAuth exchange, refresh-token flow, or external identity provider is created.
- No production key vault, durable revocation database, cross-process nonce/replay database, or key-rotation controller is included.
- Access tokens are short-lived bearer credentials. Protect transport and storage; do not put them in task payloads, logs, issues, or audit metadata.
- High-impact actions still require the existing independently verified human approval path.
- The current fabric implementation is on a separate unmerged branch. Integrate these callbacks only after that branch's constructor wiring and tests are reviewed and corrected.

## Verification

Run:

    node --check MicroFederation/agent-identity.cjs
    node --test MicroFederation/test-agent-identity.cjs

The GitHub Actions workflow runs the same checks on Node 20 and Node 22.
