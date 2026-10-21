import { submitProposal } from "../../integrations/shared-task-proposal-adapter.mjs";

/**
 * Submit a minimal proposal to the explicitly loopback-only shared-task inbox.
 * Sensitive prompt/input/evidence payloads are deliberately not copied to the proposal.
 */
export async function submitSharedTaskProposalTask(task, { submitter = submitProposal } = {}) {
  if (!task || typeof task !== "object" || !task.metadata || task.metadata.capability !== "task.proposal.submit") {
    throw new TypeError("Task must request task.proposal.submit.");
  }
  if (task.status !== "running") throw new Error("Only a running, approved task snapshot may submit a shared proposal.");
  if (typeof submitter !== "function") throw new TypeError("submitter must be a function.");
  const purpose = task.metadata.proposalPurpose;
  if (typeof purpose !== "string" || !purpose.trim() || purpose.length > 200) {
    throw new TypeError("proposalPurpose is required and must be a non-empty string up to 200 characters.");
  }
  const safeTask = {
    taskId: task.taskId,
    title: purpose.trim(),
    requestedBy: task.requestedBy,
    status: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    metadata: {
      capability: "task.proposal.submit",
      sourceTaskId: task.taskId,
      proposalPurpose: purpose.trim(),
    },
  };
  const options = task.metadata.endpoint === undefined ? {} : { endpoint: task.metadata.endpoint };
  return submitter(safeTask, options);
}
