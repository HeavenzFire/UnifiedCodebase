import { resolve } from "node:path";
import { createGovernedTaskLifecycle } from "./governed-task-lifecycle.mjs";
import { createWorkerDispatcher } from "./worker-dispatcher.mjs";
import { createWorkerResultJournal } from "./worker-result-journal.mjs";
import { createRegistryBackedWorkers } from "./registry-worker-adapter.mjs";

/**
 * Wires task intake, durable approval, registry-backed workers, and durable results.
 * This is an in-process host API, not an HTTP server, identity provider, or OS sandbox.
 */
export function createWorkerHost({
  taskFilePath,
  approvalFilePath,
  resultFilePath,
  registry,
  handlers = [],
  maxConcurrent = 2,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof taskFilePath !== "string" || !taskFilePath.trim()) throw new TypeError("taskFilePath is required.");
  if (typeof approvalFilePath !== "string" || !approvalFilePath.trim()) throw new TypeError("approvalFilePath is required.");
  if (typeof resultFilePath !== "string" || !resultFilePath.trim()) throw new TypeError("resultFilePath is required.");
  const taskPath = resolve(taskFilePath.trim());
  const approvalPath = resolve(approvalFilePath.trim());
  const resultPath = resolve(resultFilePath.trim());
  if (new Set([taskPath, approvalPath, resultPath]).size !== 3) {
    throw new TypeError("Task, approval, and result journals must use separate paths.");
  }
  if (typeof now !== "function") throw new TypeError("now must be a function.");

  const lifecycle = createGovernedTaskLifecycle({ taskFilePath: taskPath, approvalFilePath: approvalPath, now });
  const resultJournal = createWorkerResultJournal({ filePath: resultPath, now });
  const workers = createRegistryBackedWorkers({ registry, handlers });
  const dispatcher = createWorkerDispatcher({ lifecycle, workers, maxConcurrent, resultJournal, now });

  return Object.freeze({
    submit(task) {
      if (!task || !task.metadata || typeof task.metadata.capability !== "string" || !task.metadata.capability.trim()) {
        throw new TypeError("Task metadata.capability is required.");
      }
      return lifecycle.create(task);
    },
    approve(taskId, approval) {
      return lifecycle.approve(taskId, approval);
    },
    revokeApproval(taskId, approval) {
      return lifecycle.revokeApproval(taskId, approval);
    },
    dispatch(taskId, extensionId, options) {
      return dispatcher.dispatch(taskId, extensionId, options);
    },
    getTask(taskId) {
      return lifecycle.get(taskId);
    },
    listTasks(options) {
      return lifecycle.list(options);
    },
    listWorkers() {
      return dispatcher.listWorkers();
    },
    workerStatus() {
      return dispatcher.status();
    },
    audit() {
      return Object.freeze({
        tasks: lifecycle.audit(),
        approvals: lifecycle.approvalAudit(),
        results: resultJournal.audit(),
      });
    },
    storagePaths: Object.freeze({
      tasks: lifecycle.storagePath,
      approvals: approvalPath,
      results: resultJournal.storagePath,
    }),
  });
}
