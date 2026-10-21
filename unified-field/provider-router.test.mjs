import test from "node:test";
import assert from "node:assert/strict";
import { providerConfig, routePrompt } from "./provider-router.mjs";

test("defaults to local Ollama without credentials", () => {
  const c = providerConfig("ollama", {});
  assert.equal(c.baseUrl, "http://127.0.0.1:11434");
  assert.equal(c.model, "heavenzfire-runtime:latest");
  assert.equal(c.keyEnv, null);
});
test("unknown provider is rejected", () => assert.throws(() => providerConfig("magic", {}), /Unknown provider/));
test("remote provider requires its own key; no silent fallback", () => assert.throws(() => providerConfig("mistral", {}), /requires MISTRAL_API_KEY/));
test("Ollama request is local and returns provider identity", async () => {
  let url = ""; let body;
  const result = await routePrompt({ prompt: "ping", env: {}, fetchImpl: async (u, options) => {
    url = u; body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: "pong" } }) };
  }});
  assert.equal(url, "http://127.0.0.1:11434/api/chat");
  assert.equal(body.model, "heavenzfire-runtime:latest");
  assert.equal(result.text, "pong");
  assert.equal(result.remote, false);
});
test("Mistral failure does not retry against local Ollama", async () => {
  let calls = 0; let captured;
  const result = await routePrompt({ providerName: "mistral", prompt: "test", env: { MISTRAL_API_KEY: "test-only-secret" },
    fetchImpl: async (url, options) => { calls++; captured = { url, authorization: options.headers.authorization, redirect: options.redirect }; return { ok: false, status: 429, json: async () => ({ error: { message: "quota" } }) }; }
  }).catch(error => error);
  assert.equal(calls, 1);
  assert.equal(captured.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(captured.authorization, "Bearer test-only-secret");
  assert.equal(captured.redirect, "error");
  assert.match(result.message, /HTTP 429/);
});
test("empty prompts are rejected before any network request", async () => {
  let calls = 0;
  await assert.rejects(routePrompt({ prompt: "  ", fetchImpl: async () => { calls++; } }), /non-empty prompt/);
  assert.equal(calls, 0);
});

test("credentialed remote providers reject plaintext HTTP endpoints before fetch", async () => {
  let calls = 0;
  await assert.rejects(
    routePrompt({
      providerName: "mistral",
      prompt: "must not leak",
      env: { MISTRAL_API_KEY: "test-only-secret", HEAVENZFIRE_MISTRAL_BASE_URL: "http://example.invalid/v1" },
      fetchImpl: async () => { calls++; throw new Error("fetch must not be called"); }
    }),
    /must use HTTPS/
  );
  assert.equal(calls, 0);
});

test("credentialed remote providers reject URLs containing embedded credentials", () => {
  assert.throws(
    () => providerConfig("openai", { OPENAI_API_KEY: "test-only-secret", HEAVENZFIRE_OPENAI_BASE_URL: "https://user:pass@example.invalid/v1" }),
    /must use HTTPS and must not include credentials/
  );
});
