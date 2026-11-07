[CmdletBinding()]
param(
    [string]$BackendUrl = 'http://127.0.0.1:11801',
    [int]$Port = 11820,
    [switch]$StartBackend,
    [string]$LlamaServerPath = '',
    [string]$ModelPath = '',
    [int]$ContextSize = 1024
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Node.js 18 or newer is required.' }
$NodeVersion = (& node --version).Trim()
if ($NodeVersion -notmatch '^v(18|19|20|21|22|23|24|25|26)\.') { throw "Unsupported Node.js version: $NodeVersion" }

function Test-HttpReady([string]$Url) {
    try {
        $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
        return ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300)
    } catch { return $false }
}
$BackendUri = [Uri]$BackendUrl
if ($BackendUri.Scheme -ne 'http' -or $BackendUri.Host -notin @('127.0.0.1','localhost','::1') -or $BackendUri.UserInfo -or $BackendUri.Query -or $BackendUri.Fragment) {
    throw 'Backend URL must be plain HTTP loopback without credentials, query, or fragment.'
}
$BackendHealth = ($BackendUrl.TrimEnd('/') + '/health')
if (-not (Test-HttpReady $BackendHealth)) {
    if (-not $StartBackend) { throw "No healthy local inference backend at $BackendHealth. Start the existing llama-server, or rerun with -StartBackend and explicit model paths." }
    if (-not $LlamaServerPath -or -not (Test-Path -LiteralPath $LlamaServerPath -PathType Leaf)) { throw '-LlamaServerPath must point to an existing llama-server executable.' }
    if (-not $ModelPath -or -not (Test-Path -LiteralPath $ModelPath -PathType Leaf)) { throw '-ModelPath must point to an existing GGUF model file.' }
    $Model = Get-Item -LiteralPath $ModelPath
    if ($Model.Extension -ne '.gguf') { throw 'ModelPath must identify a GGUF file.' }
    if ($ContextSize -lt 512 -or $ContextSize -gt 32768) { throw 'ContextSize must be between 512 and 32768.' }
    $Os = Get-CimInstance Win32_OperatingSystem
    $FreeBytes = [int64]$Os.FreePhysicalMemory * 1KB
    $RequiredBytes = [int64]($Model.Length * 1.35 + 1.5GB)
    if ($FreeBytes -lt $RequiredBytes) {
        $free = [math]::Round($FreeBytes / 1GB, 2)
        $need = [math]::Round($RequiredBytes / 1GB, 2)
        throw ('Insufficient free RAM to start model safely. Free=' + $free + 'GB; conservative estimate=' + $need + 'GB. Existing services were not changed.')
    }
    $BackendPort = $BackendUri.Port
    $LogDir = Join-Path $env:USERPROFILE '.heavenzfire\local-inference'
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $OutLog = Join-Path $LogDir 'llama-server.stdout.log'
    $ErrLog = Join-Path $LogDir 'llama-server.stderr.log'
    $Args = '-m "' + $Model.FullName + '" --host 127.0.0.1 --port ' + $BackendPort + ' -c ' + $ContextSize + ' -np 1 --alias heavenzfire-local'
    Start-Process -FilePath $LlamaServerPath -ArgumentList $Args -WorkingDirectory (Split-Path -Parent $LlamaServerPath) -WindowStyle Hidden -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog | Out-Null
    $deadline = (Get-Date).AddMinutes(3)
    do { Start-Sleep -Seconds 2; if (Test-HttpReady $BackendHealth) { break } } while ((Get-Date) -lt $deadline)
    if (-not (Test-HttpReady $BackendHealth)) { throw "llama-server did not become healthy. Inspect $ErrLog" }
}
$EngineHealth = "http://127.0.0.1:$Port/health"
$ExistingEngine = $null
try { $ExistingEngine = Invoke-RestMethod -Uri $EngineHealth -TimeoutSec 2 } catch {}
if ($ExistingEngine) {
    $ExpectedBackend = $BackendUri.GetLeftPart([System.UriPartial]::Authority)
    if ($ExistingEngine.engine -ne 'heavenzfire-local-inference' -or
        $ExistingEngine.status -ne 'ok' -or $ExistingEngine.backendUrl -ne $ExpectedBackend) {
        throw "Port $Port already has a listener, but its inference backend cannot be verified as $ExpectedBackend. No process was stopped or replaced."
    }
    Write-Output "HeavenzFire Local Inference Engine already running with verified backend: $ExpectedBackend"
    Write-Output "API_BASE=http://127.0.0.1:$Port/v1"
    exit 0
}
if (Test-NetConnection -ComputerName 127.0.0.1 -Port $Port -InformationLevel Quiet) {
    throw "Port $Port is occupied by an unverified listener. No process was stopped or replaced."
}
$LogDir = Join-Path $env:USERPROFILE '.heavenzfire\local-inference'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$env:HEAVENZFIRE_INFERENCE_BACKEND = $BackendUrl
$env:HEAVENZFIRE_INFERENCE_HOST = '127.0.0.1'
$env:HEAVENZFIRE_INFERENCE_PORT = "$Port"
$OutLog = Join-Path $LogDir 'engine.stdout.log'
$ErrLog = Join-Path $LogDir 'engine.stderr.log'
$Entry = Join-Path $Root 'local-inference-engine.cjs'
$Process = Start-Process -FilePath $Node.Source -ArgumentList ('"' + $Entry + '"') -WorkingDirectory $Root -WindowStyle Hidden -PassThru -RedirectStandardOutput $OutLog -RedirectStandardError $ErrLog
$deadline = (Get-Date).AddSeconds(20)
do {
    Start-Sleep -Milliseconds 500
    if (Test-HttpReady $EngineHealth) {
        Write-Output 'HEAVENZFIRE_LOCAL_INFERENCE=READY'
        Write-Output "API_BASE=http://127.0.0.1:$Port/v1"
        Write-Output "HEALTH=$EngineHealth"
        Write-Output "PID=$($Process.Id)"
        Write-Output "MODEL_LIST=http://127.0.0.1:$Port/v1/models"
        exit 0
    }
} while ((Get-Date) -lt $deadline)
throw "Local inference facade failed to start. PID=$($Process.Id). Inspect $ErrLog"
