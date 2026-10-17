# egress-warp.ps1 -- Cloudflare WARP 免费出口(零账号、零登录,匿名设备注册)
#
# 引擎:官方客户端 warp-cli(C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe)
#   安装:  winget install Cloudflare.Warp
#   注册:  warp-cli --accept-tos registration new     (匿名,不需要账号)
#   实测(2026-10-17):免费层放行 —— 经网关真请求返回正常响应(不是 VPN Gate 那种
#   "free tier can only be used from within OpenCode" 硬封禁);共享出口 IP 偶发
#   软限流,交给账户池轮询消化。
#
# 用法:
#   .\egress-warp.ps1 status|connect|disconnect
# 可 dot-source 复用:Warp-Status / Warp-Connect / Warp-Disconnect / Warp-Registered
param([ValidateSet("status","connect","disconnect")][string]$Action = "")

$ErrorActionPreference = "Continue"
$script:WarpCli = "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe"

function Get-WarpCliStatus {
  # warp-cli status 的原始输出压缩成一行
  if (-not (Test-Path $script:WarpCli)) { return "" }
  try { return ((& $script:WarpCli --accept-tos status 2>&1 | Out-String) -replace '\s+', ' ').Trim() } catch { return "" }
}

function Warp-Status {
  $s = Get-WarpCliStatus
  if (-not $s) { return "unknown" }
  if ($s -match 'Status update: Connected') { return "connected" }
  if ($s -match 'Status update: Disconnected') { return "disconnected" }
  if ($s -match 'Status update: Unable') { return "disconnected" }   # 未注册/守护未起:视为未连接
  return "unknown"
}

function Warp-Registered {
  # 判断本机是否已做过匿名注册(auto 后端选择用)
  if (-not (Test-Path $script:WarpCli)) { return $false }
  try {
    $null = (& $script:WarpCli --accept-tos registration show 2>&1 | Out-String)
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

function Warp-Connect {
  if ((Warp-Status) -eq "connected") { return $true }        # 已连接:幂等成功
  try { $null = (& $script:WarpCli --accept-tos connect 2>&1 | Out-String) } catch { return $false }
  for ($i = 0; $i -lt 30; $i++) {                            # 最多等 60s 隧道就绪
    Start-Sleep -Seconds 2
    if ((Warp-Status) -eq "connected") { return $true }
  }
  return $false
}

function Warp-Disconnect {
  if ((Warp-Status) -ne "connected") { return $true }        # 已断开:幂等成功
  try { $null = (& $script:WarpCli --accept-tos disconnect 2>&1 | Out-String) } catch { return $false }
  for ($i = 0; $i -lt 15; $i++) {                            # 最多等 30s 断开完成
    Start-Sleep -Seconds 2
    if ((Warp-Status) -ne "connected") { return $true }
  }
  return $false
}

if ($Action) {
  switch ($Action) {
    "status"     { Write-Host ("state={0}" -f (Warp-Status)) }
    "connect"    { if (Warp-Connect) { Write-Host "connect: OK" } else { Write-Host "connect: FAILED"; exit 1 } }
    "disconnect" { if (Warp-Disconnect) { Write-Host "disconnect: OK" } else { Write-Host "disconnect: FAILED"; exit 1 } }
  }
}
