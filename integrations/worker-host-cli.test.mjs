import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
