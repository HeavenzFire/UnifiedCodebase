import { appendEvidenceRecord, createEvidenceRecord, verifyEvidenceRecord } from "../extensions/guardian-evidence/evidence-ledger.mjs";
import { reconcileFunding } from "../extensions/funding-integrity/reconcile.mjs";

function requireDeclared(manifest, capability, permission = null) {
  if (!manifest.capabilities.includes(capability)) {
    throw new Error("Extension does not declare capability: " + capability);
  }
  if (permission && !manifest.permissions.includes(permission)) {
    throw new Error("Extension does not declare permission: " + permission);
  }
}

/**
 * A closed, host-owned dispatch table for the two reviewed built-in extensions.
 * This deliberately does not import arbitrary manifest entrypoints or evaluate
 * commands from manifest metadata. Adding an extension requires a code-reviewed
 * handler here plus explicit policy and tests.
 */
export function createExtensionRuntime({ registry, ledgerPath = null } = {}) {
  if (!registry || typeof registry.get !== "function") {
    throw new TypeError("A validated extension registry is required.");
  }

  return Object.freeze({
    async invoke({ extensionId, action, input }) {
      const manifest = registry.get(extensionId);
      if (!manifest) throw new Error("Extension is not registered: " + extensionId);

      if (extensionId === "guardian.evidence" && action === "verify") {
        requireDeclared(manifest, "evidence.verify");
        return { ok: true, valid: verifyEvidenceRecord(input) };
      }

      if (extensionId === "guardian.evidence" && action === "append") {
        requireDeclared(manifest, "evidence.append", "filesystem.write:local-evidence-ledger");
        if (typeof ledgerPath !== "string" || !ledgerPath.trim()) {
          throw new Error("Host must configure a local evidence ledger path before append.");
        }
        const record = createEvidenceRecord(input);
        const path = await appendEvidenceRecord(ledgerPath, record);
        return { ok: true, recordId: record.recordId, recordSha256: record.recordSha256, path };
      }

      if (extensionId === "funding.integrity" && action === "reconcile") {
        requireDeclared(manifest, "funding.reconcile.read_only", "filesystem.read:input-records");
        return reconcileFunding(input);
      }

      throw new Error("Unsupported extension action: " + extensionId + "/" + action);
    },
  });
}
