import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGovernedTaskLifecycle } from "./governed-task-lifecycle.mjs";
import { createWorkerDispatcher } from "./worker-dispatcher.mjs";
import { createWorkerResultJournal } from "./worker-result-journal.mjs";

async function withLifecycle(run) {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-dispatch-"));
  const lifecycle = createGovernedTaskLifecycle({
    taskFilePath: join(directory, "tasks.jsonl"),
    approvalFilePath: join(directory, "approvals.jsonl"),
  });
  try { return await run({ directory, lifecycle }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

function makeApproved(lifecycle, taskId, metadata = {}) {
  lifecycle.create({ taskId, title: "Run bounded worker", requestedBy: "test", metadata });
  lifecycle.approve(taskId, { actor: "operator", reason: "test approval" });
}

test("dispatch requires explicit approval and a registered worker", async () => withLifecycle(async ({ lifecycle }) => {
  lifecycle.create({ taskId: "no-approval", title: "Approval gate", requestedBy: "test" });
  const dispatcher = createWorkerDispatcher({ lifecycle, workers: [{ id: "test", run: async () => "ok" }] });
  await assert.rejects(dispatcher.dispatch("no-approval", "test"), /Explicit approval required/);
  await assert.rejects(dispatcher.dispatch("no-approval", "missing"), /Unknown worker/);
  assert.equal(lifecycle.get("no-approval").status, "queued");
}));

test("dispatch consumes approval, runs only the registered handler, and records a result digest", async () => withLifecycle(async ({ lifecycle }) => {
  makeApproved(lifecycle, "success-1", { capability: "summarize" });
  let calls = 0;
  const dispatcher = createWorkerDispatcher({
    lifecycle,
    workers: [{ id: "summarizer", capabilities: ["summarize"], run: async task => { calls += 1; assert.equal(task.status, "running"); return { taskId: task.taskId, summary: "verified" }; } }],
  });
  const result = await dispatcher.dispatch("success-1", "summarizer", { actor: "operator", reason: "approved test" });
  assert.equal(calls, 1);
  assert.equal(result.status, "succeeded");
  assert.match(result.resultSha256, /^[a-f0-9]{64}$/);
  assert.equal(resultJournal.list().length, 1);
  assert.equal(resultJournal.list()[0].entry.resultSha256, result.resultSha256);
  assert.match(result.resultJournal.hash, /^[a-f0-9]{64}$/);
  assert.equal(lifecycle.get("success-1").status, "succeeded");
  assert.equal(lifecycle.isApproved("success-1"), false);
  const taskAudit = lifecycle.audit();
  assert.ok(taskAudit.some(record => record.event?.task?.taskId === "success-1" && record.event.status === "succeeded"));
  const approvalAudit = lifecycle.approvalAudit();
  assert.ok(approvalAudit.some(record => record.event?.taskId === "success-1" && record.event.eventType === "task.approval_consumed"));
  assert.ok(taskAudit.some(record => record.event?.taskId === "success-1" && record.event?.evidenceRefs?.some(ref => ref === "worker-result:sha256:" + result.resultSha256)));
  assert.equal(dispatcher.status().activeTasks, 0);
  const recovered = createGovernedTaskLifecycle({
    taskFilePath: join(directory, "tasks.jsonl"),
    approvalFilePath: join(directory, "approvals.jsonl"),
  });
  assert.equal(recovered.get("success-1").status, "succeeded");
  assert.equal(recovered.isApproved("success-1"), false);
  assert.ok(recovered.audit().length >= 3);
  assert.ok(recovered.approvalAudit().some(record => record.event?.eventType === "task.approval_consumed"));
  const recoveredResults = createWorkerResultJournal({ filePath: join(directory, "results.jsonl") });
  assert.equal(recoveredResults.list().length, 1);
  assert.deepEqual(recoveredResults.list()[0].entry.result, { taskId: "success-1", summary: "verified" });
  assert.ok(recovered.get("success-1").history.at(-1).evidenceRefs.some(ref => ref === "worker-result-journal:sha256:" + result.resultJournal.hash));
}));

test("capability mismatch fails closed before consuming approval", async () => withLifecycle(async ({ lifecycle }) => {
  makeApproved(lifecycle, "capability-1", { capability: "write-files" });
  const dispatcher = createWorkerDispatcher({ lifecycle, workers: [{ id: "reader", capabilities: ["read-only"], run: async () => "never" }] });
  await assert.rejects(dispatcher.dispatch("capability-1", "reader"), /lacks required capability/);
  assert.equal(lifecycle.get("capability-1").status, "queued");
  assert.equal(lifecycle.isApproved("capability-1"), true);
}));

test("worker failure becomes a durable failed task and frees capacity", async () => withLifecycle(async ({ lifecycle }) => {
  makeApproved(lifecycle, "failure-1");
  const dispatcher = createWorkerDispatcher({ lifecycle, workers: [{ id: "throws", run: async () => { throw new Error("fixture failure"); } }] });
  await assert.rejects(dispatcher.dispatch("failure-1", "throws"), /fixture failure/);
  assert.equal(lifecycle.get("failure-1").status, "failed");
  assert.equal(dispatcher.status().activeTasks, 0);
}));

test("enforces capacity and prevents duplicate concurrent dispatch", async () => withLifecycle(async ({ lifecycle }) => {
  makeApproved(lifecycle, "slow-1");
  makeApproved(lifecycle, "slow-2");
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const dispatcher = createWorkerDispatcher({
    lifecycle, maxConcurrent: 1,
    workers: [{ id: "slow", run: async () => { await waiting; return "done"; } }],
  });
  const first = dispatcher.dispatch("slow-1", "slow");
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(dispatcher.dispatch("slow-2", "slow"), /capacity reached/);
  await assert.rejects(dispatcher.dispatch("slow-1", "slow"), /capacity reached/);
  release();
  await first;
  assert.equal(dispatcher.status().activeTasks, 0);
}));

test("validates worker registry and concurrency bounds", () => withLifecycle(({ lifecycle }) => {
  assert.throws(() => createWorkerDispatcher({ lifecycle, maxConcurrent: 0 }), /maxConcurrent/);
  assert.throws(() => createWorkerDispatcher({ lifecycle, workers: [{ id: "bad" }] }), /worker.run/);
  const dispatcher = createWorkerDispatcher({ lifecycle, workers: [{ id: "read", capabilities: ["read"] }] .map(w => ({ ...w, run: async () => null })) });
  assert.deepEqual(dispatcher.listWorkers(), [{ id: "read", capabilities: ["read"] }]);
}));
