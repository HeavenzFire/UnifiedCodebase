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


## Command Center HTTP integration

The existing Command Center accepts an optional remediationPipeline at construction. When configured, POST /api/remediation/issues/{numericIssueId} delegates to pipeline.process(issueId) and returns HTTP 202 with the pipeline result. Without a configured pipeline it returns HTTP 503. The route inherits the Command Center's loopback-only Host/Origin checks; it is not exposed over LAN or the public internet.

Construct the pipeline with the adapters above, then pass it to createCommandCenterServer({ stateDirectory, adapter: inference, remediationPipeline: pipeline }). The endpoint is an explicit user-triggered intake action, not a background poller. The service does not automatically scan or claim issues.

The current repository includes the lifecycle, adapter contracts, HTTP injection point, and tests. It still does not include a live authenticated Google Issue Tracker intake adapter, maintained-source resolver, sandbox implementation, or GitHub branch/PR writer. Those host adapters must be built and tested before any real issue can be processed end-to-end.


## Continuous engineering control plane

`engineering-control-plane.cjs` generalizes the same evidence-gated lifecycle to registered repositories and both defects and features. The host injects:
- inventory.list(): registered targets, each with stable id and repository context
- scanner.scan(target): defect/feature work items with explicit acceptance criteria and target repositories
- triager.triage(item): actionable, duplicate, not_a_defect, or needs_human
- planner.plan(item, triage): implementation steps and allowlisted test commands
- implementer.implement(item, plan): isolated workspace patch result
- tester.test(item, plan, patch): regression evidence
- verifier.verify(...): independent code verification and, for features, separate acceptance verification
- ledger.append(...): durable lifecycle evidence

`cycle()` performs one bounded pass over the registered inventory. It does not silently treat a planned feature as implemented: feature items reach instantiated only after both code verification and acceptance verification pass. Defects and features that cannot be safely reproduced, mapped to maintained source, or verified are recorded as blocked with a reason. The current module is an orchestration kernel; it is not yet wired to live repository scanners, sandboxes, test execution, or deployment systems.

Suggested operating model:
1. Inventory every owned repository and application; record maintainership, default branch, language, build/test commands, deployment target, owners, and allowed automation scope.
2. Discover defects from CI failures, test failures, runtime telemetry, dependency/security scans, issue trackers, and user-reported incidents.
3. Discover feature gaps from an explicit product/capability registry with acceptance criteria; never infer a feature is required merely because a codebase lacks it.
4. Route each work item through triage, root-cause analysis, implementation, regression, independent verification, and draft PR.
5. Reconcile open work every cycle; deduplicate by stable fingerprints; retry only transient failures with bounded backoff; escalate missing access, ambiguous requirements, and unsafe changes.
6. Publish a dashboard from the ledger: discovered, in progress, blocked, verified, instantiated, CI failing, and awaiting review.

No automatic production deployment, destructive data migration, permission changes, issue closure, or PR merge is enabled by this control plane.
