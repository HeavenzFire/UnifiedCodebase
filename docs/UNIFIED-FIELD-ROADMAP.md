# HeavenzFire Unified Field — Integration Roadmap

## North star
A local-first, evidence-preserving research and coordination platform that connects existing HeavenzFire projects through small, testable adapters. It does not claim that every repository is already integrated.

## Architecture layers
1. Entry point: Enter-UnifiedField.ps1; Windows PowerShell 5.1 compatible.
2. Provider routing: unified-field/provider-router.mjs; local Ollama by default, optional explicit remote adapters.
3. Service adapters: health, model, repository, browser, voice, and research connectors; each reports observed status and permissions.
4. Evidence plane: source provenance, hashes, correction history, and human review.
5. Guardian extensions: evidence intake and funding-integrity reconciliation, initially read-only.
6. Governance plane: least privilege, explicit approval for external actions, privacy controls, and audit events.
7. Verification: unit tests, contract tests, end-to-end checks, and CI.

## Provider policy
- Default provider is local Ollama at 127.0.0.1:11434.
- Remote providers are opt-in and require their own provider-specific environment variable.
- No silent fallback from failed remote calls to local inference or vice versa.
- The selected provider and model are included in result metadata.
- Secrets and prompt contents are not logged by the router.
- Supported IDs: ollama, openai, mistral, gemini.

## Public-interest safeguards
The system can collect, compare, and explain records relevant to public spending and service delivery. It cannot itself establish criminal intent, decide legal liability, redirect money, or end armed conflicts. Findings must distinguish source facts, calculations, inference, uncertainty, and human-reviewed conclusions.

## Integration sequence
Phase 1: provider router, PowerShell entry point, unit tests, CI.
Phase 2: read-only service health manifest and consistent model configuration.
Phase 3: evidence ledger with provenance and correction history.
Phase 4: funding reconciliation using synthetic fixtures and public records.
Phase 5: repository inventory and staged adapters, one project at a time.
Phase 6: reviewable pull requests and reproducible release artifacts.

## Acceptance gates
- Unit tests pass on a clean Node.js LTS runtime.
- Provider failures never trigger an unrequested provider switch.
- No API keys or sensitive user data appear in committed files or logs.
- Every extension has schemas, tests, permission scope, and documented failure states.
- Human review remains mandatory for consequential actions affecting people, funds, or legal claims.
