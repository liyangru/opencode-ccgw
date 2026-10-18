param(
  [ValidateSet('wire', 'unwire', 'status')]
  [string]$Action = 'status',
  [string]$Target = '',
  [int]$ListenPort = 41800,
  [string]$IdentityFile = '',
  [int]$SshPort = 0
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $root 'gateway.vbs'
$bak = Join-Path $root 'gateway.vbs.egress-bak'
$bridgeScript = Join-Path $root 'egress-ssh.ps1'
$warpUpstream = 'http://127.0.0.1:41700'
$bridgeUpstream = "http://127.0.0.1:$ListenPort"

function Get-GatewayUpstream {
  if (-not (Test-Path $vbs)) { return '' }
  $m = Select-String -Path $vbs -Pattern 'CCGW_EGRESS_UPSTREAM"\)\s*=\s*"([^"]+)"' | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value }
  return ''
}

function Set-GatewayUpstream([string]$url) {
  $text = Get-Content $vbs -Raw
  $pattern = 'CCGW_EGRESS_UPSTREAM"\)\s*=\s*"[^"]*"'
  if (-not [regex]::IsMatch($text, $pattern)) { throw "gateway.vbs does not contain a CCGW_EGRESS_UPSTREAM line" }
  if (-not (Test-Path $bak)) { Copy-Item $vbs $bak -Force }
  $replacement = 'CCGW_EGRESS_UPSTREAM") = "' + $url + '"'
  $new = [regex]::Replace($text, $pattern, $replacement)
  # gateway.vbs is UTF-16LE (wscript needs the BOM); keep that encoding.
  Set-Content -Path $vbs -Value $new -Encoding Unicode -NoNewline
}

function Get-PreviousUpstream {
  $orig = $warpUpstream
  if (Test-Path $bak) {
    $m = Select-String -Path $bak -Pattern 'CCGW_EGRESS_UPSTREAM"\)\s*=\s*"([^"]+)"' | Select-Object -First 1
    if ($m) { $orig = $m.Matches[0].Groups[1].Value }
  }
  return $orig
}

function Restart-Gateway {
  $conn = Get-NetTCPConnection -LocalPort 8317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($conn) { Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue }
  for ($i = 0; $i -lt 20; $i++) {
    if (-not (Get-NetTCPConnection -LocalPort 8317 -State Listen -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  Start-ScheduledTask -TaskName ccgw-gateway
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $h = Invoke-RestMethod 'http://127.0.0.1:8317/health' -TimeoutSec 3
      if ($h.ok) { return $h }
    } catch {}
  }
  throw "gateway did not become healthy on 8317"
}

function Test-UpstreamTurn {
  $body = '{"model":"claude-opus-5","max_tokens":24,"messages":[{"role":"user","content":"Reply with exactly: EGRESS-WIRE-OK"}]}'
  $r = Invoke-WebRequest 'http://127.0.0.1:8317/v1/messages' -Method POST -TimeoutSec 180 -UseBasicParsing -Headers @{ 'content-type' = 'application/json' } -Body $body
  return ($r.StatusCode -eq 200 -and $r.Content -match 'EGRESS-WIRE-OK')
}

switch ($Action) {
  'status' {
    "gatewayUpstream=$(Get-GatewayUpstream)"
    "bridgeUpstream=$bridgeUpstream"
    "backup=$(if (Test-Path $bak) { $bak } else { '(none)' })"
    & $bridgeScript -Action status
    try {
      $h = Invoke-RestMethod 'http://127.0.0.1:8317/health' -TimeoutSec 5
      "health.ok=$($h.ok) egress.lastFamily=$($h.egress.lastFamily) connections=$($h.egress.connections) failures=$($h.egress.failures)"
    } catch { "health=unreachable" }
  }
  'wire' {
    if (-not $Target) {
      if (-not (Test-Path (Join-Path $root 'egress-ssh.target'))) {
        "ERROR: pass -Target user@host (or write zero-window/egress-ssh.target)"
        exit 2
      }
    }
    if ($Target) { Set-Content -Path (Join-Path $root 'egress-ssh.target') -Value $Target }
    "1/5 checking the SSH bridge end to end"
    $bridgeArgs = @{ ListenPort = $ListenPort }
    if ($Target) { $bridgeArgs.Target = $Target }
    if ($IdentityFile) { $bridgeArgs.IdentityFile = $IdentityFile }
    if ($SshPort -gt 0) { $bridgeArgs.SshPort = $SshPort }
    & $bridgeScript -Action check @bridgeArgs
    if ($LASTEXITCODE -ne 0) { "ERROR: bridge check failed; gateway left untouched"; exit 1 }

    "2/5 starting the bridge"
    & $bridgeScript -Action start @bridgeArgs

    try {
      "3/5 pointing the gateway at $bridgeUpstream"
      Set-GatewayUpstream $bridgeUpstream
      "4/5 restarting the gateway"
      $h = Restart-Gateway

      "5/5 proving a real turn through the bridge"
      if (-not (Test-UpstreamTurn)) { throw "turn did not return EGRESS-WIRE-OK" }
      $h2 = Invoke-RestMethod 'http://127.0.0.1:8317/health' -TimeoutSec 5
      if ($h2.egress.lastFamily -ne 'proxy' -or $h2.egress.connections -lt 1) {
        throw "gateway did not relay through the bridge (lastFamily=$($h2.egress.lastFamily) connections=$($h2.egress.connections))"
      }
      "OK upstream=$(Get-GatewayUpstream) egress.lastFamily=$($h2.egress.lastFamily) connections=$($h2.egress.connections)"
    } catch {
      "FAILED: $($_.Exception.Message)"
      $orig = Get-PreviousUpstream
      "rolling back to $orig"
      try { Set-GatewayUpstream $orig } catch {}
      try { [void](Restart-Gateway) } catch {}
      & $bridgeScript -Action stop
      "verifying the rollback with a real turn"
      try {
        if (-not (Test-UpstreamTurn)) { throw "turn did not return EGRESS-WIRE-OK" }
        $h3 = Invoke-RestMethod 'http://127.0.0.1:8317/health' -TimeoutSec 5
        if ($h3.egress.lastFamily -ne 'proxy' -or $h3.egress.connections -lt 1) {
          throw "rollback turn did not use the original proxy (lastFamily=$($h3.egress.lastFamily) connections=$($h3.egress.connections))"
        }
        "rollback verified: turn ok, egress.lastFamily=$($h3.egress.lastFamily) connections=$($h3.egress.connections)"
      } catch {
        "WARN: rollback restored the upstream but verification failed: $($_.Exception.Message)"
      }
      exit 1
    }
  }
  'unwire' {
    "1/3 restoring the previous upstream"
    $orig = Get-PreviousUpstream
    Set-GatewayUpstream $orig
    "2/3 restarting the gateway"
    $h = Restart-Gateway
    "3/3 stopping the bridge"
    & $bridgeScript -Action stop
    if (-not (Test-UpstreamTurn)) { throw "turn failed after unwire" }
    $h2 = Invoke-RestMethod 'http://127.0.0.1:8317/health' -TimeoutSec 5
    "OK upstream=$(Get-GatewayUpstream) egress.lastFamily=$($h2.egress.lastFamily) connections=$($h2.egress.connections)"
  }
}
