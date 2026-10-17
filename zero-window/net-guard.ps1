# net-guard.ps1 -- 全池限流时自动把机器出口切到备用 VPN(全自动,无人值守)
#   常驻循环,每 15s 读一次网关 /health:
#     pool.quotaExhausted=true 且备用出口未连接 -> 自动连接并等隧道就绪(安静、无窗口)
#     已在备用出口上仍判定限流(超过冷却排水期)-> 提醒(该出口可能也被限)
#   备用出口后端(-Backend 参数,或一行文件 net-guard.backend 写 nord/vpngate/none):
#     auto(默认)  = 装了 NordVPN 用 Nord;没装则不自动切换(等价 none)
#     nord        = NordVPN 官方 CLI 通道(零窗口秒级;见 nord-cli.ps1)
#     vpngate     = VPN Gate 公共免费出口(零账号、零安装;见 egress-vpngate.ps1)
#                   ⚠ 实测共享出口已被上游按 IP 标记:切上去后免费层请求会被拒
#                   ("can only be used from within OpenCode")——手动可选,不建议默认
#     none        = 只监听并写日志提示,不做任何切换
#   暂停:在 zero-window 下新建文件 net-guard.pause
#   日志:zero-window\net-guard.log(每 ~10 分钟写一行 heartbeat,便于确认存活)
#   静默:用 net-guard.vbs 启动(无控制台);系统通知默认关闭,
#         想要切换时弹通知就新建文件 zero-window/net-guard.toast
param(
  [switch]$Once, [switch]$ForceQuota,     # -Once: 只跑一轮(测试用); -ForceQuota: 假装"全池限流"(测试用)
  [ValidateSet("auto","nord","vpngate","none")][string]$Backend = "auto"
)

$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $zw "net-guard.log"
$pause = Join-Path $zw "net-guard.pause"
$toastFile = Join-Path $zw "net-guard.toast"

. (Join-Path $zw "nord-cli.ps1")
. (Join-Path $zw "egress-vpngate.ps1")

# 后端选择:参数 > net-guard.backend 文件 > 自动(装了 Nord 用 Nord,否则 VPN Gate)
if ($Backend -eq "auto") {
  $bf = Join-Path $zw "net-guard.backend"
  if (Test-Path $bf) {
    $v = ""
    $fc = Get-Content $bf -TotalCount 1 -ErrorAction SilentlyContinue
    if ($fc) { $v = "$fc".Trim().ToLower() }
    if (@("nord","vpngate","none") -contains $v) { $Backend = $v }
  }
}
if ($Backend -eq "auto") {
  # 默认策略:有 Nord 用 Nord;否则不自动切 —— 公共 VPN Gate 出口实测已被免费层按 IP 拉黑,
  # 自动切过去只会把"全池限流"升级成 403,对用户是负收益(要用请显式 -Backend vpngate)
  $Backend = "none"
  if (Test-Path "C:\Program Files\NordVPN\NordVPN.exe") { $Backend = "nord" }
}
$BackendName = "VPN Gate"
if ($Backend -eq "nord") { $BackendName = "Nord" }
if ($Backend -eq "none") { $BackendName = "none" }

function LG([string]$m) {
  $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}

function Toast([string]$title, [string]$text) {
  if (-not (Test-Path $toastFile)) { return }   # 默认静默;建 net-guard.toast 开启通知
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $x = New-Object Windows.Data.Xml.Dom.XmlDocument
    $x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$text</text></binding></visual></toast>")
    $t = New-Object Windows.UI.Notifications.ToastNotification($x)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("ccgw net-guard").Show($t)
  } catch {}
}

# 出口状态:任何一条备用出口已经连着都算"已切",避免两条隧道叠加
function Egress-Status {
  if ("$((Get-NetAdapter -Name 'NordLynx' -ErrorAction SilentlyContinue).Status)" -eq "Up") {
    return @{ state = "connected"; detail = "nord(adapter=Up)" }
  }
  $vg = Get-VpnConnection -Name "ccgw-vpngate" -ErrorAction SilentlyContinue
  if ($vg -and $vg.ConnectionStatus -eq "Connected") {
    return @{ state = "connected"; detail = "vpngate($($vg.ServerAddress))" }
  }
  return @{ state = "disconnected"; detail = "none" }
}

function Egress-Connect {
  if ($Backend -eq "nord") { return [bool](Nord-Connect) }
  if ($Backend -eq "vpngate") { return [bool](VPngate-Connect) }
  return $false
}

LG "net-guard started (backend=$Backend)"
$switched = $false
$alarmSent = $false
$switchTime = $null
$pausedShown = $false
$beat = 0
while ($true) {
  try {
    # 自愈看门狗:ccgw-vpngate 只应由 vpngate 后端使用;其余情况下它的存在
    # 都是残留(测试/手动遗留),会把整台机器静默留在(可能被上游标记的)公共出口上
    if ($Backend -ne "vpngate") {
      $vgc = Get-VpnConnection -Name "ccgw-vpngate" -ErrorAction SilentlyContinue
      if ($vgc -and $vgc.ConnectionStatus -eq "Connected") {
        LG "stale egress cleanup: disconnecting leftover ccgw-vpngate ($($vgc.ServerAddress))"
        $null = VPngate-Disconnect
      }
    }
    if (Test-Path $pause) {
      if ($Once) { LG "paused - one-shot exits"; break }
      if (-not $pausedShown) { LG "paused (net-guard.pause present) - sleeping"; $pausedShown = $true }
      Start-Sleep -Seconds 30; continue
    } else { $pausedShown = $false }
    $h = Invoke-RestMethod "http://127.0.0.1:8317/health" -TimeoutSec 6
    $q = [bool]$h.pool.quotaExhausted
    if ($ForceQuota) { $q = $true }
    if ($q) {
      if ($Backend -eq "none") {
        # 没有可切的备用出口:每个限流周期只提示一次,不做任何动作
        if (-not $alarmSent) {
          $alarmSent = $true
          LG "QUOTA EXHAUSTED (all accounts rate-limited) - no alternate egress configured (install NordVPN or set -Backend explicitly; see README)"
        }
      } elseif (-not $switched) {
        $st = Egress-Status
        if ($st.state -ne "connected") {
          LG ("QUOTA EXHAUSTED (all accounts rate-limited) -> connecting $BackendName (current: $($st.detail))")
          if (Egress-Connect) {
            $switched = $true
            $switchTime = Get-Date
            LG "switched to ${BackendName}: OK"
            Toast "ccgw 已自动切换出口" "检测到全池限流,已连上备用出口($BackendName),稍等数秒重试即可继续"
          } else {
            LG "connect $BackendName FAILED - manual action needed"
            Toast "ccgw 切换失败" "检测到全池限流,但备用出口($BackendName)自动连接失败,请手动处理"
          }
        } else {
          $switched = $true
          $switchTime = Get-Date
          LG "already on alternate egress ($($st.detail)) while quota exhausted (no action)"
        }
      } elseif (-not $alarmSent) {
        # 切换后账户池还有最多 ~5 分钟冷却排水期,期间 quota 必然仍为 true(正常现象);
        # 只有超过排水期仍被限,才值得提醒"备用出口可能也被限"
        if ($switchTime -and ((Get-Date) - $switchTime).TotalSeconds -gt 380) {
          $alarmSent = $true
          LG "QUOTA EXHAUSTED still true >6min after switch - $BackendName exit may also be limited"
          Toast "ccgw 提示" "备用出口($BackendName)可能也被限流,考虑换节点或回切"
        }
      }
    } else {
      if ($switched) { $switched = $false; $switchTime = $null; LG "pool healthy again (staying on $BackendName until manual switch-back)" }
      $alarmSent = $false
    }
    $beat++
    if ($beat % 40 -eq 0) { LG ("heartbeat (quota=$q)") }
    if ($Once) { LG "one-shot done (quota=$q switched=$switched)"; break }
  } catch {
    # 网关不可达(重启/未启动)时忽略本轮
  }
  Start-Sleep -Seconds 15
}
