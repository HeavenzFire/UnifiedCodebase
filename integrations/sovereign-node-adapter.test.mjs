import test from "node:test";
import assert from "node:assert/strict";
import { checkSovereignNodeHealth } from "./sovereign-node-adapter.mjs";

test("reports a valid loopback health response", async () => {
  let requested;
  const result = await checkSovereignNodeHealth({
    fetchImpl: async (url, options) => {
      requested = { url: String(url), options };
      return { ok: true, status: 200, json: async () => ({ status: "ok" }) };
    },
  });
  assert.deepEqual(result, {
    component: "sovereign-node",
    status: "healthy",
    httpStatus: 200,
    probe: "read_only",
  });
  assert.equal(requested.url, "http://127.0.0.1:3000/api/health");
  assert.equal(requested.options.method, "GET");
  assert.equal(requested.options.body, undefined);
});

test("rejects non-loopback URLs before making a request", async () => {
  let called = false;
  await assert.rejects(
    checkSovereignNodeHealth({
      baseUrl: "http://192.0.2.10:3000",
      fetchImpl: async () => { called = true; },
    }),
    /only on loopback/,
  );
  assert.equal(called, false);
});

test("rejects HTTPS and credential-bearing URLs", async () => {
  await assert.rejects(checkSovereignNodeHealth({ baseUrl: "https://127.0.0.1:3000" }), /only on loopback/);
  await assert.rejects(checkSovereignNodeHealth({ baseUrl: "http://user:pass@localhost:3000" }), /only on loopback/);
});

test("reports non-200 and malformed responses without throwing", async () => {
  const down = await checkSovereignNodeHealth({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal(down.status, "unavailable");
  const malformed = await checkSovereignNodeHealth({
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: "warming" }) }),
  });
  assert.equal(malformed.status, "invalid_response");
});

test("rejects unreasonable timeouts", async () => {
  await assert.rejects(checkSovereignNodeHealth({ timeoutMs: 0 }), /between 1 and 10000/);
});
