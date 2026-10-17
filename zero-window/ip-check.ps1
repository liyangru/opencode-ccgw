# ip-check.ps1 -- 出口 IP 快速体检:对比基线 + 可选链路测试
# 用法:
#   .\ip-check.ps1                 只看出口 IP 是否变化
#   .\ip-check.ps1 -Probe          外加一个经网关(8317)的测试请求
#   .\ip-check.ps1 -Rebase         把当前出口设为新基线
param([switch]$Probe, [switch]$Rebase)

$ErrorActionPreference = "Continue"
$dir = "D:\Temp\ccgw-ip"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$baseline = Join-Path $dir "baseline.json"

$cur = [ordered]@{ ts = (Get-Date).ToString("s") }
try {
  $j = Invoke-RestMethod -Uri "https://ipinfo.io/json" -TimeoutSec 15
  $cur.ip = $j.ip; $cur.org = $j.org; $cur.city = $j.city; $cur.country = $j.country
  Write-Host "当前出口: $($j.ip)"
  Write-Host "运营商:   $($j.org)"
  Write-Host "位置:     $($j.city), $($j.country)"
  if (Test-Path $baseline) {
    $b = Get-Content $baseline -Raw | ConvertFrom-Json
    if ($b.ip -eq $j.ip) {
      Write-Host "对比基线: 相同(仍是原出口)"
    } else {
      Write-Host "对比基线: *** 出口已变化!*** (基线: $($b.ip) / $($b.org))"
    }
  } else {
    Write-Host "对比基线: 无基线文件"
  }
  if ($Rebase) {
    [IO.File]::WriteAllText($baseline, ($cur | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Write-Host "基线已更新 -> $baseline"
  }
} catch {
  Write-Host "取出口 IP 失败: $($_.Exception.Message)"
}

try {
  $v6 = Invoke-RestMethod -Uri "https://api64.ipify.org" -TimeoutSec 15
  Write-Host "api64:    $v6"
} catch {}

if ($Probe) {
  Write-Host ""
  Write-Host "--- 经网关测试请求(8317)---"
  $body = '{"model":"claude-sonnet-5","max_tokens":16,"messages":[{"role":"user","content":"Reply with exactly: OK"}]}'
  try {
    $null = Invoke-RestMethod -Uri "http://127.0.0.1:8317/v1/messages" -Method Post -Body $body -ContentType "application/json" -TimeoutSec 120
    Write-Host "结果: 请求成功 -- 这个出口能正常出量"
  } catch {
    Write-Host "结果: 请求失败 -- $($_.Exception.Message)"
    Write-Host "(若报 429 / 冷却:说明该出口额度桶仍被锁,换出口后再测)"
  }
}
