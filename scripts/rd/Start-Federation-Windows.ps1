param(
    [string]$RepoRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '../..')).Path
)

$ErrorActionPreference = 'Stop'

$RepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
$NodeEntry = Join-Path $RepoRoot 'MicroFederation\federation-node.cjs'
$ExampleConfig = Join-Path $RepoRoot 'scripts\rd\federation-node-config.example.cjs'

if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    throw "UnifiedCodebase repository not found at $RepoRoot"
}
if (-not (Test-Path $NodeEntry)) {
    throw "Federation node entrypoint missing: $NodeEntry"
}

$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) {
    throw 'Node.js is required; this launcher does not install packages.'
}

$Branch = (& git -C $RepoRoot branch --show-current).Trim()
if ($LASTEXITCODE -ne 0 -or $Branch -ne 'research/cross-device-federation-rd-v0.1') {
    throw "Expected branch research/cross-device-federation-rd-v0.1; found '$Branch'."
}

$env:HF_UNIFIEDCODEBASE_ROOT = $RepoRoot
if (-not $env:HF_FEDERATION_NODE_CONFIG) {
    $env:HF_FEDERATION_NODE_CONFIG = $ExampleConfig
}
if (-not (Test-Path $env:HF_FEDERATION_NODE_CONFIG)) {
    throw "Federation config module not found: $env:HF_FEDERATION_NODE_CONFIG"
}

$Required = @(
    'HF_SHARED_TASK_CONTRACT_MODULE',
    'HF_FEDERATION_PEERS_JSON',
    'HF_OPERATOR_APPROVAL_SECRET',
    'HF_FEDERATION_AGENT_ID',
    'HF_FEDERATION_GRANT_ID',
    'HF_FEDERATION_TASK_ID'
)
foreach ($Name in $Required) {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($Name))) {
        throw "$Name is required. No service was started."
    }
}

if ($env:HF_OPERATOR_APPROVAL_SECRET.Length -lt 32) {
    throw 'HF_OPERATOR_APPROVAL_SECRET must contain at least 32 characters.'
}

$GrantVerifier = Join-Path $RepoRoot 'scripts\rd\verify-federation-grant.cjs'
& $Node.Source $GrantVerifier $env:HF_FEDERATION_AGENT_ID $env:HF_FEDERATION_GRANT_ID $env:HF_FEDERATION_TASK_ID
if ($LASTEXITCODE -ne 0) {
    throw 'Task-scoped capability grant verification failed. Federation node was not started.'
}

$InferenceBase = if ($env:HF_INFERENCE_BASE_URL) { $env:HF_INFERENCE_BASE_URL } else { 'http://127.0.0.1:11820' }
$InferenceHealth = Invoke-RestMethod -Uri ($InferenceBase.TrimEnd('/') + '/health') -TimeoutSec 5
if (-not ($InferenceHealth.status -eq 'ok' -or $InferenceHealth.ok -eq $true)) {
    throw 'Local inference facade health check failed. Federation node was not started.'
}

$Port = if ($env:HF_FEDERATION_PORT) { $env:HF_FEDERATION_PORT } else { '18100' }
Write-Host '=== HEAVENZFIRE FEDERATION NODE PREFLIGHT ===' -ForegroundColor Cyan
Write-Host "BRANCH=$Branch"
Write-Host "NODE_CONFIG=$($env:HF_FEDERATION_NODE_CONFIG)"
Write-Host "INFERENCE=$InferenceBase"
Write-Host 'INFERENCE_HEALTH=PASS'
Write-Host 'BIND=127.0.0.1'
Write-Host "PORT=$Port"
Write-Host 'REMOTE_ACCESS=SSH_LOCAL_FORWARD_ONLY'
Write-Host 'APPROVAL=HMAC_OPERATOR_PROOF_REQUIRED'
Write-Host 'CAPABILITY_GATE=REQUIRED'
Write-Host 'Starting foreground node. Press Ctrl+C to stop.'
Write-Host

& $Node.Source $NodeEntry
if ($LASTEXITCODE -ne 0) {
    throw "Federation node exited with code $LASTEXITCODE"
}
