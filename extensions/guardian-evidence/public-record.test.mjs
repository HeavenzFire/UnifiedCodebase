import test from "node:test";
import assert from "node:assert/strict";
import { validatePublicRecord } from "./public-record.mjs";

const valid = () => ({
  record_id: "PUB-001",
  source_url: "https://example.gov/reports/annual.pdf",
  source_type: "official_record",
  retrieved_at_utc: "2026-10-20T12:00:00Z",
  source_sha256: "a".repeat(64),
  reporting_period: "FY2026",
  accounting_basis: "cash",
  claim: "Synthetic example: the reported total is USD 100.",
  review_status: "unreviewed",
  pii_review: "passed",
  limitations: ["Synthetic fixture; not a real government record."]
});

test("normalizes a valid provenance-first public record", () => {
  const record = validatePublicRecord(valid());
  assert.equal(record.schema_version, "heavenzfire.public-record.v1");
  assert.equal(record.source_sha256, "a".repeat(64));
  assert.equal(record.review_status, "unreviewed");
  assert.equal(record.limitations.length, 1);
});

test("rejects insecure URLs and embedded credentials", () => {
  assert.throws(() => validatePublicRecord({ ...valid(), source_url: "http://example.gov/file" }), /HTTPS/);
  assert.throws(() => validatePublicRecord({ ...valid(), source_url: "https://user:pass@example.gov/file" }), /credentials/);
});

test("rejects credential-like URL query parameters", () => {
  assert.throws(() => validatePublicRecord({ ...valid(), source_url: "https://example.gov/report?access_token=secret" }), /credential-like query parameters/);
});

test("rejects unsupported fields and date-only timestamps", () => {
  assert.throws(() => validatePublicRecord({ ...valid(), unexpected_field: "ignored?" }), /Unsupported public-record fields/);
  assert.throws(() => validatePublicRecord({ ...valid(), retrieved_at_utc: "2026-10-20Z" }), /valid UTC timestamp/);
});

test("rejects invalid hashes, reporting period, and accounting basis", () => {
  assert.throws(() => validatePublicRecord({ ...valid(), source_sha256: "not-a-hash" }), /SHA-256/);
  assert.throws(() => validatePublicRecord({ ...valid(), reporting_period: " " }), /reporting_period/);
  assert.throws(() => validatePublicRecord({ ...valid(), accounting_basis: "guess" }), /accounting_basis/);
});

test("PII-blocked evidence cannot be marked corroborated", () => {
  assert.throws(() => validatePublicRecord({ ...valid(), pii_review: "blocked", review_status: "corroborated" }), /PII-blocked/);
});

test("requires limitations and UTC timestamps", () => {
  assert.throws(() => validatePublicRecord({ ...valid(), limitations: [] }), /limitations/);
  assert.throws(() => validatePublicRecord({ ...valid(), retrieved_at_utc: "2026-10-20T12:00:00-05:00" }), /ending in Z/);
});
