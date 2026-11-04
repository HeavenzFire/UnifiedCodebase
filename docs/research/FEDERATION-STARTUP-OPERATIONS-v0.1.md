# Federation startup operations v0.1

This is the guarded launch path for the Windows receiver and Android/Termux submitter. The operator approval secret stays on Windows; Android receives only the signed, task-scoped approval package.

## 1. Windows — create, grant, approve, and start

Run from the UnifiedCodebase repository root in PowerShell:

```powershell
$env:HF_UNIFIEDCODEBASE_ROOT = (Get-Location).Path
$env:HF_SHARED_TASK_CONTRACT_MODULE = 'C:\PATH\TO\UnifiedField\FieldCore\shared-task-contract.cjs'
$env:HF_OPERATOR_APPROVAL_SECRET = (Get-Content "$HOME\.heavenzfire\federation\operator-approval.secret" -Raw).Trim()
$env:HF_FEDERATION_PEERS_JSON = '[{"nodeId":"android-a67l","secret":"<SAME_PEER_SECRET>","approved":true,"approvedAt":"<ENROLLMENT_TIMESTAMP>","allowedCapabilities":["task.submit","task.read"]}]'
$env:HF_FEDERATION_AGENT_ID = 'agent-android-zdh'
$env:HF_FEDERATION_GRANT_ID = 'grant-hf-task-001'
$env:HF_FEDERATION_TASK_ID = 'hf-task-001'
```

Use a random peer secret of at least 32 bytes, provisioned to both devices through a protected channel. The enrollment timestamp must be the same on both sides. Never put either secret in Git, task metadata, or issue comments.

Create a proposed canonical task. Use the same agent and grant IDs configured above:

```powershell
node .\scripts\rd\create-federation-task.cjs .\proposed-task.json $env:HF_FEDERATION_AGENT_ID $env:HF_FEDERATION_GRANT_ID "Return the exact text HF_FEDERATION_TASK_OK"
```

Set the task ID printed by that command:

```powershell
$env:HF_FEDERATION_TASK_ID = '<TASK_ID_FROM_CREATE_OUTPUT>'
```

Create the narrow task-scoped capability grant. The command prints the grant and requires typing its exact ID:

```powershell
node .\scripts\rd\grant-federation-task.cjs $env:HF_FEDERATION_AGENT_ID $env:HF_FEDERATION_GRANT_ID $env:HF_FEDERATION_TASK_ID 60
```

Approve the proposed record and create the signed approval package on Windows. The operator approval secret is not copied to Android:

```powershell
node .\scripts\rd\approve-federation-task.cjs .\proposed-task.json .\approval-package.json operator-zdh
```

Start the receiver. Its preflight verifies the task-scoped grant and local inference health before starting the foreground node:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\rd\Start-Federation-Windows.ps1
```

Keep this PowerShell process open. The service listens only on `127.0.0.1:18100`.

## 2. Android / Termux — transfer the approval package and submit

Copy only the signed approval package to Termux over the existing SSH connection. Replace the Windows path with the actual repository path:

```bash
export HF_FEDERATION_SSH_TARGET='rucke@<WINDOWS_TAILSCALE_IP>'
export HF_FEDERATION_SSH_KEY="$HOME/.ssh/heavenzfire_bridge"
scp -i "$HF_FEDERATION_SSH_KEY" "$HF_FEDERATION_SSH_TARGET:C:/Users/rucke/HeavenzFire-RD/approval-package.json" "$HOME/approval-package.json"
```

Configure the peer identity and SSH key. The peer secret must match the Windows peer secret; the operator approval secret is not needed on Android:

```bash
export HF_FEDERATION_SSH_TARGET='rucke@<WINDOWS_TAILSCALE_IP>'
export HF_FEDERATION_SSH_KEY="$HOME/.ssh/heavenzfire_bridge"
export HF_FEDERATION_NODE_ID=android-a67l
export HF_FEDERATION_PEER_ID=windows-zdh
export HF_FEDERATION_PEER_SECRET='<SAME_PEER_SECRET>'
export HF_FEDERATION_PEER_APPROVED=true
export HF_FEDERATION_PEER_APPROVED_AT='<SAME_ENROLLMENT_TIMESTAMP>'
```

Run the combined SSH-tunnel and submitter launcher from the UnifiedCodebase checkout:

```bash
bash scripts/rd/start-federation-android.sh "$HOME/approval-package.json"
```

It opens a local-only forward from Termux port 18101 to Windows loopback port 18100, checks receiver health, authenticates the peer, submits the signed task, polls the authenticated task projection for up to 50 seconds, and closes the tunnel on exit.

## 3. Acceptance criteria

A submission HTTP 202 is admission only. A successful live acceptance requires the Termux client to report `TASK_COMPLETED`, with canonical status `completed` and ledger status `succeeded`. Verify the same task ID in the Windows ledger. Repeat the same package to test idempotent delivery. Invalid approval, expired peer session, missing capability grant, and unauthorized scope must be rejected.

CI loopback tests are not physical-device acceptance. Record redacted output and exit codes separately. Never commit peer secrets, approval secrets, private addresses, or raw approval packages. Remove the approval package from Termux after acceptance.
