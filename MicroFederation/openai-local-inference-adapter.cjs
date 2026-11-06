'use strict';

function createOpenAICompatibleInferenceAdapter({ baseUrl = 'http://127.0.0.1:11820', model = 'heavenzfire-qwen-0.5b', fetchImpl = globalThis.fetch, timeoutMs = 45000 } = {}) {
  const url = new URL(baseUrl);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('local inference adapter accepts loopback HTTP endpoints only');
  }
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (typeof model !== 'string' || !model.trim() || model.length > 200) throw new Error('model identifier is invalid');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new Error('timeoutMs must be 1000..120000');

  async function run({ taskId, role = 'worker', prompt, signal }) {
    if (typeof taskId !== 'string' || typeof prompt !== 'string' || !prompt.trim()) throw new Error('taskId and non-empty prompt are required');
    const timeout = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetchImpl(new URL('/v1/chat/completions', url), {
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: 'You are a bounded local task worker. Answer the approved task only. Do not claim to execute tools, access files, or perform external actions.' },
          { role: 'user', content: '[task:' + taskId + '][role:' + role + ']\n' + prompt }
        ],
        temperature: 0,
        max_tokens: 512,
        stream: false
      }),
      signal: requestSignal
    });
    if (!response.ok) throw new Error('local inference returned HTTP ' + response.status);
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('local inference returned no message content');
    return {
      taskId,
      model: typeof data.model === 'string' ? data.model : model,
      content,
      finishReason: data.choices[0].finish_reason || null,
      usage: data.usage && typeof data.usage === 'object' ? data.usage : null
    };
  }

  return Object.freeze({ run, model, baseUrl: url.origin });
}

module.exports = { createOpenAICompatibleInferenceAdapter };
