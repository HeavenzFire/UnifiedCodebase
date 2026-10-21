import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensionManifests } from "./load-extension-manifests.mjs";
import { createExtensionRuntime } from "./extension-runtime.mjs";
import { readEvidenceRecords } from "../extensions/guardian-evidence/evidence-ledger.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const policy = {
  allowedCapabilities: ["evidence.append", "evidence.verify", "funding.reconcile.read_only"],
  allowedPermissions: ["filesystem.write:local-evidence-ledger", "filesystem.read:input-records"],
};
const manifests = [
  "extensions/guardian-evidence/manifest.json",
  "extensions/funding-integrity/manifest.json",
];

async function setup(ledgerPath = null) {
  const registry = await loadExtensionManifests({ repositoryRoot, manifestPaths: manifests, ...policy });
  return createExtensionRuntime({ registry, ledgerPath });
}

const balanced = () => ({
  appropriations: [{ appropriationId: "AP1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
  awards: [{ awardId: "A1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
  disbursements: [{ disbursementId: "D1", awardId: "A1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
});

test("Guardian append uses only the host-configured ledger path and can verify the record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hf-runtime-"));
  try {
    const ledgerPath = join(dir, "evidence.jsonl");
    const runtime = await setup(ledgerPath);
    const appended = await runtime.invoke({
      extensionId: "guardian.evidence",
      action: "append",
      input: { source: "https://example.org/report", claim: "Allocation record captured", capturedAt: "2026-10-20T10:00:00Z" },
    });
    assert.equal(appended.ok, true);
    const records = await readEvidenceRecords(ledgerPath);
    assert.equal(records.length, 1);
    assert.equal((await runtime.invoke({ extensionId: "guardian.evidence", action: "verify", input: records[0] })).valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Guardian append fails closed without a host-configured ledger path", async () => {
  const runtime = await setup();
  await assert.rejects(
    runtime.invoke({
      extensionId: "guardian.evidence",
      action: "append",
      input: { source: "https://example.org/report", claim: "Claim", capturedAt: "2026-10-20T10:00:00Z" },
    }),
    /Host must configure a local evidence ledger path/,
  );
});

test("funding reconciliation is routed through the read-only built-in handler", async () => {
  const runtime = await setup();
  const result = await runtime.invoke({ extensionId: "funding.integrity", action: "reconcile", input: balanced() });
  assert.equal(result.mode, "read_only");
  assert.equal(result.reconciliations[0].status, "reconciled");
});

test("runtime refuses unknown extensions and arbitrary actions", async () => {
  const runtime = await setup();
  await assert.rejects(runtime.invoke({ extensionId: "unknown.extension", action: "run", input: {} }), /not registered/);
  await assert.rejects(runtime.invoke({ extensionId: "guardian.evidence", action: "shell", input: {} }), /Unsupported extension action/);
});
