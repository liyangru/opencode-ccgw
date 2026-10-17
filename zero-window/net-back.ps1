# net-back.ps1 -- 一键回切家宽:断开 Nord -> 探测 -> 不行就自动连回
# 用途:你手动决定"试试回家宽直连"时运行;家宽还在限流的话不会把你晾着
$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $zw "nord-cli.ps1")

function Probe-Gateway {
  try {
    $body = '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:8317/v1/messages" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
    return $true
  } catch {
    Write-Host "  探测失败: $($_.Exception.Message)"
    return $false
  }
}

Write-Host "1) 断开 Nord..."
if (-not (Nord-Disconnect)) { Write-Host "断开失败,放弃(保持现状)"; exit 1 }
Start-Sleep -Seconds 2

Write-Host "2) 探测家宽(经网关发测试请求)..."
$ok = $false
foreach ($i in 1..2) {
  Write-Host "  第 $i 次..."
  if (Probe-Gateway) { $ok = $true; break }
  Start-Sleep -Seconds 3
}

if ($ok) {
  Write-Host "家宽正常,已回到直连(想再上 Nord 说一声即可)。"
} else {
  Write-Host "家宽仍被限流,自动连回 Nord..."
  if (Nord-Connect) { Write-Host "已连回 Nord。" } else { Write-Host "连回失败,请手动打开 Nord。" }
}
