# nord-ctl.ps1 -- NordVPN 自动化开关(方案:UI Automation,不碰网络层)
# 用法:
#   .\nord-ctl.ps1 status        # 查看连接状态(窗口+适配器)
#   .\nord-ctl.ps1 connect       # 确保已连接(窗口不在会自动拉起应用)
#   .\nord-ctl.ps1 disconnect    # 断开
# 也可被其他脚本 dot-source 复用:Nord-Status / Nord-Connect / Nord-Disconnect

param([ValidateSet("status","connect","disconnect")][string]$Action = "")

$ErrorActionPreference = "Continue"
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$script:NordExe = "C:\Program Files\NordVPN\NordVPN.exe"

function Get-NordWindow {
  $procs = Get-Process -Name "NordVPN" -ErrorAction SilentlyContinue
  if (-not $procs) { return $null }
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  foreach ($p in $procs) {
    $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $p.Id)
    $w = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) { return $w }
  }
  return $null
}

function Ensure-NordWindow {
  $w = Get-NordWindow
  if ($w) { return $w }
  Start-Process $script:NordExe | Out-Null
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    $w = Get-NordWindow
    if ($w) { return $w }
  }
  return $null
}

function Find-NordEl($win, [string]$autoId) {
  if (-not $win) { return $null }
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, $autoId)
  return $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}

function Invoke-NordEl($el) {
  try {
    $pat = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pat.Invoke()
    return $true
  } catch {
    # 回退:点元素中心坐标(仅在 Invoke 模式不可用时)
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

function Get-NordAdapter { (Get-NetAdapter -Name "NordLynx" -ErrorAction SilentlyContinue).Status }

function Nord-Status {
  # 已连接: DashboardVpnDisconnect / DashboardVpnPause("暂停连接")
  # 未连接: DashboardVpnQuickConnect("首选位置…保护连接安全"),部分版本为 DashboardVpnConnect
  $adapter = Get-NordAdapter
  $state = "unknown"
  $hasWin = $false
  for ($k = 0; $k -lt 3; $k++) {
    $w = Get-NordWindow
    if ($w) {
      $hasWin = $true
      if ((Find-NordEl $w "DashboardVpnDisconnect") -or (Find-NordEl $w "DashboardVpnPause")) { $state = "connected"; break }
      if ((Find-NordEl $w "DashboardVpnQuickConnect") -or (Find-NordEl $w "DashboardVpnConnect")) { $state = "disconnected"; break }
    }
    Start-Sleep -Milliseconds 1200
  }
  return @{ window = $hasWin; state = $state; adapter = "$adapter" }
}

function Nord-Connect {
  $w = Ensure-NordWindow
  if (-not $w) { return $false }
  if ((Find-NordEl $w "DashboardVpnDisconnect") -or (Find-NordEl $w "DashboardVpnPause")) { return $true }  # 已连接
  $btn = Find-NordEl $w "DashboardVpnQuickConnect"
  if (-not $btn) { $btn = Find-NordEl $w "DashboardVpnConnect" }
  if (-not $btn) { return $false }
  if (-not (Invoke-NordEl $btn)) { return $false }
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 1
    if ((Get-NordAdapter) -eq "Up") { return $true }
  }
  return ((Get-NordAdapter) -eq "Up")
}

function Nord-Disconnect {
  $w = Get-NordWindow
  if (-not $w) { return ((Get-NordAdapter) -ne "Up") }  # 无窗口且适配器不 Up = 已断开
  $dis = Find-NordEl $w "DashboardVpnDisconnect"
  if (-not $dis) { return ((Get-NordAdapter) -ne "Up") }
  if (-not (Invoke-NordEl $dis)) { return $false }
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
