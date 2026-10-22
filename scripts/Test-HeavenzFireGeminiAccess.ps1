#requires -Version 5.1
<#
.SYNOPSIS
  Tests an already-configured Gemini API key without changing billing or account settings.
.DESCRIPTION
  This diagnostic never creates API keys, enables billing, requests a payment method,
  writes credentials, or prints the key. If GEMINI_API_KEY is absent, it reports that
  the direct API route cannot yet be tested and checks local HeavenzFire bridge health.
#>
[CmdletBinding()]
param(
    [string]$Model = 'gemini-2.5-flash',
    [switch]$SkipLocalBridgeChecks
)

$ErrorActionPreference = 'Stop'
$apiKey = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'Process')
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User')
}
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    $apiKey = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'Machine')
}

Write-Output 'HeavenzFire Gemini zero-billing diagnostic'
Write-Output ('Model requested: {0}' -f $Model)
Write-Output 'Billing changes: none. API-key creation: none. Secret output: disabled.'

if (-not $SkipLocalBridgeChecks) {
    foreach ($port in @(18888, 18889)) {
        $uri = 'http://127.0.0.1:{0}/health' -f $port
        try {
            $health = Invoke-RestMethod -Method Get -Uri $uri -TimeoutSec 3
            Write-Output ('LOCAL_BRIDGE port={0} ok={1} service={2}' -f $port, $health.ok, $health.service)
            if ($port -eq 18888 -and $null -ne $health.PSObject.Properties['geminiConfigured']) {
                Write-Output ('BRIDGE_KEY_CONFIGURED={0}' -f [bool]$health.geminiConfigured)
            }
            if ($port -eq 18889 -and $null -ne $health.PSObject.Properties['oauthConnected']) {
                Write-Output ('GOOGLE_OAUTH_CONNECTED={0}' -f [bool]$health.oauthConnected)
            }
        } catch {
            Write-Output ('LOCAL_BRIDGE port={0} unavailable_or_unreadable' -f $port)
        }
    }
}

if ([string]::IsNullOrWhiteSpace($apiKey)) {
    Write-Output 'RESULT=BLOCKED_NO_EXISTING_GEMINI_API_KEY'
    Write-Output 'NEXT=Obtain or locate an already-authorized key through an eligible free-tier route; do not enable billing for this test.'
    exit 2
}

$endpoint = 'https://generativelanguage.googleapis.com/v1beta/models/{0}:generateContent?key={1}' -f $Model, $apiKey
$body = @{
    contents = @(
        @{
            parts = @(
                @{ text = 'Reply with exactly: HEAVENZFIRE_GEMINI_ZERO_BILLING_TEST_OK' }
            )
        }
    )
    generationConfig = @{
        temperature = 0
        maxOutputTokens = 32
    }
} | ConvertTo-Json -Depth 8

try {
    $response = Invoke-RestMethod -Method Post -Uri $endpoint -ContentType 'application/json' -Body $body -TimeoutSec 30
    $textParts = @()
    foreach ($candidate in @($response.candidates)) {
        foreach ($part in @($candidate.content.parts)) {
            if ($part.text) { $textParts += [string]$part.text }
        }
    }
    $answer = ($textParts -join '').Trim()
    if ($answer -eq 'HEAVENZFIRE_GEMINI_ZERO_BILLING_TEST_OK') {
        Write-Output 'HTTP_STATUS=200'
        Write-Output 'RESULT=PASS'
        Write-Output ('MODEL={0}' -f $Model)
        Write-Output 'AUTH=API_KEY'
        Write-Output 'BILLING_CONFIGURATION_CHANGED=false'
        exit 0
    }

    Write-Output 'HTTP_STATUS=200'
    Write-Output 'RESULT=INCONCLUSIVE_RESPONSE'
    Write-Output ('MODEL={0}' -f $Model)
    Write-Output ('RESPONSE_TEXT={0}' -f ($answer -replace '[\r\n]+', ' ').Substring(0, [Math]::Min(240, $answer.Length)))
    exit 3
} catch {
    $statusCode = $null
    $responseBody = ''
    try {
        $httpResponse = $_.Exception.Response
        if ($null -ne $httpResponse) {
            $statusCode = [int]$httpResponse.StatusCode
            $stream = $httpResponse.GetResponseStream()
            if ($null -ne $stream) {
                $reader = New-Object System.IO.StreamReader($stream)
                $responseBody = $reader.ReadToEnd()
                $reader.Dispose()
            }
        }
    } catch { }

    if ($null -ne $statusCode) { Write-Output ('HTTP_STATUS={0}' -f $statusCode) }
    else { Write-Output 'HTTP_STATUS=NO_HTTP_RESPONSE' }

    # Error bodies from the API do not need the request URI or key. Never print exception text.
    if ($responseBody -match 'API_KEY_INVALID|API key not valid|invalid API key') {
        Write-Output 'ERROR_CLASS=INVALID_API_KEY'
    } elseif ($responseBody -match 'PERMISSION_DENIED|permission|IAM') {
        Write-Output 'ERROR_CLASS=PERMISSION_OR_POLICY'
    } elseif ($responseBody -match 'billing|BILLING') {
        Write-Output 'ERROR_CLASS=BILLING_OR_PROJECT_ELIGIBILITY'
    } elseif ($responseBody -match 'RESOURCE_EXHAUSTED|quota|QUOTA') {
        Write-Output 'ERROR_CLASS=QUOTA_OR_RATE_LIMIT'
    } elseif ($responseBody -match 'not found|NOT_FOUND|unsupported') {
        Write-Output 'ERROR_CLASS=MODEL_OR_ENDPOINT_UNAVAILABLE'
    } else {
        Write-Output 'ERROR_CLASS=UNCLASSIFIED'
    }

    Write-Output ('ERROR_SUMMARY={0}' -f (($responseBody -replace '[\r\n]+', ' ') -replace '(?i)(key=)[^&\s"]+', '$1[REDACTED]').Substring(0, [Math]::Min(500, (($responseBody -replace '[\r\n]+', ' ') -replace '(?i)(key=)[^&\s"]+', '$1[REDACTED]').Length)))
    Write-Output 'BILLING_CONFIGURATION_CHANGED=false'
    exit 4
}
