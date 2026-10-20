import test from "node:test";
import assert from "node:assert/strict";
import { reconcileFunding } from "./reconcile.mjs";

const balanced = () => ({
  appropriations: [{ programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
  awards: [{ awardId: "A1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }],
  disbursements: [{ disbursementId: "D1", awardId: "A1", programId: "P1", fiscalYear: "2026", currency: "USD", amount: 100 }]
});

test("balanced program reconciles deterministically", () => {
  const result = reconcileFunding(balanced());
  assert.equal(result.reconciliations[0].status, "reconciled");
  assert.equal(result.mode, "read_only");
  assert.equal(result.issues.length, 0);
});

test("over-award is flagged for review, never labeled fraud", () => {
  const input = balanced();
  input.awards[0].amount = 125;
  const result = reconcileFunding(input);
  assert.equal(result.reconciliations[0].status, "review_required");
  assert.match(result.reconciliations[0].reason, /does not establish fraud/);
});

test("missing stage is unknown, not an accusation", () => {
  const input = balanced();
  input.disbursements = [];
  const result = reconcileFunding(input);
  assert.equal(result.reconciliations[0].status, "unknown");
  assert.match(result.reconciliations[0].reason, /not evidence of misconduct/);
});

test("orphan disbursement is reported as unknown", () => {
  const input = balanced();
  input.awards = [];
  const result = reconcileFunding(input);
  assert.ok(result.issues.some(issue => issue.type === "orphan_disbursement" && issue.status === "unknown"));
});

test("duplicate identifiers are excluded to prevent double counting", () => {
  const input = balanced();
  input.awards.push({ ...input.awards[0] });
  const result = reconcileFunding(input);
  assert.ok(result.issues.some(issue => issue.type === "duplicate_id"));
  assert.equal(result.totals.awardRecords, 1);
});

test("different currencies remain separate", () => {
  const input = balanced();
  input.appropriations.push({ programId: "P1", fiscalYear: "2026", currency: "EUR", amount: 100 });
  const result = reconcileFunding(input);
  assert.ok(result.reconciliations.some(row => row.key.endsWith("|EUR") && row.status === "unknown"));
});

test("rejects malformed input and invalid tolerance", () => {
  assert.throws(() => reconcileFunding({}), /arrays/);
  assert.throws(() => reconcileFunding(balanced(), { tolerance: -1 }), /non-negative/);
});
