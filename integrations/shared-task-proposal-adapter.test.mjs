import test from "node:test";
import assert from "node:assert/strict";
import { submitProposal, toSharedTaskRecord, SHARED_TASK_SCHEMA } from "./shared-task-proposal-adapter.mjs";

const task = {
  taskId: "task-bridge-001",
  title: "Reconcile a public funding dataset",
  requestedBy: "local-user",
  status: "queued",
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:00:00.000Z",
  metadata: { project: "guardian", cycle: 3 },
};

function response(body, status = 201) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test("maps local lifecycle task to a proposed/pending shared contract without approving it", () => {
  const record = toSharedTaskRecord(task);
  assert.equal(SHARED_TASK_SCHEMA, "heavenzfire.shared-task.v1");
  assert.equal(record.taskId, task.taskId);
  assert.equal(record.source, "unified-codebase");
  assert.equal(record.status, "proposed");
  assert.equal(record.approvalState, "pending");
  assert.deepEqual(record.evidence, []);
  assert.equal(record.metadata.requestedBy, "local-user");
  assert.equal(record.metadata.localLifecycleStatus, "queued");
  assert.equal(record.updatedAt, task.updatedAt);
});

test("submits only to the explicit loopback task inbox and reports idempotent duplicates", async () => {
  let captured;
  const result = await submitProposal(task, {
    endpoint: "http://127.0.0.1:18796/api/tasks",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return response({ ok: true, duplicate: true, taskId: task.taskId, status: "proposed" }, 200);
    },
  });
  assert.equal(captured.url, "http://127.0.0.1:18796/api/tasks");
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.redirect, "error");
  assert.equal(captured.body.taskRecord.status, "proposed");
  assert.equal(captured.body.taskRecord.approvalState, "pending");
  assert.deepEqual(result, { ok: true, duplicate: true, taskId: task.taskId, status: "proposed", approvalState: "pending" });
});

test("rejects non-loopback, alternate-path, credentialed, and non-HTTP endpoints before sending", async () => {
  const badEndpoints = [
    "http://localhost:18796/api/tasks",
    "http://example.com/api/tasks",
    "https://127.0.0.1:18796/api/tasks",
    "http://user:pass@127.0.0.1:18796/api/tasks",
    "http://127.0.0.1:18796/other",
  ];
  for (const endpoint of badEndpoints) {
    let called = false;
    await assert.rejects(submitProposal(task, { endpoint, fetchImpl: async () => { called = true; } }));
    assert.equal(called, false, endpoint);
  }
});

test("rejects inbox errors and malformed or mismatched acknowledgements", async () => {
  await assert.rejects(
    submitProposal(task, { fetchImpl: async () => response({ ok: false, error: "task_id_conflict" }, 409) }),
    /HTTP 409/,
  );
  await assert.rejects(
    submitProposal(task, { fetchImpl: async () => response({ ok: true, duplicate: false, taskId: "different", status: "proposed" }) }),
    /did not match/,
  );
  await assert.rejects(
    submitProposal(task, { fetchImpl: async () => ({ ok: true, status: 201, json: async () => { throw new Error("bad json"); } }) }),
    /invalid JSON/,
  );
});

test("rejects malformed lifecycle input and non-JSON metadata", () => {
  assert.throws(() => toSharedTaskRecord({ ...task, title: " " }), /title/);
  assert.throws(() => toSharedTaskRecord({ ...task, metadata: { circular: null } , status: undefined }), /status/);
  const circular = {};
  circular.self = circular;
  assert.throws(() => toSharedTaskRecord({ ...task, metadata: circular }), /JSON-serializable/);
});
