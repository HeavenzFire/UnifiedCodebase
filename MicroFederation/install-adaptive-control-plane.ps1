[CmdletBinding()]
param(
    [switch]$SkipGitUpdate
)

$ErrorActionPreference = 'Stop'
$moduleRoot = $PSScriptRoot
$repoRoot = Split-Path -Parent $moduleRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 18 or later is required.' }
$version = (& node --version).Trim()
if ($version -notmatch '^v?(\d+)\.' -or [int]$Matches[1] -lt 18) {
    throw "Node.js 18 or later is required; found $version."
}

if (-not $SkipGitUpdate) {
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { throw 'Git is required unless -SkipGitUpdate is specified.' }
    $dirty = @(& git -C $repoRoot status --porcelain --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Git worktree; refusing update.' }
    # Preserve the known recovery snapshot; never stage, overwrite, or delete it.
    $unsafe = @($dirty | Where-Object {
        $_ -notmatch '^\?\?\s+MicroFederation[\\/]mesh-queue-recovery\.json
    Write-Host 'Updating the clean checkout from origin/main...'
    & git -C $repoRoot pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw 'Git fast-forward update failed.' }
}

$verifier = Join-Path $moduleRoot 'verify-adaptive-control-plane.ps1'
$bootstrap = Join-Path $moduleRoot 'bootstrap-adaptive-control-plane.cjs'
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw 'Verification script is missing.' }
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'Bootstrap script is missing.' }

Write-Host 'Running adaptive control plane and regression verification...'
& $verifier
if ($LASTEXITCODE -ne 0) { throw 'Verification failed; bootstrap was not started.' }

Write-Host 'Initializing persistent control-plane state and collecting host telemetry...'
& node $bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Control-plane bootstrap failed.' }

Write-Host ''
Write-Host 'HEAVENZFIRE ADAPTIVE CONTROL PLANE INSTALLED AND BOOTSTRAPPED.'
Write-Host 'No workers or model tasks were started. Configure real provider adapters before enabling evolutionary execution.'
 -and
        $_ -notmatch '^\?\?\s+mesh-queue-recovery\.json
    Write-Host 'Updating the clean checkout from origin/main...'
    & git -C $repoRoot pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw 'Git fast-forward update failed.' }
}

$verifier = Join-Path $moduleRoot 'verify-adaptive-control-plane.ps1'
$bootstrap = Join-Path $moduleRoot 'bootstrap-adaptive-control-plane.cjs'
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw 'Verification script is missing.' }
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'Bootstrap script is missing.' }

Write-Host 'Running adaptive control plane and regression verification...'
& $verifier
if ($LASTEXITCODE -ne 0) { throw 'Verification failed; bootstrap was not started.' }

Write-Host 'Initializing persistent control-plane state and collecting host telemetry...'
& node $bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Control-plane bootstrap failed.' }

Write-Host ''
Write-Host 'HEAVENZFIRE ADAPTIVE CONTROL PLANE INSTALLED AND BOOTSTRAPPED.'
Write-Host 'No workers or model tasks were started. Configure real provider adapters before enabling evolutionary execution.'

    })
    if ($unsafe.Count -gt 0) {
        throw ('Worktree has other local changes. Preserve or commit them before updating; no files were changed: ' + ($unsafe -join '; '))
    }
    Write-Host 'Updating the clean checkout from origin/main...'
    & git -C $repoRoot pull --ff-only origin main
    if ($LASTEXITCODE -ne 0) { throw 'Git fast-forward update failed.' }
}

$verifier = Join-Path $moduleRoot 'verify-adaptive-control-plane.ps1'
$bootstrap = Join-Path $moduleRoot 'bootstrap-adaptive-control-plane.cjs'
if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) { throw 'Verification script is missing.' }
if (-not (Test-Path -LiteralPath $bootstrap -PathType Leaf)) { throw 'Bootstrap script is missing.' }

Write-Host 'Running adaptive control plane and regression verification...'
& $verifier
if ($LASTEXITCODE -ne 0) { throw 'Verification failed; bootstrap was not started.' }

Write-Host 'Initializing persistent control-plane state and collecting host telemetry...'
& node $bootstrap
if ($LASTEXITCODE -ne 0) { throw 'Control-plane bootstrap failed.' }

Write-Host ''
Write-Host 'HEAVENZFIRE ADAPTIVE CONTROL PLANE INSTALLED AND BOOTSTRAPPED.'
Write-Host 'No workers or model tasks were started. Configure real provider adapters before enabling evolutionary execution.'
