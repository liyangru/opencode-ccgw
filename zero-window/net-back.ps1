# net-back.ps1 -- 一键回切家宽:断开备用出口(谁连着断谁)-> 探测 -> 不行就自动连回
# 用途:你手动决定"试试回家宽直连"时运行;家宽还在限流的话不会把你晾着
$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $zw "nord-cli.ps1")
. (Join-Path $zw "egress-warp.ps1")
. (Join-Path $zw "egress-vpngate.ps1")

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

Write-Host "1) 断开备用出口..."
$was = "none"
if ((Nord-Status).state -eq "connected") {
  Write-Host "   检测到 Nord 已连接,正在断开..."
  if (-not (Nord-Disconnect)) { Write-Host "断开 Nord 失败,放弃(保持现状)"; exit 1 }
  $was = "nord"
} elseif ((Warp-Status) -eq "connected") {
  Write-Host "   检测到 WARP 已连接,正在断开..."
  if (-not (Warp-Disconnect)) { Write-Host "断开 WARP 失败,放弃(保持现状)"; exit 1 }
  $was = "warp"
} elseif ((VPngate-Status) -eq "connected") {
  Write-Host "   检测到 VPN Gate 已连接,正在断开..."
  if (-not (VPngate-Disconnect)) { Write-Host "断开 VPN Gate 失败,放弃(保持现状)"; exit 1 }
  $was = "vpngate"
} else {
  Write-Host "   当前没有备用出口连着,无需断开"
  $null = VPngate-Disconnect   # 顺手清理可能残留的连接项
}
Start-Sleep -Seconds 2

Write-Host "2) 探测家宽(经网关发测试请求)..."
$ok = $false
foreach ($i in 1..2) {
  Write-Host "  第 $i 次..."
  if (Probe-Gateway) { $ok = $true; break }
  Start-Sleep -Seconds 3
}

if ($ok) {
  Write-Host "家宽正常,已回到直连(想再上备用出口说一声即可)。"
} else {
  if ($was -eq "none") {
    # 本来就没有备用出口在连:按 auto 策略回退(优先 WARP,其次 Nord);都没有就如实相告
    $was = ""
    if (Test-Path "C:\Program Files\NordVPN\NordVPN.exe") { $was = "nord" }
    if (Warp-Registered) { $was = "warp" }
  }
  if ($was -eq "") {
    Write-Host "家宽仍被限流,且本机没有可用的备用出口(推荐 Cloudflare WARP:winget install Cloudflare.Warp + warp-cli registration new;或装 NordVPN;VPN Gate 公共出口可能被上游拉黑)。"
  } else {
    Write-Host "家宽仍被限流,自动连回 $was..."
    if ($was -eq "nord") {
      if (Nord-Connect) { Write-Host "已连回 Nord。" } else { Write-Host "连回失败,请手动打开 Nord。" }
    } elseif ($was -eq "warp") {
      if (Warp-Connect) { Write-Host "已连回 WARP。" } else { Write-Host "连回失败,请手动运行 zero-window\egress-warp.ps1 connect。" }
    } else {
      if (VPngate-Connect) { Write-Host "已连回 VPN Gate。" } else { Write-Host "连回失败。" }
    }
  }
}
