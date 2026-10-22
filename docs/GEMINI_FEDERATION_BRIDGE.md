# HeavenzFire Gemini Federation Bridge

Status: architecture and integration plan; implementation is not yet complete.

## Objective

Unify authorized access to Gemini-powered workflows across Google AI Studio Playground, AI Studio Build mode, the Gemini API, Gemini CLI/agent tooling, a HeavenzFire Chrome extension, and Google Search AI Mode into one auditable HeavenzFire control plane.

"All Gemini versions" means a common orchestration layer that can route to supported models and interfaces, not merging model weights, bypassing product boundaries, or assuming every consumer interface exposes an API.

## Integration lanes

1. **Gemini API adapter (primary execution interface)**
   - Use the official Gemini API and supported SDKs for model calls, streaming, multimodal requests, tool/function calling, and supported agentic interactions.
   - Keep API keys server-side or in the local secret store; never embed keys in extension bundles, prompts, Git history, or browser storage.
   - Record model ID, request correlation ID, tool grants, usage, latency, and outcome without logging secrets or unnecessary private content.

2. **Google AI Studio Playground**
   - Treat Playground as a prompt/model prototyping surface.
   - Export prompts and app code through supported UI features and version them in GitHub.
   - Promote validated configurations into the API adapter; do not assume the Playground session itself can be programmatically controlled through a public API.

3. **Google AI Studio Build mode**
   - Treat Build projects as app-generation and prototyping workspaces.
   - Use supported code export, GitHub integration, or user-directed browser workflows to move artifacts into the repository.
   - Preserve the existing app and its state; review diffs before overwriting or publishing.

4. **Gemini CLI / agent development tools**
   - Integrate through documented CLI/MCP interfaces where available.
   - Give each agent a scoped workspace, allowlisted tools, time/resource limits, structured results, and a correlation ID.
   - Never treat model output as trusted executable code; validate arguments and enforce policy outside the model.

5. **HeavenzFire Chrome extension**
   - Manifest V3 extension with explicit per-site enablement, minimal host permissions, user-visible controls, and no credential extraction.
   - Content scripts may provide a user-invoked handoff panel and pass selected user-approved text to the local gateway.
   - Do not silently scrape conversations, inject hidden prompts, defeat site controls, or automate actions without user-visible authorization.
   - Extension messages are untrusted inputs and must be schema-validated by the gateway.

6. **Google Search AI Mode**
   - Treat this as a separate consumer UI unless Google documents an official integration/API for the specific capability.
   - Provide a user-invoked copy/hand-off workflow through the extension where permitted.
   - Do not claim direct API access to AI Mode, shared sessions, or privileged control over Google's interface.
   - Use the Gemini API or supported Search grounding tools for programmatic search workflows instead.

## Unified control plane

Proposed flow:

AI Studio / CLI / Extension / Local UI -> Authenticated Gateway -> Policy Engine -> Provider Adapters -> Tools / Sandboxes

Core components:
- Provider registry: provider, model, supported modalities, capabilities, quota, health, and fallback policy.
- Task orchestrator: typed tasks, bounded retries, idempotency keys, deadlines, cancellation, and durable task state.
- Capability gateway: typed operations, least privilege, schema validation, per-tool grants, and approval gates.
- Execution workers: isolated workspaces for builds, tests, repository changes, and approved diagnostics.
- Evidence ledger: append-only task events, timestamps, actor identity, policy decision, result status, artifact hashes, and sanitized logs.
- Secrets manager: environment/OS secret store or server-side secret storage; no secrets in extension code or repository.
- UI: one task inbox and status surface showing queued/running/succeeded/failed/blocked, with evidence links.

## Privilege model

Do not expose unrestricted root or administrator shell access to a model. Use a dedicated Windows service or scheduled-task broker with:
- a non-admin default execution identity;
- individually allowlisted typed operations;
- separate approval for elevated, destructive, credential, network-policy, persistence, and publication actions;
- argument validation and fixed executable paths;
- timeouts, output limits, audit events, and a kill/cancel path;
- fail-closed behavior when policy or identity checks are unavailable.

A model may request an operation; only the gateway authorizes it. A successful model response is not proof that the operation ran.

## Initial acceptance tests

- Provider registry reports actual capabilities and unsupported interfaces without inventing support.
- Gemini API adapter makes a minimal authenticated request using a secret supplied outside source control.
- Extension cannot send an arbitrary shell command; it can submit only validated task schemas.
- Untrusted page content cannot alter gateway policy or grant permissions.
- An unauthorized operation is denied and recorded.
- An approved harmless diagnostic returns an operation ID, exit status, sanitized output, and artifact hash.
- A simulated timeout does not cause duplicate side effects on retry.
- API keys and OAuth tokens are absent from extension bundles, logs, screenshots, and Git history.
- Google AI Studio and Search AI Mode are labeled as UI workflows unless an official supported API exists.
- End-to-end tests verify provider failure, fallback, cancellation, and audit completeness.

## Delivery phases

1. Establish repository contract, threat model, schemas, and acceptance tests.
2. Implement provider registry and Gemini API adapter.
3. Implement local gateway, policy engine, and evidence ledger.
4. Add bounded worker execution and repository/test tools.
5. Add extension handoff UI with explicit user action.
6. Add documented AI Studio artifact import/export workflow.
7. Add supported Gemini CLI/MCP adapter.
8. Verify each lane independently; publish a capability matrix with evidence and known gaps.

## Non-goals

- Bypassing Google's safety systems, account permissions, product restrictions, or access controls.
- Extracting cookies, OAuth tokens, API keys, private prompts, or other credentials from browser sessions.
- Claiming consumer Gemini apps, AI Studio, CLI, API, and Search AI Mode share a single session or can all be controlled through one undocumented endpoint.
- Giving an AI unrestricted administrator access merely through system instructions.

## Evidence discipline

Every capability must be marked one of: PLANNED, IMPLEMENTED, TESTED, BLOCKED, or UNSUPPORTED. A feature is TESTED only when a repeatable test and its result are available. Do not label the federation connected until each adapter has passed its own acceptance tests.
