# HeavenzFire Unified Field

This repository is the integration spine for connecting the HeavenzFire project ecosystem through small, testable adapters. It does not claim that all existing repositories have already been merged or that experimental field/quantum concepts are established physics.

## Start here
- Integration roadmap: docs/UNIFIED-FIELD-ROADMAP.md
- Provider router: unified-field/provider-router.mjs
- Windows PowerShell 5.1 entry point: Enter-UnifiedField.ps1
- Guardian evidence extension: extensions/guardian-evidence/README.md
- Funding integrity extension: extensions/funding-integrity/README.md

## Quick start
Requirements: Node.js 20+ and, for local inference, Ollama with a model installed.

Run health check:
    .\Enter-UnifiedField.ps1 -HealthOnly

Run local inference:
    .\Enter-UnifiedField.ps1 -Prompt "Summarize this public report and separate facts from hypotheses."

Explicit remote provider selection requires that provider's own key:
    $env:MISTRAL_API_KEY = 'set-this-in-your-session-only'
    .\Enter-UnifiedField.ps1 -Provider mistral -Prompt "Summarize this report."

Run tests:
    node --test .\unified-field\provider-router.test.mjs

## Operating principles
Local-first; explicit provider selection; no silent fallback; no secrets in source control; reproducible tests; human review for consequential decisions; evidence and corrections preserved.
