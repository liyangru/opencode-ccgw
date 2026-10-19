# nord-cli.ps1 -- NordVPN 静默开关(官方 CLI 通道:零窗口、秒级;net-guard 的首选引擎)
#
# 原理(REA 反编译 NordVPNApp.dll 8.13.1.0 实证,2026-10):
#   NordVPN.exe 内建 CLI:
#     -c/--connect  [-i 服务器ID | -n 服务器名 | -g 组名]   连接(缺省=最佳服务器)
#     -d/--disconnect                                      断开
#     -v / --help                                          版本/帮助(控制台输出)
#   应用已在运行时,再跑 NordVPN.exe 会把参数经 "nord-security\v1\NordVpnApp\Self"
#   命名管道(gRPC over NordSecurity.Communication.Pipes)转发给运行中实例直接执行;
#   两边都是签名的 NordVPN.exe,天然通过互信检查;带 -c/-d 不显示主窗口
#   (仅"无参数默认启动"才显示窗口)。
# 实测(8.13.1.0):连接 ~2s 适配器 Up;已连接换组(新加坡→日本)~7s;断开 ~2s;
#   全程窗口不可见、不抢前台、不抢焦点。
#
# 用法:
#   .\nord-cli.ps1 status|connect|disconnect|rotate
# 可 dot-source 复用:Nord-Status / Nord-Connect [-Group 组名] / Nord-Disconnect / Nord-Rotate
# 冷启动兜底:若应用进程不在,自动转交 nord-ctl.ps1(UIA 引擎:屏幕外材料化 + 隐藏)。
param([ValidateSet("status","connect","disconnect","rotate")][string]$Action = "")

$ErrorActionPreference = "Continue"
$script:NordExe     = "C:\Program Files\NordVPN\NordVPN.exe"
$script:NordAdapter = "NordLynx"
$script:UiaScript   = Join-Path $PSScriptRoot "nord-ctl.ps1"

function Get-NordAdapterState { return "$((Get-NetAdapter -Name $script:NordAdapter -ErrorAction SilentlyContinue).Status)" }
function Test-NordApp { return [bool](Get-Process -Name "NordVPN" -ErrorAction SilentlyContinue) }

function Invoke-NordCli([string]$ArgLine, [int]$TimeoutMs = 20000) {
  # 转发进程通常 1~2s 退出;成败以随后的适配器状态轮询为准
  try {
    $p = Start-Process -FilePath $script:NordExe -ArgumentList $ArgLine -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit($TimeoutMs)) { try { $p.Kill() } catch {}; return $false }
    return $true
  } catch { return $false }
}

function Invoke-NordUia([string]$ActionName) {
  # 冷启动兜底:交给 UIA 引擎(它负责把窗口材料化到屏幕外、操作后隐藏)
  try {
    $p = Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$script:UiaScript`" $ActionName" -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(120000)) { try { $p.Kill() } catch {}; return $false }
    return ($p.ExitCode -eq 0)
  } catch { return $false }
}

function Nord-Status {
  $adapter = Get-NordAdapterState
  $state = "unknown"
  if ($adapter -eq "Up") { $state = "connected" }
  elseif ($adapter -eq "Disconnected" -or $adapter -eq "") { $state = "disconnected" }
  $hasWin = $false
  $pr = Get-Process -Name "NordVPN" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pr -and $pr.MainWindowHandle -ne 0) { $hasWin = $true }
  return @{ window = $hasWin; state = $state; adapter = $adapter }
}

function Nord-Connect {
  param([string]$Group = "")
  if ((Get-NordAdapterState) -eq "Up") { return $true }        # 已连接:幂等成功
  if (-not (Test-NordApp)) {                                   # 应用不在:冷启动兜底(UIA)
    if (-not (Invoke-NordUia "connect")) { return $false }
    return ((Get-NordAdapterState) -eq "Up")
  }
  $argLine = "-c"
  if ($Group) { $argLine = "$argLine -g `"$Group`"" }
  [void](Invoke-NordCli $argLine)
  for ($i = 0; $i -lt 30; $i++) {                              # 最多等 60s 隧道就绪
    Start-Sleep -Seconds 2
    if ((Get-NordAdapterState) -eq "Up") { return $true }
  }
  return $false
}

function Nord-Disconnect {
  if ((Get-NordAdapterState) -ne "Up") { return $true }        # 已断开:幂等成功
  if (Test-NordApp) {
    [void](Invoke-NordCli "-d")
  } elseif (-not (Invoke-NordUia "disconnect")) {
    return $false
  }
  for ($i = 0; $i -lt 15; $i++) {                              # 最多等 30s 断开完成
    Start-Sleep -Seconds 2
    if ((Get-NordAdapterState) -ne "Up") { return $true }
  }
  return $false
}

function Nord-Rotate {
  # 换到下一个 Nord 节点(按组轮换):断开 -> 连新组 -> 校验出口 IP。
  # 用于"全池限流 / 出口 IP 被封时自动换节点"(ccgw nord-rotate.mjs、net-guard 共用)。
  # 组列表:参数 > nord-rotate.groups 文件(每行一个)> 内置默认表。
  param([string[]]$Groups = @())
  $list = @($Groups | Where-Object { $_ })
  if ($list.Count -eq 0) {
    $gf = Join-Path $PSScriptRoot "nord-rotate.groups"
    if (Test-Path $gf) {
      $list = @(Get-Content $gf -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
    }
  }
  # 内置兜底顺序与 nord-rotate.groups 一致:优先实测四槽全通的国家。
  if ($list.Count -eq 0) { $list = @("South Korea","United States","Japan","Singapore","Taiwan","Canada","Germany","United Kingdom","Netherlands","Hong Kong") }
  $idxFile = Join-Path $PSScriptRoot "nord-rotate.index"
  $start = 0
  if (Test-Path $idxFile) {
    $raw = Get-Content $idxFile -TotalCount 1 -ErrorAction SilentlyContinue
    $v = 0
    if ($raw -and [int]::TryParse("$raw".Trim(), [ref]$v)) { $start = $v }
  }
  $tries = [Math]::Min($list.Count, 3)                          # 最多试 3 个组,避免长时间打转
  for ($k = 0; $k -lt $tries; $k++) {
    $i = ($start + $k) % $list.Count
    $g = $list[$i]
    if ((Get-NordAdapterState) -eq "Up") { [void](Nord-Disconnect) }
    Start-Sleep -Milliseconds 400
    if (Nord-Connect -Group $g) {
      try { Set-Content -Path $idxFile -Value (($i + 1) % $list.Count) -Encoding ASCII } catch {}
      # 出口 IP 只用于审计;新隧道刚起来时 DNS/代理可能还没就绪,重试两次。
      $ip = "unknown"
      for ($a = 0; $a -lt 2 -and $ip -eq "unknown"; $a++) {
        Start-Sleep -Milliseconds 1200
        try {
          $j = Invoke-RestMethod -Uri "https://api.ipify.org?format=json" -TimeoutSec 8
          if ($j.ip) { $ip = $j.ip }
        } catch {}
        if ($ip -eq "unknown") {
          try {
            $j = Invoke-RestMethod -Uri "https://ipinfo.io/json" -TimeoutSec 8
            if ($j.ip) { $ip = $j.ip }
          } catch {}
        }
      }
      Write-Host ("rotate: OK group={0} ip={1}" -f $g, $ip)
      return $true
    }
    Write-Host ("rotate: group {0} failed, trying next" -f $g)
  }
  Write-Host "rotate: FAILED"
  return $false
}

if ($Action) {
  switch ($Action) {
    "status"     { $s = Nord-Status; Write-Host ("state={0}  adapter={1}  window={2}" -f $s.state, $s.adapter, $s.window) }
    "connect"    { if (Nord-Connect) { Write-Host "connect: OK" } else { Write-Host "connect: FAILED"; exit 1 } }
    "disconnect" { if (Nord-Disconnect) { Write-Host "disconnect: OK" } else { Write-Host "disconnect: FAILED"; exit 1 } }
    "rotate"     { if (Nord-Rotate) { exit 0 } else { exit 1 } }
  }
}
