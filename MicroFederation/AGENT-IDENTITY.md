# HeavenzFire Agent Identity v0.2

## Purpose

`agent-identity.cjs` provides a dependency-free Ed25519 token issuer/verifier and concrete adapters for the Unified Field fabric's producer and worker authorization callbacks. It complements, rather than replaces, the TaskLedger, CapabilityGate, human approval gate, and durable audit evidence.

## Token contract

Tokens use a compact three-segment format with canonical JSON and an Ed25519 signature. The signed header contains `alg=EdDSA`, `typ=HFA1`, and `kid`. Claims contain:

- `iss`: trusted issuer identifier.
- `sub`: stable agent identity.
- `aud`: one exact service audience.
- `iat` / `exp`: issue and expiry time in Unix seconds.
- `jti`: unique token identifier.
- `grantId` / `taskId`: capability grant and task binding.
- `nodeId`: optional exact workflow-node binding; required for worker authorization.
- `capabilities`: bounded explicit capability slugs.

The default maximum lifetime is 300 seconds; the configured ceiling is 900 seconds. The verifier rejects invalid signatures, non-canonical encodings, untrusted issuer/key IDs, wrong audience, wrong subject, wrong task, wrong node, missing capability, expired/future-issued tokens, and revoked tokens. It never accepts a caller-supplied algorithm or public key.

## Actual fabric integration

`createFabricIdentityPolicies()` now returns callbacks compatible with the current `TaskLedger` and `createUnifiedFieldFabric` contracts:

- `authenticateProducer({ principal, producerProof, taskId })` verifies a short-lived producer token containing `fabric.submit`, then returns the authenticated issuer/subject/grant provenance to the ledger. The raw token is not copied into the task payload or metadata.
- `authorizeWorker({ taskId, nodeId, capability, peerId })` obtains a worker token from the injected `getWorkerToken` provider, verifies exact subject/task/node/capability scope, calls the trusted `CapabilityGate.authorize()`, and returns the exact grant envelope expected by the fabric: task ID, node ID, capability, peer ID, expiry, issuer, and grant ID.
- A worker token bound to another node cannot execute the requested DAG node.
- The integration test instantiates the real TaskLedger, PixelMesh, and UnifiedField fabric, then proves producer admission, worker execution, node-scope denial, and absence of raw tokens in the persisted ledger.

A valid signature alone does not authorize an operation. The existing CapabilityGate must independently allow the exact action.

## Key and revocation boundaries

Private signing keys are injected as a Node KeyObject or supported Node key input. The module does not read private keys from task data, environment variables, repository files, or logs. Production key custody, rotation, secure provisioning, and durable revocation storage remain responsibilities of the host integration.

A revocation-store callback is mandatory. It must return exactly `false` for a token that is not revoked, `true` for a revoked token, and throw or return another value when status cannot be established. The verifier fails closed when revocation status is unavailable. Unit tests use an in-memory set only as a deterministic fixture; it is not a production revocation store.

## Limitations

- No HTTP listener, token transport, OAuth exchange, refresh-token flow, or external identity provider is created.
- No production key vault, durable revocation database, or key-rotation controller is included.
- Worker-token delivery is injected through `getWorkerToken`; production deployments must implement a protected broker and avoid logging or persisting bearer tokens.
- The current worker capacity map remains process-local; multi-process worker scheduling requires a shared atomic lease service.
- High-impact actions still require the independently verified human approval path.
- Ed25519 private-key custody and durable revocation are deployment responsibilities.

## Verification

Run:

```sh
node --check MicroFederation/agent-identity.cjs
node --test MicroFederation/test-agent-identity.cjs MicroFederation/test-agent-identity-fabric-integration.cjs
```

GitHub Actions runs both suites on Node 20 and Node 22.
