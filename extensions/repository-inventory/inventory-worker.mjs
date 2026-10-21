import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateRepositoryInventory } from "../../integrations/validate-repository-inventory.mjs";

const DEFAULT_SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../docs/repository-inventory.snapshot.json");
const STATES = new Set(["unassessed", "candidate", "verified_component", "integrated", "blocked"]);

/** Read-only summary of the checked-in metadata snapshot; it does not query GitHub live. */
export async function summarizeRepositoryInventory({
  query,
  integrationStatus,
  limit = 10,
} = {}, { snapshotPath = DEFAULT_SNAPSHOT } = {}) {
  if (query !== undefined && (typeof query !== "string" || !query.trim())) {
    throw new TypeError("query must be a non-empty string when provided.");
  }
  if (integrationStatus !== undefined && !STATES.has(integrationStatus)) {
    throw new TypeError("integrationStatus must be a documented inventory state.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError("limit must be an integer from 1 through 50.");
  }
  const snapshot = JSON.parse(await readFile(resolve(snapshotPath), "utf8"));
  const validation = validateRepositoryInventory(snapshot);
  if (!validation.ok) throw new Error("Repository inventory snapshot failed validation: " + validation.errors.join("; "));

  const statusCounts = Object.fromEntries([...STATES].map(status => [
    status, snapshot.repositories.filter(repository => repository.integration_status === status).length,
  ]));
  const needle = query?.trim().toLowerCase();
  const matches = snapshot.repositories.filter(repository => {
    const queryMatches = !needle || repository.full_name.toLowerCase().includes(needle) || repository.name.toLowerCase().includes(needle);
    return queryMatches && (!integrationStatus || repository.integration_status === integrationStatus);
  });
  return {
    schema: "heavenzfire.repository-inventory-report.v1",
    sourceSchema: snapshot.schema,
    snapshotDate: snapshot.snapshot_date,
    totalVisible: snapshot.repositories.length,
    filteredCount: matches.length,
    statusCounts,
    scopeNote: snapshot.scope_note,
    repositories: matches.slice(0, limit).map(repository => ({
      full_name: repository.full_name,
      name: repository.name,
      default_branch: repository.default_branch,
      visibility: repository.visibility,
      archived: repository.archived,
      size_kb: repository.size_kb,
      integration_status: repository.integration_status,
      url: repository.url,
    })),
  };
}
