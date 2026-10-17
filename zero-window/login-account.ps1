# login-account.ps1 — one-time browser login for an account instance created by
# add-account.ps1.
#
# Runs `opencode-cli auth login --standalone` with the account's isolated
# profile environment, so the credentials land in that account only (its own
# quota). The main profile is never touched.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File zero-window\login-account.ps1 -Name acct2
#   powershell -ExecutionPolicy Bypass -File zero-window\login-account.ps1 -Name acct2 -Target opencode
#   (-Target "" opens the interactive integration picker instead)
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [string]$Target = "opencode",
  [string]$CliPath = ""
)
$ErrorActionPreference = "Stop"
$zw = $PSScriptRoot
$acctDir = Join-Path $zw "accounts\$Name"
if (-not (Test-Path (Join-Path $acctDir "home"))) { throw "account '$Name' not found - run zero-window\add-account.ps1 first" }
$home2 = Join-Path $acctDir "home"

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

# --- point the CLI at this account's isolated profile
$env:USERPROFILE = $home2
$env:HOME = $home2
$env:XDG_CONFIG_HOME = "$home2\.config"
$env:XDG_DATA_HOME = "$home2\.local\share"
$env:XDG_STATE_HOME = "$home2\.local\state"
$env:XDG_CACHE_HOME = "$home2\.cache"

Write-Host "Logging into account '$Name'" -ForegroundColor Cyan
Write-Host "  isolated profile: $home2"
Write-Host ""

# --standalone: run a private server with this environment instead of talking
# to the desktop app's background service (which would write to the main
# profile instead of this account's).
if ($Target) {
  & $CliPath auth login --standalone $Target
} else {
  & $CliPath auth login --standalone
}

Write-Host ""
Write-Host "Authenticated integrations for '$Name':"
$jtxt = (& $CliPath auth list --standalone --format json 2>&1 | Out-String)
$identity = ""
$credId = ""
try {
  foreach ($i in ($jtxt | ConvertFrom-Json)) {
    foreach ($c in $i.connections) {
      $identity = "$($i.name) / $($c.label)"
      $credId = "$($c.id)"
    }
  }
  if ($identity) { Write-Host "  $identity  ($credId)" }
  else { Write-Host "  no integration found - login may not have completed" }
} catch { Write-Host "  (could not read integration list: $($_.Exception.Message))" }

# Record the identity in accounts.json so the gateway /health and
# accounts-status.ps1 can tell accounts apart. Logging the SAME account in
# again keeps the same credential id; a genuinely new account gets a new one.
if ($identity) {
  $accountsFile = Join-Path $zw "accounts.json"
  if (Test-Path $accountsFile) {
    $cfg = Get-Content $accountsFile -Raw | ConvertFrom-Json
    foreach ($a in $cfg.accounts) {
      if ($a.name -eq $Name) {
        $a | Add-Member -NotePropertyName identity -NotePropertyValue $identity -Force
        $a | Add-Member -NotePropertyName credentialId -NotePropertyValue $credId -Force
      }
    }
    [IO.File]::WriteAllText($accountsFile, ($cfg | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
    Write-Host "  identity recorded in accounts.json"
  }
}

Write-Host ""
Write-Host "Restart its serve instance so it picks up the credentials:"
Write-Host "  Stop-ScheduledTask ccgw-serve-$Name -ErrorAction SilentlyContinue; Start-ScheduledTask ccgw-serve-$Name"
Write-Host "Check all accounts: powershell -ExecutionPolicy Bypass -File zero-window\accounts-status.ps1"
