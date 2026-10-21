import { pathToFileURL } from "node:url";

const SOURCE_TYPES = new Set([
  "official_record",
  "official_dataset",
  "court_filing",
  "audit_report",
  "secondary_reporting",
  "testimony",
  "other"
]);
const ACCOUNTING_BASES = new Set([
  "cash",
  "accrual",
  "obligation",
  "disbursement",
  "not_applicable",
  "unknown"
]);
const REVIEW_STATES = new Set(["unreviewed", "corroborated", "disputed", "corrected", "retracted"]);
const PII_STATES = new Set(["passed", "redacted", "blocked"]);
const SHA256 = /^[a-f0-9]{64}$/i;

function requiredText(value, field, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(field + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}

/**
 * Validate a provenance-first public record. This is a structural validator,
 * not proof that the source is authentic or the claim is true.
 */
export function validatePublicRecord(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Public record must be an object.");
  }
  const recordId = requiredText(input.record_id, "record_id", 200);
  const sourceUrl = requiredText(input.source_url, "source_url", 2048);
  let url;
  try { url = new URL(sourceUrl); } catch { throw new TypeError("source_url must be a valid URL."); }
  if (url.protocol !== "https:") throw new TypeError("source_url must use HTTPS.");
  if (url.username || url.password) throw new TypeError("source_url must not contain embedded credentials.");
  if (!SOURCE_TYPES.has(input.source_type)) throw new TypeError("source_type is not supported.");
  const retrievedAt = requiredText(input.retrieved_at_utc, "retrieved_at_utc", 64);
  if (!retrievedAt.endsWith("Z") || Number.isNaN(Date.parse(retrievedAt))) {
    throw new TypeError("retrieved_at_utc must be a valid UTC timestamp ending in Z.");
  }
  if (typeof input.source_sha256 !== "string" || !SHA256.test(input.source_sha256)) {
    throw new TypeError("source_sha256 must be a 64-character SHA-256 hex digest.");
  }
  const reportingPeriod = requiredText(input.reporting_period, "reporting_period", 200);
  if (!ACCOUNTING_BASES.has(input.accounting_basis)) throw new TypeError("accounting_basis is not supported.");
  const claim = requiredText(input.claim, "claim");
  if (!REVIEW_STATES.has(input.review_status)) throw new TypeError("review_status is not supported.");
  if (!PII_STATES.has(input.pii_review)) throw new TypeError("pii_review is not supported.");
  if (!Array.isArray(input.limitations) || input.limitations.some(x => typeof x !== "string" || !x.trim())) {
    throw new TypeError("limitations must be an array of non-empty strings.");
  }
  if (input.pii_review === "blocked" && input.review_status === "corroborated") {
    throw new TypeError("A PII-blocked record cannot be marked corroborated.");
  }
  const result = {
    schema_version: "heavenzfire.public-record.v1",
    record_id: recordId,
    source_url: url.toString(),
    source_type: input.source_type,
    retrieved_at_utc: new Date(retrievedAt).toISOString(),
    source_sha256: input.source_sha256.toLowerCase(),
    reporting_period: reportingPeriod,
    accounting_basis: input.accounting_basis,
    claim,
    review_status: input.review_status,
    pii_review: input.pii_review,
    limitations: input.limitations.map(x => x.trim())
  };
  for (const field of ["source_publisher", "source_document_id", "calculation_method", "reviewer_role", "correction_of"]) {
    if (input[field] !== undefined) result[field] = requiredText(input[field], field, field === "calculation_method" ? 4000 : 500);
  }
  if (input.source_archive_url !== undefined) {
    let archive;
    try { archive = new URL(requiredText(input.source_archive_url, "source_archive_url", 2048)); }
    catch { throw new TypeError("source_archive_url must be a valid URL."); }
    if (archive.protocol !== "https:") throw new TypeError("source_archive_url must use HTTPS.");
    result.source_archive_url = archive.toString();
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error("This module exposes validatePublicRecord(input) for a host-owned ingestion workflow.");
  process.exitCode = 2;
}
