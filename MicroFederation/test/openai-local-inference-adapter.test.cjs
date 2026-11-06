'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createOpenAICompatibleInferenceAdapter } = require('../openai-local-inference-adapter.cjs');

test('inference adapter accepts loopback only and sends a bounded deterministic request', async () => {
  let captured;
  const adapter = createOpenAICompatibleInferenceAdapter({
    baseUrl: 'http://127.0.0.1:11820',
    model: 'heavenzfire-qwen-0.5b',
    fetchImpl: async (url, options) => {
      captured = { url: String(url), options, body: JSON.parse(options.body) };
      return {
        ok: true,
        json: async () => ({
          model: 'heavenzfire-qwen-0.5b',
          choices: [{ message: { content: 'HF_LOCAL_INFERENCE_OK' }, finish_reason: 'stop' }],
          usage: { completion_tokens: 3 }
        })
      };
    }
  });
  const result = await adapter.run({ taskId: 'task-local-1', role: 'verifier', prompt: 'Return HF_LOCAL_INFERENCE_OK' });
  assert.equal(result.content, 'HF_LOCAL_INFERENCE_OK');
  assert.equal(captured.url, 'http://127.0.0.1:11820/v1/chat/completions');
  assert.equal(captured.body.model, 'heavenzfire-qwen-0.5b');
  assert.equal(captured.body.temperature, 0);
  assert.equal(captured.body.max_tokens, 512);
  assert.equal(captured.body.stream, false);
});

test('inference adapter refuses redirects so prompts cannot be forwarded to another origin', async () => {
  let captured;
  const adapter = createOpenAICompatibleInferenceAdapter({
    baseUrl: 'http://127.0.0.1:11820',
    fetchImpl: async (url, options) => {
      captured = options;
      throw Object.assign(new Error('redirect mode error'), { name: 'TypeError' });
    }
  });
  await assert.rejects(adapter.run({ taskId: 'redirect-test', prompt: 'private prompt' }), /redirect mode error/);
  assert.equal(captured.redirect, 'error');
  assert.equal(captured.cache, 'no-store');
});

test('inference adapter rejects non-loopback backends', () => {
  assert.throws(() => createOpenAICompatibleInferenceAdapter({ baseUrl: 'http://192.0.2.1:11820' }), /loopback HTTP endpoints only/);
});
