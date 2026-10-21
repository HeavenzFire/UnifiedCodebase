# Repository Integration Inventory

This catalog is deliberately a starter set, not a claim that the entire GitHub account has been inventoried. Entries marked `candidate-not-reverified` come from an earlier audit summary and must be rechecked against the current default branch before integration.

## Integration gate

A repository can move from `unassessed` to an integration candidate only after recording:
- Exact repository URL, default branch, and inspected commit SHA.
- Root file listing and detected languages/runtime.
- Build/test commands and observed results (including failures).
- Network listeners, credentials, data flows, and write/destructive capabilities.
- Proposed adapter contract and a test proving its behavior.
- Maintainer review before any merge into `main`.

## Status definitions

- `unassessed`: not yet inspected in this stage.
- `candidate-not-reverified`: candidate surfaced by prior work; current source has not yet been reconfirmed.
- `verified-component`: inspected commit, reproducible checks, and explicit interface contract exist.
- `integrated`: adapter is merged and contract tests pass against the component.
- `blocked`: dependency, security, provenance, or test gap prevents integration.

## Safety boundaries

The catalog must not treat a repository name, README claim, HTTP 200, or green health endpoint as proof of functional integration. No credentials or personal data belong in this file. Keep external-provider calls opt-in, local-first by default, and consequential actions human-approved.


## Initial metadata triage (selected repositories)

Snapshot date: 2026-10-20. The following metadata was fetched from GitHub repository metadata. Candidate roles are hypotheses from repository names/descriptions, not verified capabilities. These entries remain `unassessed` until the gate above is completed.

| Repository | Default branch | Primary language | Last updated (UTC) | Candidate role | Required next inspection |
|---|---|---|---|---|---|
| [Sovereign-Node-](https://github.com/HeavenzFire/Sovereign-Node-) | main | TypeScript | 2026-10-19 | Node/API service adapter | Inspect routes, auth, health semantics, and side effects |
| [Audit-of-the-State-](https://github.com/HeavenzFire/Audit-of-the-State-) | main | TypeScript | 2026-04-22 | Public-record audit / evidence intake | Inspect data sources, citations, privacy, and correction cadence |
| [Public-Transparency-Portal](https://github.com/HeavenzFire/Public-Transparency-Portal) | main | TypeScript | 2026-04-17 | Public-facing findings and aggregate reporting | Inspect data model, publication flow, redaction, and corrections |
| [CivicForce](https://github.com/HeavenzFire/CivicForce) | main | TypeScript | 2025-12-28 | Nonviolent civic action / evidence packet workflow | Inspect workflows and require sourced claims and human review |
| [HRE-Allocator-Hashchain-Vanguards](https://github.com/HeavenzFire/HRE-Allocator-Hashchain-Vanguards) | main | TypeScript | 2026-01-03 | Ledger / allocation concepts | Inspect accounting semantics, identity model, and payment capabilities |
| [HeavenzFire-Reclamation-Command](https://github.com/HeavenzFire/HeavenzFire-Reclamation-Command) | main | TypeScript | 2026-02-01 | Governance / orchestration candidate | Inspect entry points, permissions, external calls, and tests |
| [Elysian-Gateway---Resurrection-Portal](https://github.com/HeavenzFire/Elysian-Gateway---Resurrection-Portal) | main | TypeScript | 2025-10-10 | Gateway / UI candidate | Inspect provider calls and distinguish simulation from factual claims |
| [HeavenzFire-Core-System-1](https://github.com/HeavenzFire/HeavenzFire-Core-System-1) | main | TypeScript | 2026-01-03 | Core orchestration candidate | Identify runtime entry point, interfaces, and overlap |
| [Verifier-Mesh-Command-Center](https://github.com/HeavenzFire/Verifier-Mesh-Command-Center) | main | TypeScript | 2026-01-05 | Child-safety verification concept | Audit privacy, authorization, lawful data access, false positives, and human oversight |
| [Syntropic-Guardian-Dashboard](https://github.com/HeavenzFire/Syntropic-Guardian-Dashboard) | main | TypeScript | 2025-10-07 | Guardian monitoring dashboard candidate | Confirm displayed status is backed by live checks |
| [Nexus-Deployment-Control](https://github.com/HeavenzFire/Nexus-Deployment-Control) | main | TypeScript | 2025-12-26 | Deployment / operations candidate | Inspect deployment privilege scope, network exposure, and rollback |
| [Unified-App-System](https://github.com/HeavenzFire/Unified-App-System) | main | TypeScript | 2026-01-19 | App aggregation / shared UI candidate | Identify reusable contracts instead of duplicating applications |

## Universal integration gate

1. Record repository URL, default branch, inspected commit SHA, license, language, and permissions.
2. Inspect actual entry points, dependencies, network access, storage, credentials, and destructive side effects.
3. Classify as library, service, UI, data source, experiment, archived shell, or duplicate; never infer function from naming alone.
4. Define a narrow adapter with typed I/O, timeout, health state, permission scope, and explicit error semantics.
5. Add fixture/mocked contract tests; use live tests only against safely available local services.
6. Open a reviewable PR and retain upstream provenance. Never copy credentials or personal case data into this repository.
7. Distinguish static checks, unit tests, live integration tests, and production operation. One does not imply the others.

Public-interest guardrails: child-safety data requires minimization, provenance, correction, and human review. Financial reconciliation is read-only; deltas are not proof of fraud and do not authorize funds movement. HTTP 200 is not proof of security or complete behavior. Autonomous external actions remain disabled until permissions, approval, rollback, and audit behavior are tested.
