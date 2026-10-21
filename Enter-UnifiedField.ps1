[CmdletBinding()]
param(
    [Parameter(Position=0)][string]$Prompt,
    [ValidateSet('ollama','openai','mistral','gemini')][string]$Provider = 'ollama',
    [string]$Model,
    [switch]$HealthOnly,
    [ValidateSet("Workers","Submit","Approve","Dispatch","List","Status","Audit")][string]$TaskAction,
    [string]$TaskJson,
    [string]$TaskId,
    [string]$ExtensionId,
    [string]$Actor,
    [string]$Reason
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Router = Join-Path $Root 'unified-field\provider-router.mjs'
$RegistryValidator = Join-Path $Root 'integrations\validate-extension-manifests.mjs'
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Node.js is not installed or is not on PATH.' }
if (-not [string]::IsNullOrWhiteSpace($TaskAction)) {
    $TaskHost = Join-Path $Root 'Invoke-UnifiedFieldTask.ps1'
    if (-not (Test-Path -LiteralPath $TaskHost -PathType Leaf)) { throw "Task host entry point missing: $TaskHost" }
    $TaskHostArguments = @('-Action', $TaskAction)
    if (-not [string]::IsNullOrWhiteSpace($TaskJson)) { $TaskHostArguments += @('-TaskJson', $TaskJson) }
    if (-not [string]::IsNullOrWhiteSpace($TaskId)) { $TaskHostArguments += @('-TaskId', $TaskId) }
    if (-not [string]::IsNullOrWhiteSpace($ExtensionId)) { $TaskHostArguments += @('-ExtensionId', $ExtensionId) }
    if (-not [string]::IsNullOrWhiteSpace($Actor)) { $TaskHostArguments += @('-Actor', $Actor) }
    if (-not [string]::IsNullOrWhiteSpace($Reason)) { $TaskHostArguments += @('-Reason', $Reason) }
    & $TaskHost @TaskHostArguments
    if ($LASTEXITCODE -ne 0) { throw "Task host failed with exit code $LASTEXITCODE." }
    return
}
if (-not (Test-Path -LiteralPath $Router -PathType Leaf)) { throw "Provider router missing: $Router" }
if (-not (Test-Path -LiteralPath $RegistryValidator -PathType Leaf)) { throw "Extension registry validator missing: $RegistryValidator" }
& $Node.Source $RegistryValidator
if ($LASTEXITCODE -ne 0) { throw "Extension manifest validation failed with exit code $LASTEXITCODE. No extension entrypoints were executed." }
Write-Host 'HeavenzFire Unified Field — explicit provider routing' -ForegroundColor Cyan
Write-Host ("Provider: {0}" -f $Provider)
if ($HealthOnly) {
    $uri = if ($env:HEAVENZFIRE_OLLAMA_URL) { $env:HEAVENZFIRE_OLLAMA_URL.TrimEnd('/') + '/api/tags' } else { 'http://127.0.0.1:11434/api/tags' }
    try {
        $tags = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 4
        Write-Host ("OLLAMA=HEALTHY; models={0}" -f (($tags.models | ForEach-Object { $_.name }) -join ', '))
        exit 0
    } catch {
        Write-Error ("OLLAMA=UNAVAILABLE; {0}" -f $_.Exception.Message)
        exit 2
    }
}
if ([string]::IsNullOrWhiteSpace($Prompt)) { $Prompt = Read-Host 'Enter research task' }
if ([string]::IsNullOrWhiteSpace($Prompt)) { throw 'A non-empty prompt is required.' }
$Arguments = @($Router, '--provider', $Provider)
if (-not [string]::IsNullOrWhiteSpace($Model)) { $Arguments += @('--model', $Model) }
$Arguments += $Prompt
& $Node.Source @Arguments
if ($LASTEXITCODE -ne 0) { throw "Provider request failed with exit code $LASTEXITCODE. No provider fallback was attempted." }
