[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)]
    [ValidateSet('Workers','Submit','Approve','Revoke','Dispatch','List','Status','Audit','StartInbox')]
    [string]$Action,
    [string]$TaskJson,
    [string]$TaskId,
    [string]$ExtensionId,
    [string]$Actor,
    [string]$Reason,
    [ValidateRange(1,65535)][int]$InboxPort = 18796,
    [string]$InboxFilePath
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Cli = Join-Path $Root 'integrations\worker-host-cli.mjs'
$InboxCli = Join-Path $Root 'integrations\shared-task-inbox.mjs'
$Node = Get-Command node -ErrorAction SilentlyContinue
if (-not $Node) { throw 'Node.js is not installed or is not on PATH.' }
if (-not (Test-Path -LiteralPath $Cli -PathType Leaf)) { throw "Worker host CLI missing: $Cli" }

switch ($Action) {
    'Workers' { & $Node.Source $Cli 'workers' }
    'List'    { & $Node.Source $Cli 'list' }
    'Status'  { & $Node.Source $Cli 'status' }
    'Audit'   { & $Node.Source $Cli 'audit' }
    'StartInbox' {
        if (-not (Test-Path -LiteralPath $InboxCli -PathType Leaf)) { throw "Shared task inbox server missing: $InboxCli" }
        if ([string]::IsNullOrWhiteSpace($InboxFilePath)) {
            & $Node.Source $InboxCli '--port' $InboxPort
        } else {
            & $Node.Source $InboxCli '--port' $InboxPort '--file' $InboxFilePath
        }
    }
    'Submit'  {
        if ([string]::IsNullOrWhiteSpace($TaskJson)) { throw 'Submit requires -TaskJson containing a JSON task object.' }
        $TaskJson | & $Node.Source $Cli 'submit' '-'
    }
    'Approve' {
        if ([string]::IsNullOrWhiteSpace($TaskId) -or [string]::IsNullOrWhiteSpace($Actor) -or [string]::IsNullOrWhiteSpace($Reason)) {
            throw 'Approve requires -TaskId, -Actor, and -Reason.'
        }
        & $Node.Source $Cli 'approve' $TaskId $Actor $Reason
    }
    'Revoke' {
        if ([string]::IsNullOrWhiteSpace($TaskId) -or [string]::IsNullOrWhiteSpace($Actor) -or [string]::IsNullOrWhiteSpace($Reason)) {
            throw 'Revoke requires -TaskId, -Actor, and -Reason.'
        }
        & $Node.Source $Cli 'revoke' $TaskId $Actor $Reason
    }
    'Dispatch' {
        if ([string]::IsNullOrWhiteSpace($TaskId) -or [string]::IsNullOrWhiteSpace($ExtensionId) -or
            [string]::IsNullOrWhiteSpace($Actor) -or [string]::IsNullOrWhiteSpace($Reason)) {
            throw 'Dispatch requires -TaskId, -ExtensionId, -Actor, and -Reason.'
        }
        & $Node.Source $Cli 'dispatch' $TaskId $ExtensionId $Actor $Reason
    }
}
if ($LASTEXITCODE -ne 0) { throw "Unified Field task host failed with exit code $LASTEXITCODE." }
