# Unified Field loopback task inbox

The inbox is the receiver for heavenzfire.shared-task.v1 proposals sent by OpenSourceAIHub and other local clients.

## Start

Requires Node.js 20+ and uses only built-in modules.

PowerShell:

    node .\integrations\task-inbox-server.mjs

The service binds exclusively to 127.0.0.1:18796. It does not accept a configurable LAN or public bind address.

The runtime journal defaults to a file named task-inbox.jsonl under the HeavenzFire directory in LOCALAPPDATA, HOME, or USERPROFILE. Override the complete path with HF_TASK_INBOX_FILE; override the port with HF_TASK_INBOX_PORT.

## Contract

- POST /api/tasks accepts only a JSON body containing one taskRecord in proposed / pending state.
- GET /api/tasks?limit=50&offset=0 returns bounded task summaries; metadata is not returned.
- GET /health reports journal health and explicitly reports executionEnabled: false.
- Identical task ID plus identical canonical record is idempotent (200, duplicate: true).
- Reusing a task ID with different content is rejected (409, task_id_conflict).
- Records are appended to a SHA-256 hash-chained JSONL journal and fsynced before acknowledgement.
- Startup verifies every record and fails closed on tampering, malformed JSON, sequence gaps, or a partial final line.
- A process lock prevents two inbox processes from writing the same journal simultaneously.

This component is an inbox only. It does not approve, schedule, dispatch, or execute received tasks. Approval and execution remain separate governed transitions.

## Recovery

A process crash can leave a .lock file. Do not delete it automatically. Inspect the recorded PID and confirm that process is no longer running before removing the stale lock and restarting. If the journal fails verification, preserve the file and investigate; do not rewrite the chain to make startup pass.

## Validation

Run:

    node --test integrations/task-inbox-server.test.mjs
