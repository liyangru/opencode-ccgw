# egress-vpngate.ps1 -- VPN Gate 免费出口引擎(零账号、零安装、零窗口)
#
# VPN Gate = 筑波大学学术项目(vpngate.net)的公共 VPN 中继网络,凭据固定公开:
#   用户名 vpn / 密码 vpn / L2TP 预共享密钥 vpn —— 无需注册、无需任何账号。
# 本引擎全部走 Windows 自带 L2TP/IPsec 客户端(Add-VpnConnection + rasdial):
#   不安装第三方软件、不需要管理员权限、不弹任何窗口。
#
# 用法:
#   .\egress-vpngate.ps1 status|connect|disconnect|list
#   connect 可选: -Server <IP> 直连指定服务器; -Countries 'TH','JP','SG' 限定优先国家
#   自动模式会记住上次成功的服务器(egress-vpngate.last),重连时优先使用
# 可 dot-source 复用:VPngate-Status / VPngate-Connect / VPngate-Disconnect / VPngate-GetServers
#
# 注意:公共中继的出口 IP 由全球用户共享,质量与"干净度"不保证 ——
#   若上游按 IP 限流,被共享的出口可能早已被用限(实测 2026-10:切到 VPN Gate 后
#   免费层第一个请求即返回 "can only be used from within OpenCode")。本引擎的定位是
#   "零门槛能用的免费出口",不是"配额的可靠刷新手段"(那需要独享 IP)。
param(
  [ValidateSet("status","connect","disconnect","list")]
  [string]$Action = "",
  [string]$Server = "",
  [string[]]$Countries = @()
)

$ErrorActionPreference = "Continue"

$script:VPNGATE_ENTRY = "ccgw-vpngate"
$script:VPNGATE_API   = "https://www.vpngate.net/api/iphone/"
$script:VPNGATE_USER  = "vpn"
$script:VPNGATE_PASS  = "vpn"
$script:VPNGATE_PSK   = "vpn"
$script:VPNGATE_DIR   = $PSScriptRoot
if (-not $script:VPNGATE_DIR) { $script:VPNGATE_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path }
$script:VPNGATE_CACHE = Join-Path $script:VPNGATE_DIR "egress-vpngate.last"

function VPngate-GetServers {
  # 拉取官方公开服务器列表(CSV),按服务器质量指标排序;可选国家过滤
  param([string[]]$Countries = @())
  try {
    $raw = (Invoke-WebRequest -Uri $script:VPNGATE_API -UseBasicParsing -TimeoutSec 40).Content
  } catch {
    Write-Warning "VPN Gate 服务器列表拉取失败: $($_.Exception.Message)"
    return @()
  }
  $rows = @($raw -split "`r?`n" | Where-Object { $_ -and -not $_.StartsWith("#") -and -not $_.StartsWith("*") } |
    ConvertFrom-Csv -Header HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64)
  $rows = @($rows | Where-Object { $_.IP -match '^\d+\.\d+\.\d+\.\d+$' })
  if ($Countries -and $Countries.Count -gt 0) {
    $pref = @($rows | Where-Object { $Countries -contains $_.CountryShort })
    if ($pref.Count -gt 0) { $rows = $pref }
  }
  return @($rows | Sort-Object { if ("$($_.Ping)" -match '^\d+') { [int]$_.Ping } else { 9999 } })
}

function VPngate-CurrentServer {
  $c = Get-VpnConnection -Name $script:VPNGATE_ENTRY -ErrorAction SilentlyContinue
  if ($c) { return "$($c.ServerAddress)" }
  return ""
}

function VPngate-Status {
  $c = Get-VpnConnection -Name $script:VPNGATE_ENTRY -ErrorAction SilentlyContinue
  if ($c -and $c.ConnectionStatus -eq "Connected") { return "connected" }
  return "disconnected"
}

function VPngate-Connect {
  param([string]$Server = "", [string[]]$Countries = @(), [int]$MaxTries = 3)
  if ((VPngate-Status) -eq "connected") {
    if (-not $Server -or (VPngate-CurrentServer) -eq $Server) { return $true }   # 已连接(目标一致):幂等成功
    $null = VPngate-Disconnect                                                  # 目标不同:先断再重建
  }
  $candidates = @()
  if ($Server) {
    $candidates = @($Server)                                                    # 指定服务器:只试它
  } else {
    $list = @(VPngate-GetServers -Countries $Countries)
    if ($list.Count -eq 0) { Write-Warning "VPN Gate 服务器列表为空,无法选择出口"; return $false }
    # 候选顺序:上次成功的服务器优先(公共列表前几名常拨不通),其余按列表顺序补足
    $cand = @()
    $last = ""
    if ($script:VPNGATE_CACHE -and (Test-Path $script:VPNGATE_CACHE)) {
      $lc = Get-Content $script:VPNGATE_CACHE -TotalCount 1 -ErrorAction SilentlyContinue
      if ($lc -and "$lc".Trim() -match '^\d+\.\d+\.\d+\.\d+$') { $last = "$lc".Trim() }
    }
    if ($last -and @($list | Where-Object { $_.IP -eq $last }).Count -gt 0) { $cand += $last }
    foreach ($r in $list) {
      if ($cand.Count -ge $MaxTries) { break }
      if ($cand -notcontains $r.IP) { $cand += $r.IP }
    }
    $candidates = @($cand)
  }
  foreach ($srv in $candidates) {
    Remove-VpnConnection -Name $script:VPNGATE_ENTRY -Force -ErrorAction SilentlyContinue
    try {
      Add-VpnConnection -Name $script:VPNGATE_ENTRY -ServerAddress $srv -TunnelType L2tp `
        -AuthenticationMethod MSChapv2 -L2tpPsk $script:VPNGATE_PSK -EncryptionLevel Optional -Force -ErrorAction Stop | Out-Null
    } catch {
      Write-Warning "创建 VPN 连接项失败($srv): $($_.Exception.Message)"
      continue
    }
    $r = (& rasdial.exe $script:VPNGATE_ENTRY $script:VPNGATE_USER $script:VPNGATE_PASS 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
      $first = ($r -split "`r?`n" | Where-Object { $_ } | Select-Object -First 1)
      Write-Warning ("拨号失败({0}) [{1}]: {2}" -f $srv, $LASTEXITCODE, $first)
      Remove-VpnConnection -Name $script:VPNGATE_ENTRY -Force -ErrorAction SilentlyContinue
      continue                                                                  # 换下一台
    }
    for ($i = 0; $i -lt 10; $i++) {                    # 最多等 20s 隧道就绪
      if ((VPngate-Status) -eq "connected") {
        try { [IO.File]::WriteAllText($script:VPNGATE_CACHE, $srv) } catch {}   # 记住成功服务器,下次优先
        return $true
      }
      Start-Sleep -Seconds 2
    }
    $null = VPngate-Disconnect                          # 隧道没起来:清理后换下一台
  }
  return $false
}

function VPngate-Disconnect {
  if ((VPngate-Status) -ne "connected") {
    Remove-VpnConnection -Name $script:VPNGATE_ENTRY -Force -ErrorAction SilentlyContinue   # 清理残留连接项
    return $true
  }
  & rasdial.exe $script:VPNGATE_ENTRY /disconnect 2>&1 | Out-Null
  for ($i = 0; $i -lt 10; $i++) {
    if ((VPngate-Status) -ne "connected") { break }
    Start-Sleep -Seconds 1
  }
  Remove-VpnConnection -Name $script:VPNGATE_ENTRY -Force -ErrorAction SilentlyContinue
  return ((VPngate-Status) -ne "connected")
}

if ($Action) {
  switch ($Action) {
    "status" {
      Write-Host ("state={0}  server={1}" -f (VPngate-Status), (VPngate-CurrentServer))
    }
    "connect" {
      if (VPngate-Connect -Server $Server -Countries $Countries) {
        Write-Host ("connect: OK  server={0}" -f (VPngate-CurrentServer))
      } else {
        Write-Host "connect: FAILED"; exit 1
      }
    }
    "disconnect" {
      if (VPngate-Disconnect) { Write-Host "disconnect: OK" } else { Write-Host "disconnect: FAILED"; exit 1 }
    }
    "list" {
      $i = 0
      foreach ($r in @(VPngate-GetServers -Countries $Countries)) {
        $i++
        if ($i -gt 12) { break }
        Write-Host ("{0,-16} {1,-3} ping={2,-4} sessions={3,-6} {4}" -f $r.IP, $r.CountryShort, $r.Ping, $r.NumVpnSessions, $r.HostName)
      }
    }
  }
}
