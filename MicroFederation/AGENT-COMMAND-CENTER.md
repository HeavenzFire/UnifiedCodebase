# HeavenzFire Agent Command Center

**Status:** working repository implementation with automated Node 18/20/22 CI. A live connection to the user's Windows or Termux orchestrator still requires a host-side smoke test.

## What is implemented

- Browser command interface with a text composer, agent selector, direct conversations, and sequential broadcast.
- Five starter specialist profiles: Planner, Architect, Security Reviewer, Runtime Integrator, and Test Engineer. The server accepts an injected role roster so the existing 16-role definitions can be supplied without hard-coding a competing roster.
- Per-agent conversation threads and a broadcast thread.
- Local JSONL message journal. Each event includes sequence, timestamp, sender, recipient, conversation ID, kind, content, metadata, previous hash, and SHA-256 hash.
- Restart loading and hash-chain verification. Corruption is rejected rather than silently accepted.
- Existing \`LiveOrchestratorAdapter\` integration. Calls are serialized through the current orchestrator API; no parallel inference is introduced.
- Loopback-only HTTP binding. Non-loopback bind requests are rejected.

## Start on Windows PowerShell 5.1

From the repository checkout:

\`\`\`powershell
Set-Location .\\MicroFederation
node --version
$env:HEAVENZFIRE_ORCHESTRATOR_ENDPOINT = 'http://127.0.0.1:8788/task'
$env:HEAVENZFIRE_COMMAND_PORT = '8789'
node .\\agent-command-center.cjs
\`\`\`

Open \`http://127.0.0.1:8789\` in the same Windows machine's browser.

The orchestrator must already be running and responding at the configured endpoint. If it uses another local port, set \`HEAVENZFIRE_ORCHESTRATOR_ENDPOINT\` to that exact \`/task\` URL.

## Start in Termux

From the repository checkout:

\`\`\`sh
export HEAVENZFIRE_ORCHESTRATOR_ENDPOINT='http://127.0.0.1:8788/task'
export HEAVENZFIRE_COMMAND_PORT='8789'
node MicroFederation/agent-command-center.cjs
\`\`\`

Open \`http://127.0.0.1:8789\` in the Android browser on the same device.

## State location

By default, persistent messages are stored outside the repository:

- Windows: \`%USERPROFILE%\\.heavenzfire\\agent-command-center\\messages.jsonl\`
- Termux/Linux: \`$HOME/.heavenzfire/agent-command-center/messages.jsonl\`

Override with \`HEAVENZFIRE_STATE\`. The service never writes into the registered project workspace paths.

## HTTP interface

- \`GET /api/agents\` — configured agent identities and voice-style descriptors.
- \`GET /api/thread/:agentId\` — an agent's persistent conversation.
- \`GET /api/thread/broadcast\` — broadcast history and individual attributed responses.
- \`POST /api/message\` — JSON body \`{"target":"planner","content":"..."}\` for direct messaging, or target \`broadcast\` for sequential broadcast.

## Important boundaries

- The default roster contains five starter roles, not the full 16-role roster. Supply the existing 16 role definitions through the \`roles\` option when embedding \`createCommandCenterServer()\`.
- Voice descriptors are currently text/personality profiles. Actual synthesized speech, voice assignment, and playback are not implemented in this slice.
- The journal is append-only by application behavior and hash-chained. It is not administrator-proof, signed, or externally anchored.
- The journal is single-process-writer. Do not run multiple Command Center processes against the same state directory.
- The service binds to loopback only. It does not expose LAN, Tailscale, or internet access and has no remote authentication protocol yet.
- Broadcasts are sequential and may take several minutes depending on model latency.
- Agent-to-agent authenticated handoff, orchestrator-level synthesis, disagreement tracking, multi-provider model fusion, and voice output are follow-on milestones.
- No approval boundary is bypassed. This UI only submits text prompts through the existing orchestrator endpoint.

## Verification

\`\`\`sh
node --check MicroFederation/agent-command-center.cjs
node --test MicroFederation/test-agent-command-center.cjs
node --check MicroFederation/project-node-registry.cjs
node --test MicroFederation/test-project-node-registry.cjs
\`\`\`

CI also runs the two suites on Node 18, 20, and 22 through the MicroFederation durable-services workflow; the separate Command Center workflow verifies Node 20 and 22.
