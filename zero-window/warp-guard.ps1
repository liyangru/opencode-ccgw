# warp-guard.ps1 -- 备用出口(WARP)保活看门狗:掉线自动重连,永不主动断开
#
#   背景:家宽 IP 被上游标记后,WARP 是能过免费层准入的出口;它一掉,桌面版 /
#   网关 / 朋友的免费模型请求会立刻 403("free tier can only be used from
#   within OpenCode")。登录时连一次(ccgw-warp-login)不够——睡眠唤醒、WARP
#   服务重启、手动误断之后都不会补连,这里补上这一环。
#
#   动作(唯一):WARP 已注册且当前未连接 -> 重连并等隧道就绪;已连接 -> 什么都不做。
#   由计划任务 ccgw-warp-guard 在登录时 + 每 ~10 分钟运行一次(见 setup.ps1)。
#   回切家宽仍是手动动作(net-back.ps1),本脚本永远不会断开任何出口。
#
#   暂停:在 zero-window 下新建文件 warp-guard.pause(内容随意),本轮跳过。
#   日志:zero-window\warp-guard.log(只在"掉线重连"与失败时写行;-Heartbeat 加心跳)
param([switch]$Heartbeat)

$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $zw "warp-guard.log"
$pause = Join-Path $zw "warp-guard.pause"

. (Join-Path $zw "egress-warp.ps1")

function LG([string]$m) {
  Add-Content -Path $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $m) -Encoding UTF8
}

if (Test-Path $pause) {
  if ($Heartbeat) { LG "paused (warp-guard.pause present)" }
  return
}
if (-not (Warp-Registered)) {
  # 本机没做过 WARP 匿名注册 = 不是备用出口;静默退出(auto 后端也不会选它)
  if ($Heartbeat) { LG "warp not registered - nothing to keep alive" }
  return
}
if ((Warp-Status) -eq "connected") {
  if ($Heartbeat) { LG "warp ok (connected)" }
  return
}
LG "warp down -> reconnecting"
if (Warp-Connect) {
  LG "warp reconnected: OK"
} else {
  LG "warp reconnect FAILED - manual action needed (zero-window\egress-warp.ps1 connect)"
}
