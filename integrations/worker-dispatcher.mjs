import { createHash } from "node:crypto";

function requiredText(value, field, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new TypeError(field + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}

function canonicalJson(value) {\n  if (value === null || typeof value !== "object") return JSON.stringify(value);\n  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";\n  return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonicalJson(value[key])).join(",") + "}";\n}\n\nfunction safeClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Bounded, explicit in-process worker dispatch for the governed task lifecycle.
 * This module never discovers or executes arbitrary commands. Only registered
 * handlers can run, and the governed lifecycle must consume an approval before
 * a task enters running. Callers remain responsible for authenticating approvers.
 */
export function createWorkerDispatcher({ lifecycle, workers = [], maxConcurrent = 2, resultJournal = null, now = () => new Date().toISOString() } = {}) {
  if (!lifecycle || typeof lifecycle.get !== "function" ||
      typeof lifecycle.transition !== "function" || typeof lifecycle.isApproved !== "function") {
    throw new TypeError("A governed task lifecycle is required.");
  }
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 32) {
    throw new RangeError("maxConcurrent must be an integer from 1 through 32.");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function.");\n  if (resultJournal !== null && typeof resultJournal.append !== "function") {\n    throw new TypeError("resultJournal.append must be a function when a result journal is provided.");\n  }

  const registry = new Map();
  const active = new Set();
  for (const worker of workers) registerWorker(worker);

  function registerWorker(worker) {
    if (!worker || typeof worker !== "object") throw new TypeError("Worker must be an object.");
    const id = requiredText(worker.id, "worker.id");
    if (registry.has(id)) throw new Error("Duplicate worker ID: " + id);
    if (typeof worker.run !== "function") throw new TypeError("worker.run must be a function.");
    const capabilities = worker.capabilities ?? [];
    if (!Array.isArray(capabilities) || capabilities.some(x => typeof x !== "string" || !x.trim())) {
      throw new TypeError("worker.capabilities must be an array of non-empty strings.");
    }
    registry.set(id, Object.freeze({ id, run: worker.run, capabilities: new Set(capabilities) }));
    return Object.freeze({ id, capabilities: [...capabilities] });
  }

  async function dispatch(taskId, workerId, { actor = "local-host", reason = "approved task dispatch" } = {}) {
    const id = requiredText(taskId, "taskId");
    const selectedWorkerId = requiredText(workerId, "workerId");
    if (active.size >= maxConcurrent) throw new Error("Worker capacity reached.");
    if (active.has(id)) throw new Error("Task is already being dispatched: " + id);
    const worker = registry.get(selectedWorkerId);
    if (!worker) throw new Error("Unknown worker: " + selectedWorkerId);

    const task = lifecycle.get(id);
    if (!task) throw new Error("Unknown task: " + id);
    if (!["queued", "blocked"].includes(task.status)) throw new Error("Task is not dispatchable from status: " + task.status);
    if (!lifecycle.isApproved(id)) throw new Error("Explicit approval required before worker dispatch.");
    const requestedCapability = task.metadata?.capability;
    if (requestedCapability && !worker.capabilities.has(requestedCapability)) {
      throw new Error("Worker lacks required capability: " + requestedCapability);
    }

    active.add(id);
    let running = false;
    try {
      // The governed lifecycle consumes approval as part of this transition.
      lifecycle.transition(id, "running", { actor, reason, evidenceRefs: ["worker:" + selectedWorkerId] });
      running = true;
      const startedAt = now();
      // Pass the post-transition snapshot so the worker sees the authoritative running state.
      const runningTask = lifecycle.get(id);
      if (!runningTask || runningTask.status !== "running") {
        throw new Error("Lifecycle did not persist the running state; worker execution was not started.");
      }
      const output = await worker.run(Object.freeze(safeClone(runningTask)));
      const finishedAt = now();
      const resultDigest = createHash("sha256").update(JSON.stringify(output ?? null), "utf8").digest("hex");
      lifecycle.transition(id, "succeeded", {
        actor: "worker:" + selectedWorkerId,
        reason: "Worker completed successfully.",
        evidenceRefs: ["worker-result:sha256:" + resultDigest],
      });
      return Object.freeze({
        taskId: id, workerId: selectedWorkerId, status: "succeeded",
        startedAt, finishedAt, result: normalizedOutput, resultSha256: resultDigest,\n        resultJournal: journalReceipt,
      });
    } catch (error) {
      if (running) {
        try {
          lifecycle.transition(id, "failed", {
            actor: "worker:" + selectedWorkerId,
            reason: String(error?.message ?? error).slice(0, 1000),
            evidenceRefs: ["worker:" + selectedWorkerId],
          });
        } catch (transitionError) {
          const wrapped = new Error("Worker failed and task failure could not be persisted; inspect the durable lifecycle journal.");
          wrapped.cause = transitionError;
          throw wrapped;
        }
      }
      throw error;
    } finally {
      active.delete(id);
    }
  }

  return Object.freeze({
    register: registerWorker,
    listWorkers() {
      return [...registry.values()].map(worker => Object.freeze({ id: worker.id, capabilities: [...worker.capabilities] }));
    },
    status() {
      return Object.freeze({ activeTasks: active.size, maxConcurrent, workerCount: registry.size });
    },
    dispatch,
  });
}
