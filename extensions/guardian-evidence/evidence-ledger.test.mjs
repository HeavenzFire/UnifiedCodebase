import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendEvidenceRecord, createEvidenceRecord, readEvidenceRecords, verifyEvidenceRecord } from "./evidence-ledger.mjs";

const sample = (extra = {}) => ({
  source: "https://example.org/report",
  sourceContent: "public report contents",
  claim: "Reported allocation total is 120000",
  capturedAt: "2026-10-20T10:00:00Z",
  ...extra
});

test("record stores source digest and verifies canonical record hash", () => {
  const record = createEvidenceRecord(sample(), { now: () => "2026-10-20T10:01:00Z" });
  assert.equal(record.sourceSha256.length, 64);
  assert.equal(verifyEvidenceRecord(record), true);
  assert.equal(verifyEvidenceRecord({ ...record, claim: "tampered" }), false);
});

test("requires source, claim and timestamp; rejects insecure HTTP by default", () => {
  assert.throws(() => createEvidenceRecord({ claim: "x", source: "https://x", capturedAt: "2026-01-01" }), /sourceContent|/);
  assert.throws(() => createEvidenceRecord(sample({ source: "http://example.org" })), /HTTP source rejected/);
});

test("append-only ledger round-trips and rejects duplicate record ids", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hf-ledger-"));
  try {
    const path = join(dir, "evidence.jsonl");
    const first = createEvidenceRecord(sample(), { now: () => "2026-10-20T10:01:00Z" });
    await appendEvidenceRecord(path, first);
    assert.deepEqual(await readEvidenceRecords(path), [first]);
    await assert.rejects(() => appendEvidenceRecord(path, first), /Duplicate recordId/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("corrections append a new record and must reference an existing record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hf-ledger-"));
  try {
    const path = join(dir, "evidence.jsonl");
    const first = createEvidenceRecord(sample(), { now: () => "2026-10-20T10:01:00Z" });
    await appendEvidenceRecord(path, first);
    const correction = createEvidenceRecord(sample({
      recordId: "correction-1",
      correctsRecordId: first.recordId,
      claim: "Corrected allocation total is 110000",
      state: "disputed"
    }));
    await appendEvidenceRecord(path, correction);
    const rows = await readEvidenceRecords(path);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].claim, "Reported allocation total is 120000");
    assert.equal(rows[1].recordType, "correction");
    const bad = createEvidenceRecord(sample({ recordId: "orphan-correction", correctsRecordId: "missing" }));
    await assert.rejects(() => appendEvidenceRecord(path, bad), /Correction target does not exist/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("ledger verifier detects altered or malformed lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hf-ledger-"));
  try {
    const path = join(dir, "evidence.jsonl");
    const record = createEvidenceRecord(sample());
    await appendEvidenceRecord(path, record);
    const text = await readFile(path, "utf8");
    await import("node:fs/promises").then(fs => fs.writeFile(path, text.replace("Reported allocation", "Forged allocation")));
    await assert.rejects(() => readEvidenceRecords(path), /Hash verification failed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
