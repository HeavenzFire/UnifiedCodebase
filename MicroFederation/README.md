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

## Security and production boundaries

- The live acceptance generates a per-run signing key in process memory. It is intentionally not persisted; this demonstrates signature validation but is **not** a production identity/key-management design.
- Audit log append mode is append-only by application behavior, not tamper-proof against a host administrator. Production needs OS-enforced ACLs, protected signing keys, and remote or WORM-backed anchoring.
- The original capability registry, policy engine, artifact store, health monitor, and audit-chain verifier are in-memory service prototypes. The new durable capability store is an opt-in persistence component; it does not automatically replace or mutate an existing running instance.
- Local model requests are restricted to the existing `/task` API. The failed `/ask` tests show the agent endpoint did not survive four concurrent requests; do not use that endpoint as a parallel worker pool until its failure mode is fixed.
- No remote GitHub mutations, commits, merges, or deployments are performed by these scripts.

## Provider registry

`provider-registry.cjs` persists provider declarations and lifecycle evidence in a local JSON file using atomic replacement. Credential configuration stores only an environment-variable name such as `GEMINI_API_KEY`; the registry does not accept API-key values, authenticate providers, or make network requests. A provider remains `configured` until separate credential checks and real provider smoke tests produce evidence. No Gemini, Mistral, Qwen Cloud, Meta, Monica, or Merlin live connection is claimed by this module.

## Durable capability store

`capability-store.cjs` persists scoped grants and revocations with atomic JSON replacement. It checks agent identity, optional task scope, capability membership, and expiry. High-impact capabilities (`repo.merge`, `deploy`, `credential.write`, `network.expose`, and `command.privileged`) require an explicit `humanApproval: true` at evaluation time. Grant inputs reject undeclared fields such as raw API keys.

The store records hash-chained grant/revocation events and verifies the event chain on restart. This detects accidental or unsophisticated event-log tampering; it is not a cryptographically signed or externally anchored audit log. Writes are serialized within one Node.js process only, not across independent processes. The module is not wired into the active runner by default; integration requires a separately reviewed adapter and migration plan.

Run `node --test .\test-capability-store.cjs` to verify persistence/restart, revocation, authorization scopes, human-approval enforcement, duplicate-grant handling, credential-field rejection, and audit-chain tamper detection.

## Next integration milestones

1. Integrate durable authorization and task state through a single supervised writer with explicit approval checks.
2. Persist artifact metadata and policy decisions with the same recovery/evidence contract.
3. Add independent model/tool adapters per sandbox and isolate their resource budgets.
4. Resolve the current `/ask` concurrent 502 behavior and measure safe parallel inference capacity.
5. Add live provider smoke tests only after authorized credentials are configured.
