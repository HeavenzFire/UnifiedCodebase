import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createTaskLifecycle } from "./task-lifecycle.mjs";

const ZERO_HASH = "0".repeat(64);
const STATUSES = new Set(["queued", "running", "blocked", "succeeded", "failed", "cancelled"]);

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function validateTaskSnapshot(task, lineNumber) {
  if (!task || typeof task !== "object" || Array.isArray(task)) {
    throw new Error("Invalid task snapshot at audit line " + lineNumber + ".");
  }
  if (typeof task.taskId !== "string" || !task.taskId.trim() || task.taskId.length > 200) {
    throw new Error("Invalid taskId at audit line " + lineNumber + ".");
  }
  if (!STATUSES.has(task.status)) throw new Error("Invalid task status at audit line " + lineNumber + ".");
  if (typeof task.title !== "string" || !task.title.trim() || typeof task.requestedBy !== "string" || !task.requestedBy.trim()) {
    throw new Error("Invalid task identity fields at audit line " + lineNumber + ".");
  }
  if (!Array.isArray(task.history) || task.history.length < 1 || task.history[0]?.status !== "queued" ||
      task.history[task.history.length - 1]?.status !== task.status) {
    throw new Error("Invalid task history at audit line " + lineNumber + ".");
  }
}

function readAndVerifyLog(filePath) {
  if (!existsSync(filePath)) return { records: [], latestTasks: [], sequence: 0, previousHash: ZERO_HASH };
  const content = readFileSync(filePath, "utf8");
  if (!content) return { records: [], latestTasks: [], sequence: 0, previousHash: ZERO_HASH };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const records = [];
  const latest = new Map();
  let previousHash = ZERO_HASH;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    if (!lines[index].trim()) throw new Error("Blank audit record at line " + lineNumber + ".");
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw new Error("Malformed JSON in task audit log at line " + lineNumber + "."); }
    if (!record || record.sequence !== lineNumber || record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) ||
        !record.event || typeof record.event !== "object") {
      throw new Error("Invalid sequence or chain metadata at audit line " + lineNumber + ".");
    }
    const expectedHash = digest({ sequence: record.sequence, previousHash: record.previousHash, event: record.event });
    if (record.hash !== expectedHash) throw new Error("Task audit hash mismatch at line " + lineNumber + ".");
    const event = record.event;
    if (typeof event.eventId !== "string" || !event.eventId ||
        !["task.created", "task.transitioned"].includes(event.eventType) ||
        typeof event.taskId !== "string" || !event.task || event.task.taskId !== event.taskId ||
        event.status !== event.task.status) {
      throw new Error("Invalid task event at audit line " + lineNumber + ".");
    }
    validateTaskSnapshot(event.task, lineNumber);
    const previousTask = latest.get(event.taskId);
    if (event.eventType === "task.created") {
      if (previousTask || event.task.status !== "queued" || event.task.history.length !== 1) {
        throw new Error("Invalid task creation event at audit line " + lineNumber + ".");
      }
    } else {
      if (!previousTask || event.task.history.length !== previousTask.history.length + 1 ||
          event.task.history[event.task.history.length - 1]?.status !== event.task.status) {
        throw new Error("Invalid task transition event at audit line " + lineNumber + ".");
      }
      for (let i = 0; i < previousTask.history.length; i += 1) {
        if (canonicalJson(event.task.history[i]) !== canonicalJson(previousTask.history[i])) {
          throw new Error("Task history rewrite detected at audit line " + lineNumber + ".");
        }
      }
    }
    latest.set(event.taskId, event.task);
    records.push(record);
    previousHash = record.hash;
  }
  return { records, latestTasks: [...latest.values()], sequence: records.length, previousHash };
}

/**
 * Append-only, hash-chained JSONL persistence for the host task lifecycle.
 * Assumes one writer per file. Corrupt or edited logs fail closed during startup.
 * This persists task state and audit events; it does not run tasks or approve them.
 */
export function createDurableTaskLifecycle({ filePath, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) throw new TypeError("filePath is required.");
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const replay = readAndVerifyLog(absolutePath);
  let sequence = replay.sequence;
  let previousHash = replay.previousHash;
  let storageFault = null;
  function assertHealthy() {
    if (storageFault) {
      const error = new Error("Task lifecycle storage is faulted; restart and recover the journal before continuing.");
      error.cause = storageFault;
      throw error;
    }
  }

  const lifecycle = createTaskLifecycle({
    now,
    initialTasks: replay.latestTasks,
    onEvent(event) {
      assertHealthy();
      const body = { sequence: sequence + 1, previousHash, event };
      const record = { ...body, hash: digest(body) };
      try {
        appendFileSync(absolutePath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
      } catch (error) {
        storageFault = error;
        throw error;
      }
      sequence = record.sequence;
      previousHash = record.hash;
    },
  });

  return Object.freeze({
    create(...args) { assertHealthy(); return lifecycle.create(...args); },
    transition(...args) { assertHealthy(); return lifecycle.transition(...args); },
    get(...args) { assertHealthy(); return lifecycle.get(...args); },
    list(...args) { assertHealthy(); return lifecycle.list(...args); },
    isTerminal(...args) { assertHealthy(); return lifecycle.isTerminal(...args); },
    audit() {
      assertHealthy();
      return readAndVerifyLog(absolutePath).records.map(record => JSON.parse(JSON.stringify(record)));
    },
    storagePath: absolutePath,
  });
}
