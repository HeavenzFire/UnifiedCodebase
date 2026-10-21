import { checkSovereignNodeHealth } from "../../integrations/sovereign-node-adapter.mjs";

/** Read-only health worker. The underlying adapter restricts requests to loopback HTTP. */
export async function runSovereignNodeHealthTask(task, { checkHealthImpl = checkSovereignNodeHealth } = {}) {
  const metadata = task?.metadata ?? {};
  return checkHealthImpl({
    baseUrl: metadata.baseUrl,
    timeoutMs: metadata.timeoutMs,
  });
}
