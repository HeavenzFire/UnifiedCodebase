import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionRegistry } from "./extension-registry.mjs";
import { createWorkerHost } from "./worker-host.mjs";

function registry() {
  const value = createExtensionRegistry({
    allowedCapabilities: ["evidence.verify"],
    allowedPermissions: ["filesystem.read:input-records"],
  });
  value.register({
    manifest_version: "1.0",
    extension_id: "guardian.evidence",
    version: "1.0.0",
    entrypoint: "extensions/guardian-evidence/evidence-ledger.mjs",
    capabilities: ["evidence.verify"],
    permissions: ["filesystem.read:input-records"],
    data_flows: ["task-metadata-to-local-evidence"],
    healthcheck: "node --check extensions/guardian-evidence/evidence-ledger.mjs",
    test_command: "node --test extensions/guardian-evidence/evidence-ledger.test.mjs",
    rollback: "disable extension and revert pinned revision",
  });
  return value;
}

function hostAt(directory) {
  return createWorkerHost({
    taskFilePath: join(directory, "tasks.jsonl"),
    approvalFilePath: join(directory, "approvals.jsonl"),
    resultFilePath: join(directory, "results.jsonl"),
    registry: registry(),
    handlers: [{
      extensionId: "guardian.evidence",
      run: async task => ({ taskId: task.taskId, observedStatus: task.status, evidence: "fixture-verified" }),
    }],
  });
}

test("host completes task intake through approval, worker execution, and durable evidence", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-host-"));
  try {
    const host = hostAt(directory);
    host.submit({
      taskId: "host-e2e-1",
      title: "Verify evidence fixture",
      requestedBy: "test-operator",
      metadata: { capability: "evidence.verify" },
    });
    host.approve("host-e2e-1", { actor: "test-operator", reason: "fixture approved" });
    const result = await host.dispatch("host-e2e-1", "guardian.evidence", {
      actor: "test-operator", reason: "run approved evidence check",
    });
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.result, {
      taskId: "host-e2e-1", observedStatus: "running", evidence: "fixture-verified",
    });
    const audit = host.audit();
    assert.ok(audit.tasks.some(record => record.event?.status === "succeeded"));
    assert.ok(audit.approvals.some(record => record.event?.eventType === "task.approval_consumed"));
    assert.equal(audit.results.length, 1);
    assert.ok(host.getTask("host-e2e-1").history.at(-1).evidenceRefs.some(ref => ref.startsWith("worker-result-journal:sha256:")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("host rejects path aliasing between task, approval, and result journals", () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-host-paths-"));
  try {
    assert.throws(() => createWorkerHost({
      taskFilePath: join(directory, "tasks.jsonl"),
      approvalFilePath: join(directory, ".", "tasks.jsonl"),
      resultFilePath: join(directory, "results.jsonl"),
      registry: registry(),
    }), /separate paths/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
