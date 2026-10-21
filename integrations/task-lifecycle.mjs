import { randomUUID } from "node:crypto";

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const TRANSITIONS = Object.freeze({
  queued: new Set(["running", "blocked", "cancelled"]),
  running: new Set(["blocked", "succeeded", "failed", "cancelled"]),
  blocked: new Set(["queued", "running", "cancelled"]),
  succeeded: new Set(),
  failed: new Set(["queued"]),
  cancelled: new Set(),
});
const TASK_STATUSES = new Set(Object.keys(TRANSITIONS));

function safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateText(value, field, max = 4000) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(field + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}

/**
 * In-memory task lifecycle contract for the Unified Field host.
 * Durable task storage and worker execution are intentionally separate.
 * Optional onEvent is a host-owned audit hook; event payloads contain task metadata,
 * not secrets or prompt contents unless a caller explicitly puts them in metadata.
 */
export function createTaskLifecycle({ now = () => new Date().toISOString(), onEvent = null, initialTasks = [] } = {}) {
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  if (onEvent !== null && typeof onEvent !== "function") throw new TypeError("onEvent must be a function when provided.");
  if (!Array.isArray(initialTasks)) throw new TypeError("initialTasks must be an array.");
  const tasks = new Map();
  for (const item of initialTasks) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new TypeError("Each initial task must be an object.");
    const id = validateText(item.taskId, "initial taskId", 200);
    if (tasks.has(id)) throw new Error("Duplicate initial task: " + id);
    if (!TASK_STATUSES.has(item.status)) throw new TypeError("Unknown initial task status: " + item.status);
    validateText(item.title, "initial title", 500);
    validateText(item.requestedBy, "initial requestedBy", 200);
    if (!Array.isArray(item.history) || item.history.length < 1) throw new TypeError("Initial task history must be a non-empty array.");
    const copy = safeClone(item);
    if (copy.history[0]?.status !== "queued") throw new TypeError("Initial task history must begin in queued state.");
    if (copy.history[copy.history.length - 1]?.status !== copy.status) {
      throw new TypeError("Initial task history must end at the current status.");
    }
    tasks.set(id, copy);
  }

  function emit(task, eventType, extra = {}) {
    if (!onEvent) return;
    const event = Object.freeze({
      eventId: randomUUID(),
      eventType,
      taskId: task.taskId,
      status: task.status,
      at: now(),
      metadata: safeClone(task.metadata),
      task: safeClone(task),
      ...extra,
    });
    // The caller controls the event sink; a sink failure is surfaced to the caller.
    onEvent(event);
  }

  function snapshot(task) {
    return Object.freeze(safeClone(task));
  }

  return Object.freeze({
    create({ taskId = randomUUID(), title, requestedBy = "local-user", metadata = {} } = {}) {
      const id = validateText(taskId, "taskId", 200);
      if (tasks.has(id)) throw new Error("Task already exists: " + id);
      const task = {
        taskId: id,
        title: validateText(title, "title", 500),
        requestedBy: validateText(requestedBy, "requestedBy", 200),
        status: "queued",
        createdAt: now(),
        updatedAt: now(),
        metadata: safeClone(metadata),
        history: [{ status: "queued", at: now(), reason: "created" }],
      };
      tasks.set(id, task);
      emit(task, "task.created");
      return snapshot(task);
    },

    transition(taskId, nextStatus, { reason, actor = "local-host", evidenceRefs = [] } = {}) {
      const id = validateText(taskId, "taskId", 200);
      const task = tasks.get(id);
      if (!task) throw new Error("Unknown task: " + id);
      if (!TASK_STATUSES.has(nextStatus)) throw new TypeError("Unknown task status: " + nextStatus);
      if (!TRANSITIONS[task.status].has(nextStatus)) {
        throw new Error("Invalid task transition: " + task.status + " -> " + nextStatus);
      }
      const safeReason = validateText(reason, "reason", 1000);
      const safeActor = validateText(actor, "actor", 200);
      if (!Array.isArray(evidenceRefs) || evidenceRefs.some(ref => typeof ref !== "string" || !ref.trim() || ref.length > 500)) {
        throw new TypeError("evidenceRefs must be an array of non-empty strings no longer than 500 characters.");
      }
      const at = now();
      task.status = nextStatus;
      task.updatedAt = at;
      task.history.push({ status: nextStatus, at, reason: safeReason, actor: safeActor, evidenceRefs: [...evidenceRefs] });
      emit(task, "task.transitioned", { actor: safeActor, reason: safeReason, evidenceRefs: [...evidenceRefs] });
      return snapshot(task);
    },

    get(taskId) {
      const task = tasks.get(String(taskId));
      return task ? snapshot(task) : null;
    },

    list({ status } = {}) {
      if (status !== undefined && !TASK_STATUSES.has(status)) throw new TypeError("Unknown task status: " + status);
      return [...tasks.values()]
        .filter(task => status === undefined || task.status === status)
        .map(snapshot)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.taskId.localeCompare(b.taskId));
    },

    isTerminal(status) {
      if (!TASK_STATUSES.has(status)) throw new TypeError("Unknown task status: " + status);
      return TERMINAL.has(status);
    },
  });
}
