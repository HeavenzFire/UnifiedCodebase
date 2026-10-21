# HeavenzFire Unified Field

This repository is the integration spine for connecting the HeavenzFire project ecosystem through small, testable adapters. It does not claim that all existing repositories have already been merged or that experimental field/quantum concepts are established physics.

## Start here
- Integration roadmap: docs/UNIFIED-FIELD-ROADMAP.md
- Provider router: unified-field/provider-router.mjs
- Windows PowerShell 5.1 entry point: Enter-UnifiedField.ps1
- Extension registry: integrations/extension-registry.mjs
- Guardian evidence extension: extensions/guardian-evidence/README.md
- Funding integrity extension: extensions/funding-integrity/README.md
- Repository inventory snapshot (276 installation-search results; mostly unassessed): docs/repository-inventory.snapshot.json
- Repository integration status rules: docs/REPOSITORY-INTEGRATION-INVENTORY.md
- Initial source-level security/privacy review: docs/INITIAL-SOURCE-INTEGRATION-REVIEW.md
- Durable task journal and approval gate: integrations/durable-task-lifecycle.mjs and integrations/governed-task-lifecycle.mjs
- Bounded, approval-gated in-process worker dispatch: integrations/worker-dispatcher.mjs (registered handlers only; no arbitrary command execution)
- Hash-chained durable worker output journal: integrations/worker-result-journal.mjs (JSON-compatible outputs, result digests, and tamper-evident replay validation)
- Registry-backed worker adapter: integrations/registry-worker-adapter.mjs (derives worker capabilities from allowlisted extension manifests)
- Integrated task-to-worker host API: integrations/worker-host.mjs (task intake, explicit approval, registry-backed dispatch, and task/approval/result audit journals)
- Default local worker bundle: integrations/default-worker-host.mjs (validated Guardian Evidence append/verify and read-only Funding Integrity reconciliation handlers)
- Local model worker: extensions/local-model/local-model-worker.mjs (pins approved model tasks to loopback Ollama; task metadata cannot select a remote provider and non-loopback endpoints are rejected)
- Sovereign Node health worker: extensions/sovereign-node-health/health-worker.mjs (read-only `/api/health` probe restricted to loopback HTTP)
- Repository inventory worker: extensions/repository-inventory/inventory-worker.mjs (bounded read-only queries over the checked-in 276-repository metadata snapshot; not a live GitHub query)
- Shared-task proposal worker: extensions/shared-task-proposal/proposal-worker.mjs (approval-gated, loopback-only proposal delivery; forwards a minimized task summary as proposed/pending without approving or executing it)

## Quick start
Requirements: Node.js 20+ and, for local inference, Ollama with a model installed.

Run health check:
    .\Enter-UnifiedField.ps1 -HealthOnly

Run local inference:
    .\Enter-UnifiedField.ps1 -Prompt "Summarize this public report and separate facts from hypotheses."

Explicit remote provider selection requires that provider's own key:
    $env:MISTRAL_API_KEY = 'set-this-in-your-session-only'
    .\Enter-UnifiedField.ps1 -Provider mistral -Prompt "Summarize this report."

Run the full configured Node.js contract suite:
    node --test integrations/validate-repository-inventory.test.mjs unified-field/provider-router.test.mjs extensions/funding-integrity/reconcile.test.mjs extensions/funding-integrity/examples/sample-funding.test.mjs extensions/guardian-evidence/evidence-ledger.test.mjs extensions/guardian-evidence/public-record.test.mjs integrations/sovereign-node-adapter.test.mjs integrations/extension-registry.test.mjs integrations/load-extension-manifests.test.mjs integrations/extension-runtime.test.mjs integrations/task-lifecycle.test.mjs integrations/durable-task-lifecycle.test.mjs integrations/governed-task-lifecycle.test.mjs integrations/shared-task-proposal-adapter.test.mjs integrations/worker-dispatcher.test.mjs integrations/registry-worker-adapter.test.mjs integrations/worker-host.test.mjs integrations/default-worker-host.test.mjs extensions/local-model/local-model-worker.test.mjs extensions/sovereign-node-health/health-worker.test.mjs extensions/repository-inventory/inventory-worker.test.mjs extensions/shared-task-proposal/proposal-worker.test.mjs integrations/shared-task-proposal-adapter.test.mjs integrations/worker-host-cli.test.mjs

The extension registry validates manifest shape, stable identifiers, versions, and explicit capability/permission allowlists. It is a metadata gate, not a sandbox: registering a manifest does not execute or isolate the extension. Runtime enforcement must remain in the host.

## Governed task host (PowerShell 5.1)

The task host is separate from the provider-routing prompt command. It runs only statically registered, reviewed handlers; it does not execute arbitrary shell commands.

Start the proposal inbox in a separate PowerShell window before dispatching `task.proposal.submit` tasks:
    .\\Enter-UnifiedField.ps1 -TaskAction StartInbox

The inbox binds only to `127.0.0.1:18796`, stores proposals in a hash-chained local journal, and accepts proposed/pending records only. It has no approval or execution endpoint.

List registered workers through the unified entry point:
    .\Enter-UnifiedField.ps1 -TaskAction Workers

Submit a JSON task object (the metadata must include a capability and the corresponding input):
    $taskJson = '{ "taskId":"funding-demo-1", "title":"Reconcile supplied records", "requestedBy":"local-operator", "metadata": { "capability":"funding.reconcile.read_only", "input": { "appropriations":[], "awards":[], "disbursements":[] } } }'
    .\Enter-UnifiedField.ps1 -TaskAction Submit -TaskJson $taskJson

Approve, revoke, and dispatch are separate, explicit operations:
    .\Enter-UnifiedField.ps1 -TaskAction Approve -TaskId funding-demo-1 -Actor local-operator -Reason "Reviewed input and approved"
    .\Enter-UnifiedField.ps1 -TaskAction Revoke -TaskId funding-demo-1 -Actor local-operator -Reason "Approval withdrawn before execution"
    .\Enter-UnifiedField.ps1 -TaskAction Dispatch -TaskId funding-demo-1 -ExtensionId funding.integrity -Actor local-operator -Reason "Run approved read-only reconciliation"

State is stored under `~/.heavenzfire/unified-field` by default; set `HEAVENZFIRE_STATE_DIR` to choose another local directory. The audit command reports journal counts and the result-chain head. Actor labels are recorded but not authenticated by this local host.

## Operating principles
Local-first; explicit provider selection; no silent fallback; no secrets in source control; reproducible tests; human review for consequential decisions; evidence and corrections preserved.
