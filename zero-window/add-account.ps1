# add-account.ps1 — provision an extra OpenCode account for the ccgw pool.
#
# Each account runs its own headless `opencode-cli serve` on its own port with
# an isolated profile (separate USERPROFILE / XDG dirs), so logins, session
# stores and rate-limit quotas are fully separate. The gateway (server.mjs)
# reads zero-window\accounts.json and spreads requests across all accounts.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File zero-window\add-account.ps1 -Name acct2
#   powershell -ExecutionPolicy Bypass -File zero-window\add-account.ps1 -Name acct2 -Port 4097
#
# Then log the account in (one-time, opens a browser):
#   powershell -ExecutionPolicy Bypass -File zero-window\login-account.ps1 -Name acct2
#
# And restart the gateway so the pool picks it up:
#   Stop-ScheduledTask ccgw-gateway -ErrorAction SilentlyContinue; Start-ScheduledTask ccgw-gateway
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [int]$Port = 0,
  [string]$CliPath = ""
)
$ErrorActionPreference = "Stop"
$zw = $PSScriptRoot

if ($Name -notmatch '^[A-Za-z0-9_-]+$') { throw "Name must match [A-Za-z0-9_-]+ (got '$Name')" }

# --- locate opencode-cli (same detection order as setup.ps1)
if (-not $CliPath) {
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
if (-not $CliPath -or -not (Test-Path $CliPath)) { throw "opencode-cli.exe not found. Pass -CliPath <path>." }

# --- load (or seed) accounts.json
$accountsFile = Join-Path $zw "accounts.json"
if (Test-Path $accountsFile) {
  $cfg = Get-Content $accountsFile -Raw | ConvertFrom-Json
} else {
  $cfg = [pscustomobject]@{ accounts = @() }
  # keep the standard headless server (from setup.ps1) as the first account
  if (Test-Path (Join-Path $zw "headless-service.json")) {
    $mainUrl = "http://127.0.0.1:4096"
    $gwVbs = Join-Path $zw "gateway.vbs"
    if (Test-Path $gwVbs) {
      foreach ($line in (Get-Content $gwVbs -Encoding Unicode)) {
        if ($line -match 'CCGW_OPENCODE_URL"\)\s*=\s*"([^"]+)"') { $mainUrl = $Matches[1]; break }
      }
    }
    $cfg.accounts = @([pscustomobject]@{ name = "main"; url = $mainUrl; serviceFile = "headless-service.json"; task = "ccgw-serve-headless" })
  }
}
$list = @($cfg.accounts)
if ($list | Where-Object { $_.name -eq $Name }) { throw "account '$Name' already exists in accounts.json" }
if (-not $Port) {
  $used = @(4096)
  foreach ($a in $list) { if ($a.url -match ':(\d+)/?$') { $used += [int]$Matches[1] } }
  $Port = ($used | Measure-Object -Maximum).Maximum + 1
}

# --- isolated profile dir + fixed random password
$acctDir = Join-Path $zw "accounts\$Name"
if (Test-Path $acctDir) { throw "already exists: $acctDir" }
$home2 = Join-Path $acctDir "home"
New-Item -ItemType Directory -Force $home2 | Out-Null
$srcCfg = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
if (Test-Path $srcCfg) {
  New-Item -ItemType Directory -Force (Join-Path $home2 ".config\opencode") | Out-Null
  Copy-Item $srcCfg (Join-Path $home2 ".config\opencode\opencode.json") -Force
}
$chars = [char[]]((48..57) + (65..90) + (97..122))
$pw = -join ($chars | Get-Random -Count 40)
$serviceFile = Join-Path $acctDir "service.json"
[IO.File]::WriteAllText($serviceFile, "{""password"":""$pw""}", (New-Object Text.UTF8Encoding($false)))

# --- hidden launcher: per-account environment, then serve on its own port
$vbs = @"
Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("PROCESS")
env("USERPROFILE") = "$home2"
env("HOME") = "$home2"
env("XDG_CONFIG_HOME") = "$home2\.config"
env("XDG_DATA_HOME") = "$home2\.local\share"
env("XDG_STATE_HOME") = "$home2\.local\state"
env("XDG_CACHE_HOME") = "$home2\.cache"
env("OPENCODE_SERVER_PASSWORD") = "$pw"
rc = sh.Run("""$CliPath"" serve --hostname 127.0.0.1 --port $Port", 0, True)
WScript.Quit rc
"@
[IO.File]::WriteAllText((Join-Path $acctDir "serve.vbs"), $vbs, [Text.Encoding]::Unicode)

# --- logon scheduled task (no window, restarts on failure)
$taskName = "ccgw-serve-$Name"
$act = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$(Join-Path $acctDir 'serve.vbs')`""
$trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $act -Trigger $trg -Settings $set `
  -Description "ccgw: headless OpenCode account '$Name' on 127.0.0.1:$Port" -Force | Out-Null

# --- register in accounts.json (UTF-8, no BOM — JSON.parse-friendly)
$list += [pscustomobject]@{ name = $Name; url = "http://127.0.0.1:$Port"; serviceFile = "accounts/$Name/service.json"; task = $taskName }
$cfg.accounts = $list
[IO.File]::WriteAllText($accountsFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))

Start-ScheduledTask -TaskName $taskName

Write-Host ""
Write-Host "Account '$Name' provisioned." -ForegroundColor Green
Write-Host "  port    : $Port"
Write-Host "  profile : $home2"
Write-Host "  task    : $taskName (autostart at logon)"
Write-Host "  routing : $accountsFile"
Write-Host ""
Write-Host "Next:"
Write-Host "  1) log in (one-time, opens a browser):"
Write-Host "     powershell -ExecutionPolicy Bypass -File zero-window\login-account.ps1 -Name $Name"
Write-Host "  2) restart the gateway to load the account pool:"
Write-Host "     Stop-ScheduledTask ccgw-gateway -ErrorAction SilentlyContinue; Start-ScheduledTask ccgw-gateway"
