[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    throw 'Node.js 18 or later is required. Install/configure Node.js, then rerun this verifier.'
}

$versionText = (& node --version).Trim()
if ($versionText -notmatch '^v?(\d+)\.') {
    throw "Could not parse Node.js version: $versionText"
}
$major = [int]$Matches[1]
if ($major -lt 18) {
    throw "Node.js 18 or later is required; found $versionText."
}

$module = Join-Path $PSScriptRoot 'provider-registry.cjs'
$tests = Join-Path $PSScriptRoot 'test-provider-registry.cjs'

Write-Host "Node.js: $versionText"
Write-Host 'Checking provider registry syntax...'
& node --check $module
if ($LASTEXITCODE -ne 0) {
    throw "Syntax check failed with exit code $LASTEXITCODE."
}

Write-Host 'Running provider registry tests...'
& node --test $tests
if ($LASTEXITCODE -ne 0) {
    throw "Provider registry tests failed with exit code $LASTEXITCODE."
}

Write-Host 'Provider registry verification passed.'
