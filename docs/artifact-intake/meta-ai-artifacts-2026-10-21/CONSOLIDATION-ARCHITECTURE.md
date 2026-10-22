# Consolidation Architecture Proposal

Status: **proposed; source inspection required before implementation**

## Goal

Deliver one coherent HeavenzFire product with shared contracts and independently testable modules. "One system" means one product experience and controlled integration—not one monolithic file or an indiscriminate merge of unrelated code.

## Proposed logical boundaries

1. **Client shell** — navigation, configuration, status, artifact/module loading. Tesla Omni Fusion Engine is a candidate only; compare its source against other shells before choosing.
2. **Topology and observability** — node inventory, truthful health states, events, relationships, logs, and diagnostics. Tesla Resurrected Topology Consciousness is a candidate UI, not a proven service.
3. **Runtime and orchestration** — task lifecycle, queueing, model-provider adapters, cancellation, retries, timeouts, concurrency and result reporting. Tesla Prime Core Real is a candidate boundary.
4. **Interchange contract** — one versioned schema, validated examples, adapter interface, and conformance tests. The visible Interchange Schema, Example, Adapter Plan, and Test Interchange artifacts should be assessed as one group.
5. **Secure local execution** — a separate Windows execution service with authentication, least privilege, explicit command allowlists, user approvals for privileged/destructive actions, and tamper-evident audit events. Omni Commander Desktop Remote may be a client to this service; UI code must not itself be treated as a security boundary.
6. **Isolation and messaging** — bounded worker processes/containers where available, message validation, quotas, timeouts, and backpressure. Microsandbox Mesh Vortex Braid is a candidate concept; isolation guarantees must be demonstrated, not inferred from the name.
7. **Platform clients** — PWA and Android clients share API contracts and identity but retain platform-specific capabilities and permissions. Legion PWA Heavenzfire Grimoire and Legion Android Final are candidates.
8. **Persistence and configuration** — explicit data schemas, migrations, backup/recovery, secret references rather than embedded secrets, and documented retention.

## Candidate mapping (not yet confirmed)

| Candidate artifact | Potential responsibility | Required source evidence |
|---|---|---|
| Tesla Omni Fusion Engine | Client shell | entry point, routing, module system, build config |
| Tesla Resurrected Topology Consciousness | Topology UI | node data source, event protocol, health semantics |
| Tesla Prime Core Real | Runtime boundary | service APIs, lifecycle, queue and provider code |
| Test Interchange | Conformance tests | executable test cases and assertions |
| Adapter Plan V0 1 0 | Adapter design | supported interfaces and migration plan |
| Interchange Example V0 1 0 | Valid example payload | validation against schema |
| Interchange Schema V0 1 0 | Canonical data contract | schema version, compatibility rules |
| Omni Commander Desktop Remote | Remote-control client | auth model, command transport, approval flow |
| Microsandbox Mesh Vortex Braid | Isolation/messaging | actual isolation primitives, limits, threat model |
| Legion PWA Heavenzfire Grimoire | Web client | service worker, routes, API use, build manifest |
| Legion Android Final | Android client | project type, package/build files, permissions |

## Integration rules

- Prefer existing working implementations over rewrites.
- Keep module interfaces explicit and versioned.
- Use one canonical schema per shared contract; validate inputs at trust boundaries.
- Keep privileged execution separate from UI and model inference.
- Do not count configured agents as operational agents; report live health, completed work, failures, and resource use from measurements.
- Make every status observable and evidence-based: `ALIVE`, `DEGRADED`, `DARK`, or `UNKNOWN`, with timestamp, reason, and last successful check.
- Do not add external network dependencies without documenting purpose, scope, and fallback behavior.
- Preserve source attribution and licensing when incorporating third-party or externally generated material.

## Recommended repository shape after source audit

```text
apps/
  desktop/
  pwa/
  android/
services/
  orchestrator/
  secure-execution/
  topology/
packages/
  interchange-schema/
  adapters/
  observability/
  shared-config/
tests/
  contract/
  integration/
  security/
  e2e/
docs/
  architecture/
  threat-model/
  operations/
```

This is a target shape, not a claim that those directories currently exist or that every boundary needs a separate deployable service. Choose process boundaries based on existing code, security needs, and operational cost.

## Merge strategy

1. Establish baseline tests and a manifest of all source artifacts.
2. Identify the authoritative implementation for each responsibility.
3. Write adapters around incompatible interfaces before refactoring internals.
4. Integrate in small slices behind feature flags.
5. Run tests after each slice and compare behavior to the baseline.
6. Keep the source artifacts and provenance intact; use a branch and reviewable commits.
7. Merge only after clean-start build, regression, security, and recovery checks pass.
