# net-guard.ps1 -- 全池限流时自动把机器出口切到 NordVPN(全自动,无人值守)
#   常驻循环,每 15s 读一次网关 /health:
#     pool.quotaExhausted=true 且 Nord 未连接  -> 自动连上 Nord(UI 自动化)
#     已在 Nord 上仍判定限流                    -> 提醒(Nord 出口可能也被限)
#   暂停:在 zero-window 下新建文件 net-guard.pause
#   日志:zero-window\net-guard.log
param([switch]$Once, [switch]$ForceQuota)   # -Once: 只跑一轮(测试用); -ForceQuota: 假装"全池限流"(测试用)

$ErrorActionPreference = "Continue"
$zw = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $zw "net-guard.log"
$pause = Join-Path $zw "net-guard.pause"

. (Join-Path $zw "nord-ctl.ps1")

function LG([string]$m) {
  $line = (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "  " + $m
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}

function Toast([string]$title, [string]$text) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
    $x = New-Object Windows.Data.Xml.Dom.XmlDocument
    $x.LoadXml("<toast><visual><binding template='ToastGeneric'><text>$title</text><text>$text</text></binding></visual></toast>")
    $t = New-Object Windows.UI.Notifications.ToastNotification($x)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("ccgw net-guard").Show($t)
  } catch {}
}

LG "net-guard started"
$switched = $false
$alarmSent = $false
while ($true) {
  try {
    if (Test-Path $pause) { if ($Once) { LG "paused - one-shot exits"; break } else { Start-Sleep -Seconds 30; continue } }
    $h = Invoke-RestMethod "http://127.0.0.1:8317/health" -TimeoutSec 6
    $q = [bool]$h.pool.quotaExhausted
    if ($ForceQuota) { $q = $true }
    if ($q) {
      if (-not $switched) {
        $st = Nord-Status
        if ($st.state -ne "connected") {
          LG ("QUOTA EXHAUSTED (all accounts rate-limited) -> connecting Nord (state=$($st.state) adapter=$($st.adapter))")
          if (Nord-Connect) {
            $switched = $true
            LG "switched to Nord: OK"
            Toast "ccgw 已自动切换出口" "检测到全池限流,已连上 NordVPN,稍等数秒重试即可继续"
          } else {
            LG "connect Nord FAILED - manual action needed"
            Toast "ccgw 切换失败" "检测到全池限流,但 NordVPN 自动连接失败,请手动打开 Nord"
          }
        } else {
          $switched = $true
          LG "already on Nord while quota exhausted (no action)"
        }
      } elseif (-not $alarmSent) {
        $alarmSent = $true
        LG "QUOTA EXHAUSTED again while already on Nord - Nord exit may also be limited"
        Toast "ccgw 提示" "Nord 出口也可能被限流,可在 Nord 里换个节点"
      }
    } else {
      if ($switched) { $switched = $false; LG "pool healthy again (staying on Nord until manual switch-back)" }
      $alarmSent = $false
    }
    if ($Once) { LG "one-shot done (quota=$q switched=$switched)"; break }
  } catch {
    # 网关不可达(重启/未启动)时忽略本轮
  }
  Start-Sleep -Seconds 15
}
