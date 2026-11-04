# HeavenzFire Cross-Device Federation R&D launcher
# Windows PowerShell 5.1+; read-only preflight, workspace sync, local evidence.
$ErrorActionPreference = 'Stop'
$RepoUrl = 'https://github.com/HeavenzFire/UnifiedCodebase.git'
$Branch = 'research/cross-device-federation-rd-v0.1'
$Workspace = Join-Path $HOME 'HeavenzFire-RD'
$EvidenceDir = Join-Path $HOME '.heavenzfire\rd'
$EvidenceFile = Join-Path $EvidenceDir 'windows-preflight.json'

function Test-HttpJson([string]$Uri) {
    try {
        $r = Invoke-RestMethod -Uri $Uri -TimeoutSec 5
        return [PSCustomObject]@{ reachable = $true; response = $r; error = $null }
    } catch {
        return [PSCustomObject]@{ reachable = $false; response = $null; error = $_.Exception.Message }
    }
}

Write-Host '=== HEAVENZFIRE WINDOWS R&D ===' -ForegroundColor Cyan
$git = Get-Command git.exe -ErrorAction SilentlyContinue
if (-not $git) { throw 'Git for Windows is required; no packages were installed.' }

if (Test-Path (Join-Path $Workspace '.git')) {
    & git -C $Workspace fetch origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'Git fetch failed; existing workspace left intact.' }
    & git -C $Workspace switch $Branch
    if ($LASTEXITCODE -ne 0) { throw 'Branch switch failed; existing workspace left intact.' }
    & git -C $Workspace pull --ff-only origin $Branch
    if ($LASTEXITCODE -ne 0) { throw 'Fast-forward update failed; workspace left intact.' }
} elseif (Test-Path $Workspace) {
    throw "Workspace path exists but is not this Git checkout: $Workspace"
} else {
    & git clone --single-branch --branch $Branch $RepoUrl $Workspace
    if ($LASTEXITCODE -ne 0) { throw 'Git clone failed.' }
}

$doc = Join-Path $Workspace 'docs\research\CROSS-DEVICE-FEDERATION-RD-v0.1.md'
if (-not (Test-Path $doc)) { throw 'R&D specification is missing from the checked-out branch.' }

$backend = Test-HttpJson 'http://127.0.0.1:11800/health'
$facade = Test-HttpJson 'http://127.0.0.1:11820/health'
$record = [ordered]@{
    schema = 'heavenzfire.rd.preflight.v1'
    node = 'windows'
    timestamp_utc = [DateTime]::UtcNow.ToString('o')
    branch = $Branch
    commit = (& git -C $Workspace rev-parse HEAD).Trim()
    spec_present = $true
    backend_reachable = $backend.reachable
    backend_ok = [bool]($backend.reachable -and $backend.response.ok -eq $true)
    facade_reachable = $facade.reachable
    facade_ok = [bool]($facade.reachable -and $facade.response.status -eq 'ok')
    execution_mode = 'preflight-only'
}
New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$record | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $EvidenceFile -Encoding UTF8

[PSCustomObject]$record | Format-List
Write-Host "EVIDENCE=$EvidenceFile"
if (-not $facade.reachable -or $facade.response.status -ne 'ok') {
    Write-Warning 'R&D workspace ready; local inference facade is not healthy.'
    exit 2
}
Write-Host 'WINDOWS_RD_PREFLIGHT=PASS' -ForegroundColor Green
