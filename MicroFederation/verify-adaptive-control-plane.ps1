[CmdletBinding()]
param(
    [switch]$SkipExistingRegression
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js 18 or later is required.' }

$version = (& node --version).Trim()
if ($version -notmatch '^v?(\d+)\.') { throw "Unable to parse Node.js version: $version" }
if ([int]$Matches[1] -lt 18) { throw "Node.js 18+ required; found $version." }

$required = @(
    'adaptive-control-plane.cjs',
    'bootstrap-adaptive-control-plane.cjs',
    'test-adaptive-control-plane.cjs',
    'task-ledger.cjs',
    'capability-store.cjs'
)
foreach ($name in $required) {
    $file = Join-Path $root $name
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Required file missing: $file" }
}

Write-Host "Node.js: $version"
Write-Host 'Checking adaptive control plane syntax...'
& node --check (Join-Path $root 'adaptive-control-plane.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Adaptive control plane syntax check failed.' }
& node --check (Join-Path $root 'bootstrap-adaptive-control-plane.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Adaptive control plane bootstrap syntax check failed.' }

Write-Host 'Running adaptive control plane tests...'
& node --test (Join-Path $root 'test-adaptive-control-plane.cjs')
if ($LASTEXITCODE -ne 0) { throw 'Adaptive control plane tests failed.' }

if (-not $SkipExistingRegression) {
    $suites = @(
        @{ File = 'test-micro-federation.cjs'; Mode = 'script' },
        @{ File = 'test-federation-services.cjs'; Mode = 'script' },
        @{ File = 'test-provider-registry.cjs'; Mode = 'test' },
        @{ File = 'test-task-ledger.cjs'; Mode = 'test' },
        @{ File = 'test-ledger-orchestrator-worker.cjs'; Mode = 'test' },
        @{ File = 'test-capability-store.cjs'; Mode = 'test' },
        @{ File = 'semantic-acceptance.test.cjs'; Mode = 'test' },
        @{ File = 'shared-task-adapter.test.cjs'; Mode = 'test' }
    )
    foreach ($suite in $suites) {
        $file = Join-Path $root $suite.File
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            Write-Host "SKIP: $($suite.File) not present in this checkout."
            continue
        }
        Write-Host "Running $($suite.File)..."
        if ($suite.Mode -eq 'test') {
            & node --test $file
        } else {
            & node $file
        }
        if ($LASTEXITCODE -ne 0) { throw "Regression suite failed: $($suite.File)" }
    }
}

Write-Host ''
Write-Host 'HEAVENZFIRE ADAPTIVE CONTROL PLANE: VERIFICATION PASSED'
Write-Host 'No workers were started. No model tasks were enqueued. No live services were modified.'
