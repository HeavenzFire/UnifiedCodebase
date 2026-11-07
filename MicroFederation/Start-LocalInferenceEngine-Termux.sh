#!/data/data/com.termux/files/usr/bin/bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "Node.js is required; this launcher does not install packages." >&2
  exit 2
fi

BACKEND_URL="${HEAVENZFIRE_INFERENCE_BACKEND:-http://127.0.0.1:18080}"
HOST="${HEAVENZFIRE_INFERENCE_HOST:-127.0.0.1}"
PORT="${HEAVENZFIRE_INFERENCE_PORT:-11820}"

if [ "$HOST" != "127.0.0.1" ]; then
  echo "HEAVENZFIRE_INFERENCE_HOST must be 127.0.0.1; remote binds are not supported." >&2
  exit 3
fi
case "$PORT" in
  ''|*[!0-9]*) echo "HEAVENZFIRE_INFERENCE_PORT must be numeric." >&2; exit 4 ;;
esac
if [ "$PORT" -lt 1024 ] || [ "$PORT" -gt 65535 ]; then
  echo "HEAVENZFIRE_INFERENCE_PORT must be 1024..65535." >&2
  exit 4
fi

"$NODE" - "$BACKEND_URL" <<'NODE'
const value = process.argv[2];
let url;
try { url = new URL(value); } catch { throw new Error('backend URL is invalid'); }
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash) {
  throw new Error('backend must be plain HTTP loopback without credentials, query, or fragment');
}
(async () => {
  const response = await fetch(new URL('/health', url.origin), { signal: AbortSignal.timeout(3000), redirect: 'error' });
  const raw = await response.text();
  let health = null;
  try { health = JSON.parse(raw); } catch {}
  if (!response.ok || !health || !['ok', 'healthy'].includes(health.status)) {
    throw new Error('local llama.cpp backend health check failed');
  }
  process.stdout.write('LOCAL_BACKEND_HEALTH=PASS\n');
})().catch(error => {
  process.stderr.write('LOCAL_BACKEND_HEALTH=FAIL: ' + error.message + '\n');
  process.exitCode = 1;
});
NODE

export HEAVENZFIRE_INFERENCE_BACKEND="$BACKEND_URL"
export HEAVENZFIRE_INFERENCE_HOST="$HOST"
export HEAVENZFIRE_INFERENCE_PORT="$PORT"

echo "HEAVENZFIRE_LOCAL_INFERENCE=STARTING"
echo "BIND=$HOST"
echo "PORT=$PORT"
echo "BACKEND=$BACKEND_URL"
echo "Press Ctrl+C to stop the facade; the existing backend is not stopped."
exec "$NODE" "$SCRIPT_DIR/local-inference-engine.cjs"
