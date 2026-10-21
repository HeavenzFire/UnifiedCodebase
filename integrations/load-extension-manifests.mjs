import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createExtensionRegistry } from "./extension-registry.mjs";

function assertInside(root, target, label) {
  const rel = relative(root, target);
  if (!rel || rel === ".") {
    if (label === "entrypoint") throw new Error("Extension entrypoint must name a file inside the repository.");
    return;
  }
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) {
    throw new Error(label + " resolves outside the repository root.");
  }
}

/**
 * Load and validate extension metadata only. This function never imports or executes
 * extension code, shell commands, healthchecks, or test commands.
 */
export async function loadExtensionManifests({
  repositoryRoot,
  manifestPaths,
  allowedCapabilities = [],
  allowedPermissions = [],
}) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) {
    throw new TypeError("repositoryRoot must be a non-empty path.");
  }
  if (!Array.isArray(manifestPaths) || manifestPaths.length === 0) {
    throw new TypeError("manifestPaths must be a non-empty array.");
  }

  const root = await realpath(resolve(repositoryRoot));
  const registry = createExtensionRegistry({ allowedCapabilities, allowedPermissions });

  for (const manifestPath of manifestPaths) {
    if (typeof manifestPath !== "string" || !manifestPath.trim() || isAbsolute(manifestPath)) {
      throw new TypeError("Manifest paths must be non-empty relative paths.");
    }
    const requestedManifest = resolve(root, manifestPath);
    assertInside(root, requestedManifest, "Manifest path");
    const actualManifest = await realpath(requestedManifest);
    assertInside(root, actualManifest, "Manifest path");
    const manifest = JSON.parse(await readFile(actualManifest, "utf8"));

    if (typeof manifest.entrypoint !== "string" || !manifest.entrypoint.trim() || isAbsolute(manifest.entrypoint)) {
      throw new Error("Extension entrypoint must be a relative repository path.");
    }
    const requestedEntrypoint = resolve(root, manifest.entrypoint);
    assertInside(root, requestedEntrypoint, "Extension entrypoint");
    const actualEntrypoint = await realpath(requestedEntrypoint);
    assertInside(root, actualEntrypoint, "Extension entrypoint");

    registry.register(manifest);
  }

  return Object.freeze({
    list: () => registry.list(),
    get: (extensionId) => registry.get(extensionId),
    // No execution API is intentionally exposed.
  });
}
