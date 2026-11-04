#!/data/data/com.termux/files/usr/bin/bash
# HeavenzFire Cross-Device Federation R&D launcher
# Termux; read-only preflight, workspace sync, SSH-mediated remote health check.
set -u
REPO_URL='https://github.com/HeavenzFire/UnifiedCodebase.git'
BRANCH='research/cross-device-federation-rd-v0.1'
WORKSPACE="$HOME/HeavenzFire-RD"
EVIDENCE_DIR="$HOME/.heavenzfire/rd"
EVIDENCE_FILE="$EVIDENCE_DIR/android-preflight.json"
WINDOWS_HOST='100.96.1.10'
SSH_KEY="$HOME/.ssh/heavenzfire_bridge"

echo '=== HEAVENZFIRE ANDROID R&D ==='
command -v git >/dev/null 2>&1 || { echo 'ERROR: git is required'; exit 10; }
command -v ssh >/dev/null 2>&1 || { echo 'ERROR: openssh is required'; exit 10; }

if [ -d "$WORKSPACE/.git" ]; then
  git -C "$WORKSPACE" fetch origin "$BRANCH" || { echo 'ERROR: git fetch failed'; exit 11; }
  git -C "$WORKSPACE" switch "$BRANCH" || { echo 'ERROR: branch switch failed'; exit 12; }
  git -C "$WORKSPACE" pull --ff-only origin "$BRANCH" || { echo 'ERROR: fast-forward update failed'; exit 13; }
elif [ -e "$WORKSPACE" ]; then
  echo "ERROR: workspace path exists and is not the expected Git checkout: $WORKSPACE"
  exit 14
else
  git clone --single-branch --branch "$BRANCH" "$REPO_URL" "$WORKSPACE" || exit 15
fi

SPEC="$WORKSPACE/docs/research/CROSS-DEVICE-FEDERATION-RD-v0.1.md"
[ -s "$SPEC" ] || { echo 'ERROR: R&D specification missing'; exit 16; }

SSH_STATE='NOT_CONFIGURED'
REMOTE_HEALTH='NOT_TESTED'
if [ -s "$SSH_KEY" ]; then
  SSH_STATE='KEY_PRESENT'
  REMOTE_OUTPUT=$(ssh -i "$SSH_KEY" -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=accept-new \
    "rucke@$WINDOWS_HOST" \
    'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "try { $h=Invoke-RestMethod http://127.0.0.1:11820/health -TimeoutSec 5; if ($h.status -eq ''ok'') { ''FACADE_OK'' } else { ''FACADE_NOT_OK''; exit 2 } } catch { ''FACADE_UNREACHABLE''; exit 3 }"' 2>&1)
  SSH_EXIT=$?
  if [ "$SSH_EXIT" -eq 0 ] && printf '%s' "$REMOTE_OUTPUT" | grep -q 'FACADE_OK'; then
    SSH_STATE='AUTHENTICATED'
    REMOTE_HEALTH='PASS'
  else
    SSH_STATE='FAILED'
    REMOTE_HEALTH="FAIL:$SSH_EXIT"
  fi
fi

mkdir -p "$EVIDENCE_DIR"
COMMIT=$(git -C "$WORKSPACE" rev-parse HEAD)
TIMESTAMP=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
cat > "$EVIDENCE_FILE" <<EOF
{
  "schema": "heavenzfire.rd.preflight.v1",
  "node": "android-termux",
  "timestamp_utc": "$TIMESTAMP",
  "branch": "$BRANCH",
  "commit": "$COMMIT",
  "spec_present": true,
  "ssh_state": "$SSH_STATE",
  "windows_facade_via_ssh": "$REMOTE_HEALTH",
  "execution_mode": "preflight-only"
}
EOF

cat "$EVIDENCE_FILE"
echo "EVIDENCE=$EVIDENCE_FILE"
if [ "$REMOTE_HEALTH" != 'PASS' ]; then
  echo 'ANDROID_RD_WORKSPACE=READY; WINDOWS_BRIDGE=NOT_VERIFIED'
  exit 2
fi
echo 'ANDROID_RD_PREFLIGHT=PASS'
