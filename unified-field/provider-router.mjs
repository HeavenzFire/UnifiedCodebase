#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

const PROVIDERS = Object.freeze({
  ollama: { kind: "ollama", baseUrlEnv: "HEAVENZFIRE_OLLAMA_URL", defaultBaseUrl: "http://127.0.0.1:11434", defaultModel: "heavenzfire-runtime:latest", keyEnv: null },
  openai: { kind: "openai-compatible", baseUrlEnv: "HEAVENZFIRE_OPENAI_BASE_URL", defaultBaseUrl: "https://api.openai.com/v1", defaultModel: "gpt-4o-mini", keyEnv: "OPENAI_API_KEY" },
  mistral: { kind: "openai-compatible", baseUrlEnv: "HEAVENZFIRE_MISTRAL_BASE_URL", defaultBaseUrl: "https://api.mistral.ai/v1", defaultModel: "mistral-small-latest", keyEnv: "MISTRAL_API_KEY" },
  gemini: { kind: "openai-compatible", baseUrlEnv: "HEAVENZFIRE_GEMINI_BASE_URL", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.5-flash", keyEnv: "GEMINI_API_KEY" }
});

export function providerConfig(name, env = process.env) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error('Unknown provider "' + name + '". Choose: ' + Object.keys(PROVIDERS).join(", "));
  const baseUrl = (env[provider.baseUrlEnv] || provider.defaultBaseUrl).replace(/\/+$/, "");
  const model = env.HEAVENZFIRE_MODEL || provider.defaultModel;
  if (provider.keyEnv && !env[provider.keyEnv]) {
    throw new Error('Provider "' + name + '" requires ' + provider.keyEnv + '; no remote fallback was attempted.');
  }
  return { name, ...provider, baseUrl, model, apiKey: provider.keyEnv ? env[provider.keyEnv] : null };
}

export async function routePrompt({ providerName = "ollama", model, prompt, env = process.env, fetchImpl = fetch, timeoutMs = 60000 }) {
  if (typeof prompt !== "string" || !prompt.trim()) throw new Error("A non-empty prompt is required.");
  const config = providerConfig(providerName, env);
  const chosenModel = model || config.model;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (config.kind === "ollama") {
      const response = await fetchImpl(config.baseUrl + "/api/chat", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: chosenModel, messages: [{ role: "user", content: prompt }], stream: false }),
        signal: controller.signal
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error("Ollama returned HTTP " + response.status + ": " + (data.error || "request failed"));
      const text = data.message && data.message.content;
      if (typeof text !== "string") throw new Error("Ollama response did not contain message.content.");
      return { provider: config.name, model: chosenModel, text, remote: false };
    }
    const response = await fetchImpl(config.baseUrl + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + config.apiKey },
      body: JSON.stringify({ model: chosenModel, messages: [{ role: "user", content: prompt }], stream: false }),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(config.name + " returned HTTP " + response.status + ": " + (data.error && data.error.message || "request failed"));
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof text !== "string") throw new Error(config.name + " response did not contain choices[0].message.content.");
    return { provider: config.name, model: chosenModel, text, remote: true };
  } finally { clearTimeout(timeout); }
}

function parseArgs(argv) {
  const args = { provider: process.env.HEAVENZFIRE_PROVIDER || "ollama", model: undefined, prompt: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider") args.provider = argv[++i];
    else if (argv[i] === "--model") args.model = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") args.help = true;
    else args.prompt += (args.prompt ? " " : "") + argv[i];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("Usage: node provider-router.mjs [--provider ollama|openai|mistral|gemini] [--model MODEL] PROMPT");
    console.log("Default: local Ollama. Remote providers require their own API key and are never selected automatically.");
    return;
  }
  let prompt = args.prompt;
  if (!prompt && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    prompt = Buffer.concat(chunks).toString("utf8").trim();
  }
  try {
    const result = await routePrompt({ providerName: args.provider, model: args.model, prompt });
    console.log(JSON.stringify({ provider: result.provider, model: result.model, remote: result.remote, text: result.text }, null, 2));
  } catch (error) {
    console.error("Unified Field provider error: " + error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
