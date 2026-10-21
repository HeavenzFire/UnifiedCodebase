const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,127}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function assertString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(label + " must be a non-empty string.");
  }
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== "string" || !value.trim())) {
    throw new Error(label + " must be an array of non-empty strings.");
  }
  if (new Set(values).size !== values.length) {
    throw new Error(label + " must not contain duplicates.");
  }
  return [...values];
}

export function validateExtensionManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Extension manifest must be an object.");
  }
  if (manifest.manifest_version !== "1.0") {
    throw new Error('manifest_version must be "1.0".');
  }
  assertString(manifest.extension_id, "extension_id");
  if (!ID_PATTERN.test(manifest.extension_id)) {
    throw new Error("extension_id must be a lowercase, stable identifier.");
  }
  assertString(manifest.version, "version");
  if (!VERSION_PATTERN.test(manifest.version)) {
    throw new Error("version must use semantic-version syntax (major.minor.patch).");
  }
  assertString(manifest.entrypoint, "entrypoint");
  assertString(manifest.healthcheck, "healthcheck");
  assertString(manifest.test_command, "test_command");
  assertString(manifest.rollback, "rollback");

  const capabilities = uniqueStrings(manifest.capabilities, "capabilities");
  const permissions = uniqueStrings(manifest.permissions, "permissions");
  const dataFlows = uniqueStrings(manifest.data_flows, "data_flows");

  return Object.freeze({
    manifest_version: "1.0",
    extension_id: manifest.extension_id,
    version: manifest.version,
    entrypoint: manifest.entrypoint,
    capabilities: Object.freeze(capabilities),
    permissions: Object.freeze(permissions),
    data_flows: Object.freeze(dataFlows),
    healthcheck: manifest.healthcheck,
    test_command: manifest.test_command,
    rollback: manifest.rollback
  });
}

export function createExtensionRegistry({ allowedCapabilities = [], allowedPermissions = [] } = {}) {
  const capabilityPolicy = new Set(uniqueStrings(allowedCapabilities, "allowedCapabilities"));
  const permissionPolicy = new Set(uniqueStrings(allowedPermissions, "allowedPermissions"));
  const entries = new Map();

  return Object.freeze({
    register(input) {
      const manifest = validateExtensionManifest(input);
      if (entries.has(manifest.extension_id)) {
        throw new Error("Extension is already registered: " + manifest.extension_id);
      }
      const deniedCapabilities = manifest.capabilities.filter(value => !capabilityPolicy.has(value));
      const deniedPermissions = manifest.permissions.filter(value => !permissionPolicy.has(value));
      if (deniedCapabilities.length) {
        throw new Error("Capability not allowlisted: " + deniedCapabilities.join(", "));
      }
      if (deniedPermissions.length) {
        throw new Error("Permission not allowlisted: " + deniedPermissions.join(", "));
      }
      entries.set(manifest.extension_id, manifest);
      return manifest;
    },
    get(extensionId) {
      return entries.get(extensionId) || null;
    },
    list() {
      return [...entries.values()].sort((a, b) => a.extension_id.localeCompare(b.extension_id));
    },
    remove(extensionId) {
      return entries.delete(extensionId);
    }
  });
}
