import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createExtensionRegistry, validateExtensionManifest } from "./extension-registry.mjs";

const manifest = (overrides = {}) => ({
  manifest_version: "1.0",
  extension_id: "guardian.evidence",
  version: "1.2.0",
  entrypoint: "extensions/guardian-evidence/evidence-ledger.mjs",
  capabilities: ["evidence.append"],
  permissions: ["evidence.write"],
  data_flows: ["task-metadata-to-local-ledger"],
  healthcheck: "node --check extensions/guardian-evidence/evidence-ledger.mjs",
  test_command: "node --test extensions/guardian-evidence/evidence-ledger.test.mjs",
  rollback: "disable extension and revert pinned revision",
  ...overrides
});

async function readManifest(relativePath) {
  return JSON.parse(await readFile(new URL(relativePath, import.meta.url), "utf8"));
}

test("validates and freezes a normalized manifest", () => {
  const normalized = validateExtensionManifest(manifest());
  assert.equal(normalized.extension_id, "guardian.evidence");
  assert.equal(normalized.version, "1.2.0");
  assert.ok(Object.isFrozen(normalized));
  assert.ok(Object.isFrozen(normalized.capabilities));
});

test("rejects malformed IDs, versions, and duplicate fields", () => {
  assert.throws(() => validateExtensionManifest(manifest({ extension_id: "Guardian/Evidence" })), /lowercase/);
  assert.throws(() => validateExtensionManifest(manifest({ version: "latest" })), /semantic-version/);
  assert.throws(() => validateExtensionManifest(manifest({ capabilities: ["read", "read"] })), /duplicates/);
});

test("registry rejects capabilities not explicitly allowlisted", () => {
  const registry = createExtensionRegistry({
    allowedCapabilities: ["evidence.read"],
    allowedPermissions: ["evidence.write"]
  });
  assert.throws(() => registry.register(manifest()), /Capability not allowlisted: evidence.append/);
  assert.equal(registry.list().length, 0);
});

test("registry rejects permissions not explicitly allowlisted", () => {
  const registry = createExtensionRegistry({
    allowedCapabilities: ["evidence.append"],
    allowedPermissions: ["evidence.read"]
  });
  assert.throws(() => registry.register(manifest()), /Permission not allowlisted: evidence.write/);
  assert.equal(registry.list().length, 0);
});

test("registry registers, resolves, sorts, and removes entries", () => {
  const registry = createExtensionRegistry({
    allowedCapabilities: ["evidence.append", "funding.reconcile"],
    allowedPermissions: ["evidence.write", "funding.read"]
  });
  const first = registry.register(manifest());
  assert.equal(registry.get(first.extension_id).version, "1.2.0");
  assert.throws(() => registry.register(manifest()), /already registered/);
  registry.register(manifest({
    extension_id: "funding.reconcile",
    entrypoint: "extensions/funding-integrity/reconcile.mjs",
    capabilities: ["funding.reconcile"],
    permissions: ["funding.read"],
    data_flows: ["public-funding-records-to-report"]
  }));
  assert.deepEqual(registry.list().map(item => item.extension_id), ["funding.reconcile", "guardian.evidence"]);
  assert.equal(registry.remove("guardian.evidence"), true);
  assert.equal(registry.get("guardian.evidence"), null);
  assert.equal(registry.remove("missing"), false);
});

test("manifest cannot mutate registry policy or registered data after registration", () => {
  const allowedCapabilities = ["evidence.append"];
  const allowedPermissions = ["evidence.write"];
  const registry = createExtensionRegistry({ allowedCapabilities, allowedPermissions });
  allowedCapabilities.push("system.admin");
  const registered = registry.register(manifest());
  assert.throws(() => registry.register(manifest({
    extension_id: "dangerous.extension",
    capabilities: ["system.admin"]
  })), /Capability not allowlisted/);
  assert.throws(() => { registered.capabilities.push("system.admin"); }, TypeError);
});

test("real Guardian and funding manifests pass the explicit registry policy", async () => {
  const guardian = await readManifest("../extensions/guardian-evidence/manifest.json");
  const funding = await readManifest("../extensions/funding-integrity/manifest.json");
  const registry = createExtensionRegistry({
    allowedCapabilities: ["evidence.append", "evidence.verify", "funding.reconcile.read_only"],
    allowedPermissions: ["filesystem.write:local-evidence-ledger", "filesystem.read:input-records"]
  });
  registry.register(guardian);
  registry.register(funding);
  assert.deepEqual(registry.list().map(item => item.extension_id), ["funding.integrity", "guardian.evidence"]);
  assert.equal(registry.get("funding.integrity").capabilities.includes("funding.reconcile.read_only"), true);
});
