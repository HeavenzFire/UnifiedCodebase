import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExtensionManifests } from "./load-extension-manifests.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const policy = {
  allowedCapabilities: ["evidence.append", "evidence.verify", "funding.reconcile.read_only"],
  allowedPermissions: ["filesystem.write:local-evidence-ledger", "filesystem.read:input-records"],
};

test("loads actual Guardian and funding manifests under explicit allowlists", async () => {
  const loaded = await loadExtensionManifests({
    repositoryRoot,
    manifestPaths: [
      "extensions/guardian-evidence/manifest.json",
      "extensions/funding-integrity/manifest.json",
    ],
    ...policy,
  });
  assert.deepEqual(loaded.list().map(item => item.extension_id), ["funding.integrity", "guardian.evidence"]);
  assert.equal(loaded.get("funding.integrity").capabilities[0], "funding.reconcile.read_only");
  assert.equal("execute" in loaded, false);
});

test("default-deny policy rejects an extension requesting unapproved permissions", async () => {
  await assert.rejects(
    loadExtensionManifests({
      repositoryRoot,
      manifestPaths: ["extensions/guardian-evidence/manifest.json"],
      allowedCapabilities: ["evidence.append", "evidence.verify"],
      allowedPermissions: [],
    }),
    /Permission not allowlisted/,
  );
});

test("rejects manifest paths that escape repository root", async () => {
  await assert.rejects(
    loadExtensionManifests({
      repositoryRoot,
      manifestPaths: ["../outside.json"],
      ...policy,
    }),
    /outside the repository root/,
  );
});

test("rejects entrypoints that escape repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-extension-root-"));
  try {
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(root, "extensions", "manifest.json"), JSON.stringify({
      manifest_version: "1.0",
      extension_id: "test.escape",
      version: "1.0.0",
      entrypoint: "../outside.mjs",
      capabilities: ["safe.read"],
      permissions: ["safe.read"],
      data_flows: ["input-to-output"],
      healthcheck: "manual",
      test_command: "manual",
      rollback: "disable",
    }));
    await assert.rejects(
      loadExtensionManifests({
        repositoryRoot: root,
        manifestPaths: ["extensions/manifest.json"],
        allowedCapabilities: ["safe.read"],
        allowedPermissions: ["safe.read"],
      }),
      /outside the repository root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects symlinked entrypoints that resolve outside repository root", async () => {
  const root = await mkdtemp(join(tmpdir(), "hf-extension-root-"));
  const outside = await mkdtemp(join(tmpdir(), "hf-extension-outside-"));
  try {
    await mkdir(join(root, "extensions"), { recursive: true });
    await writeFile(join(outside, "payload.mjs"), "export const unsafe = true;\n");
    await symlink(join(outside, "payload.mjs"), join(root, "extensions", "payload.mjs"));
    await writeFile(join(root, "extensions", "manifest.json"), JSON.stringify({
      manifest_version: "1.0",
      extension_id: "test.symlink",
      version: "1.0.0",
      entrypoint: "extensions/payload.mjs",
      capabilities: ["safe.read"],
      permissions: ["safe.read"],
      data_flows: ["input-to-output"],
      healthcheck: "manual",
      test_command: "manual",
      rollback: "disable",
    }));
    await assert.rejects(
      loadExtensionManifests({
        repositoryRoot: root,
        manifestPaths: ["extensions/manifest.json"],
        allowedCapabilities: ["safe.read"],
        allowedPermissions: ["safe.read"],
      }),
      /outside the repository root/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
