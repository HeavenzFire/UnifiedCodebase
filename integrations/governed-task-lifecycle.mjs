import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createDurableTaskLifecycle } from "./durable-task-lifecycle.mjs";

const ZERO_HASH = "0".repeat(64);
function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";
}
function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
function requiredText(value, field, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(field + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}
function loadApprovalLog(filePath) {
  if (!existsSync(filePath)) return { sequence: 0, previousHash: ZERO_HASH, states: new Map(), records: [] };
  const content = readFileSync(filePath, "utf8");
  if (!content) return { sequence: 0, previousHash: ZERO_HASH, states: new Map(), records: [] };
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const states = new Map();
  const records = [];
  let previousHash = ZERO_HASH;
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let record;
    try { record = JSON.parse(lines[index]); }
    catch { throw new Error("Malformed approval journal JSON at line " + lineNumber + "."); }
    if (!record || record.sequence !== lineNumber || record.previousHash !== previousHash ||
        typeof record.hash !== "string" || !/^[a-f0-9]{64}$/.test(record.hash) || !record.event) {
      throw new Error("Invalid approval journal chain metadata at line " + lineNumber + ".");
    }
    if (record.hash !== digest({ sequence: record.sequence, previousHash: record.previousHash, event: record.event })) {
      throw new Error("Approval journal hash mismatch at line " + lineNumber + ".");
    }
    const event = record.event;
    if (!["task.approved", "task.approval_revoked", "task.approval_consumed"].includes(event.eventType) ||
        typeof event.taskId !== "string" || !event.taskId || typeof event.actor !== "string" ||
        typeof event.reason !== "string" || typeof event.at !== "string") {
      throw new Error("Invalid approval event at line " + lineNumber + ".");
    }
    const current = states.get(event.taskId) === true;
    if (event.eventType === "task.approved") {
      if (current) throw new Error("Duplicate approval event at line " + lineNumber + ".");
      states.set(event.taskId, true);
    } else {
      if (!current) throw new Error("Approval revocation/consumption without active approval at line " + lineNumber + ".");
      states.set(event.taskId, false);
    }
    records.push(record);
    previousHash = record.hash;
  }
  return { sequence: records.length, previousHash, states, records };
}

/**
 * Adds a durable human-approval gate around the task lifecycle.
 * Every transition to running consumes a prior explicit approval.
 * This is an API-level guard, not a sandbox or a worker; callers must not bypass this wrapper.
 */
export function createGovernedTaskLifecycle({ taskFilePath, approvalFilePath, now = () => new Date().toISOString() } = {}) {
  if (typeof taskFilePath !== "string" || !taskFilePath.trim()) throw new TypeError("taskFilePath is required.");
  if (typeof approvalFilePath !== "string" || !approvalFilePath.trim()) throw new TypeError("approvalFilePath is required.");
  const taskPath = resolve(taskFilePath);
  const approvalPath = resolve(approvalFilePath);
  if (taskPath === approvalPath) throw new TypeError("Task and approval journals must be separate files.");
  mkdirSync(dirname(approvalPath), { recursive: true });
  let approvalLog = loadApprovalLog(approvalPath);
  let approvalFault = null;
  function assertApprovalHealthy() {
    if (approvalFault) {
      const error = new Error("Approval journal is faulted; restart and recover the journal before continuing.");
      error.cause = approvalFault;
      throw error;
    }
  }
  const lifecycle = createDurableTaskLifecycle({ filePath: taskPath, now });

  function appendApprovalEvent(eventType, taskId, actor, reason) {
    assertApprovalHealthy();
    const event = { eventId: randomUUID(), eventType, taskId, actor, reason, at: now() };
    const body = { sequence: approvalLog.sequence + 1, previousHash: approvalLog.previousHash, event };
    const record = { ...body, hash: digest(body) };
    try {
      appendFileSync(approvalPath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
    } catch (error) {
      approvalFault = error;
      throw error;
    }
    approvalLog.sequence = record.sequence;
    approvalLog.previousHash = record.hash;
    approvalLog.records.push(record);
    approvalLog.states.set(taskId, eventType === "task.approved");
    return Object.freeze({ ...event });
  }
  function isApproved(taskId) {
    assertApprovalHealthy();
    return approvalLog.states.get(String(taskId)) === true;
  }

  return Object.freeze({
    create(...args) { assertApprovalHealthy(); return lifecycle.create(...args); },
    get(...args) { assertApprovalHealthy(); return lifecycle.get(...args); },
    list(...args) { assertApprovalHealthy(); return lifecycle.list(...args); },
    isTerminal(...args) { assertApprovalHealthy(); return lifecycle.isTerminal(...args); },
    audit() { assertApprovalHealthy(); return lifecycle.audit(); },
    storagePath: lifecycle.storagePath,

    approve(taskId, { actor, reason } = {}) {
      const id = requiredText(taskId, "taskId", 200);
      const task = lifecycle.get(id);
      if (!task) throw new Error("Unknown task: " + id);
      if (!["queued", "blocked"].includes(task.status)) throw new Error("Only queued or blocked tasks may be approved.");
      if (isApproved(id)) throw new Error("Task already has an active approval: " + id);
      return appendApprovalEvent("task.approved", id, requiredText(actor, "actor", 200), requiredText(reason, "reason", 1000));
    },

    revokeApproval(taskId, { actor, reason } = {}) {
      const id = requiredText(taskId, "taskId", 200);
      if (!lifecycle.get(id)) throw new Error("Unknown task: " + id);
      if (!isApproved(id)) throw new Error("Task has no active approval: " + id);
      return appendApprovalEvent("task.approval_revoked", id, requiredText(actor, "actor", 200), requiredText(reason, "reason", 1000));
    },

    isApproved,

    transition(taskId, nextStatus, options = {}) {
      assertApprovalHealthy();
      if (nextStatus === "running") {
        const id = requiredText(taskId, "taskId", 200);
        const task = lifecycle.get(id);
        if (!task) throw new Error("Unknown task: " + id);
        if (!isApproved(id)) throw new Error("Explicit human approval required before a task can enter running state.");
        requiredText(options.reason, "reason", 1000);
        requiredText(options.actor ?? "local-host", "actor", 200);
        if (options.evidenceRefs !== undefined && (!Array.isArray(options.evidenceRefs) ||
            options.evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 500))) {
          throw new TypeError("evidenceRefs must be an array of non-empty strings no longer than 500 characters.");
        }
        // Consume first: if task persistence fails, fail closed and require a fresh approval.
        appendApprovalEvent("task.approval_consumed", id, requiredText(options.actor ?? "local-host", "actor", 200), "approval consumed for running transition");
      }
      return lifecycle.transition(taskId, nextStatus, options);
    },

    approvalAudit() {
      assertApprovalHealthy();
      return loadApprovalLog(approvalPath).records.map(record => JSON.parse(JSON.stringify(record)));
    },
  });
}
