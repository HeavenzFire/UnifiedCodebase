const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Read-only health probe for the Sovereign-Node- service.
 * Deliberately does not call /seal, /api/vault, or WebSocket actions.
 */
export async function checkSovereignNodeHealth({
  baseUrl = process.env.HEAVENZFIRE_SOVEREIGN_NODE_URL || "http://127.0.0.1:3000",
  fetchImpl = fetch,
  timeoutMs = 1500,
} = {}) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new TypeError("Sovereign Node URL must be a valid URL");
  }

  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new TypeError("Sovereign Node adapter permits unauthenticated HTTP only on loopback");
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    throw new RangeError("timeoutMs must be between 1 and 10000");
  }

  url.pathname = "/api/health";
  url.search = "";
  url.hash = "";

  const response = await fetchImpl(url, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    return { component: "sovereign-node", status: "unavailable", httpStatus: response.status };
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    return { component: "sovereign-node", status: "invalid_response", httpStatus: response.status };
  }

  if (payload?.status !== "ok") {
    return { component: "sovereign-node", status: "invalid_response", httpStatus: response.status };
  }

  return { component: "sovereign-node", status: "healthy", httpStatus: response.status, probe: "read_only" };
}
