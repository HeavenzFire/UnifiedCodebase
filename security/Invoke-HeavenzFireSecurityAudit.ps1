#requires -Version 5.1
<#
.SYNOPSIS
Read-only combined HeavenzFire credential/API exposure audit.
.DESCRIPTION
Scans authorized local working trees and optional authenticated GitHub code-search
results. Reports metadata only; never stores matched secret values or source excerpts.
Git history is not scanned. No rotation, deployment changes, endpoint probing, permission changes, or history rewrite.
#>
[CmdletBinding()]
param(
 [string[]]$Root = @(),
 [string]$OutputDirectory = (Join-Path $PWD 'HeavenzFire-SecurityAudit'),
 [string]$GitHubOwner = 'HeavenzFire',
 [switch]$GitHubCodeSearch,
 [int]$MaxFileSizeMB = 5
)
$ErrorActionPreference='Stop'
$runId=[Guid]::NewGuid().ToString('N')
$started=(Get-Date).ToUniversalTime().ToString('o')
$findings=New-Object System.Collections.Generic.List[object]
$inventory=New-Object System.Collections.Generic.List[object]
$notes=New-Object System.Collections.Generic.List[string]
$maxBytes=[long]$MaxFileSizeMB * 1MB
$extensions=@('.ps1','.psm1','.py','.js','.jsx','.ts','.tsx','.json','.yaml','.yml','.toml','.env','.config','.xml','.html','.cs','.go','.rs','.java','.properties','.txt','.md','.ini','.conf','.sh','.bat','.cmd','.tf','.ipynb','.pem','.key','.crt','.cer','.pub')
$excluded=@('\.git\','\node_modules\','\vendor\','\.venv\','\venv\','\bin\','\obj\','\dist\','\build\','\coverage\')
$rules=@(
 @{id='HF-CRED-001';severity='CRITICAL';category='Private key material';regex='-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----';fix='Validate owner and purpose; treat a real exposed key as compromised and replace/revoke after explicit approval.'},
 @{id='HF-CRED-002';severity='HIGH';category='Google API key candidate';regex='AIza[0-9A-Za-z_-]{30,}';fix='Validate in Google Cloud; restrict or rotate after approval; remove from source and history under an approved plan.'},
 @{id='HF-CRED-003';severity='HIGH';category='GitHub token candidate';regex='(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})';fix='Revoke/rotate through GitHub after approval; inspect scopes and audit activity.'},
 @{id='HF-CRED-004';severity='MEDIUM';category='Potential hardcoded credential assignment';regex='(?i)(?:api[_-]?key|client[_-]?secret|access[_-]?token|refresh[_-]?token|private[_-]?key|password)[ \t]*["'']?[ \t]*[:=][ \t]*["'']?[A-Za-z0-9_./+=:-]{12,}';fix='Manually distinguish real secrets from placeholders; use OS/CI secret storage and rotate confirmed exposure after approval.'},
 @{id='HF-API-001';severity='MEDIUM';category='Gemini endpoint configuration';regex='generativelanguage\.googleapis\.com';fix='Check server-side boundary, API-key restrictions, quotas and logs.'},
 @{id='HF-OAUTH-001';severity='MEDIUM';category='OAuth client secret reference';regex='(?i)client_secret';fix='Determine whether placeholder, variable name or secret; confidential secrets must remain server-side.'},
 @{id='HF-OAUTH-002';severity='MEDIUM';category='OAuth redirect configuration';regex='(?i)redirect_uris|redirect_uri';fix='Review exact allowlisted redirect URIs, state/PKCE, scopes and callback ownership.'},
 @{id='HF-APPS-001';severity='LOW';category='Apps Script deployment URL';regex='script\.google\.com/macros/s/';fix='Review deployment access, executing identity and data exposure.'},
 @{id='HF-API-002';severity='MEDIUM';category='Potential client-side provider key injection';regex='(?i)(?:process\.env\.(?:API_KEY|GEMINI_API_KEY)|import\.meta\.env\.(?:VITE_.*KEY|.*API_KEY))';fix='Check built browser assets; proxy confidential provider calls server-side.'}
)
function Add-Finding {
 param($Source,$Repository,$Path,$RuleId,$Severity,$Category,$EvidenceRef,$Status,$Remediation,$Line=0,$SourceHash='')
 $findings.Add([pscustomobject]@{run_id=$runId;observed_utc=(Get-Date).ToUniversalTime().ToString('o');source=$Source;repository=$Repository;path=$Path;line=$Line;rule_id=$RuleId;severity=$Severity;category=$Category;evidence_ref=$EvidenceRef;status=$Status;remediation=$Remediation;source_hash=$SourceHash;secret_value='[NOT COLLECTED]'})
}
$outFull=[IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $outFull -Force | Out-Null
foreach($r in $Root){
 if(-not(Test-Path -LiteralPath $r -PathType Container)){ $notes.Add("Root unavailable; not scanned: $r"); continue }
 $resolved=(Resolve-Path -LiteralPath $r).Path
 if($outFull.StartsWith($resolved.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'OutputDirectory must be outside scanned roots.'}
 $files=Get-ChildItem -LiteralPath $resolved -File -Recurse -Force -ErrorAction SilentlyContinue | Where-Object {
   $p=$_.FullName
   (@($excluded|Where-Object {$p -match [regex]::Escape($_)}).Count -eq 0 -and (($extensions -contains $_.Extension.ToLowerInvariant()) -or $_.Name -match '^\.env(?:\..+)?$') -and $_.Length -le $maxBytes)
 }
 foreach($f in $files){
  try{
   $content=[IO.File]::ReadAllText($f.FullName)
   $sha=(Get-FileHash -LiteralPath $f.FullName -Algorithm SHA256).Hash
   $inventory.Add([pscustomobject]@{path=$f.FullName;bytes=$f.Length;last_write_utc=$f.LastWriteTimeUtc.ToString('o');sha256=$sha})
   foreach($rule in $rules){
    $ruleMatches=[regex]::Matches($content,$rule.regex)
    foreach($m in $ruleMatches){
     $prefix=$content.Substring(0,[Math]::Min($m.Index,$content.Length))
     $line=1+([regex]::Matches($prefix,[string][char]10)).Count
     Add-Finding 'local_file' '' $f.FullName $rule.id $rule.severity $rule.category ('sha256:'+ $sha) 'REVIEW_REQUIRED' $rule.fix $line $sha
    }
   }
  }catch{$notes.Add("Read failed; content omitted: $($f.FullName)")}
 }
}
if($GitHubCodeSearch){
 $gh=Get-Command gh -ErrorAction SilentlyContinue
 if(-not $gh){$notes.Add('GitHub code search skipped: gh CLI is not installed.')}
 else{
  & gh auth status *> $null
  if($LASTEXITCODE -ne 0){$notes.Add('GitHub code search skipped: gh CLI is not authenticated.')}
  else{
   $queries=@(
    @{q='AIzaSy';id='HF-CRED-002';sev='HIGH';cat='Google API key candidate';fix=$rules[1].fix},
    @{q='"BEGIN PRIVATE KEY"';id='HF-CRED-001';sev='CRITICAL';cat='Private key material';fix=$rules[0].fix},
    @{q='GEMINI_API_KEY';id='HF-CRED-004';sev='HIGH';cat='Gemini key configuration';fix=$rules[3].fix},
    @{q='client_secret';id='HF-OAUTH-001';sev='MEDIUM';cat='OAuth client secret reference';fix=$rules[5].fix},
    @{q='script.google.com/macros/s/';id='HF-APPS-001';sev='LOW';cat='Apps Script deployment URL';fix=$rules[7].fix},
    @{q='generativelanguage.googleapis.com';id='HF-API-001';sev='MEDIUM';cat='Gemini endpoint configuration';fix=$rules[4].fix},
    @{q='github_pat_';id='HF-CRED-003';sev='HIGH';cat='GitHub token candidate';fix=$rules[2].fix}
   )
   foreach($q in $queries){
    try{
     $search='user:'+$GitHubOwner+' '+$q.q
     $raw=& gh api search/code -X GET -f q=$search -f per_page=100 2>$null
     if($LASTEXITCODE -ne 0 -or -not $raw){$notes.Add("GitHub search unavailable for "+$q.id);continue}
     $data=($raw -join [string][char]10)|ConvertFrom-Json
     foreach($item in $data.items){
      # Deliberately ignore text_matches and all source excerpts.
      Add-Finding 'github_code_search' $item.repository.full_name $item.path $q.id $q.sev $q.cat $item.html_url 'INDEXED_MATCH_REQUIRES_VALIDATION' $q.fix
     }
    }catch{$notes.Add("GitHub search error for "+$q.id+"; response content omitted.")}
   }
  }
 }
}
$findings=@($findings|Sort-Object source,repository,path,rule_id,line -Unique)
$inventory = $inventory.ToArray()
$stamp=(Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$report=[ordered]@{
 schema='heavenzfire.security-audit.v1';run_id=$runId;started_utc=$started;completed_utc=(Get-Date).ToUniversalTime().ToString('o')
 read_only=$true;changes_applied=$false;secret_values_collected=$false;roots_scanned=$Root;local_files_scanned=$inventory.Count;findings_total=$findings.Count
 findings_by_severity=@{CRITICAL=@($findings|Where-Object severity -eq 'CRITICAL').Count;HIGH=@($findings|Where-Object severity -eq 'HIGH').Count;MEDIUM=@($findings|Where-Object severity -eq 'MEDIUM').Count;LOW=@($findings|Where-Object severity -eq 'LOW').Count}
 limitations=@('GitHub code search covers indexed current/default-branch code; local Git history is not scanned.','Pattern matches are not proof that credentials are valid or abused.','Cloud, OAuth and Apps Script runtime settings require separate authorized API inspection.','No credentials, deployments, permissions or repository history were changed.')
 notes=@($notes);findings=$findings;inventory=$inventory
}
$json=Join-Path $outFull ("HF-SecurityAudit-"+$stamp+".json")
$csv=Join-Path $outFull ("HF-SecurityAudit-"+$stamp+".csv")
$plan=Join-Path $outFull ("HF-RemediationPlan-"+$stamp+".md")
$report|ConvertTo-Json -Depth 9|Set-Content -LiteralPath $json -Encoding UTF8
$findings|Export-Csv -LiteralPath $csv -NoTypeInformation -Encoding UTF8
$md=@"
# HeavenzFire Security Remediation Plan
Run ID: $runId
Generated UTC: $((Get-Date).ToUniversalTime().ToString('o'))
Findings: $($findings.Count)
No changes were applied.

## Triage
1. CRITICAL: validate private-key material. Preserve evidence and replace/revoke a real exposed key only after explicit approval.
2. HIGH: validate API/provider/token candidates, issuer restrictions, permissions and usage logs. Rotate only after approval.
3. MEDIUM: review OAuth redirects/scopes, client-side key injection, endpoint configuration and quota controls.
4. LOW: review Apps Script deployment access and execution identity.

## Per-finding workflow
1. Preserve source URL/path, commit or file hash, observation time and redacted metadata.
2. Confirm whether the match is a placeholder, public identifier, test fixture or actual secret. Do not copy values into tickets.
3. If confirmed exposed, replace/revoke through the issuer after approval.
4. Remove from current source, use a secret store and address Git history under a separately approved plan.
5. Verify the old credential is invalid, the replacement works, and a fresh scan is clean.
6. Close only after independent verification.

## Limits
This is a first-pass detector, not proof of compromise. GitHub search is not full history coverage. Cloud API and Apps Script access settings need authenticated authorized inspection. No changes were applied.
"@
Set-Content -LiteralPath $plan -Value $md -Encoding UTF8
[pscustomobject]@{ok=$true;run_id=$runId;local_files_scanned=$inventory.Count;findings=$findings.Count;critical=@($findings|Where-Object severity -eq 'CRITICAL').Count;high=@($findings|Where-Object severity -eq 'HIGH').Count;json=$json;csv=$csv;remediation_plan=$plan;read_only=$true;secret_values_collected=$false}|ConvertTo-Json -Depth 4
