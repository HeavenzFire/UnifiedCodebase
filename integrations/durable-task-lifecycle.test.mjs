import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDurableTaskLifecycle } from "./durable-task-lifecycle.mjs";

function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "heavenzfire-task-store-"));
  const filePath = join(directory, "audit", "tasks.jsonl");
  try { run({ directory, filePath }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test("persists task creation and transitions across restart", () => withStore(({ filePath }) => {
  const first = createDurableTaskLifecycle({ filePath, now: () => "2026-10-21T00:00:00.000Z" });
  first.create({ taskId: "persist-1", title: "Verify integration", requestedBy: "operator", metadata: { repo: "UnifiedCodebase" } });
  first.transition("persist-1", "blocked", { reason: "approval required", actor: "host" });
  const beforeRestart = first.get("persist-1");

  const restarted = createDurableTaskLifecycle({ filePath });
  assert.deepEqual(restarted.get("persist-1"), beforeRestart);
  assert.equal(restarted.audit().length, 2);
  assert.equal(restarted.audit()[1].event.task.status, "blocked");
  restarted.transition("persist-1", "queued", { reason: "review complete", actor: "operator", evidenceRefs: ["ledger:event-2"] });
  assert.equal(createDurableTaskLifecycle({ filePath }).get("persist-1").status, "queued");
}));

test("audit records have a valid monotonic hash chain", () => withStore(({ filePath }) => {
  const lifecycle = createDurableTaskLifecycle({ filePath });
  lifecycle.create({ taskId: "chain-1", title: "Hash chain", requestedBy: "test" });
  lifecycle.transition("chain-1", "running", { reason: "test transition" });
  const records = lifecycle.audit();
  assert.deepEqual(records.map(record => record.sequence), [1, 2]);
  assert.equal(records[0].previousHash, "0".repeat(64));
  assert.equal(records[1].previousHash, records[0].hash);
  assert.match(records[1].hash, /^[a-f0-9]{64}$/);
}));

test("fails closed if a stored record is edited", () => withStore(({ filePath }) => {
  const lifecycle = createDurableTaskLifecycle({ filePath });
  lifecycle.create({ taskId: "tamper-1", title: "Detect edits", requestedBy: "test" });
  const line = JSON.parse(readFileSync(filePath, "utf8").trim());
  line.event.task.title = "edited after the fact";
  writeFileSync(filePath, JSON.stringify(line) + "\n", "utf8");
  assert.throws(() => createDurableTaskLifecycle({ filePath }), /hash mismatch/);
}));

test("fails closed on malformed JSON and sequence gaps", () => withStore(({ filePath }) => {
  writeFileSync(filePath, "{not-json}\n", "utf8");
  assert.throws(() => createDurableTaskLifecycle({ filePath }), /Malformed JSON/);
  writeFileSync(filePath, JSON.stringify({ sequence: 2, previousHash: "0".repeat(64), event: {}, hash: "a".repeat(64) }) + "\n", "utf8");
  assert.throws(() => createDurableTaskLifecycle({ filePath }), /sequence or chain metadata/);
}));

test("rejects duplicate task creation after restart", () => withStore(({ filePath }) => {
  const first = createDurableTaskLifecycle({ filePath });
  first.create({ taskId: "dup-1", title: "No duplicate", requestedBy: "test" });
  const restarted = createDurableTaskLifecycle({ filePath });
  assert.throws(() => restarted.create({ taskId: "dup-1", title: "No duplicate", requestedBy: "test" }), /already exists/);
}));
