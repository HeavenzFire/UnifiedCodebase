# HeavenzFire federation node — local launch guide v0.1

This guide launches a single Windows receiver and an Android/Termux submitter. It uses the existing SSH private-overlay connection as a local port-forward only. The federation HTTP listener remains bound to `127.0.0.1`; do not open port 18100 in the Windows firewall or bind it to a mesh/public interface.

## 1. Components

- `federation-node.cjs`: process entry point and graceful shutdown.
- `federation-runtime.cjs`: protocol server, governed worker, capability gate, and local inference adapter.
- `federation-http-server.cjs` / `federation-http-client.cjs`: bounded task submit/read API.
- `federation-protocol.cjs`: HMAC-authenticated peer handshake and capability negotiation.
- `operator-approval.cjs`: signed, task-bound operator approval proof.
- `shared-task-ledger-adapter.cjs`: canonical contract admission, approval re-verification, and ledger projection.
- `governed-runtime.cjs`: sole worker lifecycle owner; capability checks run before the adapter.
- `openai-local-inference-adapter.cjs`: local inference requests to loopback only.

No component exposes arbitrary remote shell or filesystem access.

## 2. Required local configuration

Use Node.js 20 or 22 on both devices. Clone/check out the R&D branch and keep the canonical Unified Field contract available locally.

Create two independent random secrets:
- **Peer HMAC secret:** shared by the two node configs; authenticates the node handshake and task messages.
- **Operator approval secret:** shared only by the operator-controlled approval and receiver processes; signs task-specific approval proofs.

Each secret must contain at least 32 UTF-8 bytes. Store them in local protected files or environment variables. Never commit them, put them in task metadata, or paste them into issues.

The server peer enrollment must explicitly list the Android peer ID, the same peer secret, an operator-approved timestamp, and only the required scopes (`task.submit`, optionally `task.read`). The Android client must enroll the Windows peer using the same secret and approved timestamp.

## 3. Windows receiver

Copy `scripts/rd/federation-node-config.example.cjs` to a local file outside the repository, for example:

`$HOME\.heavenzfire\federation\windows-node-config.cjs`

Set the process environment before launching Node:

- `HF_UNIFIEDCODEBASE_ROOT`: absolute path to the UnifiedCodebase checkout.
- `HF_SHARED_TASK_CONTRACT_MODULE`: absolute path to the canonical `shared-task-contract.cjs` from the Unified Field checkout.
- `HF_OPERATOR_APPROVAL_SECRET`: operator approval HMAC secret.
- `HF_FEDERATION_PEERS_JSON`: JSON array containing the explicitly approved Android peer enrollment.
- `HF_FEDERATION_BOOTSTRAP_GRANT_FILE` or `HF_FEDERATION_BOOTSTRAP_GRANT_JSON`: optional one-task capability grant. The grant must match the task's `metadata.agentId`, `metadata.grantId`, and `taskId`, and include `shared-task.v1`.
- `HF_FEDERATION_NODE_CONFIG`: path to the copied local config file.

The example config creates a local TaskLedger and CapabilityStore. High-impact capabilities remain denied. A bootstrap grant is optional but, when supplied, is validated and recorded in the CapabilityStore before the worker starts. Do not use a broad agent-wide grant for this initial test.

Start the receiver from the repository root:

```powershell
$env:HF_FEDERATION_NODE_CONFIG = "$HOME\.heavenzfire\federation\windows-node-config.cjs"
node .\MicroFederation\federation-node.cjs
```

Expected startup output includes `"state":"READY"`, `"bind":"127.0.0.1"`, the selected port, and the worker identity. The process stays in the foreground. Ctrl+C performs a graceful worker stop and server close.

## 4. Android/Termux tunnel and client

Keep a separate Termux session open for the SSH local forward. Substitute the actual Windows Tailscale address and SSH user; do not expose port 18100 on the network:

```bash
ssh -i "$HOME/.ssh/heavenzfire_bridge" -N \
  -L 18100:127.0.0.1:18100 \
  -o BatchMode=yes \
  -o ConnectTimeout=8 \
  -o ExitOnForwardFailure=yes \
  rucke@<WINDOWS_TAILSCALE_IP>
```

In a second Termux session, set:
- `HF_FEDERATION_NODE_ID=android-a67l`
- `HF_FEDERATION_PEER_ID=windows-zdh`
- `HF_FEDERATION_PEER_SECRET`: the peer HMAC secret shared with the Windows enrollment.
- `HF_FEDERATION_PEER_APPROVED=true`
- `HF_FEDERATION_PEER_APPROVED_AT`: the matching enrollment timestamp.
- `HF_FEDERATION_BASE_URL=http://127.0.0.1:18100`

The client accepts numeric loopback URLs only. Do not substitute the Windows Tailscale address in `HF_FEDERATION_BASE_URL`; SSH owns that network boundary.

## 5. Approve and submit one bounded task

The canonical task must already contain:
- a stable `taskId`;
- `metadata.agentId` and `metadata.grantId` matching the Windows task-scoped capability grant;
- a bounded, non-privileged goal;
- a proposed/pending lifecycle state.

On the operator-controlled device, set `HF_SHARED_TASK_CONTRACT_MODULE` and `HF_OPERATOR_APPROVAL_SECRET`, then create the signed approval package:

```bash
node scripts/rd/approve-federation-task.cjs proposed-task.json approval-package.json operator-zdh
```

This transitions a proposed record to approved through the canonical contract, appends attributable approval evidence, and signs the exact canonical record hash. It does not create a capability grant.

Configure the Windows receiver with a task-scoped bootstrap grant matching the record. Example shape (replace all values; `expiresAt` is Unix milliseconds):

```json
{
  "grantId": "grant-federation-task-001",
  "agentId": "agent-android-zdh",
  "taskId": "hf-task-001",
  "capabilities": ["shared-task.v1"],
  "expiresAt": 1793822400000
}
```

Submit from Android after the SSH tunnel is open:

```bash
node scripts/rd/submit-federation-task.cjs approval-package.json
```

The client performs the authenticated handshake first, verifies that `task.submit` was granted, and submits the signed canonical record. The receiver independently verifies the operator proof, enqueues idempotently, and the governed worker checks the task-scoped capability grant before invoking the local inference adapter.

## 6. Acceptance evidence

A successful live acceptance requires all of these, not just an HTTP 202:
1. Windows process reports READY and remains bound to 127.0.0.1.
2. Android handshake returns `AUTHENTICATED` with `task.submit`.
3. Submitter reports the exact canonical task ID.
4. Windows ledger reaches `succeeded` with a result from the configured local model.
5. A task projection reports canonical `completed` and ledger `succeeded`.
6. Repeating the same task ID and same canonical record does not create a second ledger task.
7. A modified record, invalid approval proof, missing grant, expired session, or unauthorized capability is rejected.

CI tests exercise a loopback HTTP round-trip with deterministic fixtures. They do not prove that the user's physical Windows and Android devices have been launched or enrolled. Record the live command output separately; do not commit peer secrets, private IPs, raw approval proofs, or personal hostnames.

## 7. Explicit limits

- Peer identity uses per-peer symmetric HMAC secrets; this is a controlled bootstrap trust model, not asymmetric identity or non-repudiation.
- Handshake sessions and replay state are in-memory and reset when the process restarts.
- TaskLedger is file-backed with process-local write serialization; it is not a distributed database or multi-writer queue.
- One Windows receiver is the initial target. Heartbeats, cross-node lease transfer, durable session resumption, key rotation, and multi-receiver consensus are not implemented.
- The inference adapter returns model output only. It does not execute generated commands, modify files, or call external tools.
