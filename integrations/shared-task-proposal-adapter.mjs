/**
 * Adapter from the UnifiedCodebase in-memory lifecycle to the shared-task.v1 inbox.
 * Proposals are delivered as proposed/pending only; this module never approves or executes tasks.
 */
const SCHEMA = "heavenzfire.shared-task.v1";
const DEFAULT_ENDPOINT = "http://127.0.0.1:18796/api/tasks";

function boundedText(value, field, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(field + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}

function jsonClone(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("metadata must be JSON-serializable.");
    return JSON.parse(encoded);
  } catch (error) {
    throw new TypeError("metadata must be JSON-serializable.", { cause: error });
  }
}

function assertLoopbackEndpoint(endpoint) {
  let url;
  try { url = new URL(endpoint); } catch { throw new TypeError("endpoint must be a valid URL."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/api/tasks") {
    throw new Error("Task inbox endpoint must be http://127.0.0.1:<port>/api/tasks.");
  }
  if (url.port && (!/^\d+$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535)) {
    throw new RangeError("endpoint port must be between 1 and 65535.");
  }
  return url;
}

export function toSharedTaskRecord(task, { source = "unified-codebase", now = () => new Date().toISOString() } = {}) {
  if (!task || typeof task !== "object" || Array.isArray(task)) throw new TypeError("task must be an object.");
  if (typeof now !== "function") throw new TypeError("now must be a function.");
  const taskId = boundedText(task.taskId, "taskId", 128);
  const goal = boundedText(task.title, "title", 12000);
  const requestedBy = boundedText(task.requestedBy, "requestedBy", 128);
  const createdAt = boundedText(task.createdAt, "createdAt", 100);
  const timestamp = boundedText(now(), "now()", 100);
  return {
    schema: SCHEMA,
    taskId,
    source: boundedText(source, "source", 128),
    goal,
    status: "proposed",
    approvalState: "pending",
    evidence: [],
    createdAt,
    updatedAt: timestamp,
    metadata: { ...jsonClone(task.metadata ?? {}), requestedBy, localLifecycleStatus: boundedText(task.status, "status", 32) }
  };
}

export async function submitProposal(task, { endpoint = DEFAULT_ENDPOINT, fetchImpl = globalThis.fetch, source, now } = {}) {
  assertLoopbackEndpoint(endpoint);
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  const taskRecord = toSharedTaskRecord(task, { ...(source === undefined ? {} : { source }), ...(now === undefined ? {} : { now }) });
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "accept": "application/json" },
    body: JSON.stringify({ taskRecord }),
    redirect: "error"
  });
  let body;
  try { body = await response.json(); } catch { throw new Error("Task inbox returned invalid JSON."); }
  if (!response.ok || body?.ok !== true) {
    throw new Error("Task inbox rejected proposal (HTTP " + response.status + "): " + String(body?.error || "unknown_error"));
  }
  if (body.taskId !== taskRecord.taskId || body.status !== "proposed" || typeof body.duplicate !== "boolean") {
    throw new Error("Task inbox response did not match the proposed task contract.");
  }
  return { ok: true, duplicate: body.duplicate, taskId: taskRecord.taskId, status: "proposed", approvalState: "pending" };
}

export const SHARED_TASK_SCHEMA = SCHEMA;
export const DEFAULT_TASK_INBOX_ENDPOINT = DEFAULT_ENDPOINT;
