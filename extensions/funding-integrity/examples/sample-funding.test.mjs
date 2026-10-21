import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { reconcileFunding } from "../reconcile.mjs";

test("synthetic funding example produces a reviewable accounting delta", async () => {
  const path = fileURLToPath(new URL("./sample-funding.json", import.meta.url));
  const input = JSON.parse(await readFile(path, "utf8"));
  const report = reconcileFunding(input);
  assert.equal(report.mode, "read_only");
  assert.equal(report.reconciliations.length, 1);
  assert.equal(report.reconciliations[0].status, "review_required");
  assert.equal(report.reconciliations[0].deltaDisbursementsMinusAwards, -27500);
  assert.match(report.disclaimer, /not findings of fraud/);
});
