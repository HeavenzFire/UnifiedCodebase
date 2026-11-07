# HeavenzFire Local GPT Inference Engine

**Status:** repository implementation with automated tests. A live host launch must be completed on the authorized Windows or Termux machine; GitHub CI cannot launch a process on that device.

This component is a local OpenAI-compatible inference facade around a local llama.cpp server. It does not contain GPT-6 weights and does not claim to reproduce GPT-6. The actual model weights are GGUF files selected by the operator and executed by llama-server.

## Architecture

- llama-server loads and executes the selected local GGUF model.
- local-inference-engine.cjs is the HeavenzFire-owned loopback facade for health, model discovery, request validation, and chat completion proxying.
- Start-LocalInferenceEngine.ps1 provides Windows PowerShell 5.1-compatible startup and a conservative model-memory gate.
- Existing Agent Command Center and orchestrator clients can use http://127.0.0.1:11820/v1 as an OpenAI-compatible base URL.

Supported routes:
- GET /health and GET /api/health (reports the configured loopback `backendUrl` so the Windows launcher can reject a pre-existing facade bound to a different backend)
- GET /v1/models
- POST /v1/chat/completions (JSON and Server-Sent Events streaming)

The facade forwards requests only to an HTTP loopback backend. It rejects remote backend URLs, non-loopback bind addresses, invalid message roles, oversized bodies, excessive message counts, and invalid token budgets. The default bind is 127.0.0.1; it is not exposed to LAN, Tailscale, or the public internet.

## Windows startup

From PowerShell 5.1, with the repository checked out:

    Set-Location <checkout>\MicroFederation
    .\Start-LocalInferenceEngine.ps1

This reuses the existing llama.cpp backend at 127.0.0.1:11801 (the separate gateway may use 11800) and launches the facade on 127.0.0.1:11820. If the backend is not healthy, the script stops rather than silently downloading a model or changing an existing service.

To explicitly start a model backend after checking available RAM:

    .\Start-LocalInferenceEngine.ps1 -StartBackend -LlamaServerPath 'C:\path\to\llama-server.exe' -ModelPath 'C:\path\to\model.gguf' -BackendUrl 'http://127.0.0.1:11801' -Port 11820 -ContextSize 1024

The launcher estimates free-memory demand as model file size × 1.35 + 1.5 GiB. This is a conservative admission heuristic, not a guarantee of runtime memory usage. It refuses to start a new backend if observed free RAM is below that estimate. It never kills or replaces an existing backend.

## Android / Termux startup

The Termux launcher reuses the existing loopback llama.cpp backend and does not install packages, download models, stop services, or expose a network interface.

From the repository checkout:

    bash MicroFederation/Start-LocalInferenceEngine-Termux.sh

Defaults are backend `http://127.0.0.1:18080`, facade bind `127.0.0.1`, and facade port `11820`. Override only when the local backend is actually listening elsewhere:

    export HEAVENZFIRE_INFERENCE_BACKEND='http://127.0.0.1:18080'
    export HEAVENZFIRE_INFERENCE_HOST='127.0.0.1'
    export HEAVENZFIRE_INFERENCE_PORT='11820'
    bash MicroFederation/Start-LocalInferenceEngine-Termux.sh

The launcher checks the backend's `/health` endpoint before starting the facade. It stays in the foreground; Ctrl+C stops the facade only and leaves the existing llama.cpp process untouched. It refuses non-loopback binds and does not create an SSH tunnel or remote access path.

## API usage

    $body = @{
      model = 'heavenzfire-local'
      messages = @(
        @{ role = 'system'; content = 'You are the local HeavenzFire assistant.' },
        @{ role = 'user'; content = 'Explain the current project architecture.' }
      )
      max_tokens = 256
    } | ConvertTo-Json -Depth 8

    Invoke-RestMethod -Uri 'http://127.0.0.1:11820/v1/chat/completions' -Method Post -ContentType 'application/json' -Body $body

OpenAI SDK clients can use base_url http://127.0.0.1:11820/v1. If the SDK requires an API key, use a placeholder only; the loopback facade does not use API-key authentication.

Do not expose this unauthenticated loopback service beyond the host. Remote access requires a separately designed authenticated transport.

## Existing orchestrator integration

Configure the local orchestrator/gateway provider base URL as http://127.0.0.1:11820/v1 only after the facade passes health, model-discovery, and chat acceptance tests. Preserve existing provider selection and no-silent-fallback policy.

## Verification

    node --check .\local-inference-engine.cjs
    node --test .\test-local-inference-engine.cjs

Tests use an in-process fake backend and verify loopback restrictions, request validation, health, model discovery, JSON chat completions, streaming passthrough, and Origin rejection. They do not prove that a real model is loaded or that host performance is adequate.

## Operational limits

- This is a local inference API and facade, not a newly trained foundation model.
- Model quality, context window, tool use, and throughput depend on the chosen GGUF and llama.cpp build.
- The Windows host has constrained memory. The current host inventory identifies 11800 as the gateway and 11801 as the llama.cpp backend; verify the live listener before overriding this default. Prefer reusing a healthy existing backend; do not start another model process unless the launcher's memory check passes.
- No model is downloaded automatically.
- No remote provider fallback is implemented.
- No model weights, API keys, prompt contents, or credentials are written to the repository.
- The engine does not expose shell, filesystem, or browser tools.
