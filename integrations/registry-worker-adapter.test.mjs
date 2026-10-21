import test from "node:test";
import assert from "node:assert/strict";
import { createExtensionRegistry } from "./extension-registry.mjs";
import { createRegistryBackedWorkers } from "./registry-worker-adapter.mjs";

function makeRegistry() {
  const registry = createExtensionRegistry({
    allowedCapabilities: ["funding.reconcile.read_only", "evidence.verify"],
    allowedPermissions: ["filesystem.read:input-records"],
  });
  registry.register({
    manifest_version: "1.0",
    extension_id: "funding.integrity",
    version: "1.0.0",
    entrypoint: "extensions/funding-integrity/reconcile.mjs",
    capabilities: ["funding.reconcile.read_only"],
    permissions: ["filesystem.read:input-records"],
    data_flows: ["public-records-to-reconciliation-report"],
    healthcheck: "node --check extensions/funding-integrity/reconcile.mjs",
    test_command: "node --test extensions/funding-integrity/reconcile.test.mjs",
    rollback: "disable extension and revert pinned revision",
  });
  return registry;
}

test("worker capabilities are sourced only from registered extension manifests", () => {
  const registry = makeRegistry();
  const [worker] = createRegistryBackedWorkers({
    registry,
    handlers: [{
      extensionId: "funding.integrity",
      capabilities: ["system.admin"],
      run: async (task, manifest) => ({ taskId: task.taskId, extension: manifest.extension_id }),
    }],
  });
  assert.equal(worker.id, "funding.integrity");
  assert.deepEqual(worker.capabilities, ["funding.reconcile.read_only"]);
});

test("adapter rejects unregistered extensions and duplicate handlers", () => {
  const registry = makeRegistry();
  assert.throws(() => createRegistryBackedWorkers({
    registry, handlers: [{ extensionId: "unknown.extension", run: async () => null }],
  }), /not registered/);
  assert.throws(() => createRegistryBackedWorkers({
    registry, handlers: [
      { extensionId: "funding.integrity", run: async () => null },
      { extensionId: "funding.integrity", run: async () => null },
    ],
  }), /Duplicate extension handler/);
});

test("registered manifest metadata is passed to the trusted handler", async () => {
  const registry = makeRegistry();
  let seenManifest;
  const [worker] = createRegistryBackedWorkers({
    registry,
    handlers: [{
      extensionId: "funding.integrity",
      run: async (_task, manifest) => { seenManifest = manifest; return manifest.version; },
    }],
  });
  assert.equal(await worker.run({ taskId: "fixture" }), "1.0.0");
  assert.equal(seenManifest.extension_id, "funding.integrity");
});
