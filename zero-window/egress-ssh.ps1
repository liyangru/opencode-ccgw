param(
  [ValidateSet('start', 'stop', 'status', 'check')]
  [string]$Action = 'status',
  [string]$Target = '',
  [int]$ListenPort = 41800,
  [int]$SocksPort = 1080
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $root 'egress-ssh.mjs'
$targetFile = Join-Path $root 'egress-ssh.target'
$pidFile = Join-Path $root 'egress-ssh.pid'
$logFile = Join-Path $root 'egress-ssh.log'

function Get-Target {
  if ($Target) { return $Target }
  if (Test-Path $targetFile) {
    $t = (Get-Content $targetFile -Raw).Trim()
    if ($t) { return $t }
  }
  return ''
}

function Get-BridgeProc {
  if (-not (Test-Path $pidFile)) { return $null }
  $bridgePid = (Get-Content $pidFile -Raw).Trim()
  if (-not $bridgePid) { return $null }
  return Get-Process -Id ([int]$bridgePid) -ErrorAction SilentlyContinue
}

function Stop-Bridge {
  $p = Get-BridgeProc
  if ($p) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  # The bridge kills its ssh child on exit; sweep an orphan only when it
  # matches this target, so an unrelated ssh tunnel on the same SOCKS port is
  # left alone.
  $t = Get-Target
  if ($t) {
    Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
      Where-Object {
        $_.CommandLine -match 'ExitOnForwardFailure' -and
        $_.CommandLine -match ":$SocksPort\b" -and
        $_.CommandLine -match [regex]::Escape($t)
      } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  return [bool]$p
}

switch ($Action) {
  'check' {
    $t = Get-Target
    if (-not $t) { "ERROR: no target (pass -Target user@host or write zero-window/egress-ssh.target)"; exit 2 }
    & node $script --target $t --check
    exit $LASTEXITCODE
  }
  'start' {
    $t = Get-Target
    if (-not $t) { "ERROR: no target (pass -Target user@host or write zero-window/egress-ssh.target)"; exit 2 }
    [void](Stop-Bridge)
    Start-Sleep -Milliseconds 500
    $nodeArgs = @($script, '--target', $t, '--listen-port', $ListenPort, '--socks-port', $SocksPort)
    $p = Start-Process -FilePath 'node' -ArgumentList $nodeArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput $logFile -RedirectStandardError "$logFile.err"
    Set-Content -Path $pidFile -Value $p.Id
    $ok = $false
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 750
      if ($p.HasExited) { break }
      if (Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
    }
    if (-not $ok) {
      "ERROR: bridge did not listen on 127.0.0.1:$ListenPort (see $logFile)"
      if (Test-Path $logFile) { Get-Content $logFile -Tail 10 | ForEach-Object { "  $_" } }
      [void](Stop-Bridge)
      exit 1
    }
    "listening=127.0.0.1:$ListenPort socks=127.0.0.1:$SocksPort target=$t pid=$($p.Id)"
    "next: set CCGW_EGRESS_UPSTREAM=http://127.0.0.1:$ListenPort in zero-window\gateway.vbs, then restart ccgw-gateway"
  }
  'stop' {
    $was = Stop-Bridge
    if ($was) { "stopped" } else { "not running" }
  }
  'status' {
    $p = Get-BridgeProc
    if ($p) { "running pid=$($p.Id)" } else { "stopped" }
    $listen = Get-NetTCPConnection -LocalPort $ListenPort -State Listen -ErrorAction SilentlyContinue
    "listen=$(if ($listen) { '127.0.0.1:' + $ListenPort } else { 'none' })"
    $t = Get-Target
    "target=$(if ($t) { $t } else { '(unset)' })"
    if (Test-Path $logFile) { "log=$logFile" }
  }
}
