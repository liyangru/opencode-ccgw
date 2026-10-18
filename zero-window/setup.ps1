# ccgw zero-window setup: register a headless OpenCode server + the ccgw gateway
# as logon scheduled tasks (no windows, auto-restart on failure).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File zero-window\setup.ps1
# Add more accounts later (multi-account pool, spreads rate limits):
#   powershell -ExecutionPolicy Bypass -File zero-window\add-account.ps1 -Name acct5
# Options:
#   -ServePort 4096                 headless OpenCode server port
#   -GatewayPort 8317               ccgw gateway port
#   -Model deepseek-v4.1-flash-free default model
#   -CliPath <opencode-cli.exe>     skip auto-detect
#
# Re-running resets the server password and overwrites the two launchers.
[CmdletBinding()]
param(
  [int]$ServePort = 4096,
  [int]$GatewayPort = 8317,
  [string]$Model = "deepseek-v4.1-flash-free",
  [string]$CliPath = ""
)
$ErrorActionPreference = "Stop"
$zw = $PSScriptRoot
$root = Split-Path $zw -Parent

# --- locate node
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "C:\Program Files\nodejs\node.exe" }
if (-not (Test-Path $node)) { throw "node.exe not found - install Node.js 18+ first." }

# --- locate opencode-cli (bundled with the OpenCode desktop app)
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
if (-not $CliPath -or -not (Test-Path $CliPath)) {
  throw "opencode-cli.exe not found - install the OpenCode desktop app or pass -CliPath <path>."
}

# --- fixed random password for the headless server
$chars = (48..57) + (65..90) + (97..122)
$pw = -join ($chars | Get-Random -Count 40 | ForEach-Object { [char]$_ })
Set-Content -Path (Join-Path $zw "headless-service.json") -Value ("{""password"":""$pw""}") -Encoding Ascii

# --- hidden launchers (VBS, UTF-16, wait-on-child so the task lives as long as the process)
$serve = @"
Set sh = CreateObject("WScript.Shell")
sh.Environment("PROCESS")("OPENCODE_SERVER_PASSWORD") = "$pw"
rc = sh.Run("""$CliPath"" serve --hostname 127.0.0.1 --port $ServePort", 0, True)
WScript.Quit rc
"@
Set-Content -Path (Join-Path $zw "serve.vbs") -Value $serve -Encoding Unicode

$gw = @"
Set sh = CreateObject("WScript.Shell")
Set env = sh.Environment("PROCESS")
env("CCGW_MODEL") = "$Model"
env("CCGW_PORT") = "$GatewayPort"
env("CCGW_OPENCODE_URL") = "http://127.0.0.1:$ServePort"
env("CCGW_SERVICE_FILE") = "$zw\headless-service.json"
env("CCGW_ACCOUNTS_FILE") = "$zw\accounts.json"
env("CCGW_LOG") = "$root\ccgw.log"
sh.CurrentDirectory = "$root"
rc = sh.Run("""$node"" ""$root\server.mjs""", 0, True)
WScript.Quit rc
"@
Set-Content -Path (Join-Path $zw "gateway.vbs") -Value $gw -Encoding Unicode

# --- scheduled tasks (logon trigger, restart on failure)
$set = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$act1 = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$zw\serve.vbs`""
$trg1 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName "ccgw-serve-headless" -Action $act1 -Trigger $trg1 -Settings $set `
  -Description "ccgw: headless OpenCode server on 127.0.0.1:$ServePort" -Force | Out-Null
$act2 = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$zw\gateway.vbs`""
$trg2 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$trg2.Delay = "PT20S"
Register-ScheduledTask -TaskName "ccgw-gateway" -Action $act2 -Trigger $trg2 -Settings $set `
  -Description "ccgw: gateway on 127.0.0.1:$GatewayPort" -Force | Out-Null

# --- net-guard (optional): handle the backup egress when the whole pool is
# rate-limited at once. The backend comes from zero-window\net-guard.backend
# (warp / nord / vpngate / none); registered when WARP or NordVPN is present.
# Falls back to an HKCU Run entry when task registration is denied.
$nordExe = "C:\Program Files\NordVPN\NordVPN.exe"
$warpExe = "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe"
if ((Test-Path $nordExe) -or (Test-Path $warpExe)) {
  $ngVbs = Join-Path $zw "net-guard.vbs"
  try {
    $act3 = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$ngVbs`""
    $trg3 = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    Register-ScheduledTask -TaskName "ccgw-netguard" -Action $act3 -Trigger $trg3 -Settings $set `
      -Description "ccgw: backup-egress guard (net-guard.backend) when the whole account pool is rate-limited" -Force | Out-Null
  } catch {
    Write-Warning "ccgw-netguard task not registered ($($_.Exception.Message)); using HKCU Run key"
    Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "ccgw-netguard" `
      -Value ('wscript.exe "' + $ngVbs + '"')
  }
} else {
  Write-Host "(No WARP / NordVPN found - skipping ccgw-netguard registration; see README)"
}

# --- WARP keepalive (optional): a windowless watchdog that reconnects WARP if it
# drops (the backup egress the free tier accepts). Harmless when WARP is absent:
# the script logs one line and exits.
$warpCli = "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe"
if (Test-Path $warpCli) {
  try {
    $wgVbs = Join-Path $zw "warp-guard.vbs"
    $wgAct = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$wgVbs`""
    $wgTrg = @(
      (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME),
      (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 10) -RepetitionDuration (New-TimeSpan -Days 3650))
    )
    $wgSet = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
    Register-ScheduledTask -TaskName "ccgw-warp-guard" -Action $wgAct -Trigger $wgTrg -Settings $wgSet `
      -Description "ccgw: reconnect WARP backup egress if it drops; never disconnects" -Force | Out-Null
  } catch {
    Write-Warning "ccgw-warp-guard task not registered ($($_.Exception.Message))"
  }
}

# --- account pool config (seeded with the headless server above; add more
# accounts later with zero-window\add-account.ps1, then restart the gateway)
$accountsFile = Join-Path $zw "accounts.json"
if (-not (Test-Path $accountsFile)) {
  $seed = @{ accounts = @(@{ name = "main"; url = "http://127.0.0.1:$ServePort"; serviceFile = "headless-service.json"; task = "ccgw-serve-headless" }) }
  [IO.File]::WriteAllText($accountsFile, ($seed | ConvertTo-Json -Depth 6), (New-Object Text.UTF8Encoding($false)))
}

Write-Host ""
Write-Host "Done. Zero-window chain configured:"
Write-Host "  server : $CliPath serve  ->  127.0.0.1:$ServePort"
Write-Host "  gateway: $node server.mjs  ->  127.0.0.1:$GatewayPort"
Write-Host ""
Write-Host "Start now : zero-window\start.cmd"
Write-Host "Stop      : zero-window\stop.cmd"
Write-Host "Add more accounts (optional): zero-window\add-account.ps1 -Name acct5"
Write-Host "(Both tasks start automatically at logon and restart on failure.)"
