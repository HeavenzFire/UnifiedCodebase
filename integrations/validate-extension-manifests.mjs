#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadExtensionManifests } from "./load-extension-manifests.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const policy = {
  allowedCapabilities: [
    "evidence.append",
    "evidence.verify",
    "funding.reconcile.read_only",
  ],
  allowedPermissions: [
    "filesystem.write:local-evidence-ledger",
    "filesystem.read:input-records",
  ],
};

try {
  const registry = await loadExtensionManifests({
    repositoryRoot: root,
    manifestPaths: [
      "extensions/guardian-evidence/manifest.json",
      "extensions/funding-integrity/manifest.json",
    ],
    ...policy,
  });
  console.log(JSON.stringify({
    ok: true,
    mode: "metadata_only",
    executedEntrypoints: false,
    extensions: registry.list().map(({ extension_id, version, capabilities, permissions }) => ({
      extension_id, version, capabilities, permissions,
    })),
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
