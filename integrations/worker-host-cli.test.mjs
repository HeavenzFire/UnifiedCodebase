import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

    const revocationTask = {
      taskId: "cli-revoke-1",
      title: "Task with revoked approval",
      requestedBy: "test-operator",
      metadata: {
        capability: "funding.reconcile.read_only",
        input: { appropriations: [], awards: [], disbursements: [] },
      },
    };
    const submittedForRevocation = run(["submit", "-"], JSON.stringify(revocationTask));
    assert.equal(submittedForRevocation.status, 0, submittedForRevocation.stderr);
    const secondApproval = run(["approve", "cli-revoke-1", "test-operator", "temporary approval"]);
    assert.equal(secondApproval.status, 0, secondApproval.stderr);
    const revoked = run(["revoke", "cli-revoke-1", "test-operator", "approval withdrawn"]);
    assert.equal(revoked.status, 0, revoked.stderr);
    const blockedDispatch = run(["dispatch", "cli-revoke-1", "funding.integrity", "test-operator", "must not run"]);
    assert.notEqual(blockedDispatch.status, 0);
    assert.match(blockedDispatch.stderr, /Explicit approval required/);

    const audit = run(["audit"]);
    assert.equal(audit.status, 0, audit.stderr);
    const summary = JSON.parse(audit.stdout);
    assert.equal(summary.resultRecords, 1);
    assert.ok(summary.taskEvents >= 3);
    assert.ok(summary.approvalEvents >= 4);
    assert.match(summary.resultChainHead, /^[a-f0-9]{64}$/);
  } finally {
    rmSync(stateDirectory, { recursive: true, force: true });
  }
});

test("PowerShell 5.1 entry points expose and forward governed task actions", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entrypoint = readFileSync(resolve(root, "Enter-UnifiedField.ps1"), "utf8");
  const wrapper = readFileSync(resolve(root, "Invoke-UnifiedFieldTask.ps1"), "utf8");
  assert.match(entrypoint, /TaskAction/);
  assert.match(entrypoint, /Invoke-UnifiedFieldTask\.ps1/);
  assert.match(entrypoint, /& \$TaskHost @TaskHostParameters/);
  assert.match(wrapper, /ValidateSet\('Workers','Submit','Approve','Revoke','Dispatch','List','Status','Audit','StartInbox','InboxList','Claim','Release','InboxAudit'\)/);
  assert.match(wrapper, /TaskJson \| & \$Node\.Source \$Cli 'submit' '-'/);
});

test("PowerShell task wrapper exposes loopback inbox startup", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const entrypoint = readFileSync(resolve(root, "Enter-UnifiedField.ps1"), "utf8");
  const wrapper = readFileSync(resolve(root, "Invoke-UnifiedFieldTask.ps1"), "utf8");
  assert.match(wrapper, /StartInbox/);
  assert.match(wrapper, /shared-task-inbox\.mjs/);
  assert.match(entrypoint, /StartInbox/);
});

test("inbox-list rejects non-loopback endpoints before making a request", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolve(root, "integrations/worker-host-cli.mjs");
  const result = spawnSync(process.execPath, [cli, "inbox-list", "http://192.0.2.20:18796/api/tasks"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Task inbox endpoint must be http:\/\/127\.0\.0\.1/);
});
