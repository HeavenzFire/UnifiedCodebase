import test from "node:test";
import assert from "node:assert/strict";
import { submitSharedTaskProposalTask } from "./proposal-worker.mjs";

function task(overrides = {}) {
  return {
    taskId: "proposal-1",
    title: "Coordinate approved repository inventory review",
    requestedBy: "local-operator",
    status: "running",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:01.000Z",
    metadata: {
      capability: "task.proposal.submit",
      endpoint: "http://127.0.0.1:18796/api/tasks",
      proposalPurpose: "coordinate a follow-up review",
      prompt: "private prompt that must not be copied",
      input: { privateRecords: ["must-not-leak"] },
      evidence: { sourceContent: "must-not-leak" },
    },
    ...overrides,
  };
}

test("submits a minimal approved proposal and excludes task payloads", async () => {
  let captured;
  const result = await submitSharedTaskProposalTask(task(), {
    submitter: async (safeTask, options) => {
      captured = { safeTask, options };
      return { ok: true, duplicate: false, taskId: safeTask.taskId, status: "proposed", approvalState: "pending" };
    },
  });
  assert.deepEqual(captured.options, { endpoint: "http://127.0.0.1:18796/api/tasks" });
  assert.equal(captured.safeTask.taskId, "proposal-1");
  assert.equal(captured.safeTask.metadata.sourceTaskId, "proposal-1");
  assert.equal(captured.safeTask.status, "running");
  assert.equal(captured.safeTask.metadata.proposalPurpose, "coordinate a follow-up review");
  assert.equal("prompt" in captured.safeTask.metadata, false);
  assert.equal("input" in captured.safeTask.metadata, false);
  assert.equal("evidence" in captured.safeTask.metadata, false);
  assert.equal(result.approvalState, "pending");
  assert.equal(result.status, "proposed");
});

test("proposal worker requires its capability and rejects remote inbox targets", async () => {
  await assert.rejects(submitSharedTaskProposalTask(task({ metadata: { capability: "funding.reconcile.read_only" } }), {
    submitter: async () => ({ ok: true }),
  }), /must request task.proposal.submit/);
  await assert.rejects(submitSharedTaskProposalTask(task({
    metadata: { capability: "task.proposal.submit", endpoint: "http://192.0.2.1:18796/api/tasks" },
  })), /must be http:\/\/127.0.0.1/);
});
