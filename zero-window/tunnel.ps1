param(
  [ValidateSet('start', 'stop', 'status', 'url', 'probe')]
  [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $root 'tunnel.log'
$cloudflared = 'C:\Program Files (x86)\cloudflared\cloudflared.exe'
$gateway = 'http://127.0.0.1:8317'

function Get-Token {
  $vbs = Join-Path $root 'gateway.vbs'
  if (-not (Test-Path $vbs)) { return '' }
  $m = Select-String -Path $vbs -Pattern 'CCGW_TOKEN"\)\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return ''
}

function Get-TunnelUrl {
  if (-not (Test-Path $log)) { return $null }
  $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -AllMatches | Select-Object -Last 1
  if (-not $m) { return $null }
  return ([regex]::Match($m.Line, 'https://[a-z0-9-]+\.trycloudflare\.com')).Value
}

function Get-TunnelProcs {
  Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue
}

function Stop-Tunnel {
  $procs = @(Get-TunnelProcs)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  return $procs.Count
}

function Test-PublicHealth([string]$url) {
  if (-not $url) { return @{ ok = $false; reason = 'no url' } }
  $token = Get-Token
  $anon = $null
  $auth = $null
  try {
    $r = Invoke-WebRequest -Uri "$url/health" -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    $anon = [int]$r.StatusCode
  } catch {
    $anon = [int]$_.Exception.Response.StatusCode.value__
  }
  if (-not $token) { return @{ ok = $false; reason = 'no token in gateway.vbs'; anon = $anon } }
  try {
    $r = Invoke-WebRequest -Uri "$url/health" -TimeoutSec 20 -UseBasicParsing -ErrorAction Stop -Headers @{ Authorization = "Bearer $token" }
    $auth = [int]$r.StatusCode
  } catch {
    $auth = [int]$_.Exception.Response.StatusCode.value__
  }
  return @{ ok = ($anon -eq 401 -and $auth -eq 200); anon = $anon; auth = $auth }
}

switch ($Action) {
  'status' {
    $procs = @(Get-TunnelProcs)
    $url = Get-TunnelUrl
    if ($procs.Count -gt 0) { "running pid=$($procs.ProcessId -join ',')" } else { "stopped" }
    if ($url) { "url=$url" }
    if (Test-Path $log) {
      $errs = (Select-String -Path $log -Pattern 'Tunnel not found').Count
      "tunnel-not-found-errors=$errs"
    }
    $task = schtasks /Query /TN ccgw-tunnel /FO CSV /NH 2>$null
    if ($LASTEXITCODE -eq 0) { "task=$($task -join ' ')" }
  }
  'url' {
    $u = Get-TunnelUrl
    if ($u) { $u } else { exit 1 }
  }
  'probe' {
    $u = Get-TunnelUrl
    $r = Test-PublicHealth $u
    "url=$u"
    "anonymous=$($r.anon) authorized=$($r.auth) ok=$($r.ok) $($r.reason)"
    if (-not $r.ok) { exit 1 }
  }
  'stop' {
    $n = Stop-Tunnel
    "stopped $n cloudflared process(es)"
  }
  'start' {
    [void](Stop-Tunnel)
    Start-Sleep -Seconds 1
    if (Test-Path $log) { Move-Item $log "$log.old" -Force }
    Start-Process -FilePath $cloudflared -WindowStyle Hidden -ArgumentList @(
      'tunnel', '--no-autoupdate', '--url', $gateway, '--logfile', $log, '--loglevel', 'info'
    )
    $url = $null
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 750
      $url = Get-TunnelUrl
      if ($url) { break }
    }
    if (-not $url) { "ERROR: no trycloudflare url after 30s"; exit 1 }
    "url=$url"
    $r = Test-PublicHealth $url
    "anonymous=$($r.anon) authorized=$($r.auth) ok=$($r.ok) $($r.reason)"
    if (-not $r.ok) { exit 2 }
  }
}
