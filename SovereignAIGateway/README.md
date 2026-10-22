# Sovereign AI Gateway (MVP)

A local-first, provider-independent HTTP gateway. This first slice routes chat requests only to a loopback Ollama service. It never silently falls back to a cloud provider.

## Principles
- Local inference by default; no cloud credentials required.
- Bind to `127.0.0.1` by default.
- No prompt or response bodies in audit logs.
- No shell, filesystem, browser, GitHub, or agent-tool execution in this MVP.
- This is a routing boundary, **not** an OS sandbox or a security audit.

## Requirements
Python 3.10+; no third-party Python packages. Ollama is optional for tests, required for live inference.

## Run in Windows PowerShell 5.1
```powershell
Set-Location .\SovereignAIGateway
$env:SAG_HOST = "127.0.0.1"
$env:SAG_PORT = "8765"
$env:SAG_OLLAMA_URL = "http://127.0.0.1:11434"
$env:SAG_OLLAMA_MODEL = "llama3.2:1b"
python .\gateway.py
```

In another PowerShell window:
```powershell
Invoke-RestMethod http://127.0.0.1:8765/health
Invoke-RestMethod http://127.0.0.1:8765/v1/providers

$body = @{
  model = "local"
  messages = @(@{ role = "user"; content = "Reply: local gateway works" })
} | ConvertTo-Json -Depth 8

Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8765/v1/chat/completions -ContentType "application/json" -Body $body
```

## Tests
```powershell
python -m unittest discover -s tests -v
```
Tests use a fake loopback provider; they do not require Ollama or internet access.

## Endpoints
- `GET /health`
- `GET /v1/providers`
- `POST /v1/chat/completions` — minimal OpenAI-compatible chat response shape.

## Configuration
- `SAG_HOST` default `127.0.0.1`
- `SAG_PORT` default `8765`
- `SAG_OLLAMA_URL` default `http://127.0.0.1:11434`
- `SAG_OLLAMA_MODEL` default `llama3.2:1b`
- `SAG_MAX_BODY_BYTES` default `1048576`
- `SAG_TIMEOUT_SECONDS` default `90`

Do not expose this unauthenticated service to a LAN or the internet. Before network access, add authentication, TLS, rate limiting, and reviewed access controls.

## Roadmap
1. Prove live local inference on supported Windows/Python/Ollama versions.
2. Add provider adapters with explicit enablement and no implicit fallback.
3. Add a least-privilege policy engine and human approval gates for tools.
4. Add truthful worker heartbeats and ALIVE/DARK reasons.
5. Add optional speech and music adapters as separate capabilities.
6. Publish threat model, compatibility matrix, and reproducible release checks.
