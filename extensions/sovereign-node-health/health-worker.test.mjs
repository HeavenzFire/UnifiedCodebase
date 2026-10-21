import test from "node:test";
import assert from "node:assert/strict";
import { runSovereignNodeHealthTask } from "./health-worker.mjs";

test("health worker forwards a read-only probe configuration", async () => {
  let received;
  const result = await runSovereignNodeHealthTask({
    metadata: { baseUrl: "http://127.0.0.1:3000", timeoutMs: 1200 },
  }, {
    checkHealthImpl: async options => {
      received = options;
      return { component: "sovereign-node", status: "healthy", httpStatus: 200, probe: "read_only" };
    },
  });
  assert.equal(received.baseUrl, "http://127.0.0.1:3000");
  assert.equal(received.timeoutMs, 1200);
  assert.equal(result.probe, "read_only");
});

test("health worker rejects non-loopback targets through the underlying adapter", async () => {
  await assert.rejects(runSovereignNodeHealthTask({
    metadata: { baseUrl: "http://192.0.2.20:3000" },
  }), /only on loopback/);
});
