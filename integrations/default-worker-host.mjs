import { resolve } from "node:path";
import { appendEvidenceRecord, createEvidenceRecord, readEvidenceRecords } from "../extensions/guardian-evidence/evidence-ledger.mjs";
import { reconcileFunding } from "../extensions/funding-integrity/reconcile.mjs";
import { runLocalModelTask } from "../extensions/local-model/local-model-worker.mjs";
import { runSovereignNodeHealthTask } from "../extensions/sovereign-node-health/health-worker.mjs";
import { summarizeRepositoryInventory } from "../extensions/repository-inventory/inventory-worker.mjs";
import { submitSharedTaskProposalTask } from "../extensions/shared-task-proposal/proposal-worker.mjs";
import { readGitHubMetadataTask } from "../extensions/github-metadata/github-metadata-worker.mjs";
import { loadExtensionManifests } from "./load-extension-manifests.mjs";
import { createWorkerHost } from "./worker-host.mjs";

const DEFAULT_CAPABILITIES = Object.freeze([
  "evidence.append",
  "evidence.verify",
  "funding.reconcile.read_only",
  "model.inference.local",
  "service.health.read_only",
  "repository.inventory.read_only",
  "task.proposal.submit",
  "repository.github.metadata.read_only",
]);
const DEFAULT_PERMISSIONS = Object.freeze([
  "filesystem.write:local-evidence-ledger",
  "filesystem.read:input-records",
  "network.loopback:ollama",
  "network.loopback:sovereign-node",
  "filesystem.read:repository-inventory-snapshot",
  "network.loopback:shared-task-inbox",
  "network.https:api.github.com",
]);

/**
 * Build a host with reviewed Guardian Evidence, read-only Funding Integrity, local Ollama,
 * and loopback-only Sovereign Node health handlers. Manifest loading validates metadata
 * and paths; only these statically imported handlers are executable. Evidence append writes
 * only to the configured local ledger.
 */
export async function createDefaultWorkerHost({
  repositoryRoot = process.cwd(),
  taskFilePath,
  approvalFilePath,
  resultFilePath,
  evidenceLedgerPath,
  localModelRunner,
  sovereignNodeHealthRunner,
  sharedTaskProposalSubmitter,
  githubMetadataFetcher,
  maxConcurrent = 2,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof evidenceLedgerPath !== "string" || !evidenceLedgerPath.trim()) {
    throw new TypeError("evidenceLedgerPath is required.");
  }
  const root = resolve(repositoryRoot);
  const evidencePath = resolve(evidenceLedgerPath);
  const journalPaths = [taskFilePath, approvalFilePath, resultFilePath].map(value => {
    if (typeof value !== "string" || !value.trim()) throw new TypeError("All host journal paths are required.");
    return resolve(value);
  });
  if (new Set([...journalPaths, evidencePath]).size !== 4) {
    throw new TypeError("Task, approval, result, and evidence ledger paths must be separate.");
  }

  const registry = await loadExtensionManifests({
    repositoryRoot: root,
    manifestPaths: [
      "extensions/guardian-evidence/manifest.json",
      "extensions/funding-integrity/manifest.json",
      "extensions/local-model/manifest.json",
      "extensions/sovereign-node-health/manifest.json",
      "extensions/repository-inventory/manifest.json",
      "extensions/shared-task-proposal/manifest.json",
      "extensions/github-metadata/manifest.json",
    ],
    allowedCapabilities: [...DEFAULT_CAPABILITIES],
    allowedPermissions: [...DEFAULT_PERMISSIONS],
  });

  const handlers = [
    {
      extensionId: "github.metadata",
      run: task => readGitHubMetadataTask(task, githubMetadataFetcher ? { fetchImpl: githubMetadataFetcher } : {}),
    },
    {
      extensionId: "shared-task.proposal",
      run: task => submitSharedTaskProposalTask(task, sharedTaskProposalSubmitter ? { submitter: sharedTaskProposalSubmitter } : {}),
    },
    {
      extensionId: "repository.inventory",
      run: task => summarizeRepositoryInventory({
        query: task.metadata?.query,
        integrationStatus: task.metadata?.integrationStatus,
        limit: task.metadata?.limit,
      }),
    },
    {
      extensionId: "sovereign-node.health",
      run: task => runSovereignNodeHealthTask(task, sovereignNodeHealthRunner ? { checkHealthImpl: sovereignNodeHealthRunner } : {}),
    },
    {
      extensionId: "local.model",
      run: task => runLocalModelTask(task, localModelRunner ? { routePromptImpl: localModelRunner } : {}),
    },
    {
      extensionId: "guardian.evidence",
      run: async task => {
        const capability = task.metadata?.capability;
        if (capability === "evidence.append") {
          const input = task.metadata?.evidence;
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            throw new TypeError("evidence.append tasks require an evidence object in task metadata.");
          }
          const record = createEvidenceRecord(input, { now });
          await appendEvidenceRecord(evidencePath, record);
          return { operation: "append", recordId: record.recordId, recordSha256: record.recordSha256 };
        }
        if (capability === "evidence.verify") {
          const records = await readEvidenceRecords(evidencePath);
          return { operation: "verify", valid: true, records: records.length, recordIds: records.map(record => record.recordId) };
        }
        throw new Error("Guardian Evidence handler does not implement capability: " + String(capability));
      },
    },
    {
      extensionId: "funding.integrity",
      run: async task => {
        if (task.metadata?.capability !== "funding.reconcile.read_only") {
          throw new Error("Funding Integrity handler requires funding.reconcile.read_only.");
        }
        const input = task.metadata?.input;
        if (!input || typeof input !== "object" || Array.isArray(input)) {
          throw new TypeError("Funding reconciliation tasks require input records in task metadata.");
        }
        return reconcileFunding(input);
      },
    },
  ];

  return createWorkerHost({
    taskFilePath: journalPaths[0],
    approvalFilePath: journalPaths[1],
    resultFilePath: journalPaths[2],
    registry,
    handlers,
    maxConcurrent,
    now,
  });
}
