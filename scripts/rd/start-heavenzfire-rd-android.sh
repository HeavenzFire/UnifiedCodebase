#!/data/data/com.termux/files/usr/bin/bash
# HeavenzFire Cross-Device Federation R&D launcher
# Termux; workspace sync and bounded, read-only Windows inference health check.
set -u

REPO_URL='https://github.com/HeavenzFire/UnifiedCodebase.git'
BRANCH='research/cross-device-federation-rd-v0.1'
WORKSPACE="$HOME/HeavenzFire-RD"
EVIDENCE_DIR="$HOME/.heavenzfire/rd"
EVIDENCE_FILE="$EVIDENCE_DIR/android-preflight.json"
WINDOWS_HOST='100.96.1.10'
SSH_KEY="$HOME/.ssh/heavenzfire_bridge"

echo '=== HEAVENZFIRE ANDROID R&D ==='
for bin in git ssh python iconv base64; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: $bin is required"; exit 10; }
done

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

  # Encode PowerShell as UTF-16LE Base64. This prevents OpenSSH/Windows
  # command-line parsing from stripping quotes around string literals.
  REMOTE_PS='try { $h = Invoke-RestMethod -Uri "http://127.0.0.1:11820/health" -TimeoutSec 5; $h | ConvertTo-Json -Compress; if ($h.status -eq "ok") { Write-Output "FACADE_OK"; exit 0 } else { Write-Output "FACADE_NOT_OK"; exit 2 } } catch { Write-Output $_.Exception.Message; exit 3 }'
  ENCODED_PS=$(printf '%s' "$REMOTE_PS" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')

  REMOTE_OUTPUT=$(ssh -i "$SSH_KEY" \
    -o BatchMode=yes \
    -o ConnectTimeout=8 \
    -o ConnectionAttempts=1 \
    -o ServerAliveInterval=3 \
    -o ServerAliveCountMax=2 \
    -o StrictHostKeyChecking=accept-new \
    "rucke@$WINDOWS_HOST" \
    "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand $ENCODED_PS" 2>&1)
  SSH_EXIT=$?

  if [ "$SSH_EXIT" -eq 0 ] && printf '%s' "$REMOTE_OUTPUT" | grep -q 'FACADE_OK'; then
    SSH_STATE='AUTHENTICATED'
    REMOTE_HEALTH='PASS'
    printf '%s\n' "$REMOTE_OUTPUT"
  else
    SSH_STATE='FAILED'
    REMOTE_HEALTH="FAIL:$SSH_EXIT"
    printf '%s\n' "$REMOTE_OUTPUT"
  fi
fi

mkdir -p "$EVIDENCE_DIR" || { echo 'ERROR: cannot create evidence directory'; exit 17; }
COMMIT=$(git -C "$WORKSPACE" rev-parse HEAD) || exit 18
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
