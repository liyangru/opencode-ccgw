# nord-ctl.ps1 -- NordVPN 静默自动化开关(无头:窗口不弹前台、不抢焦点,可在隐藏状态操作)
# 用法:
#   .\nord-ctl.ps1 status        # 查看连接状态(窗口+适配器)
#   .\nord-ctl.ps1 connect       # 确保已连接(必要时静默唤起应用,操作完立即隐藏)
#   .\nord-ctl.ps1 disconnect    # 断开(同样静默)
# 也可被其他脚本 dot-source 复用:Nord-Status / Nord-Connect / Nord-Disconnect
#
# 静默原理(实测):
#   - 托盘态窗口内容会被应用卸载;需要"唤起"(再跑一次 NordVPN.exe 向运行中实例发显示信号)
#   - 唤起前先把主窗口句柄挪到屏幕外(-4000,-4000),内容在屏幕外加载,完成后立即隐藏并还原位置
#   - 内容已加载的隐藏窗口可直接 InvokePattern 点击(连接/断开均约 1 秒)
#   - 仅"进程完全不在"的冷启动可能闪现 <1 秒
#   - 主窗口句柄缓存于 nord-hwnd.txt(hwnd + pid,进程重启自动失效)

param([ValidateSet("status","connect","disconnect")][string]$Action = "")

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

if (-not ("NordWin" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NordWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
}
'@
}

$script:NordExe = "C:\Program Files\NordVPN\NordVPN.exe"
$script:NordHwndFile = Join-Path $PSScriptRoot "nord-hwnd.txt"
$script:NordOffX = -4000
$script:NordOffY = -4000
$script:NordSwp = 0x0015   # SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE

# ---------- 基础 ----------
function Get-NordProc { return @(Get-Process -Name "NordVPN" -ErrorAction SilentlyContinue | Select-Object -First 1) }
function Get-NordAdapter { return (Get-NetAdapter -Name "NordLynx" -ErrorAction SilentlyContinue).Status }

function Find-NordEl($root, [string]$autoId) {
  if (-not $root) { return $null }
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $autoId)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

function Get-NordButtonMap($root) {
  $map = @{}
  if (-not $root) { return $map }
  foreach ($id in @("DashboardVpnQuickConnect", "DashboardVpnDisconnect", "DashboardVpnPause", "DashboardVpnConnect")) {
    if (Find-NordEl $root $id) { $map[$id] = $true }
  }
  return $map
}

function Invoke-NordEl($el, [bool]$visible = $true) {
  if (-not $el) { return $false }
  try {
    ($el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
    return $true
  } catch {
    if (-not $visible) { return $false }   # 隐藏窗口不做鼠标兜底
    try {
      if (-not ("W.U" -as [type])) {
        Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, int e);' -Name U -Namespace W -PassThru | Out-Null
      }
      $pt = $el.GetClickablePoint()
      [W.U]::SetCursorPos([int]$pt.X, [int]$pt.Y) | Out-Null
      Start-Sleep -Milliseconds 150
      [W.U]::mouse_event(2, 0, 0, 0, 0)
      [W.U]::mouse_event(4, 0, 0, 0, 0)
      return $true
    } catch { return $false }
  }
}

# ---------- 窗口定位 ----------
function Test-NordMainSig([int64]$h) {
  $hh = [IntPtr]$h
  if (-not [NordWin]::IsWindow($hh)) { return $false }
  $tt = New-Object System.Text.StringBuilder 256
  [void][NordWin]::GetWindowText($hh, $tt, 256)
  $cn = New-Object System.Text.StringBuilder 256
  [void][NordWin]::GetClassName($hh, $cn, 256)
  return ($tt.ToString().StartsWith("NordVPN") -and $cn.ToString().Contains("Hosted Main"))
}

function Get-NordDesktopWindow {
  $p = Get-NordProc
  if (-not $p) { return $null }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
}

function Get-NordHwnds {
  $p = Get-NordProc
  if (-not $p) { return @() }
  $script:__nordEnumPid = $p.Id
  $script:__nordEnumList = New-Object System.Collections.ArrayList
  $cb = [NordWin+EnumProc] {
    param($h, $lp)
    $wpid = 0
    [void][NordWin]::GetWindowThreadProcessId($h, [ref]$wpid)
    if ([int]$wpid -eq [int]$script:__nordEnumPid) { [void]$script:__nordEnumList.Add([int64]$h) }
    return $true
  }
  [void][NordWin]::EnumWindows($cb, [IntPtr]::Zero)
  return @($script:__nordEnumList)
}

function Save-NordHwnd([int64]$h) {
  $p = Get-NordProc
  if (-not $p) { return }
  try { Set-Content -Path $script:NordHwndFile -Value ("$h $($p.Id)") -Encoding Ascii } catch {}
}

function Get-NordMainHwnd {
  # 主窗口句柄:缓存 -> 桌面树 -> 标题/类名签名扫描 -> 带仪表盘按钮的窗口兜底
  $p = Get-NordProc
  if (-not $p) { return 0 }
  if (Test-Path $script:NordHwndFile) {
    $t = Get-Content $script:NordHwndFile -Raw -ErrorAction SilentlyContinue
    if ($t -and $t -match "(\d+)\s+(\d+)") {
      $ch = [int64]$Matches[1]
      $cp = [int64]$Matches[2]
      if ($cp -eq [int64]$p.Id -and (Test-NordMainSig $ch)) { return $ch }
    }
  }
  $w = Get-NordDesktopWindow
  if ($w) { $h = [int64]$w.Current.NativeWindowHandle; Save-NordHwnd $h; return $h }
  foreach ($h in (Get-NordHwnds)) {
    if (Test-NordMainSig $h) { Save-NordHwnd $h; return $h }
  }
  foreach ($h in (Get-NordHwnds)) {
    $el = $null
    try { $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$h) } catch {}
    if ($el) {
      $m = Get-NordButtonMap $el
      if ($m.Count -gt 0) { Save-NordHwnd $h; return $h }
    }
  }
  return 0
}

function Ensure-NordUi {
  # 拿到可操作的窗口元素。返回 @{ root; hwnd; visible; materialized } 或 $null
  # 1) 桌面上已有可见窗口且按钮就绪(可能是用户自己开着的)
  $w = Get-NordDesktopWindow
  if ($w) {
    $h1 = [int64]$w.Current.NativeWindowHandle
    if ((Get-NordButtonMap $w).Count -gt 0) { Save-NordHwnd $h1; return @{ root = $w; hwnd = $h1; visible = $true; materialized = $false } }
    for ($i = 0; $i -lt 16; $i++) {
      Start-Sleep -Milliseconds 500
      $w2 = Get-NordDesktopWindow
      if ($w2) {
        $h2 = [int64]$w2.Current.NativeWindowHandle
        if ((Get-NordButtonMap $w2).Count -gt 0) { Save-NordHwnd $h2; return @{ root = $w2; hwnd = $h2; visible = $true; materialized = $false } }
      }
    }
    return $null   # 可见但无按钮(例如停在登录页):不碰用户窗口
  }
  # 2) 隐藏窗口已有内容(之前唤起过的 warm 状态)
  $h = Get-NordMainHwnd
  if ($h -ne 0) {
    $el = $null
    try { $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h) } catch {}
    if ($el -and (Get-NordButtonMap $el).Count -gt 0) { return @{ root = $el; hwnd = $h; visible = $false; materialized = $false } }
  }
  # 3) 静默唤起:已有句柄先挪屏外 -> 触发显示(再跑一次 exe)-> 等内容 -> 隐藏 -> 还原位置
  $orig = $null
  if ($h -ne 0 -and (Test-NordMainSig $h)) {
    $r = New-Object "NordWin+RECT"
    if ([NordWin]::GetWindowRect([IntPtr]$h, [ref]$r)) { $orig = @($r.Left, $r.Top) }
    [void][NordWin]::SetWindowPos([IntPtr]$h, [IntPtr]::Zero, $script:NordOffX, $script:NordOffY, 0, 0, $script:NordSwp)
  }
  try { Start-Process $script:NordExe | Out-Null } catch { return $null }
  $target = 0
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if ($target -eq 0) {
      $hh = Get-NordMainHwnd
      if ($hh -ne 0) {
        $target = $hh
        if (-not $orig) {
          $r = New-Object "NordWin+RECT"
          if ([NordWin]::GetWindowRect([IntPtr]$hh, [ref]$r)) { $orig = @($r.Left, $r.Top) }
        }
      }
    }
    if ($target -ne 0) {
      $el = $null
      try { $el = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr][int64]$target) } catch {}
      if ($el -and (Get-NordButtonMap $el).Count -gt 0) {
        [void][NordWin]::SetWindowPos([IntPtr][int64]$target, [IntPtr]::Zero, $script:NordOffX, $script:NordOffY, 0, 0, $script:NordSwp)
        Start-Sleep -Milliseconds 150
        [void][NordWin]::ShowWindow([IntPtr][int64]$target, 0)
        if ($orig) { [void][NordWin]::SetWindowPos([IntPtr][int64]$target, [IntPtr]::Zero, [int]$orig[0], [int]$orig[1], 0, 0, $script:NordSwp) }
        Save-NordHwnd $target
        return @{ root = $el; hwnd = [int64]$target; visible = $false; materialized = $true }
      }
    }
  }
  return $null
}

# ---------- 对外功能 ----------
function Nord-Status {
  $adapter = Get-NordAdapter
  $state = "unknown"
  $hasWin = $false
  $root = $null
  $w = Get-NordDesktopWindow
  if ($w) {
    $hasWin = $true
    $root = $w
  } else {
    $h = Get-NordMainHwnd
    if ($h -ne 0) {
      try { $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$h) } catch {}
    }
  }
  if ($root) {
    $m = Get-NordButtonMap $root
    if ($m.ContainsKey("DashboardVpnDisconnect") -or $m.ContainsKey("DashboardVpnPause")) { $state = "connected" }
    elseif ($m.ContainsKey("DashboardVpnQuickConnect") -or $m.ContainsKey("DashboardVpnConnect")) { $state = "disconnected" }
  }
  if ($state -eq "unknown" -and $adapter -eq "Up") { $state = "connected" }
  return @{ window = $hasWin; state = $state; adapter = "$adapter" }
}

function Nord-Connect {
  if ((Get-NordAdapter) -eq "Up") { return $true }
  $ctx = Ensure-NordUi
  if (-not $ctx) { return $false }
  $m = Get-NordButtonMap $ctx.root
  if (-not ($m.ContainsKey("DashboardVpnDisconnect") -or $m.ContainsKey("DashboardVpnPause"))) {
    $btn = Find-NordEl $ctx.root "DashboardVpnQuickConnect"
    if (-not $btn) { $btn = Find-NordEl $ctx.root "DashboardVpnConnect" }
    if (-not $btn) { return $false }
    if (-not (Invoke-NordEl $btn $ctx.visible)) { return $false }
  }
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if ((Get-NordAdapter) -eq "Up") { return $true }
  }
  return ((Get-NordAdapter) -eq "Up")
}

function Nord-Disconnect {
  if ((Get-NordAdapter) -ne "Up") { return $true }
  $ctx = Ensure-NordUi
  if (-not $ctx) { return $false }
  $m = Get-NordButtonMap $ctx.root
  if (-not ($m.ContainsKey("DashboardVpnQuickConnect") -or $m.ContainsKey("DashboardVpnConnect"))) {
    $btn = Find-NordEl $ctx.root "DashboardVpnDisconnect"
    if (-not $btn) { return $false }
    if (-not (Invoke-NordEl $btn $ctx.visible)) { return $false }
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if ((Get-NordAdapter) -ne "Up") { return $true }
  }
  return ((Get-NordAdapter) -ne "Up")
}

if ($Action) {
  switch ($Action) {
    "status"     { $s = Nord-Status; Write-Host ("state={0}  adapter={1}  window={2}" -f $s.state, $s.adapter, $s.window) }
    "connect"    { if (Nord-Connect) { Write-Host "connect: OK" } else { Write-Host "connect: FAILED"; exit 1 } }
    "disconnect" { if (Nord-Disconnect) { Write-Host "disconnect: OK" } else { Write-Host "disconnect: FAILED"; exit 1 } }
  }
}
