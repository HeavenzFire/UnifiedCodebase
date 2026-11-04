# HeavenzFire Open-Source Consolidation Register v0.2

**Status:** Updated baseline; integration milestones are verified, portfolio classification remains provisional  
**Coordinator:** HeavenzFire / UnifiedCodebase  
**Created:** 2026-11-04  
**Canonical coordination thread:** [Unified Field parallel work queue](https://github.com/HeavenzFire/UnifiedCodebase/issues/4)

## Mission

Build a maintainable, auditable consolidation of the HeavenzFire open-source portfolio and selected upstream projects into interoperable capabilities. Consolidation means verified reuse, adapters, shared contracts, deduplication, and reproducible integration—not indiscriminate code copying or flattening every repository into one monolith.

The intended outcome is a local-first engineering and research fabric with reusable modules, clear ownership, measurable runtime behavior, and independently verifiable evidence.

## Evidence and scope limits

The connected GitHub repository listing returned 100 repositories for owner `HeavenzFire` on its first page and zero on the second page. This is a connector-visible listing, not proof of a complete account inventory. Existing UnifiedCodebase coordination notes refer to a historical 276-repository installation-search snapshot; that snapshot must be recovered and reconciled before claiming a complete total.

An account-wide open-pull-request search returned 35 results on 2026-11-04. This is a point-in-time search result, not a stable total. The current UnifiedCodebase open set includes PR #37 (legacy registry/command-center branch), PR #38 (this register's predecessor), and PR #41 (current registry/command-center integration). Dependency-update PRs and work in other repositories remain in the account-wide queue.

No source code is imported by this register. No license has been certified by this register. A repository name, README claim, fork relationship, or GitHub search result is not sufficient proof of license compatibility or technical suitability.

## Provisional capability clusters

These are discovery clusters, not merge decisions.

| Domain | Candidate repositories | Initial treatment |
|---|---|---|
| Unified Field control plane, task lifecycle, policy, registry, evidence | `UnifiedCodebase`, `HeavenzFire`, `The-Elysium-Gateway-`, related ledger/mesh repositories | Compare contracts and implementation boundaries first; select one authoritative contract per capability |
| Local inference and model serving | `ollama`, `llama.cpp`, `Qwen-AgentJC`, `OpenManus`, `crewAI`, `AgentGPT`, `anything-llm` | Preserve upstream projects; integrate through narrow adapters; distinguish forks from original implementations |
| Multimodal and human interaction | `EntangledMultimodalSystem` variants, `mini-omni2`, `LLM2CLIP`, voice/UI projects | Compare actual feature coverage, model/runtime requirements, licenses, and resource costs |
| Quantum and scientific computing | `Quantum-Interplay`, `QuantumChirstosAngelusComputing`, `quantum-ai-research-studio`, `ZAZO-COHERENCE-LATTICE-` | Keep reproducible, testable scientific work separate from speculative claims; preserve null results and controls |
| Developer tools, browser automation, observability, self-hosted services | `MicrosoftEdge-Extensions`, `awesome-mcp-servers`, `awesome-selfhosted`, `awesome-selfhost-docker`, and related projects | Evaluate as tools/catalogs/dependencies; do not absorb entire upstream trees without a concrete need |

## Required repository evidence record

Every candidate must have a record with the following fields before integration:

- Canonical repository URL and immutable source commit SHA
- Owner, upstream repository, fork status, and remotes/provenance
- Default branch, last push, archived status, and repository visibility
- License file, SPDX identifier, license text/version, and compatibility decision; use `UNKNOWN` until verified
- Languages, runtimes, build system, dependency manifests, and generated/vendor code boundaries
- Source-tree fingerprint and duplicate/near-duplicate evidence
- Build/test commands, environment, exit codes, test counts, and artifact hashes
- Security posture: permissions, network listeners, secret handling, execution model, sandbox claims and limitations
- Capability mapping, overlap analysis, maturity, maintenance status, and resource footprint
- Disposition: `KEEP`, `INTEGRATE`, `ADAPT`, `REFERENCE`, `ARCHIVE_CANDIDATE`, or `REJECT`
- Destination module, adapter/API boundary, migration plan, rollback plan, and reviewer evidence

## License and provenance policy

1. No source import until the exact source revision and applicable license are verified.
2. Missing or ambiguous license means reference-only pending legal/provenance review; do not infer permission from public availability.
3. Preserve copyright notices, license texts, NOTICE files, attribution, and upstream history as required.
4. Record modifications and the source commit for every adapted component.
5. Separate HeavenzFire-authored code, third-party upstream code, generated artifacts, and user-provided material.
6. Do not relicense upstream material or claim authorship of imported code.
7. Prefer dependency or adapter integration over copying a whole repository.

## Consolidation decision rules

- Consolidate capabilities and stable contracts, not repository names.
- Retain independent repositories when they have distinct product, research, licensing, or release lifecycles.
- Do not create a second orchestrator, registry, task ledger, approval system, or provider router when an existing implementation can be verified and extended.
- Keep model-generated text untrusted. It cannot grant itself capabilities or approve actions.
- Privileged, destructive, credential-bearing, publishing, or external side-effect operations remain explicitly authorized and auditable.
- Do not describe logical agent roles as independent worker processes unless distinct processes and isolation are demonstrated.
- Every integration must include deterministic tests and a rollback path.

## Work queue

| ID | Work | Acceptance evidence | Status |
|---|---|---|---|
| CONS-01 | Recover and reconcile the historical 276-repository snapshot with the connected account listing | Reconciled list, collection method, timestamp, pagination evidence, unresolved visibility gaps | ACTIVE |
| CONS-02 | Build license, upstream/fork, and provenance register | Per-repository source commit, SPDX/license evidence, attribution and compatibility disposition | QUEUED |
| CONS-03 | Fingerprint repositories and cluster duplicate implementations | Reproducible tree fingerprints, capability matrix, overlap evidence | QUEUED |
| CONS-04 | Reconcile open PRs across the account | PR URL, head SHA, checks, conflicts, dependencies, review status, disposition | ACTIVE |
| CONS-05 | Select authoritative Unified Field contracts | Source paths, API/schema comparisons, compatibility gaps, decision record | ACTIVE |
| CONS-06 | Define integration waves and isolated ownership | Dependency graph, scoped branches, test gates, rollback and reviewers | ACTIVE |
| CONS-07 | Implement first narrow integration with tests | Reviewable PR, deterministic test output, evidence hashes, no unrelated refactor | IN_PROGRESS |

## First convergence target

Most of the control-plane spine now has a verified implementation baseline:

1. **Task lifecycle and pixel mesh:** merged UnifiedCodebase PR #29, including its tested human-protection successor PR #35.
2. **Durable approval replay:** PR #39 merged into the PR #35 branch before #29 reached main.
3. **Agent identity:** merged PR #40, with exact producer/task/node/capability/peer binding into the actual TaskLedger and UnifiedField fabric.
4. **Assistant/GPT provider route and ternary policy:** HeavenzFire PRs #137 and #138 implement UF-TCP/0.2, the task verification endpoint, and an authenticated loopback adapter to the existing provider gateway.
5. **Project/node registry and Agent Command Center:** current PR #41 is rebuilding the stale PR #37 branch on current main, with registry API integration and local-origin controls; final CI/review is pending.
6. **Audit and failure evidence:** TaskLedger, approval nonce store, and bounded workflow failure traces are in the merged fabric.

Do not describe these as a complete portfolio consolidation. The registry/command-center integration, provider runtime configuration, cross-process worker capacity, and external cryptographic verifier attestation still have open work.



## Verified integration baseline (2026-11-04)

| Capability | Verified source of truth | Evidence | Remaining boundary |
|---|---|---|---|
| Ternary policy and assistant KPI contract | `HeavenzFire/HeavenzFire` UF-TCP/0.2 | PR #137 and #138 merged; policy and LocalOrchestrator workflows passed on exact PR head | Full provider inference and signed independent verifier provenance still require operator-side configuration |
| Task ledger, pixel mesh, nonlinear DAG, human approvals | `HeavenzFire/UnifiedCodebase` MicroFederation | PR #29 merged after successor #35; Node 20/22 fabric 49/49, durable services Node 18/20/22 green, shared adapter 11/11 | Worker capacity remains process-local; multi-host execution needs a shared atomic lease service |
| Durable approval replay | `MicroFederation/approval-nonce-store.cjs` | PR #39 merged into #35 before #29; exclusive create, canonical signatures, POSIX permissions, cross-process tests | Same trusted local filesystem only; multi-host deployments need transactional nonce storage |
| Agent identity and node-bound grants | `MicroFederation/agent-identity.cjs` | PR #40 merged; 10/10 unit/integration tests on Node 20 and Node 22 | Production key custody, durable revocation, and protected token broker remain deployment responsibilities |
| Project/node registry and agent console | Current branch PR #41 | Registry CRUD, audit chain, command-center integration, local-origin controls; exact-head CI under review | Do not adopt until all final checks pass; local registry does not prove node liveness |

These milestones are code-level evidence, not a claim that every repository has been inventoried, licensed, tested, or consolidated.

## Current checkpoint

- Existing coordination ledger: [issue #4](https://github.com/HeavenzFire/UnifiedCodebase/issues/4)
- Existing open-PR backlog ledger: [issue #11](https://github.com/HeavenzFire/UnifiedCodebase/issues/11)
- Existing provider integration requirements: [issue #12](https://github.com/HeavenzFire/UnifiedCodebase/issues/12)
- Existing task-contract adapter: [issue #19](https://github.com/HeavenzFire/UnifiedCodebase/issues/19)
- Initial connected-account query: 100 repositories on first page; zero on second
- Current account-wide open-PR query: 35 results (2026-11-04)
- Merged implementation baseline: UnifiedCodebase PR #29 (including #35/#39) and PR #40; HeavenzFire PRs #135–#138
- Current registry/command-center successor: UnifiedCodebase PR #41, pending final CI/review
- Superseded UnifiedCodebase PRs #30–#36 were closed or merged into the verified successor chain; old branches must not be treated as independent integration targets
- No repository deletion or archival is authorized by this register

**Next step:** finish PR #41 exact-head CI and review, then reconcile the remaining 35 account-wide open PRs by dependency, security, license, and workflow status. Recover the historical 276-repository snapshot before making any portfolio-total claim.
