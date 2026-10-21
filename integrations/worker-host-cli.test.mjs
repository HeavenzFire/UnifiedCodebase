import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("worker host CLI help is available without initializing state or executing workers", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(root, "integrations/worker-host-cli.mjs");
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /submit <task-json \| ->/);
  assert.match(result.stdout, /Every dispatch requires a prior explicit approval/);
  assert.match(result.stdout, /HEAVENZFIRE_STATE_DIR/);
});

test("CLI completes a persisted submit-approve-dispatch-audit cycle", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(root, "integrations/worker-host-cli.mjs");
  const stateDirectory = mkdtempSync(join(tmpdir(), "heavenzfire-cli-e2e-"));
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    input,
    env: { ...process.env, HEAVENZFIRE_STATE_DIR: stateDirectory },
  });
  try {
    const task = {
      taskId: "cli-e2e-1",
      title: "CLI funding fixture",
      requestedBy: "test-operator",
      metadata: {
        capability: "funding.reconcile.read_only",
        input: { appropriations: [], awards: [], disbursements: [] },
      },
    };
    const submitted = run(["submit", "-"], JSON.stringify(task));
    assert.equal(submitted.status, 0, submitted.stderr);
    assert.equal(JSON.parse(submitted.stdout).status, "queued");

    const approved = run(["approve", "cli-e2e-1", "test-operator", "approved synthetic CLI task"]);
    assert.equal(approved.status, 0, approved.stderr);

    const dispatched = run(["dispatch", "cli-e2e-1", "funding.integrity", "test-operator", "execute synthetic read-only reconciliation"]);
    assert.equal(dispatched.status, 0, dispatched.stderr);
    assert.equal(JSON.parse(dispatched.stdout).status, "succeeded");
    assert.equal(JSON.parse(dispatched.stdout).result.mode, "read_only");

    const audit = run(["audit"]);
    assert.equal(audit.status, 0, audit.stderr);
    const summary = JSON.parse(audit.stdout);
    assert.equal(summary.resultRecords, 1);
    assert.ok(summary.taskEvents >= 3);
    assert.ok(summary.approvalEvents >= 2);
    assert.match(summary.resultChainHead, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});
