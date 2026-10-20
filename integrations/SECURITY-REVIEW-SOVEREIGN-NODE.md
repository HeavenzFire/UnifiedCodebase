# Sovereign-Node- integration review

Reviewed against the repository default branch `main` at commit
`ddb9dc5d1e99e695b9fd57d9f973013e4897a769` on 2026-10-20.

## Verified entry points

- `package.json`: Vite/React app with an Express server, TypeScript, WebSocket support, and Google/OpenAI client dependencies.
- `server.ts` blob: `a5a43fed6435f02e7dd4a5ba88c5be0621ae1fe2`.
- `GET /api/health`: returns `{ "status": "ok" }`.
- `POST /seal`: accepts caller-supplied data and invokes the local seal implementation.
- `GET /api/vault`: returns recent seal history.
- `GET /api/mesh/nodes`: currently returns hard-coded sample nodes; do not treat these as live infrastructure telemetry.
- The HTTP server listens on `0.0.0.0:3000`, making it reachable on all interfaces unless the host/network restricts access.
- The WebSocket message handler parses client JSON without a local parse-error guard and can start/stop the engine.

## Integration decision

Only the read-only `GET /api/health` probe is connected through
`sovereign-node-adapter.mjs`. The adapter defaults to `127.0.0.1`, rejects non-loopback hosts,
uses a bounded timeout, sends no body, and never invokes seal, vault, or WebSocket actions.

Do not expose this service to untrusted networks or wire mutating endpoints into the orchestrator
until authentication, authorization, input validation, rate limits, and explicit network-boundary
controls have been reviewed and tested. Health status confirms only that the health endpoint
responded; it does not certify the whole service or the sample mesh data.
