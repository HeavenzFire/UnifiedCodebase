import test from "node:test";
import assert from "node:assert/strict";
import { runLocalModelTask } from "./local-model-worker.mjs";

test("local model worker pins provider to Ollama regardless of task metadata", async () => {
  let received;
  const result = await runLocalModelTask({
    metadata: { capability: "model.inference.local", prompt: "Summarize the fixture.", model: "fixture-model", provider: "openai" },
  }, {
    routePromptImpl: async input => {
      received = input;
      return { provider: "ollama", model: input.model, remote: false, text: "fixture summary" };
    },
  });
  assert.equal(received.providerName, "ollama");
  assert.equal(received.prompt, "Summarize the fixture.");
  assert.equal(result.remote, false);
  assert.equal(result.text, "fixture summary");
});

test("local model worker rejects missing prompts and remote provider results", async () => {
  await assert.rejects(runLocalModelTask({ metadata: {} }, { routePromptImpl: async () => null }), /metadata.prompt/);
  await assert.rejects(runLocalModelTask({ metadata: { prompt: "test" } }, {
    routePromptImpl: async () => ({ provider: "openai", model: "remote", remote: true, text: "no" }),
  }), /non-local/);
});
