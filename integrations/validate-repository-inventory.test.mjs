import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateRepositoryInventory } from "./validate-repository-inventory.mjs";

test("connected GitHub repository snapshot validates and has unique identities", async () => {
  const path = fileURLToPath(new URL("../docs/repository-inventory.snapshot.json", import.meta.url));
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  const result = validateRepositoryInventory(snapshot);
  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.count, snapshot.repositories.length);
  assert.ok(result.count > 0);
});

test("rejects duplicate repositories and inconsistent counts", () => {
  const repo = { full_name: "Owner/Repo", name: "Repo", default_branch: "main", visibility: "public", archived: false, size_kb: 0, url: "https://github.com/Owner/Repo" };
  const snapshot = { schema: "heavenzfire.repository-inventory-snapshot.v1", result_count: 2, integration_status_default: "unassessed", repositories: [repo, { ...repo, full_name: "owner/repo" }] };
  const result = validateRepositoryInventory(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("Duplicate repository")));
});

test("does not allow inventory entries to imply verified integration by default", () => {
  const snapshot = { schema: "heavenzfire.repository-inventory-snapshot.v1", result_count: 0, integration_status_default: "integrated", repositories: [] };
  const result = validateRepositoryInventory(snapshot);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes("unassessed")));
});
