# HeavenzFire MicroFederation

**Status:** implementation and tests published on the `centropic-age/micro-sandbox-foundation` branch for review; not merged or deployed.

## Architecture

- One root conductor routes a bounded task to configured micro-sandboxes.
- Each sandbox dispatches four logical roles concurrently: conductor, builder, verifier, reviewer.
- Ternary role decisions: `+1` approve, `0` abstain, `-1` reject. Any rejection vetoes acceptance; approval requires quorum; otherwise defer.
- Root acceptance requires every sandbox to approve, stable builder-artifact hashes to agree, and independent code verification to validate the artifacts. A mismatch quarantines the task.
- Task envelopes support HMAC-SHA256 signatures, expiry, issuer allowlists, and replay rejection.
- Shared service prototypes cover capability scoping, expiry/revocation, high-impact human approval, append-only JSONL evidence, hash-chained audit events, content-addressed artifacts, bounded scheduling, and health reporting.

## Run the local tests (Windows PowerShell 5.1)

```powershell
Set-Location C:\Users\rucke\HeavenzFire\UnifiedField\MicroFederation
node .\test-micro-federation.cjs
node .\test-federation-services.cjs
```

## Run a live two-sandbox acceptance

```powershell
node .\run-live-two-sandbox.cjs
```

This submits eight real model-backed tasks through the existing loopback orchestrator. Both sandbox task graphs run concurrently, but the adapter serializes inference because the current orchestrator only admits one active task. The roles share one model; they are not four independent AI instances. The live test uses exact expected response tokens, so it proves routing/execution/evidence plumbing, not broad reasoning quality.

## Evidence files

- `live-multisandbox-receipt.json`: latest live run, signed-envelope verification, both sandbox traces, model responses, root decision, artifact digest, and audit-chain result.
- `federation-audit.jsonl`: append-only JSONL audit events from live runs; each run has its own hash chain.
- `federation-receipts.jsonl`: compact per-run receipts, including the earlier quarantined run. Retaining the failed run demonstrates that disagreement leads to quarantine rather than being silently overwritten.
- `live-orchestrator-acceptance.json`: four sequential live model task results.
- `live-agent-acceptance.json` and `live-single-agent-evidence.json`: failed `/ask`-endpoint acceptance attempts; retained as counterevidence.

## Security and production boundaries

- The live acceptance generates a per-run signing key in process memory. It is intentionally not persisted; this demonstrates signature validation but is **not** a production identity/key-management design.
- Audit log append mode is append-only by application behavior, not tamper-proof against a host administrator. Production needs OS-enforced ACLs, protected signing keys, and remote or WORM-backed anchoring.
- Capability registry, policy engine, artifact store, health monitor, and audit-chain verifier are in-memory service prototypes. The live runner writes JSONL evidence to disk, but the service state itself is not a durable distributed database.
- Local model requests are restricted to the existing `/task` API. The failed `/ask` tests show the agent endpoint did not survive four concurrent requests; do not use that endpoint as a parallel worker pool until its failure mode is fixed.
- No remote GitHub mutations, commits, merges, or deployments are performed by these scripts.

## Next integration milestones

1. Replace per-run HMAC keys with managed service identity and key rotation.
2. Persist grants, revocations, policies, and artifact metadata in a durable store.
3. Add independent model/tool adapters per sandbox and isolate their resource budgets.
4. Resolve the current `/ask` concurrent 502 behavior and measure safe parallel inference capacity.
5. Integrate the subsystem into the root task ledger and capability registry; add CI coverage and only then propose a reviewed pull request.