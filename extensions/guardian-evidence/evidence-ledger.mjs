import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const STATES = new Set(["unreviewed", "corroborated", "disputed", "retracted"]);
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function createEvidenceRecord(input, { now = () => new Date().toISOString() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Evidence input must be an object");
  for (const field of ["source", "claim", "capturedAt"]) {
    if (typeof input[field] !== "string" || !input[field].trim()) throw new TypeError(`Missing required field: ${field}`);
  }
  if (input.source.startsWith("http:") && !input.allowInsecureHttp) throw new TypeError("HTTP source rejected; use HTTPS or explicitly document a local source");
  if (input.capturedAt && Number.isNaN(Date.parse(input.capturedAt))) throw new TypeError("capturedAt must be a valid date");
  const state = input.state ?? "unreviewed";
  if (!STATES.has(state)) throw new TypeError("Invalid evidence review state");
  const sourceText = typeof input.sourceContent === "string" ? input.sourceContent : input.source;
  const body = {
    schemaVersion: 1,
    recordType: input.correctsRecordId ? "correction" : "evidence",
    recordId: input.recordId ?? sha256(`${input.source}\n${input.claim}\n${input.capturedAt}`).slice(0, 24),
    source: input.source,
    sourceSha256: sha256(sourceText),
    claim: input.claim.trim(),
    capturedAt: new Date(input.capturedAt).toISOString(),
    recordedAt: now(),
    state,
    reviewNote: input.reviewNote ?? null,
    correctsRecordId: input.correctsRecordId ?? null,
    limitations: Array.isArray(input.limitations) ? input.limitations : []
  };
  body.recordSha256 = sha256(stableJson(body));
  return body;
}

export function verifyEvidenceRecord(record) {
  if (!record || typeof record !== "object" || typeof record.recordSha256 !== "string") return false;
  const { recordSha256, ...body } = record;
  return sha256(stableJson(body)) === recordSha256;
}

export async function appendEvidenceRecord(path, record) {
  if (!verifyEvidenceRecord(record)) throw new TypeError("Evidence record hash invalid");
  const target = resolve(path);
  const previous = await readEvidenceRecords(target);
  if (previous.some(item => item.recordId === record.recordId)) throw new Error("Duplicate recordId; append a correction with a new recordId instead");
  if (record.correctsRecordId && !previous.some(item => item.recordId === record.correctsRecordId)) {
    throw new Error("Correction target does not exist in this ledger");
  }
  await appendFile(target, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
  return target;
}

export async function readEvidenceRecords(path) {
  try {
    const content = await readFile(resolve(path), "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line, index) => {
      let record;
      try { record = JSON.parse(line); } catch { throw new Error(`Invalid JSON at ledger line ${index + 1}`); }
      if (!verifyEvidenceRecord(record)) throw new Error(`Hash verification failed at ledger line ${index + 1}`);
      return record;
    });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [command, ledgerPath, recordJson] = process.argv.slice(2);
  if (command === "verify" && ledgerPath) {
    try {
      const records = await readEvidenceRecords(ledgerPath);
      console.log(JSON.stringify({ ok: true, records: records.length }));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
  } else if (command === "append" && ledgerPath && recordJson) {
    try {
      const input = JSON.parse(recordJson);
      const record = createEvidenceRecord(input);
      await appendEvidenceRecord(ledgerPath, record);
      console.log(JSON.stringify({ ok: true, recordId: record.recordId, recordSha256: record.recordSha256 }));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, error: error.message }));
      process.exitCode = 1;
    }
  } else {
    console.error("Usage: node evidence-ledger.mjs verify <ledger.jsonl> | append <ledger.jsonl> '<record-json>'");
    process.exitCode = 2;
  }
}
