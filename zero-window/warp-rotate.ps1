# warp-rotate.ps1 -- keep ccgw's upstream egress alive by rotating the WARP edge when the free tier says no.
#
# Why this exists (2026-10-18):
#   The free tier answers two different 403s:
#     "detected abusive traffic from this IP address"  -> egress/IP level (this file acts on it)
#     "free tier can only be used from within OpenCode" -> client fingerprint level (rotation cannot fix it)
#   A gateway request therefore only proves success when it returns type=message.
#
# What it does NOT do:
#   - never changes the machine's routing beyond what WARP itself already is
#   - never switches the tunnel to full-tunnel mode; ccgw uses WARP's SOCKS5 listener only,
#     so the desktop OpenCode keeps its own native path
#   - never deletes or recreates the WARP registration (license/quota untouched)
#
# Actions:
#   status  show mode, tunnel state, egress IP seen through the proxy
#   check   one real gateway call; on refusal rotate until the gate serves (bounded)
#   rotate  force one rotation cycle (re-dial, then key rotation if the IP does not change)
#   pause / resume  create/remove zero-window\warp-rotate.pause
#
# Log: zero-window\warp-rotate.log (one line per action)
param(
  [ValidateSet("status","rotate","check","pause","resume")]
  [string]$Action = "status",
  [int]$MaxRotations = 6
)
$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $zw "warp-rotate.log"
$pause = Join-Path $zw "warp-rotate.pause"
$proxyPort = 41700
$warpCli = "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe"
$gw = "http://127.0.0.1:8317"

function LG([string]$m) {
  Add-Content -Path $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $m) -Encoding UTF8
}

function Warp-Mode {
  $s = (& $warpCli settings 2>&1 | Out-String)
  if ($s -match 'Mode:\s*WarpProxy') { return "proxy" }
  return "warp"
}

function Warp-Status {
  $s = (& $warpCli status 2>&1 | Out-String)
  if ($s -match "Connected") { return "connected" }
  if ($s -match "Connecting") { return "connecting" }
  return "disconnected"
}

function Warp-WaitConnected([int]$seconds = 60) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if ((Warp-Status) -eq "connected") {
      Start-Sleep -Seconds 3
      return $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

# Re-dial the tunnel: new Cloudflare edge/colocation and a new client IP.
function Warp-Dial {
  if ((Warp-Mode) -ne "proxy") {
    & $warpCli mode proxy 2>&1 | Out-Null
    & $warpCli proxy port $proxyPort 2>&1 | Out-Null
  }
  & $warpCli disconnect 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  & $warpCli connect 2>&1 | Out-Null
  return (Warp-WaitConnected 60)
}

# New WireGuard key pair (same registration) usually lands on a different address too.
function Warp-KeyRotate {
  & $warpCli tunnel rotate-keys 2>&1 | Out-Null
  & $warpCli disconnect 2>&1 | Out-Null
  Start-Sleep -Seconds 2
  & $warpCli connect 2>&1 | Out-Null
  return (Warp-WaitConnected 60)
}

function Egress-Ip {
  try {
    $t = (curl.exe -s -m 15 --socks5-hostname 127.0.0.1:$proxyPort https://www.cloudflare.com/cdn-cgi/trace 2>&1 | Out-String)
    $ip = ([regex]::Match($t, "ip=([^\r\n]+)")).Groups[1].Value
    $loc = ([regex]::Match($t, "loc=([^\r\n]+)")).Groups[1].Value
    $colo = ([regex]::Match($t, "colo=([^\r\n]+)")).Groups[1].Value
    if ($ip) { return "$ip loc=$loc colo=$colo" }
  } catch {}
  return $null
}

# One real gateway call. Only type=message means the free tier actually served us.
function Gate-Probe {
  $j = '{"model":"deepseek-v4.1-flash-free","stream":true,"max_tokens":16,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
  $f = Join-Path $env:TEMP "warp-rotate-probe.json"
  [IO.File]::WriteAllText($f, $j, (New-Object Text.UTF8Encoding($false)))
  $raw = (curl.exe -s -m 90 -H 'content-type: application/json' --data-binary "@$f" "$gw/v1/messages" 2>&1 | Out-String)
  if ($raw -match '"type"\s*:\s*"message"') { return @{ ok = $true; msg = "served" } }
  if ($raw -match 'abusive traffic') { return @{ ok = $false; msg = "abuse-403" } }
  if ($raw -match 'free tier can only be used from within') { return @{ ok = $false; msg = "fingerprint-403" } }
  if ($raw -match 'Rate limit exceeded|FreeUsageLimitError') { return @{ ok = $false; msg = "429" } }
  $m = ([regex]::Match($raw, '"message"\s*:\s*"([^"]{0,80})')).Groups[1].Value
  return @{ ok = $false; msg = ("other: " + $m) }
}

function Health-Refresh {
  # After an egress switch the gateway's in-memory pool still points at the old tunnel.
  # Restarting it costs a few seconds and clears stale per-model cooling.
  $p = Get-NetTCPConnection -LocalPort 8317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($p) { Stop-Process -Id $p.OwningProcess -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName "ccgw-gateway" | Out-Null
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 2
    try { $h = Invoke-RestMethod "$gw/health" -TimeoutSec 4; if ($h) { return $true } } catch {}
  }
  return $false
}

function Rotate-Once {
  $before = Egress-Ip
  LG ("rotate requested (current egress: " + $before + ")")
  $up = $false
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    $up = if ($attempt -eq 1) { Warp-Dial } else { Warp-KeyRotate }
    if (-not $up) { LG "  attempt $attempt : tunnel did not reconnect"; continue }
    Start-Sleep -Seconds 2
    $after = Egress-Ip
    if (-not $after) { LG "  attempt $attempt : tunnel up but no egress IP"; continue }
    if ($after -ne $before) { LG "  attempt $attempt : new egress $after"; break }
    LG "  attempt $attempt : same edge/IP again ($after)"
  }
  if (-not $up) { LG "rotate FAILED (tunnel did not come back)"; return $false }
  Health-Refresh | Out-Null
  $probe = Gate-Probe
  LG ("  gate after rotate: " + $probe.msg)
  return $probe.ok
}

switch ($Action) {
  "pause"  {
    Set-Content -Path $pause -Value ("paused " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")) -Encoding UTF8
    LG "paused by user"
    break
  }
  "resume" {
    if (Test-Path $pause) { Remove-Item $pause -Force }
    LG "resumed by user"
    break
  }
  "status" {
    $mode = if (Test-Path $warpCli) { Warp-Mode } else { "n/a" }
    $st = if (Test-Path $warpCli) { Warp-Status } else { "n/a" }
    $ip = if ($mode -eq "proxy") { Egress-Ip } else { "(full-tunnel mode: not proxied)" }
    "  warp mode       : $mode"
    "  warp status     : $st"
    "  proxy port      : $proxyPort"
    "  egress via proxy: $ip"
    "  paused          : $(Test-Path $pause)"
    "  log             : $log"
    break
  }
  "rotate" {
    if (Test-Path $pause) { LG "rotate skipped (paused)"; break }
    if (Rotate-Once) { "  rotated: the gate served a real reply from this egress" }
    else { "  rotated, but the gate still refuses this egress" }
    break
  }
  "check" {
    if (Test-Path $pause) { LG "check skipped (paused)"; break }
    $probe = Gate-Probe
    if ($probe.ok) { LG ("ok: " + (Egress-Ip)); break }    LG ("gate refused (" + $probe.msg + ") -> rotating")
    $done = 0
    for ($i = 1; $i -le $MaxRotations; $i++) {
      $done = $i
      if (Rotate-Once) { $probe = @{ ok = $true; msg = "served" }; break }
      $probe = Gate-Probe
      if ($probe.ok) { break }
    }
    if ($probe.ok) { LG ("recovered after $done rotation(s)") }
    else { LG "all $MaxRotations rotations refused by the gate; leaving the tunnel as-is" }
    break
  }
}
