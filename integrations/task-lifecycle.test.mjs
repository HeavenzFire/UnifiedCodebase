import test from "node:test";
import assert from "node:assert/strict";
import { createTaskLifecycle } from "./task-lifecycle.mjs";

function makeTask(lifecycle, taskId = "task-1") {
  return lifecycle.create({ taskId, title: "Inspect a dataset", requestedBy: "test-suite", metadata: { project: "guardian" } });
}

test("creates queued tasks and returns defensive snapshots", () => {
  const lifecycle = createTaskLifecycle({ now: () => "2026-10-20T00:00:00.000Z" });
  const task = makeTask(lifecycle);
  assert.equal(task.status, "queued");
  assert.equal(task.history.length, 1);
  task.metadata.project = "changed";
  task.history.push({ status: "succeeded" });
  assert.equal(lifecycle.get("task-1").metadata.project, "guardian");
  assert.equal(lifecycle.get("task-1").history.length, 1);
});

test("enforces valid transitions and terminal states", () => {
  const lifecycle = createTaskLifecycle();
  makeTask(lifecycle);
  lifecycle.transition("task-1", "running", { reason: "approved locally" });
  lifecycle.transition("task-1", "succeeded", { reason: "checks passed", evidenceRefs: ["sha256:abc"] });
  assert.equal(lifecycle.isTerminal("succeeded"), true);
  assert.throws(() => lifecycle.transition("task-1", "queued", { reason: "restart" }), /Invalid task transition/);
});

test("permits retry after failure but not after cancellation", () => {
  const lifecycle = createTaskLifecycle();
  makeTask(lifecycle, "failed-task");
  lifecycle.transition("failed-task", "running", { reason: "start" });
  lifecycle.transition("failed-task", "failed", { reason: "provider unavailable" });
  lifecycle.transition("failed-task", "queued", { reason: "retry requested" });
  makeTask(lifecycle, "cancelled-task");
  lifecycle.transition("cancelled-task", "cancelled", { reason: "user cancelled" });
  assert.throws(() => lifecycle.transition("cancelled-task", "queued", { reason: "retry" }), /Invalid task transition/);
});

test("rejects duplicate IDs and missing transition reasons", () => {
  const lifecycle = createTaskLifecycle();
  makeTask(lifecycle);
  assert.throws(() => makeTask(lifecycle), /already exists/);
  assert.throws(() => lifecycle.transition("task-1", "running", { reason: " " }), /reason/);
});

test("records actor and evidence references in history and audit events", () => {
  const events = [];
  const lifecycle = createTaskLifecycle({ onEvent: event => events.push(event) });
  makeTask(lifecycle);
  lifecycle.transition("task-1", "running", { reason: "operator approved", actor: "operator-1", evidenceRefs: ["ledger:record-7"] });
  const task = lifecycle.get("task-1");
  assert.equal(task.history[1].actor, "operator-1");
  assert.deepEqual(task.history[1].evidenceRefs, ["ledger:record-7"]);
  assert.equal(events.length, 2);
  assert.equal(events[1].eventType, "task.transitioned");
});

test("filters tasks by status and rejects unknown statuses", () => {
  const lifecycle = createTaskLifecycle();
  makeTask(lifecycle, "task-a");
  makeTask(lifecycle, "task-b");
  lifecycle.transition("task-b", "blocked", { reason: "waiting for approval" });
  assert.equal(lifecycle.list({ status: "queued" }).length, 1);
  assert.equal(lifecycle.list({ status: "blocked" })[0].taskId, "task-b");
  assert.throws(() => lifecycle.list({ status: "approved" }), /Unknown task status/);
});
