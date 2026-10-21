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
    node --test integrations/validate-repository-inventory.test.mjs unified-field/provider-router.test.mjs extensions/funding-integrity/reconcile.test.mjs extensions/funding-integrity/examples/sample-funding.test.mjs extensions/guardian-evidence/evidence-ledger.test.mjs extensions/guardian-evidence/public-record.test.mjs integrations/sovereign-node-adapter.test.mjs integrations/extension-registry.test.mjs integrations/load-extension-manifests.test.mjs integrations/extension-runtime.test.mjs integrations/task-lifecycle.test.mjs integrations/durable-task-lifecycle.test.mjs integrations/governed-task-lifecycle.test.mjs integrations/shared-task-proposal-adapter.test.mjs integrations/worker-dispatcher.test.mjs

The extension registry validates manifest shape, stable identifiers, versions, and explicit capability/permission allowlists. It is a metadata gate, not a sandbox: registering a manifest does not execute or isolate the extension. Runtime enforcement must remain in the host.

## Operating principles
Local-first; explicit provider selection; no silent fallback; no secrets in source control; reproducible tests; human review for consequential decisions; evidence and corrections preserved.
