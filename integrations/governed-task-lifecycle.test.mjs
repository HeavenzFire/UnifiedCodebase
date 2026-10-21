import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGovernedTaskLifecycle } from "./governed-task-lifecycle.mjs";

function withStores(run) {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-governed-tasks-"));
  const options = { taskFilePath: join(directory, "tasks.jsonl"), approvalFilePath: join(directory, "approvals.jsonl") };
  try { run(options); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("blocks running until an explicit approval is recorded", () => withStores(paths => {
  const host = createGovernedTaskLifecycle(paths);
  host.create({ taskId: "approval-1", title: "Run only after review", requestedBy: "test" });
  assert.throws(() => host.transition("approval-1", "running", { reason: "try run" }), /Explicit human approval required/);
  host.approve("approval-1", { actor: "reviewer-1", reason: "Reviewed scope and evidence" });
  assert.equal(host.isApproved("approval-1"), true);
  host.transition("approval-1", "running", { actor: "reviewer-1", reason: "Approved execution" });
  assert.equal(host.get("approval-1").status, "running");
  assert.equal(host.isApproved("approval-1"), false);
  assert.equal(host.approvalAudit().map(record => record.event.eventType).join(","), "task.approved,task.approval_consumed");
}));

test("approval persists across restart and can be revoked before execution", () => withStores(paths => {
  let host = createGovernedTaskLifecycle(paths);
  host.create({ taskId: "approval-2", title: "Await review", requestedBy: "test" });
  host.approve("approval-2", { actor: "reviewer-1", reason: "Initial approval" });
  host = createGovernedTaskLifecycle(paths);
  assert.equal(host.isApproved("approval-2"), true);
  host.revokeApproval("approval-2", { actor: "reviewer-1", reason: "New evidence requires review" });
  assert.equal(host.isApproved("approval-2"), false);
  assert.throws(() => host.transition("approval-2", "running", { reason: "not approved" }), /Explicit human approval required/);
}));

test("approval journal tampering fails closed at startup", () => withStores(paths => {
  const host = createGovernedTaskLifecycle(paths);
  host.create({ taskId: "approval-3", title: "Tamper test", requestedBy: "test" });
  host.approve("approval-3", { actor: "reviewer", reason: "Review complete" });
  const record = JSON.parse(readFileSync(paths.approvalFilePath, "utf8").trim());
  record.event.reason = "edited";
  writeFileSync(paths.approvalFilePath, JSON.stringify(record) + "\n", "utf8");
  assert.throws(() => createGovernedTaskLifecycle(paths), /Approval journal hash mismatch/);
}));

test("approval cannot be granted to unknown or running tasks", () => withStores(paths => {
  const host = createGovernedTaskLifecycle(paths);
  assert.throws(() => host.approve("missing", { actor: "reviewer", reason: "review" }), /Unknown task/);
  host.create({ taskId: "approval-4", title: "Already running", requestedBy: "test" });
  host.approve("approval-4", { actor: "reviewer", reason: "review" });
  host.transition("approval-4", "running", { reason: "execute" });
  assert.throws(() => host.approve("approval-4", { actor: "reviewer", reason: "again" }), /Only queued or blocked tasks/);
}));


test("fails closed after an approval journal write error", () => withStores(paths => {
  const host = createGovernedTaskLifecycle(paths);
  host.create({ taskId: "approval-write-fail", title: "Approval journal fault", requestedBy: "test" });
  mkdirSync(paths.approvalFilePath);
  assert.throws(() => host.approve("approval-write-fail", { actor: "reviewer", reason: "approve" }));
  assert.throws(() => host.isApproved("approval-write-fail"), /Approval journal is faulted/);
  assert.throws(
    () => host.transition("approval-write-fail", "running", { actor: "reviewer", reason: "try running" }),
    /Approval journal is faulted/
  );
}));
