#!/data/data/com.termux/files/usr/bin/bash
set -eu

PACKAGE_PATH="${1:-}"
if [ -z "$PACKAGE_PATH" ]; then
  echo "Usage: bash scripts/rd/start-federation-android.sh <approval-package.json>" >&2
  exit 2
fi
case "$PACKAGE_PATH" in /*) ;; *) PACKAGE_PATH="$PWD/$PACKAGE_PATH" ;; esac
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

: "${HF_FEDERATION_SSH_TARGET:?Set HF_FEDERATION_SSH_TARGET to the approved Windows SSH target}"
: "${HF_FEDERATION_PEER_SECRET:?Set HF_FEDERATION_PEER_SECRET to the provisioned peer secret}"
: "${HF_FEDERATION_PEER_APPROVED_AT:?Set HF_FEDERATION_PEER_APPROVED_AT to the peer enrollment timestamp}"
: "${HF_FEDERATION_PEER_APPROVED:?Set HF_FEDERATION_PEER_APPROVED=true after operator enrollment}"

LOCAL_PORT="${HF_FEDERATION_LOCAL_PORT:-18101}"
REMOTE_PORT="${HF_FEDERATION_REMOTE_PORT:-18100}"
export HF_FEDERATION_BASE_URL="http://127.0.0.1:$LOCAL_PORT"

for tool in ssh curl node; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "Required command not found: $tool" >&2
    exit 3
  }
done

if ! [[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] || [ "$LOCAL_PORT" -lt 1024 ] || [ "$LOCAL_PORT" -gt 65535 ]; then
  echo "HF_FEDERATION_LOCAL_PORT must be 1024..65535" >&2
  exit 4
fi
if [ ! -f "$PACKAGE_PATH" ]; then
  echo "Approval package not found: $PACKAGE_PATH" >&2
  exit 5
fi

echo "Starting SSH local forward: 127.0.0.1:$LOCAL_PORT -> Windows loopback:$REMOTE_PORT"
ssh -N \
  -L "127.0.0.1:$LOCAL_PORT:127.0.0.1:$REMOTE_PORT" \
  -o BatchMode=yes \
  -o ConnectTimeout=8 \
  -o ConnectionAttempts=1 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=2 \
  -o StrictHostKeyChecking=accept-new \
  "$HF_FEDERATION_SSH_TARGET" &
TUNNEL_PID=$!

cleanup() {
  kill "$TUNNEL_PID" 2>/dev/null || true
  wait "$TUNNEL_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

READY=0
for attempt in 1 2 3 4 5 6 7 8; do
  if curl --silent --fail --max-time 2 "$HF_FEDERATION_BASE_URL/health" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "FEDERATION_TUNNEL_PREFLIGHT=FAIL" >&2
  exit 6
fi

echo "FEDERATION_TUNNEL_PREFLIGHT=PASS"
node scripts/rd/submit-federation-task.cjs "$PACKAGE_PATH"
