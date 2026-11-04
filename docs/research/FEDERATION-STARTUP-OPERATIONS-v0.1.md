# Federation startup operations v0.1

This is the current guarded launch path for the Windows receiver and Android/Termux submitter. It supersedes the earlier optional-grant wording in the first launch note.

## Windows — prepare and start the receiver

Set these variables in the PowerShell session that will run the service:

    $env:HF_UNIFIEDCODEBASE_ROOT = (Get-Location).Path
    $env:HF_SHARED_TASK_CONTRACT_MODULE = 'C:\PATH\TO\UnifiedField\FieldCore\shared-task-contract.cjs'
    $env:HF_OPERATOR_APPROVAL_SECRET = (Get-Content "$HOME\.heavenzfire\federation\operator-approval.secret" -Raw).Trim()
    $env:HF_FEDERATION_PEERS_JSON = '[{"nodeId":"android-a67l","secret":"<SAME_PEER_SECRET>","approved":true,"approvedAt":"<ENROLLMENT_TIMESTAMP>","allowedCapabilities":["task.submit"]}]'
    $env:HF_FEDERATION_AGENT_ID = 'agent-android-zdh'
    $env:HF_FEDERATION_GRANT_ID = 'grant-hf-task-001'
    $env:HF_FEDERATION_TASK_ID = 'hf-task-001'

Use the same peer secret and operator approval secret on the corresponding Android side. Do not place either secret in Git, task metadata, or issue comments.

Before service startup, create the task-scoped grant. The command displays the exact grant and requires typed confirmation:

    node .\scripts\rd\grant-federation-task.cjs $env:HF_FEDERATION_AGENT_ID $env:HF_FEDERATION_GRANT_ID $env:HF_FEDERATION_TASK_ID 60

Then launch the receiver. Its preflight verifies the grant and local inference health before starting the foreground node:

    powershell -ExecutionPolicy Bypass -File .\scripts\rd\Start-Federation-Windows.ps1

Keep this PowerShell process open. The service listens only on 127.0.0.1:18100.

## Android / Termux — approve and submit

The canonical proposed task must contain the exact taskId, metadata.agentId, and metadata.grantId used above. Set the contract path and same operator approval secret:

    export HF_SHARED_TASK_CONTRACT_MODULE="$HOME/HeavenzFire/UnifiedField/FieldCore/shared-task-contract.cjs"
    export HF_OPERATOR_APPROVAL_SECRET="$(cat "$HOME/.heavenzfire/federation/operator-approval.secret")"

Create the signed approval package:

    node scripts/rd/approve-federation-task.cjs proposed-task.json approval-package.json operator-zdh

Configure the Windows SSH target and key, then the approved peer identity:

    export HF_FEDERATION_SSH_TARGET='rucke@<WINDOWS_TAILSCALE_IP>'
    export HF_FEDERATION_SSH_KEY="$HOME/.ssh/heavenzfire_bridge"
    export HF_FEDERATION_NODE_ID=android-a67l
    export HF_FEDERATION_PEER_ID=windows-zdh
    export HF_FEDERATION_PEER_SECRET="$(cat "$HOME/.heavenzfire/federation/windows-peer.secret")"
    export HF_FEDERATION_PEER_APPROVED=true
    export HF_FEDERATION_PEER_APPROVED_AT='<ENROLLMENT_TIMESTAMP>'

Run the combined SSH-tunnel and submitter launcher:

    bash scripts/rd/start-federation-android.sh approval-package.json

It opens a local-only forward to Windows loopback, checks the receiver health endpoint, performs the authenticated handshake, submits the approved task, and closes the tunnel on exit. The script defaults to local port 18101 and remote port 18100.

## Required live acceptance

A submitter HTTP 202 is admission only. Confirm on Windows that the TaskLedger reaches succeeded and that the task projection reports canonical completed plus ledger succeeded. Repeat the same task package to verify idempotency. Then verify invalid approval, expired peer session, missing grant, and unauthorized scope are rejected.

The CI loopback round-trip is not physical-device acceptance. Record redacted output and exit codes separately. Never commit peer secrets, approval secrets, private addresses, or raw approval packages.
