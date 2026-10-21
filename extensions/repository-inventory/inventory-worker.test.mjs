import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRepositoryInventory } from "./inventory-worker.mjs";

test("summarizes the checked-in snapshot without claiming live GitHub state", async () => {
  const report = await summarizeRepositoryInventory({ query: "heavenzfire", limit: 3 });
  assert.equal(report.schema, "heavenzfire.repository-inventory-report.v1");
  assert.equal(report.sourceSchema, "heavenzfire.repository-inventory-snapshot.v1");
  assert.equal(report.totalVisible, 276);
  assert.equal(report.filteredCount, 276);
  assert.equal(report.repositories.length, 3);
  assert.match(report.scopeNote, /not proof|not a guarantee/i);
  assert.ok(Object.hasOwn(report.statusCounts, "unassessed"));
});

test("filters by documented integration status and rejects unsafe query options", async () => {
  const report = await summarizeRepositoryInventory({ integrationStatus: "unassessed", limit: 2 });
  assert.ok(report.repositories.every(repository => repository.integration_status === "unassessed"));
  await assert.rejects(summarizeRepositoryInventory({ integrationStatus: "verified" }), /documented inventory state/);
  await assert.rejects(summarizeRepositoryInventory({ limit: 0 }), /limit must be an integer/);
  await assert.rejects(summarizeRepositoryInventory({ query: " " }), /query must be a non-empty string/);
});
