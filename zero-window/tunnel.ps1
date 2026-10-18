param(
  [ValidateSet('start', 'stop', 'status', 'url', 'probe', 'clients')]
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
  # Scope to this gateway: a cloudflared the user runs for something else must
  # survive start/stop of the ccgw tunnel. The metrics port is a unique marker
  # of a tunnel started by this script.
  Get-CimInstance Win32_Process -Filter "Name = 'cloudflared.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -match '20241' -or $_.CommandLine -match [regex]::Escape($gateway)) }
}

function Wait-PortFree([int]$port, [int]$seconds = 10) {
  for ($i = 0; $i -lt ($seconds * 2); $i++) {
    if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Get-TunnelMetrics {
  for ($i = 0; $i -lt 5; $i++) {
    try {
      return (Invoke-WebRequest 'http://127.0.0.1:20241/metrics' -TimeoutSec 3 -UseBasicParsing -ErrorAction Stop).Content
    } catch { Start-Sleep -Seconds 1 }
  }
  return $null
}

function Stop-Tunnel {
  $procs = @(Get-TunnelProcs)
  foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  return $procs.Count
}

function Get-HttpStatus([string]$url, [hashtable]$headers) {
  # Use HttpClient with UseProxy=false: the machine's system proxy (WARP/Nord)
  # intermittently blackholes trycloudflare.com, which made this probe report a
  # false failure even though the tunnel was registered.
  Add-Type -AssemblyName System.Net.Http -ErrorAction SilentlyContinue
  $handler = New-Object System.Net.Http.HttpClientHandler
  $handler.UseProxy = $false
  $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
  $client.Timeout = [TimeSpan]::FromSeconds(12)
  $last = 0
  try {
    for ($i = 0; $i -lt 10; $i++) {
      try {
        $req = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::Get), $url
        foreach ($k in $headers.Keys) { [void]$req.Headers.TryAddWithoutValidation($k, [string]$headers[$k]) }
        $resp = $client.SendAsync($req).GetAwaiter().GetResult()
        $code = [int]$resp.StatusCode
        $resp.Dispose()
        $req.Dispose()
        $last = $code
        if ($code -lt 500) { return $code }
      } catch {
        # timeout / DNS not ready yet
      }
      Start-Sleep -Seconds 3
    }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
  return $last
}

function Test-PublicHealth([string]$url) {
  if (-not $url) { return @{ ok = $false; reason = 'no url' } }
  $token = Get-Token
  if (-not $token) { return @{ ok = $false; reason = 'no token in gateway.vbs' } }
  # Wait for the tunnel to actually carry traffic first; probing anonymously
  # while the hostname is still propagating burns the retry budget and reports
  # a false failure.
  $auth = Get-HttpStatus "$url/health" @{ Authorization = "Bearer $token" }
  $anon = Get-HttpStatus "$url/health" @{}
  return @{ ok = ($auth -eq 200 -and $anon -eq 401); anon = $anon; auth = $auth }
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
  'clients' {
    # Answers "is anyone actually using the tunnel?" without relying on the
    # gateway log (cloudflared lands on loopback, so the gateway cannot tell
    # tunnel traffic from local clients by address).
    $m = Get-TunnelMetrics
    if (-not $m) { "metrics=unavailable (tunnel not running)"; exit 1 }
    $lines = $m -split "`n" | Where-Object { $_ -match '^cloudflared_(tunnel_(total_requests|request_errors|active_connections|ha_connections)|tunnel_total_requests)' }
    if (-not $lines) { $lines = $m -split "`n" | Where-Object { $_ -match '^cloudflared_.*(request|connection)' } | Select-Object -First 12 }
    $lines | ForEach-Object { "  " + $_.Trim() }
  }
  'stop' {
    $n = Stop-Tunnel
    Remove-Item (Join-Path $root 'tunnel.pid') -Force -ErrorAction SilentlyContinue
    "stopped $n cloudflared process(es)"
  }
  'start' {
    [void](Stop-Tunnel)
    if (-not (Wait-PortFree 20241 10)) {
      # A stale connector that did not match the scope still owns the metrics
      # port; without this the new cloudflared exits and the edge serves 530.
      $owner = (Get-NetTCPConnection -LocalPort 20241 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess
      $ownProc = if ($owner) { Get-Process -Id $owner -ErrorAction SilentlyContinue } else { $null }
      if ($ownProc -and $ownProc.ProcessName -eq 'cloudflared') {
        Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
      } elseif ($ownProc) {
        "ERROR: metrics port 20241 is held by $($ownProc.ProcessName) (pid $owner), not cloudflared"
        exit 1
      }
      if (-not (Wait-PortFree 20241 5)) { "ERROR: metrics port 20241 is still in use"; exit 1 }
    }
    if (Test-Path $log) { Move-Item $log "$log.old" -Force }
    $proc = Start-Process -FilePath $cloudflared -WindowStyle Hidden -PassThru -ArgumentList @(
      'tunnel', '--no-autoupdate', '--url', $gateway, '--logfile', $log, '--loglevel', 'info', '--metrics', '127.0.0.1:20241'
    )
    Set-Content -Path (Join-Path $root 'tunnel.pid') -Value $proc.Id
    $url = $null
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 750
      if ($proc.HasExited) { break }
      $url = Get-TunnelUrl
      if ($url) { break }
    }
    if (-not $url) {
      if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
      [void](Stop-Tunnel)
      "ERROR: no trycloudflare url after 30s (tunnel stopped)"
      exit 1
    }
    "url=$url"
    $r = Test-PublicHealth $url
    "anonymous=$($r.anon) authorized=$($r.auth) ok=$($r.ok) $($r.reason)"
    if (-not $r.ok) {
      # Never leave a public endpoint up when the token gate is unproven.
      if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
      $n = Stop-Tunnel
      Remove-Item (Join-Path $root 'tunnel.pid') -Force -ErrorAction SilentlyContinue
      "cleanup: stopped $n tunnel process(es) after a failed probe"
      exit 2
    }
  }
}
