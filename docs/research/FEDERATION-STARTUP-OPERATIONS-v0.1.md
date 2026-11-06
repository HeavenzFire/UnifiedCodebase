# Federation startup operations v0.1

This is the current guarded launch sequence: create and approve the task on Windows, grant one task-scoped capability on Windows, start the receiver, transfer the signed package to Android, then submit through an SSH local forward. The operator approval secret never leaves Windows.

## 1. Windows — create and approve one task

From the UnifiedCodebase repository root, set the canonical contract module and the local operator approval secret. The approval secret must contain at least 32 UTF-8 bytes and must never be committed or sent to Android.

    $env:HF_UNIFIEDCODEBASE_ROOT = (Get-Location).Path
    $env:HF_SHARED_TASK_CONTRACT_MODULE = 'C:\PATH\TO\UnifiedField\FieldCore\shared-task-contract.cjs'
    $env:HF_OPERATOR_APPROVAL_SECRET = (Get-Content "$HOME\.heavenzfire\federation\operator-approval.secret" -Raw).Trim()

Create a proposed task. Use stable IDs and keep the goal bounded; this task's metadata is later matched to the Windows capability grant.

    node .\scripts\rd\create-federation-task.cjs "$HOME\.heavenzfire\federation\proposed-task.json" agent-android-zdh grant-hf-task-001 "Return a bounded read-only inference result"

Approve it using the operator identity. This invokes the canonical transition function, appends attributable approval evidence, and signs the exact record hash.

    node .\scripts\rd\approve-federation-task.cjs "$HOME\.heavenzfire\federation\proposed-task.json" "$HOME\.heavenzfire\federation\approval-package.json" operator-zdh

Create the one-task capability grant. The script requires the operator to type the exact confirmation string.

    node .\scripts\rd\grant-federation-task.cjs agent-android-zdh grant-hf-task-001 <TASK_ID> 60

Use the taskId printed by the create command. Then set the exact IDs for startup preflight:

    $env:HF_FEDERATION_AGENT_ID = 'agent-android-zdh'
    $env:HF_FEDERATION_GRANT_ID = 'grant-hf-task-001'
    $env:HF_FEDERATION_TASK_ID = '<TASK_ID>'

## 2. Windows — configure and launch receiver

Set the approved Android peer enrollment. The peer HMAC secret is distinct from the operator approval secret. The same peer secret and approved timestamp must be configured on Android.

    $peerSecret = (Get-Content "$HOME\.heavenzfire\federation\android-peer.secret" -Raw).Trim()
    $approvedAt = '<ENROLLMENT_TIMESTAMP>'
    $peer = @{ nodeId = 'android-a67l'; secret = $peerSecret; approved = $true; approvedAt = $approvedAt; allowedCapabilities = @('task.submit','task.read') }
    $env:HF_FEDERATION_PEERS_JSON = ConvertTo-Json -InputObject @($peer) -Compress

The Windows config example creates the local TaskLedger, CapabilityStore, capability gate, and local inference adapter. Set the receiver identity and start the preflight launcher:

    $env:HF_NODE_ID = 'windows-zdh'
    $env:HF_FEDERATION_NODE_CONFIG = (Join-Path (Get-Location) 'scripts\rd\federation-node-config.example.cjs')
    powershell -ExecutionPolicy Bypass -File .\scripts\rd\Start-Federation-Windows.ps1

The launcher verifies the task-scoped grant and local inference health before starting. It binds only to 127.0.0.1:18100. Keep this PowerShell process open.

## 3. Transfer the signed package to Android

The package contains the approved canonical record and a signed, task-bound approval proof. It does not contain the operator approval secret.

From Termux, copy it over the already-authorized SSH connection. The remote path is relative to the Windows SSH user's home directory:

    mkdir -p "$HOME/.heavenzfire/federation"
    scp -i "$HOME/.ssh/heavenzfire_bridge" "rucke@<WINDOWS_TAILSCALE_IP>:.heavenzfire/federation/approval-package.json" "$HOME/.heavenzfire/federation/approval-package.json"

If your Windows SSH account uses a different home mapping, use the verified remote path for that account. Do not paste the package or secrets into GitHub issues.

## 4. Android / Termux — establish tunnel and submit

Set the Android node identity and the Windows peer enrollment. Android needs the peer secret, not the operator approval secret.

    export HF_FEDERATION_NODE_ID=android-a67l
    export HF_FEDERATION_PEER_ID=windows-zdh
    export HF_FEDERATION_PEER_SECRET="$(cat "$HOME/.heavenzfire/federation/windows-peer.secret")"
    export HF_FEDERATION_PEER_APPROVED=true
    export HF_FEDERATION_PEER_APPROVED_AT='<SAME_ENROLLMENT_TIMESTAMP>'
    export HF_FEDERATION_SSH_TARGET='rucke@<WINDOWS_TAILSCALE_IP>'
    export HF_FEDERATION_SSH_KEY="$HOME/.ssh/heavenzfire_bridge"

Run the combined tunnel, health-check, handshake, submit, and completion poll:

    bash scripts/rd/start-federation-android.sh "$HOME/.heavenzfire/federation/approval-package.json"

The script binds the local end of the SSH forward to 127.0.0.1:18101 and forwards to Windows 127.0.0.1:18100. It checks the receiver, submits the package, and polls for up to 50 seconds for canonical completed plus ledger succeeded. The tunnel is closed automatically when the script exits.

## 5. Acceptance evidence

A successful run must report TASK_COMPLETED with the exact task ID, canonicalStatus completed, and ledgerStatus succeeded. Also verify on Windows that the local TaskLedger contains the same task ID and a succeeded result.

Repeat the same package to verify idempotent admission. Invalid approval proof, expired peer session, missing or mismatched grant, and unauthorized capability must be rejected.

CI loopback tests are not physical-device acceptance. Keep the live output redacted and separate. Never commit peer secrets, operator secrets, private addresses, raw approval packages, or SSH private keys.
