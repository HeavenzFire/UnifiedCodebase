# Governed Google Issue Tracker remediation pipeline

This module extends the existing 16-role Agent Command Center; it is not a second orchestrator. It is fail-closed and all external capabilities are injected.

## Scope

- Google Issue Tracker component: 1400036 (developer.chrome.com content issues).
- Accepts numeric issue IDs only and revalidates the returned component ID.
- Runs the canonical 16 specialists sequentially through an injected agent runner.
- Synthesizes a unified-diff proposal, applies it in an isolated per-issue workspace, runs tests, and requires independent verification with evidence.
- Creates a GitHub draft PR only after all gates pass.
- Never edits, comments on, or closes Google issues; merges PRs; deploys; or changes component permissions.
- Persists a SHA-256 hash-chained JSONL remediation ledger. This detects tampering but is not a signed external audit anchor.

## Adapter contracts

The host must supply:

- intake.getIssue(id): authenticated, read-only issue retrieval. Return id, componentId, title, description, and url.
- sourceResolver.resolve(issue): evidence-backed mapping to repository, baseBranch, and evidence. The target must be maintained and in the explicit allowedRepositories allowlist. Do not map issues to the archived GoogleChrome/developer.chrome.com repository.
- agentRunner.run(roleId, task): the included createCommandCenterAgentRunner() adapts the existing LiveOrchestratorAdapter and canonical roster; inference remains serialized by the existing adapter.
- patcher.createWorkspace(...) and patcher.applyPatch(...): create a fresh isolated workspace for the allowlisted repository and apply the proposed diff. The host implementation must reject path traversal, symlinks, submodules, binary changes unless explicitly allowed, and writes outside the workspace. It must not expose host credentials or unrestricted shell access to agents.
- testRunner.run(...): run repository-defined, allowlisted test commands inside the same isolated workspace and return exact commands plus evidence.
- verifier.verify(...): independently inspect the changed diff and test evidence. Do not use the implementer's conclusion as verification.
- pullRequests.createDraft(...): push a per-issue branch and create a draft PR; return draft=true, url, and number. The adapter must not merge.

Example construction:

\`\`\`js
const { LiveOrchestratorAdapter } = require('./live-orchestrator-adapter.cjs');
const { DEFAULT_ROLES } = require('./agent-command-center.cjs');
const { IssueRemediationPipeline, createCommandCenterAgentRunner } = require('./issue-remediation-pipeline.cjs');

const inference = new LiveOrchestratorAdapter({ endpoint: process.env.HEAVENZFIRE_ORCHESTRATOR_ENDPOINT });
const pipeline = new IssueRemediationPipeline({
  ledgerFile: process.env.HEAVENZFIRE_REMEDIATION_LEDGER,
  intake, sourceResolver,
  agentRunner: createCommandCenterAgentRunner({ adapter: inference, roles: DEFAULT_ROLES }),
  patcher, testRunner, verifier, pullRequests,
  allowedRepositories: ['owner/maintained-docs-repository']
});
const result = await pipeline.process('123456789');
\`\`\`

The names intake, sourceResolver, patcher, testRunner, verifier, and pullRequests above are host-supplied adapters, not preconfigured live integrations. The repository currently does not contain a verified maintained-source mapping or a live Google Issue Tracker intake adapter. Until those are supplied and tested, the pipeline cannot autonomously fetch a real issue or modify a real repository.

## Verification

\`\`\`sh
node --check MicroFederation/issue-remediation-pipeline.cjs
node --test MicroFederation/test-issue-remediation-pipeline.cjs
\`\`\`

The tests use injected fixtures to verify lifecycle gates, component isolation, repository allowlisting, draft-only PR behavior, and ledger integrity. They do not claim a live Google issue was repaired.
