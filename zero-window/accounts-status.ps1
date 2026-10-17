# accounts-status.ps1 - show every account of the ccgw pool and what identity
# each one is logged in as.
#
#   name / port / task state / whether the port is listening / gateway cooldown
#   / identity (e.g. "OpenCode Console / Personal (cred_...XAEPB)")
#
# Use it to verify a newly added account really is a different account:
# compare the accountID / email columns - a genuinely new account shows a
# different one. (The credential id is NOT reliable: it changes on every
# login, even for the same account.)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File zero-window\accounts-status.ps1
#   powershell -ExecutionPolicy Bypass -File zero-window\accounts-status.ps1 -Live
#     (-Live re-reads each account's integration list straight from its isolated
#      profile via opencode-cli and refreshes accounts.json; takes a few seconds
#      per account)
[CmdletBinding()]
param(
  [switch]$Live,
  [int]$GatewayPort = 8317,
  [string]$CliPath = ""
)
$ErrorActionPreference = "Stop"
$zw = $PSScriptRoot
$accountsFile = Join-Path $zw "accounts.json"
if (-not (Test-Path $accountsFile)) { throw "no accounts.json - run zero-window\setup.ps1 first" }
$cfg = Get-Content $accountsFile -Raw | ConvertFrom-Json

if ($Live -and -not $CliPath) {
  $cands = @()
  $cliRoot = Join-Path $env:APPDATA "ai.opencode.desktop\cli"
  if (Test-Path $cliRoot) {
    foreach ($d in Get-ChildItem $cliRoot -Directory | Sort-Object Name -Descending) {
      $exe = Join-Path $d.FullName "opencode-cli.exe"
      if (Test-Path $exe) { $cands += $exe }
    }
  }
  $prog = Join-Path $env:LOCALAPPDATA "Programs\@opencodedesktop\resources\opencode-cli.exe"
  if (Test-Path $prog) { $cands += $prog }
  $CliPath = $cands | Select-Object -First 1
}

$orig = @{ UP = $env:USERPROFILE; HM = $env:HOME; CFG = $env:XDG_CONFIG_HOME; DATA = $env:XDG_DATA_HOME; STATE = $env:XDG_STATE_HOME; CACHE = $env:XDG_CACHE_HOME }
function Set-ProfileEnv($home2) {
  if ($home2 -and (Test-Path $home2)) {
    $env:USERPROFILE = $home2; $env:HOME = $home2
    $env:XDG_CONFIG_HOME = "$home2\.config"; $env:XDG_DATA_HOME = "$home2\.local\share"
    $env:XDG_STATE_HOME = "$home2\.local\state"; $env:XDG_CACHE_HOME = "$home2\.cache"
  } else {
    $env:USERPROFILE = $orig.UP; $env:HOME = $orig.HM
    $env:XDG_CONFIG_HOME = $orig.CFG; $env:XDG_DATA_HOME = $orig.DATA
    $env:XDG_STATE_HOME = $orig.STATE; $env:XDG_CACHE_HOME = $orig.CACHE
  }
}

# gateway health (optional - shows cooldown state when the gateway is running)
$health = $null
try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$GatewayPort/health" -TimeoutSec 4 } catch {}

$updated = $false
$rows = @()
foreach ($a in $cfg.accounts) {
  $port = 0
  if ($a.url -match ':(\d+)/?$') { $port = [int]$Matches[1] }
  $taskState = "-"
  if ($a.task) {
    $t = Get-ScheduledTask -TaskName $a.task -ErrorAction SilentlyContinue
    if (-not $t) { $taskState = "missing" } else { $taskState = [string]$t.State }
  }
  $listening = [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)

  # account's isolated profile: <serviceFile dir>\home (main uses the real profile)
  $home2 = ""
  if ($a.serviceFile) {
    $sf = "$($a.serviceFile)"
    if (-not [IO.Path]::IsPathRooted($sf)) { $sf = Join-Path $zw $sf }
    $cand = Join-Path (Split-Path $sf -Parent) "home"
    if (Test-Path $cand) { $home2 = $cand }
  }

  if ($Live -and $CliPath -and $listening) {
    Set-ProfileEnv $home2
    $jtxt = (& $CliPath auth export --standalone 2>&1 | Out-String)
    try {
      foreach ($c in ($jtxt | ConvertFrom-Json)) {
        $idName = "OpenCode Console"
        if ($c.integrationID -and "$($c.integrationID)" -ne "opencode") { $idName = "$($c.integrationID)" }
        $id = "$idName / $($c.label)"
        $cid = "$($c.id)"
        $mail = ""; $aid = ""
        if ($c.value -and $c.value.metadata) { $mail = "$($c.value.metadata.email)"; $aid = "$($c.value.metadata.accountID)" }
        if ($a.identity -ne $id -or $a.credentialId -ne $cid -or "$($a.email)" -ne $mail -or "$($a.accountID)" -ne $aid) {
          $a | Add-Member -NotePropertyName identity -NotePropertyValue $id -Force
          $a | Add-Member -NotePropertyName credentialId -NotePropertyValue $cid -Force
          $a | Add-Member -NotePropertyName email -NotePropertyValue $mail -Force
          $a | Add-Member -NotePropertyName accountID -NotePropertyValue $aid -Force
          $updated = $true
        }
      }
    } catch {}
  }
  Set-ProfileEnv ""   # restore

  $identity = "(anonymous / not logged in)"
  if ($a.identity) { $identity = $a.identity }
  $cred = ""
  if ($a.credentialId) { $cred = "..." + ($a.credentialId -replace '^cred_', '').Substring([Math]::Max(0, ($a.credentialId -replace '^cred_', '').Length - 6)) }
  $cool = ""
  $fails = ""
  if ($health -and $health.accounts) {
    $ha = $health.accounts | Where-Object { $_.name -eq $a.name }
    if ($ha) { $cool = "$($ha.coolingSeconds)s"; $fails = [string]$ha.fails }
  }
  $email = ""
  if ($a.email) { $email = [string]$a.email }
  $rows += [pscustomobject]@{
    Name = $a.name; Port = $port; Task = $taskState; Listening = $listening
    Email = $email; Identity = $identity; CredId = $cred; Cooling = $cool; Fails = $fails
  }
}

if ($updated) {
  [IO.File]::WriteAllText($accountsFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
  Write-Host "(accounts.json refreshed from live profiles)"
}
if (-not $health) { Write-Host "(gateway not reachable on 127.0.0.1:$GatewayPort - cooldown columns empty)" }

$rows | Format-Table -AutoSize
