#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const KEY_FIELDS = ["programId", "fiscalYear", "currency"];
const amountOk = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const keyOf = row => KEY_FIELDS.map(k => String(row[k] ?? "").trim()).join("|");
const roundMoney = n => Math.round((n + Number.EPSILON) * 100) / 100;

function validRow(row, fields) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  for (const field of fields) if (row[field] === undefined || row[field] === null || String(row[field]).trim() === "") return false;
  return amountOk(row.amount);
}

function sumByKey(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    map.set(key, (map.get(key) || 0) + row.amount);
  }
  return map;
}

export function reconcileFunding(input, { tolerance = 0.01 } = {}) {
  if (!input || typeof input !== "object" || !Array.isArray(input.appropriations) || !Array.isArray(input.awards) || !Array.isArray(input.disbursements)) {
    throw new Error("Input must contain appropriations, awards, and disbursements arrays.");
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error("Tolerance must be a non-negative number.");

  const issues = [];
  const clean = { appropriations: [], awards: [], disbursements: [] };
  const seen = { appropriation: new Set(), award: new Set(), disbursement: new Set() };

  for (const [kind, idField, required] of [
    ["appropriations", "appropriationId", ["appropriationId", "programId", "fiscalYear", "currency", "amount"]],
    ["awards", "awardId", ["awardId", "programId", "fiscalYear", "currency", "amount"]],
    ["disbursements", "disbursementId", ["disbursementId", "awardId", "programId", "fiscalYear", "currency", "amount"]]
  ]) {
    for (let i = 0; i < input[kind].length; i++) {
      const row = input[kind][i];
      if (!validRow(row, required)) {
        issues.push({ type: "invalid_row", source: kind, rowIndex: i, status: "unknown", reason: "Required fields missing or amount is not a finite non-negative number." });
        continue;
      }
      const id = String(row[idField]).trim();
      if (seen[kind === "appropriations" ? "appropriation" : kind === "awards" ? "award" : "disbursement"].has(id)) {
        issues.push({ type: "duplicate_id", source: kind, recordId: id, status: "review_required", reason: "Duplicate identifier; row excluded from totals to avoid double counting." });
        continue;
      }
      seen[kind === "appropriations" ? "appropriation" : kind === "awards" ? "award" : "disbursement"].add(id);
      clean[kind].push({ ...row, [idField]: id, programId: String(row.programId).trim(), fiscalYear: String(row.fiscalYear).trim(), currency: String(row.currency).trim().toUpperCase(), amount: roundMoney(row.amount) });
    }
  }

  const appropriations = sumByKey(clean.appropriations, keyOf);
  const awardsByProgram = sumByKey(clean.awards, keyOf);
  const awardById = new Map(clean.awards.map(row => [String(row.awardId), row]));
  const disbursementsByProgram = sumByKey(clean.disbursements, keyOf);
  const disbursementsByAward = sumByKey(clean.disbursements, row => String(row.awardId));

  const programKeys = new Set([...appropriations.keys(), ...awardsByProgram.keys(), ...disbursementsByProgram.keys()]);
  const reconciliations = [];
  for (const key of [...programKeys].sort()) {
    const hasAppropriation = appropriations.has(key);
    const hasAwards = awardsByProgram.has(key);
    const hasDisbursements = disbursementsByProgram.has(key);
    if (!hasAppropriation || !hasAwards || !hasDisbursements) {
      reconciliations.push({ key, status: "unknown", appropriation: hasAppropriation ? roundMoney(appropriations.get(key)) : null, awards: hasAwards ? roundMoney(awardsByProgram.get(key)) : null, disbursements: hasDisbursements ? roundMoney(disbursementsByProgram.get(key)) : null, reason: "At least one stage is missing; absence is not evidence of misconduct." });
      continue;
    }
    const appropriation = roundMoney(appropriations.get(key));
    const awards = roundMoney(awardsByProgram.get(key));
    const disbursements = roundMoney(disbursementsByProgram.get(key));
    const deltaAwards = roundMoney(awards - appropriation);
    const deltaDisbursements = roundMoney(disbursements - awards);
    const matched = Math.abs(deltaAwards) <= tolerance && Math.abs(deltaDisbursements) <= tolerance;
    reconciliations.push({ key, status: matched ? "reconciled" : "review_required", appropriation, awards, disbursements, deltaAwardsMinusAppropriation: deltaAwards, deltaDisbursementsMinusAwards: deltaDisbursements, reason: matched ? "Totals reconcile within configured tolerance." : "Accounting delta requires human review; this result does not establish fraud." });
  }

  for (const row of clean.disbursements) {
    const award = awardById.get(String(row.awardId));
    if (!award) {
      issues.push({ type: "orphan_disbursement", recordId: row.disbursementId, status: "unknown", reason: "No matching award record; validate source systems and identifiers." });
      continue;
    }
    if (keyOf(award) !== keyOf(row)) {
      issues.push({ type: "award_disbursement_dimension_mismatch", recordId: row.disbursementId, status: "review_required", reason: "Award and disbursement program, fiscal year, or currency differ." });
    }
    const disbursed = roundMoney(disbursementsByAward.get(String(row.awardId)) || 0);
    if (disbursed - roundMoney(award.amount) > tolerance) {
      issues.push({ type: "disbursement_exceeds_award", recordId: row.awardId, status: "review_required", awardAmount: roundMoney(award.amount), disbursedAmount: disbursed, reason: "Disbursements exceed recorded award amount; verify timing, amendments, reversals, and source records." });
    }
  }

  return {
    schema: "heavenzfire.funding-reconciliation.v1",
    generatedAt: new Date().toISOString(),
    mode: "read_only",
    tolerance,
    totals: { appropriationRecords: clean.appropriations.length, awardRecords: clean.awards.length, disbursementRecords: clean.disbursements.length },
    reconciliations,
    issues,
    disclaimer: "Exceptions are accounting signals for review, not findings of fraud, intent, or legal liability."
  };
}

async function main() {
  const path = process.argv[2];
  if (!path) throw new Error("Usage: node reconcile.mjs <input.json>");
  const input = JSON.parse(await readFile(path, "utf8"));
  console.log(JSON.stringify(reconcileFunding(input), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error("Funding reconciliation error: " + error.message); process.exitCode = 1; });
}
