import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDefaultWorkerHost } from "./default-worker-host.mjs";

test("default host runs read-only funding reconciliation and Guardian evidence append/verify", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-default-host-"));
  try {
    const host = await createDefaultWorkerHost({
      repositoryRoot: resolve("."),
      taskFilePath: join(directory, "tasks.jsonl"),
      approvalFilePath: join(directory, "approvals.jsonl"),
      resultFilePath: join(directory, "results.jsonl"),
      evidenceLedgerPath: join(directory, "guardian-evidence.jsonl"),
    });

    host.submit({
      taskId: "funding-check-1",
      title: "Reconcile synthetic funding fixture",
      requestedBy: "test-operator",
      metadata: {
        capability: "funding.reconcile.read_only",
        input: {
          appropriations: [{ appropriationId: "A1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
          awards: [{ awardId: "W1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
          disbursements: [{ disbursementId: "D1", awardId: "W1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 80 }],
        },
      },
    });
    host.approve("funding-check-1", { actor: "test-operator", reason: "synthetic fixture approved" });
    const funding = await host.dispatch("funding-check-1", "funding.integrity", {
      actor: "test-operator", reason: "run read-only reconciliation",
    });
    assert.equal(funding.status, "succeeded");
    assert.equal(funding.result.mode, "read_only");
    assert.equal(funding.result.schema, "heavenzfire.funding-reconciliation.v1");
    assert.equal(funding.result.reconciliations.length, 1);

    host.submit({
      taskId: "evidence-append-1",
      title: "Record a source-backed evidence fixture",
      requestedBy: "test-operator",
      metadata: {
        capability: "evidence.append",
        evidence: {
          source: "https://example.org/public-report",
          claim: "Synthetic evidence fixture for integration testing",
          capturedAt: "2026-10-21T00:00:00.000Z",
          sourceContent: "Synthetic source text",
          limitations: ["Synthetic test data; not a real-world finding"],
        },
      },
    });
    host.approve("evidence-append-1", { actor: "test-operator", reason: "evidence fixture approved" });
    const appended = await host.dispatch("evidence-append-1", "guardian.evidence", {
      actor: "test-operator", reason: "append approved evidence fixture",
    });
    assert.equal(appended.status, "succeeded");
    assert.equal(appended.result.operation, "append");
    assert.match(appended.result.recordSha256, /^[a-f0-9]{64}$/);

    host.submit({
      taskId: "evidence-verify-1",
      title: "Verify local evidence ledger",
      requestedBy: "test-operator",
      metadata: { capability: "evidence.verify" },
    });
    host.approve("evidence-verify-1", { actor: "test-operator", reason: "ledger verification approved" });
    const verified = await host.dispatch("evidence-verify-1", "guardian.evidence", {
      actor: "test-operator", reason: "verify approved local ledger",
    });
    assert.equal(verified.status, "succeeded");
    assert.equal(verified.result.valid, true);
    assert.equal(verified.result.records, 1);
    assert.equal(host.audit().results.length, 3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default host dispatches approved model tasks through local Ollama only", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-local-model-"));
  let observedProvider;
  try {
    const host = await createDefaultWorkerHost({
      repositoryRoot: resolve("."),
      taskFilePath: join(directory, "tasks.jsonl"),
      approvalFilePath: join(directory, "approvals.jsonl"),
      resultFilePath: join(directory, "results.jsonl"),
      evidenceLedgerPath: join(directory, "guardian-evidence.jsonl"),
      localModelRunner: async input => {
        observedProvider = input.providerName;
        return { provider: "ollama", model: input.model || "fixture-model", remote: false, text: "synthetic local answer" };
      },
    });
    host.submit({
      taskId: "local-model-1",
      title: "Summarize a local fixture",
      requestedBy: "test-operator",
      metadata: { capability: "model.inference.local", prompt: "Summarize this synthetic fixture.", provider: "openai" },
    });
    host.approve("local-model-1", { actor: "test-operator", reason: "local model fixture approved" });
    const result = await host.dispatch("local-model-1", "local.model", {
      actor: "test-operator", reason: "run approved local inference",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(observedProvider, "ollama");
    assert.equal(result.result.remote, false);
    assert.equal(result.result.text, "synthetic local answer");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default host exposes only the read-only loopback Sovereign Node health worker", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-sovereign-health-"));
  let observed;
  try {
    const host = await createDefaultWorkerHost({
      repositoryRoot: resolve("."),
      taskFilePath: join(directory, "tasks.jsonl"),
      approvalFilePath: join(directory, "approvals.jsonl"),
      resultFilePath: join(directory, "results.jsonl"),
      evidenceLedgerPath: join(directory, "guardian-evidence.jsonl"),
      sovereignNodeHealthRunner: async options => {
        observed = options;
        return { component: "sovereign-node", status: "healthy", httpStatus: 200, probe: "read_only" };
      },
    });
    host.submit({
      taskId: "sovereign-health-1",
      title: "Check local Sovereign Node health",
      requestedBy: "test-operator",
      metadata: { capability: "service.health.read_only", baseUrl: "http://127.0.0.1:3000", timeoutMs: 1500 },
    });
    host.approve("sovereign-health-1", { actor: "test-operator", reason: "health probe approved" });
    const result = await host.dispatch("sovereign-health-1", "sovereign-node.health", {
      actor: "test-operator", reason: "run read-only loopback health check",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.probe, "read_only");
    assert.equal(observed.baseUrl, "http://127.0.0.1:3000");
    assert.equal(observed.timeoutMs, 1500);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default host exposes repository inventory as a bounded read-only task", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-inventory-host-"));
  try {
    const host = await createDefaultWorkerHost({
      repositoryRoot: resolve("."),
      taskFilePath: join(directory, "tasks.jsonl"),
      approvalFilePath: join(directory, "approvals.jsonl"),
      resultFilePath: join(directory, "results.jsonl"),
      evidenceLedgerPath: join(directory, "guardian-evidence.jsonl"),
    });
    host.submit({
      taskId: "inventory-read-1",
      title: "Inspect checked-in repository inventory",
      requestedBy: "test-operator",
      metadata: { capability: "repository.inventory.read_only", query: "heavenzfire", limit: 2 },
    });
    host.approve("inventory-read-1", { actor: "test-operator", reason: "inventory query approved" });
    const result = await host.dispatch("inventory-read-1", "repository.inventory", {
      actor: "test-operator", reason: "read checked-in metadata snapshot",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.totalVisible, 276);
    assert.equal(result.result.filteredCount, 276);
    assert.equal(result.result.repositories.length, 2);
    assert.match(result.result.scopeNote, /not proof|not a guarantee/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("default host submits only minimal shared-task proposals after explicit approval", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-shared-proposal-"));
  let captured;
  try {
    const host = await createDefaultWorkerHost({
      repositoryRoot: resolve("."),
      taskFilePath: join(directory, "tasks.jsonl"),
      approvalFilePath: join(directory, "approvals.jsonl"),
      resultFilePath: join(directory, "results.jsonl"),
      evidenceLedgerPath: join(directory, "guardian-evidence.jsonl"),
      sharedTaskProposalSubmitter: async (safeTask, options) => {
        captured = { safeTask, options };
        return { ok: true, duplicate: false, taskId: safeTask.taskId, status: "proposed", approvalState: "pending" };
      },
    });
    host.submit({
      taskId: "shared-proposal-1",
      title: "Coordinate follow-up repository review",
      requestedBy: "test-operator",
      metadata: {
        capability: "task.proposal.submit",
        endpoint: "http://127.0.0.1:18796/api/tasks",
        proposalPurpose: "coordinate independent review",
        prompt: "sensitive prompt that must not be forwarded",
        input: { privateRecord: "must not be forwarded" },
      },
    });
    host.approve("shared-proposal-1", { actor: "test-operator", reason: "proposal delivery approved" });
    const result = await host.dispatch("shared-proposal-1", "shared-task.proposal", {
      actor: "test-operator", reason: "submit approved proposal to local inbox",
    });
    assert.equal(result.status, "succeeded");
    assert.equal(result.result.status, "proposed");
    assert.equal(result.result.approvalState, "pending");
    assert.equal(captured.safeTask.status, "running");
    assert.deepEqual(captured.options, { endpoint: "http://127.0.0.1:18796/api/tasks" });
    assert.equal("prompt" in captured.safeTask.metadata, false);
    assert.equal("input" in captured.safeTask.metadata, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
