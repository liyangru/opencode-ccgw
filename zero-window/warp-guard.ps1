# warp-guard.ps1 -- 备用出口(WARP)保活看门狗:掉线自动重连,永不主动断开
#
#   背景:家宽 IP 可能被上游偶发软限流;WARP 是能过免费层准入的备用出口。
#   它一掉线,桌面版 / 网关 / 朋友的免费模型请求都会 403。登录时连一次不够——
#   睡眠唤醒、WARP 服务重启、手动误断之后都要有人补连,这就是本脚本。
#
#   动作(唯一):warp-cli 在且当前未连接 -> 重连并等隧道就绪;已连接 -> 记一行日志。
#   由计划任务 ccgw-warp-guard 在登录时 + 每 ~10 分钟运行一次(见 setup.ps1)。
#   回切家宽仍是手动动作(net-back.ps1),本脚本永远不会断开任何出口。
#
#   暂停:zero-window\warp-guard.pause
#   日志:zero-window\warp-guard.log(每次运行一行,便于确认它真的在干活)
#
#   2026-10-18 修复:原先先做 `registration show` 预检,该命令偶发失败时会把看门狗
#   静默跳过(日志空白、WARP 却一直没连回来)。现在只看 warp-cli 是否存在,且每次运行都记日志。
param([switch]$Heartbeat)   # 兼容旧调用;现在默认就记一行

$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $zw "warp-guard.log"
$pause = Join-Path $zw "warp-guard.pause"
$warpCli = "C:\Program Files\Cloudflare\Cloudflare WARP\warp-cli.exe"

. (Join-Path $zw "egress-warp.ps1")

function LG([string]$m) {
  Add-Content -Path $log -Value ((Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $m) -Encoding UTF8
}

if (Test-Path $pause) { LG "paused (warp-guard.pause present)"; return }
if (-not (Test-Path $warpCli)) { LG "warp-cli not installed - nothing to keep alive"; return }

$st = Warp-Status
if ($st -eq "connected") { LG "warp ok (connected)"; return }

LG "warp down (status=$st) -> reconnecting"
if (Warp-Connect) { LG "warp reconnected: OK" }
else { LG "warp reconnect FAILED - manual action needed (zero-window\egress-warp.ps1 connect)" }
