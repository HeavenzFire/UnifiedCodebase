import { providerConfig, routePrompt } from "../../unified-field/provider-router.mjs";

/** Runs a task through local Ollama only; task metadata cannot select a remote provider. */
export async function runLocalModelTask(task, { routePromptImpl = routePrompt, env = process.env } = {}) {
  const prompt = task?.metadata?.prompt;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new TypeError("model.inference.local tasks require a non-empty metadata.prompt.");
  }
  const model = task.metadata.model;
  if (model !== undefined && (typeof model !== "string" || !model.trim())) {
    throw new TypeError("metadata.model must be a non-empty string when provided.");
  }
  const config = providerConfig("ollama", env);
  const hostname = new URL(config.baseUrl).hostname.toLowerCase();
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)) {
    throw new Error("Local model worker requires an Ollama endpoint on loopback; remote endpoints are not allowed.");
  }
  const result = await routePromptImpl({ providerName: "ollama", model, prompt, env });
  if (!result || result.provider !== "ollama" || result.remote !== false || typeof result.text !== "string") {
    throw new Error("Local model worker rejected a non-local or malformed provider result.");
  }
  return { provider: "ollama", model: result.model, remote: false, text: result.text };
}
