import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toSharedTaskRecord } from "./shared-task-proposal-adapter.mjs";
import { createSharedTaskInbox, createSharedTaskInboxServer } from "./shared-task-inbox.mjs";

function fixture(overrides = {}) {
  return toSharedTaskRecord({
    taskId: "inbox-task-1",
    title: "Reconcile public records",
    requestedBy: "local-operator",
    status: "running",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:01.000Z",
    metadata: { capability: "task.proposal.submit" },
    ...overrides,
  });
}

test("inbox persists proposals, treats exact retries idempotently, and rejects conflicting IDs", () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-inbox-"));
  const filePath = join(directory, "inbox.jsonl");
  try {
    const inbox = createSharedTaskInbox({ filePath, now: () => "2026-10-21T00:00:02.000Z" });
    const record = fixture();
    assert.deepEqual(inbox.accept(record), {
      ok: true, duplicate: false, taskId: record.taskId, status: "proposed", approvalState: "pending",
    });
    assert.equal(inbox.accept(record).duplicate, true);
    assert.throws(() => inbox.accept({ ...record, goal: "Conflicting goal" }), error => error.code === "TASK_ID_CONFLICT");
    const recovered = createSharedTaskInbox({ filePath });
    assert.equal(recovered.list().length, 1);
    assert.equal(recovered.list()[0].status, "proposed");
    assert.equal(recovered.audit().length, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("inbox replay fails closed when the hash-chained journal is modified", () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-inbox-tamper-"));
  const filePath = join(directory, "inbox.jsonl");
  try {
    const inbox = createSharedTaskInbox({ filePath });
    inbox.accept(fixture());
    const original = readFileSync(filePath, "utf8");
    writeFileSync(filePath, original.replace("Reconcile public records", "Changed public records"), "utf8");
    assert.throws(() => createSharedTaskInbox({ filePath }), /hash mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP inbox binds only to loopback and serves health, list, and proposal-only POST", async () => {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-inbox-http-"));
  const inbox = createSharedTaskInbox({ filePath: join(directory, "inbox.jsonl") });
  assert.throws(() => createSharedTaskInboxServer({ inbox, host: "0.0.0.0" }), /only to 127.0.0.1/);
  const server = createSharedTaskInboxServer({ inbox, maxBodyBytes: 1024 });
  assert.throws(() => server.listen(0, "0.0.0.0"), /may bind only to 127.0.0.1/);
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    const base = "http://127.0.0.1:" + port;
    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).mode, "proposal-only");

    const posted = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskRecord: fixture() }),
    });
    assert.equal(posted.status, 201);
    assert.equal((await posted.json()).approvalState, "pending");

    const listed = await fetch(base + "/api/tasks");
    const listedBody = await listed.json();
    assert.equal(listedBody.tasks.length, 1);
    assert.equal(listedBody.tasks[0].status, "proposed");

    const duplicate = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskRecord: fixture() }),
    });
    assert.equal((await duplicate.json()).duplicate, true);

    const conflict = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskRecord: { ...fixture(), goal: "Conflicting goal" } }),
    });
    assert.equal(conflict.status, 409);

    const wrongType = await fetch(base + "/api/tasks", { method: "POST", body: "{}" });
    assert.equal(wrongType.status, 415);
    const notFound = await fetch(base + "/api/execute", { method: "POST", body: "{}" });
    assert.equal(notFound.status, 404);
    const tooLarge = await fetch(base + "/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "x".repeat(1200),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});
