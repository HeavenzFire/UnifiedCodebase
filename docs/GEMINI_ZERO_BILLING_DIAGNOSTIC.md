# Gemini access test under the zero-dollar constraint

## Purpose

This is an evidence-first test of whether Gemini inference works with an **already authorized API key** and the existing project configuration. It does not assume that a free tier is available to every account, model, or project. It does not try to bypass Google's access controls.

## Hard constraints

- No payment card entry.
- No Cloud Billing activation or paid-tier upgrade.
- No API-key creation or IAM modification.
- No secret is printed or committed.
- Gemini is not considered integrated until a real inference request succeeds and its model and HTTP result are recorded.

## Run on Windows PowerShell 5.1

Save the script at `scripts/Test-HeavenzFireGeminiAccess.ps1` and run:

```powershell
$env:GEMINI_API_KEY = Read-Host 'Paste an existing Gemini API key for this process only'
.\scripts\Test-HeavenzFireGeminiAccess.ps1
Remove-Item Env:\GEMINI_API_KEY
```

Only use this when you already possess a key you're authorized to use. The script never writes the key to disk. If the environment variable is already configured securely, do not paste it again.

The script checks local health endpoints on ports 18888 and 18889, then sends a single low-token prompt to `gemini-2.5-flash`. It does not print the request URL or the key. Exit codes: 0 = exact expected response; 2 = no configured key; 3 = HTTP success but unexpected answer; 4 = request failed.

## Interpret the result

- `401` / invalid key: credential is invalid or revoked.
- `403` / permission or policy: inspect the returned error category and project/key restrictions.
- Billing/project eligibility: this is evidence of a project-level gate for this request, not proof that all Gemini products are paid.
- Quota/rate limit: access exists but this request is blocked by usage limits.
- Model/endpoint unavailable: the requested model or API endpoint is not available to this credential.
- Exact expected response: direct Gemini inference worked for this key and model during this test. It does not prove unlimited free use.

## When no key exists

A local bridge being healthy is not evidence of Gemini access. A successful Google sign-in is not evidence that a Gemini API key exists or that OAuth credentials are connected to this adapter. Do not invent a key, scrape browser storage, or weaken IAM/security controls. Capture the exact AI Studio or Cloud Console error, identify the missing permission or eligibility rule, and determine whether an already-authorized free-tier route exists.

## Architecture direction

Keep Gemini as a replaceable provider adapter behind the HeavenzFire policy gateway. Record provider, model, status, latency, and sanitized error class; never log keys, OAuth tokens, or full request URLs. The local Ollama path must remain independent of cloud billing state.
