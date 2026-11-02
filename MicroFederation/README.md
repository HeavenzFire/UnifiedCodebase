# HeavenzFire MicroFederation

**Status:** repository-tracked orchestration and evidence prototype. GitHub source and automated tests are verifiable here; the live Windows/Termux runtime must be verified on its host and is not inferred from repository state.

## Architecture

- One root conductor routes a bounded task to configured micro-sandboxes.
- Each sandbox dispatches four logical roles concurrently: conductor, builder, verifier, reviewer.
- Ternary role decisions: `+1` approve, `0` abstain, `-1` reject. Any rejection vetoes acceptance; approval requires quorum; otherwise defer.
- Root acceptance requires every sandbox to approve, stable builder-artifact hashes to agree, independent receipt verification, and any declared supported task acceptance contract to pass. Incorrect or unsupported declared contracts quarantine the task.
- Task envelopes support HMAC-SHA256 signatures, expiry, issuer allowlists, and replay rejection.
- Shared service prototypes cover capability scoping, expiry/revocation, high-impact human approval, append-only JSONL evidence, hash-chained audit events, content-addressed artifacts, bounded scheduling, and health reporting.
- The provider registry persists provider/model declarations and lifecycle evidence without accepting or storing credential values.

## Run the local tests (Windows PowerShell 5.1)

```powershell
Set-Location C:\Users\rucke\HeavenzFire\UnifiedField\MicroFederation
node .\test-micro-federation.cjs
node .\test-federation-services.cjs
node --test .\test-provider-registry.cjs
.\verify-provider-registry.ps1
node --test .\test-task-ledger.cjs
node --test .\test-ledger-orchestrator-worker.cjs
node --test .\test-capability-store.cjs
node --test .\semantic-acceptance.test.cjs
```

## Run a live two-sandbox acceptance

```powershell
node .\run-live-two-sandbox.cjs
```

This submits eight real model-backed tasks through the existing loopback orchestrator. Both sandbox task graphs run concurrently, but the adapter serializes inference because the current orchestrator only admits one active task. The roles share one model; they are not four independent AI instances. The live test uses exact expected response tokens, so it proves routing/execution/evidence plumbing, not broad reasoning quality.

## Evidence files

- `live-multisandbox-receipt.json`: latest live run, signed-envelope verification, both sandbox traces, model responses, root decision, artifact digest, and audit-chain result.
- `federation-audit.jsonl`: append-only JSONL audit events from live runs; each run has its own hash chain.
- `federation-receipts.jsonl`: compact per-run receipts, including the earlier quarantined run.
- `live-orchestrator-acceptance.json`: four sequential live model task results.
- `live-agent-acceptance.json` and `live-single-agent-evidence.json`: failed `/ask`-endpoint acceptance attempts; retained as counterevidence.

## Provider registry and rollback

`provider-registry.cjs` persists provider/model declarations, capability labels, lifecycle states, and evidence references. Supported states are `configured`, `authenticated`, `smoke-tested`, `capability-tested`, `degraded`, and `disabled`. Credential configuration stores only an environment-variable name such as `GEMINI_API_KEY`; raw API-key values are rejected and never persisted. A provider remains `configured` until a separate credential check and provider-specific smoke test produce evidence. No Gemini, Mistral, Qwen Cloud, Meta, Monica, or Merlin live connection is claimed by this registry.

Run `node --test .\test-provider-registry.cjs` and `.\verify-provider-registry.ps1`. The PowerShell 5.1 verifier checks for Node.js 18+, syntax-checks the registry module, and runs the registry test suite.

Before changing a live registry file, stop the process that writes it and make a timestamped backup **outside the repository**. Example PowerShell 5.1 commands (set the path to the actual registry file used by the running instance):

```powershell
$RegistryPath = 'C:\path\to\providers.json'
$BackupPath = "$RegistryPath.$(Get-Date -Format yyyyMMddHHmmss).bak"
Copy-Item -LiteralPath $RegistryPath -Destination $BackupPath
Get-Content -LiteralPath $BackupPath -Raw | ConvertFrom-Json | Out-Null
```

To roll back, stop the writer, restore the chosen backup, verify that it parses, then restart the service. Do not commit registry data containing secrets; the module is designed to store environment-variable names rather than credential values.

## Durable task ledger and orchestrator bridge

`task-ledger.cjs` is an opt-in persistence primitive for the existing orchestrator, not a replacement runtime or an automatic worker launcher. It supports:
- `queued → claimed → running → succeeded/failed/cancelled` task lifecycle.
- Atomic JSON-file replacement, restart recovery, idempotent task creation, evidence references, and auditable transition events.
- Exclusive claims within one ledger instance, worker ownership checks, expiring leases, lease reclamation, and bounded retries (1–10 attempts).
- Strict task input fields; arbitrary credential fields such as `apiKey` are rejected.
- Explicit cancellation and status/attempt statistics.

`ledger-orchestrator-worker.cjs` is a small opt-in bridge to the existing `LiveOrchestratorAdapter` contract. A caller supplies the existing ledger and adapter; `runOnce()` claims one task, passes its prompt/role to the adapter, and persists either the result or a bounded retry/failure. It times out adapter work before lease expiry and reports lease loss explicitly. It does not start automatically, modify the existing live runner, or bypass the policy/approval boundary.

The task ledger serializes writes within one Node.js process. It is **not** a multi-process or distributed lock/queue, and must not be shared concurrently by independent processes until cross-process coordination is implemented.

## Governed supervised runtime

`governed-runtime.cjs` adds an explicit, single-process polling supervisor around the durable TaskLedger and the existing `adapter.run()` contract. It is opt-in: importing the module starts no timers or workers. Call `start()` to begin polling and `stop()` to stop future claims and await the in-flight task.

- Every declared task capability is checked through the injected CapabilityGate before the orchestrator adapter is invoked.
- Capability-bearing tasks fail closed when the gate, agent identity, or grant identity is missing; policy denials are terminal and are not retried.
- Transient adapter failures use the ledger's bounded retry policy. Successful results and evidence references are persisted through TaskLedger.
- The supervisor exposes running/in-flight/completed/failed/blocked status and prevents overlapping polling cycles within the process.
- This remains a single-process supervisor. It does not claim distributed locking, cross-process singleton enforcement, automatic service installation, or a configured production approval verifier.

Run `node --test .\\test-governed-runtime.cjs` or use `verify-adaptive-control-plane.ps1`, which includes this suite.

## Governed shared-task execution

The shared-task adapter now exposes two execution modes:

- `run()` is the governed-supervisor adapter contract. It does **not** claim, start, complete, or fail ledger tasks. The `governed-runtime.cjs` supervisor is the sole owner of those transitions.
- `runOne()` remains available for compatibility with existing standalone callers. Do not run it against the same queue at the same time as a governed supervisor; it owns its own claim/start/complete/fail lifecycle.

For governed execution, the canonical approved task metadata must include `agentId` and `grantId`. The enqueue path stores those identifiers with the canonical-record digest and trusted approval evidence reference. Before execution, `run()` reloads the canonical record, verifies its digest, rechecks the trusted approval attestation, and checks that the prompt and role still match the approved record. Verification failures are marked as policy denials, so the supervisor fails the task without retrying it. The supervisor's CapabilityGate separately checks the `shared-task.v1` grant before invoking the adapter.

The trusted approval verifier and canonical-task loader remain host-injected dependencies. The adapter does not manufacture approvals, credentials, or provider connections. A grant must be scoped to the resulting ledger task ID when the CapabilityStore grant uses task-level scope.

The governed integration tests cover the real CapabilityStore/CapabilityGate path, approval re-verification, canonical-content drift, capability denial, and single-owner lifecycle transitions:

```powershell
node --test .\\test-governed-runtime.cjs
node --test .\\shared-task-adapter.test.cjs
```

## Durable capability and policy store

`capability-store.cjs` persists scoped grants and revocations with atomic JSON replacement. It checks agent identity, optional task scope, capability membership, and expiry. High-impact capabilities (`repo.merge`, `deploy`, `credential.write`, `network.expose`, and `command.privileged`) require explicit `humanApproval: true` at evaluation time. Grant inputs reject undeclared fields such as raw API keys.

Grant, revocation, and policy-evaluation events are hash-chained. On restart, the store verifies the chain and checks that persisted grant state matches the event history. This detects accidental or unsophisticated edits, but is not a signed or externally anchored audit system. Writes are serialized within one Node.js process only. The component is opt-in and is not wired into the live instance by default; production integration must source approval from the trusted control plane, not from an untrusted agent payload.

Run `node --test .\test-capability-store.cjs` to verify restart persistence, revocation, scoped authorization, human-approval enforcement, credential-field rejection, and audit integrity.

## Security and production boundaries

- The live acceptance generates a per-run signing key in process memory. It is intentionally not persisted; this demonstrates signature validation but is **not** a production identity/key-management design.
- Audit log append mode is append-only by application behavior, not tamper-proof against a host administrator. Production needs OS-enforced ACLs, protected signing keys, and remote or WORM-backed anchoring.
- The original capability registry, policy engine, artifact store, and health monitor remain in-memory prototypes.
- Local model requests are restricted to the existing `/task` API. The failed `/ask` tests show the agent endpoint did not survive four concurrent requests; do not use that endpoint as a parallel worker pool until its failure mode is fixed.
- No Gemini, Mistral, Qwen Cloud, Meta, Monica, or Merlin live connection is claimed without provider-specific credentials and successful smoke-test evidence.
- No remote GitHub mutations, commits, merges, or deployments are performed by these scripts.

## Next integration milestones

1. Integrate task and capability persistence through a single supervised local service with single-writer ownership and graceful shutdown.
2. Persist artifact metadata and policy decisions with the same recovery/evidence contract.
3. Add independent model/tool adapters per sandbox and isolate their resource budgets.
4. Resolve the current `/ask` concurrent 502 behavior and measure safe parallel inference capacity.
5. Add live provider smoke tests only after authorized credentials are configured.


## Adaptive control plane (opt-in)

```powershell
Set-Location C:\Users\rucke\HeavenzFire\UnifiedField\UnifiedCodebase\MicroFederation
.\install-adaptive-control-plane.ps1
```

The installer fast-forwards a clean checkout from `origin/main`, preserves the known untracked `mesh-queue-recovery.json` snapshot, runs the adaptive and existing regression suites, initializes persistent state under the user's home directory (`~/.heavenzfire/adaptive-control-plane`), and records a fresh host telemetry snapshot. It refuses to overwrite other local changes. To verify without updating Git, run ` .\verify-adaptive-control-plane.ps1 `.

The adaptive layer extends this repository; it does not replace the root conductor, TaskLedger, CapabilityStore, or shared-task approval contract.

- `adaptive-control-plane.cjs` collects host telemetry (RAM, CPU, optional NVIDIA VRAM, disk and socket-count observations) and accepts explicit provider-quota telemetry. It derives per-workload concurrency from resource profiles. Capacity can expand or contract after each telemetry refresh; no fixed agent-count ceiling is encoded.
- `BudgetLedger` persists task allocations and measured consumption for tokens, microcurrency, compute time, and network bytes. The evolutionary loop requires a budget and non-zero measured usage; it stops on budget exhaustion or an explicit stop condition.
- `CandidateRepository` stores content-addressed candidate objects and parent/child mutation edges with evaluation history.
- `DockerSandbox` requires a pinned image and a configured workspace root. It disables networking, mounts the candidate directory read-only, drops Linux capabilities, uses a non-root UID, and applies runtime resource controls. Docker isolation shares the host kernel; use a VM for higher-risk workloads.
- `CredentialBroker` accepts provider IDs and allowlisted paths, reads credentials only inside the broker process, forces HTTPS, rejects redirects, and redacts the exact credential from returned response text. Agents must receive only the broker interface, never process environment access.
- `CapabilityGate` delegates ordinary authorization to the existing CapabilityStore and requires a separately injected trusted approval verifier for high-impact actions. It never accepts a caller-supplied `humanApproval: true` as proof.
- `startTelemetry()` is explicit. Importing the module starts no timers, workers, containers, model calls, or network requests.
- `createAdaptiveControlPlane()` requires the existing MicroFederation TaskLedger. The caller supplies actual provider/model generation and evaluation adapters; no live independent provider connections are fabricated by this module.

The implementation is an integration layer, not a claim that all providers, model agents, containers, or production approval infrastructure are already connected. The JSON ledgers are single-process coordination primitives; do not share them between independent processes. Production deployments still require OS-enforced isolation, protected key storage, durable external audit anchoring, and cross-process/distributed coordination.

Run the verifier above to syntax-check the module and run its new tests plus the existing MicroFederation regression suites. The verifier does not start workers, enqueue model tasks, modify live services, or merge/deploy code.
