/**
 * Converts already-registered extension manifests into dispatcher workers.
 * Manifest capabilities are the source of truth; handler declarations cannot add privileges.
 * Handlers are trusted in-process code and are not sandboxed by this adapter.
 */
export function createRegistryBackedWorkers({ registry, handlers = [] } = {}) {
  if (!registry || typeof registry.get !== "function") {
    throw new TypeError("A validated extension registry is required.");
  }
  if (!Array.isArray(handlers)) throw new TypeError("handlers must be an array.");
  const seen = new Set();
  return handlers.map(handler => {
    if (!handler || typeof handler !== "object" ||
        typeof handler.extensionId !== "string" || !handler.extensionId.trim() ||
        typeof handler.run !== "function") {
      throw new TypeError("Each handler requires extensionId and run.");
    }
    const extensionId = handler.extensionId.trim();
    if (seen.has(extensionId)) throw new Error("Duplicate extension handler: " + extensionId);
    seen.add(extensionId);
    const manifest = registry.get(extensionId);
    if (!manifest) throw new Error("Extension is not registered: " + extensionId);
    if (!Array.isArray(manifest.capabilities)) {
      throw new Error("Registered extension has no validated capabilities: " + extensionId);
    }
    return Object.freeze({
      id: extensionId,
      capabilities: [...manifest.capabilities],
      run: task => handler.run(task, manifest),
    });
  });
}
