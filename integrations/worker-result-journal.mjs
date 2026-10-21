import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const ZERO_HASH = "0".repeat(64);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}
function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}
function validateEntry(entry, lineNumber) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.taskId !== "string" || !entry.taskId ||
      typeof entry.workerId !== "string" || !entry.workerId ||
      typeof entry.startedAt !== "string" || typeof entry.finishedAt !== "string" ||
      typeof entry.resultSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.resultSha256)) {
    throw new Error("Invalid worker result entry at line " + lineNumber + ".");
  }
  if (sha256(canonicalJson(entry.result)) !== entry.resultSha256) {
    throw new Error("Worker result digest mismatch at line " + lineNumber + ".");
  }
}
function readAndVerify(filePath) {
  if (!existsSync(filePath)) return { records: [], previousHash: ZERO_HASH };
  const content = readFileSync(filePath, "utf8");
  if (!content) return { records: [], previousHash: ZERO_HASH };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const records = [];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw new Error("Malformed worker result journal JSON at line " + lineNumber + "."); }
    if (!record || record.sequence !== lineNumber || record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) ||
        !record.entry || typeof record.entry !== "object") {
      throw new Error("Invalid worker result journal chain at line " + lineNumber + ".");
    }
    validateEntry(record.entry, lineNumber);
    const expected = sha256(canonicalJson({ sequence: record.sequence, previousHash: record.previousHash, entry: record.entry }));
    if (record.hash !== expected) throw new Error("Worker result journal hash mismatch at line " + lineNumber + ".");
    records.push(record);
    previousHash = record.hash;
  }
  return { records, previousHash };
}

/** Append-only, hash-chained persistence for JSON-compatible worker outputs. Assumes one writer per file. */
export function createWorkerResultJournal({ filePath, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("filePath is required.");
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const replay = readAndVerify(absolutePath);
  let sequence = replay.records.length;
  let previousHash = replay.previousHash;
  let fault = null;
  function assertHealthy() {
    if (fault) {
      const error = new Error("Worker result journal is faulted; restart and recover the journal before continuing.");
      error.cause = fault;
      throw error;
    }
  }
  return Object.freeze({
    append({ taskId, workerId, startedAt, finishedAt, result } = {}) {
      assertHealthy();
      const serialized = JSON.stringify(result ?? null);
      if (serialized === undefined) throw new TypeError("Worker result must be JSON-serializable.");
      const normalizedResult = JSON.parse(serialized);
      const entry = {
        entryId: randomUUID(),
        taskId: String(taskId ?? ""),
        workerId: String(workerId ?? ""),
        startedAt: String(startedAt ?? ""),
        finishedAt: String(finishedAt ?? ""),
        recordedAt: now(),
        result: normalizedResult,
        resultSha256: sha256(canonicalJson(normalizedResult)),
      };
      validateEntry(entry, sequence + 1);
      const body = { sequence: sequence + 1, previousHash, entry };
      const record = { ...body, hash: sha256(canonicalJson(body)) };
      try {
        appendFileSync(absolutePath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
      } catch (error) {
        fault = error;
        throw error;
      }
      sequence = record.sequence;
      previousHash = record.hash;
      return Object.freeze({ sequence, hash: record.hash, resultSha256: entry.resultSha256 });
    },
    list() {
      assertHealthy();
      return readAndVerify(absolutePath).records.map(record => cloneJson(record));
    },
    audit() {
      assertHealthy();
      return readAndVerify(absolutePath).records.map(({ sequence, previousHash, hash, entry }) => ({
        sequence, previousHash, hash, entry: cloneJson(entry),
      }));
    },
    storagePath: absolutePath,
  });
}
