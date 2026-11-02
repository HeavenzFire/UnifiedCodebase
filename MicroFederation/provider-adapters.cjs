'use strict';

const { performance } = require('node:perf_hooks');

const RESULT_SCHEMA = 'heavenzfire.provider-result.v1';
const DEFAULT_TIMEOUT_MS = 60000;
const MODEL_ID = /^[A-Za-z0-9._-]{1,128}$/;

class ProviderAdapterError extends Error {
  constructor(message, { providerId, code = 'provider_error', retryable = false, status = null } = {}) {
    super(message);
    this.name = 'ProviderAdapterError';
    this.providerId = providerId || null;
    this.code = code;
    this.retryable = retryable === true;
    this.status = Number.isInteger(status) ? status : null;
  }
}

function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('provider request must be an object');
  if (typeof input.taskId !== 'string' || !input.taskId.trim() || input.taskId.length > 128) throw Error('taskId is required');
  if (typeof input.prompt !== 'string' || !input.prompt.trim()) throw Error('prompt must be a non-empty string');
  const maxOutputTokens = input.maxOutputTokens === undefined ? 512 : input.maxOutputTokens;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 65536) throw Error('maxOutputTokens must be an integer from 1 to 65536');
  const temperature = input.temperature === undefined ? 0.2 : input.temperature;
  if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw Error('temperature must be between 0 and 2');
  const model = input.model || null;
  if (model !== null && (typeof model !== 'string' || !MODEL_ID.test(model))) throw Error('model identifier is invalid');
  if (input.signal !== undefined && (!input.signal || typeof input.signal.aborted !== 'boolean' || typeof input.signal.addEventListener !== 'function')) throw Error('signal must be an AbortSignal');
  return { taskId: input.taskId, role: input.role || 'assistant', prompt: input.prompt,
    maxOutputTokens, temperature, model, signal: input.signal || null };
}

function abortScope(parentSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('provider request timed out')), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  const onAbort = () => controller.abort(parentSignal.reason);
  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    close() {
      clearTimeout(timer);
      if (parentSignal) parentSignal.removeEventListener('abort', onAbort);
    }
  };
}

function tokenCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function parseJsonBody(body, providerId) {
  try {
    const value = typeof body === 'string' ? JSON.parse(body) : body;
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('not an object');
    return value;
  } catch {
    throw new ProviderAdapterError(providerId + ' returned malformed JSON', {
      providerId, code: 'invalid_provider_response'
    });
  }
}

function providerFailure(providerId, status, body) {
  const data = parseJsonBody(body, providerId);
  const raw = data.error && (data.error.message || data.error) || data.message || 'request failed';
  const message = typeof raw === 'string' ? raw.slice(0, 1000) : 'request failed';
  return new ProviderAdapterError(providerId + ' HTTP ' + status + ': ' + message, {
    providerId,
    code: status === 401 || status === 403 ? 'authentication_or_permission' :
      status === 429 ? 'rate_limited' : status >= 500 ? 'provider_unavailable' : 'provider_rejected',
    retryable: [408, 409, 429, 500, 502, 503, 504].includes(status),
    status
  });
}

class ProviderAdapter {
  constructor({ providerId, provider, model, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof providerId !== 'string' || !/^[a-z][a-z0-9._-]{0,63}$/.test(providerId)) throw Error('providerId is invalid');
    if (typeof provider !== 'string' || !provider.trim()) throw Error('provider name is required');
    if (typeof model !== 'string' || !MODEL_ID.test(model)) throw Error('default model is invalid');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 600000) throw Error('timeoutMs must be 100..600000');
    this.providerId = providerId;
    this.provider = provider;
    this.model = model;
    this.timeoutMs = timeoutMs;
  }

  async run(input) {
    const request = validateRequest(input);
    const model = request.model || this.model;
    const started = performance.now();
    const result = await this.generate({ ...request, model });
    const elapsedMs = Math.max(0, performance.now() - started);
    if (!result || typeof result.text !== 'string' || !result.text.trim()) {
      throw new ProviderAdapterError(this.provider + ' returned no text completion', {
        providerId: this.providerId, code: 'empty_completion'
      });
    }
    const inputTokens = tokenCount(result.inputTokens);
    const outputTokens = tokenCount(result.outputTokens);
    return {
      schema: RESULT_SCHEMA,
      taskId: request.taskId,
      role: request.role,
      providerId: this.providerId,
      provider: this.provider,
      model,
      response: result.text,
      finishReason: result.finishReason || null,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens
      },
      providerRequestId: result.providerRequestId || null,
      timing: { elapsedMs },
      evidenceRefs: []
    };
  }

  async generate() {
    throw new Error('ProviderAdapter.generate must be implemented');
  }
}

class GeminiDeveloperAdapter extends ProviderAdapter {
  constructor({ credentialBroker, providerId = 'gemini-developer', model = 'gemini-2.5-flash',
    timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super({ providerId, provider: 'gemini-developer-api', model, timeoutMs });
    if (!credentialBroker || typeof credentialBroker.request !== 'function') {
      throw Error('Gemini adapter requires the MicroFederation CredentialBroker');
    }
    this.credentialBroker = credentialBroker;
  }

  async generate(request) {
    const scope = abortScope(request.signal, this.timeoutMs);
    try {
      const path = '/v1beta/models/' + encodeURIComponent(request.model) + ':generateContent';
      const response = await this.credentialBroker.request({
        providerId: this.providerId,
        path,
        method: 'POST',
        signal: scope.signal,
        body: {
          contents: [{ role: 'user', parts: [{ text: request.prompt }] }],
          generationConfig: {
            maxOutputTokens: request.maxOutputTokens,
            temperature: request.temperature
          }
        }
      });
      if (!response || !Number.isInteger(response.status)) {
        throw new ProviderAdapterError('CredentialBroker returned an invalid response', {
          providerId: this.providerId, code: 'invalid_broker_response'
        });
      }
      if (!response.ok) throw providerFailure(this.providerId, response.status, response.body);
      const data = parseJsonBody(response.body, this.providerId);
      const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
      const parts = candidate && candidate.content && Array.isArray(candidate.content.parts)
        ? candidate.content.parts : [];
      const text = parts.filter(part => part && typeof part.text === 'string').map(part => part.text).join('');
      const usage = data.usageMetadata || {};
      return {
        text,
        inputTokens: tokenCount(usage.promptTokenCount),
        outputTokens: tokenCount(usage.candidatesTokenCount),
        finishReason: candidate && candidate.finishReason || null,
        providerRequestId: response.requestId || null
      };
    } catch (error) {
      if (request.signal && request.signal.aborted) throw new ProviderAdapterError('Gemini request cancelled', {
        providerId: this.providerId, code: 'cancelled'
      });
      if (scope.signal.aborted) throw new ProviderAdapterError('Gemini request timed out or was cancelled', {
        providerId: this.providerId, code: 'timeout_or_cancelled', retryable: true
      });
      if (error instanceof ProviderAdapterError) throw error;
      throw new ProviderAdapterError('Gemini broker request failed: ' + String(error && error.message || error).slice(0, 500), {
        providerId: this.providerId, code: 'broker_failure', retryable: false
      });
    } finally {
      scope.close();
    }
  }
}

function isLoopback(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host);
}

class OllamaAdapter extends ProviderAdapter {
  constructor({ endpoint = 'http://127.0.0.1:11434', model = 'qwen2.5:0.5b',
    timeoutMs = 120000, fetchImpl = globalThis.fetch, allowRemoteHttps = false } = {}) {
    super({ providerId: 'ollama-local', provider: 'ollama', model, timeoutMs });
    if (typeof fetchImpl !== 'function') throw Error('Ollama adapter requires fetch');
    let url;
    try { url = new URL(endpoint); } catch { throw Error('Ollama endpoint must be a valid URL'); }
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Ollama endpoint must be an origin without credentials, path, query, or fragment');
    const localHttp = url.protocol === 'http:' && isLoopback(url.hostname);
    const remoteHttps = url.protocol === 'https:' && allowRemoteHttps === true;
    if (!localHttp && !remoteHttps) throw Error('Ollama endpoint must be loopback HTTP or explicitly allowed HTTPS');
    this.endpoint = url.origin;
    this.fetchImpl = fetchImpl;
  }

  async generate(request) {
    const scope = abortScope(request.signal, this.timeoutMs);
    try {
      let response;
      try {
        response = await this.fetchImpl(this.endpoint + '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            model: request.model,
            messages: [{ role: 'user', content: request.prompt }],
            stream: false,
            options: { num_predict: request.maxOutputTokens, temperature: request.temperature }
          }),
          redirect: 'error',
          signal: scope.signal
        });
      } catch (error) {
        if (scope.signal.aborted) throw new ProviderAdapterError('Ollama request timed out or was cancelled', {
          providerId: this.providerId, code: 'timeout_or_cancelled', retryable: true
        });
        throw new ProviderAdapterError('Ollama transport failure: ' + String(error && error.message || error).slice(0, 500), {
          providerId: this.providerId, code: 'transport_failure', retryable: true
        });
      }
      const raw = await response.text();
      if (!response.ok) throw providerFailure(this.providerId, response.status, raw);
      const data = parseJsonBody(raw, this.providerId);
      const message = data.message || {};
      return {
        text: typeof message.content === 'string' ? message.content : '',
        inputTokens: tokenCount(data.prompt_eval_count),
        outputTokens: tokenCount(data.eval_count),
        finishReason: data.done === true ? 'stop' : null,
        providerRequestId: response.headers && (response.headers.get('x-request-id') || response.headers.get('request-id')) || null
      };
    } finally {
      scope.close();
    }
  }
}

module.exports = {
  RESULT_SCHEMA,
  ProviderAdapterError,
  ProviderAdapter,
  GeminiDeveloperAdapter,
  OllamaAdapter,
  isLoopback
};
