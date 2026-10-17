@echo off
rem Stop the ccgw zero-window chain completely (all account servers + gateway;
rem also disables autostart until start.cmd re-enables it).
for /f "tokens=1" %%t in ('schtasks /query /fo table 2^>nul ^| findstr /r "^ccgw-"') do schtasks /Change /TN %%t /DISABLE >nul 2>&1
schtasks /End /TN ccgw-gateway >nul 2>&1
for /f "tokens=1" %%t in ('schtasks /query /fo table 2^>nul ^| findstr /r "^ccgw-serve-"') do schtasks /End /TN %%t >nul 2>&1
timeout /t 2 /nobreak >nul
rem Fallback: kill whatever still listens on the gateway / account ports (from accounts.json).
powershell -NoProfile -Command "$ports=@(8317,4096); $af='%~dp0accounts.json'; if (Test-Path $af) { (Get-Content $af -Raw | ConvertFrom-Json).accounts | ForEach-Object { if ($_.url -match ':(\d+)/?$') { $ports += [int]$Matches[1] } } }; foreach ($p in ($ports | Select-Object -Unique)) { Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue } }"
echo.
echo Zero-window chain stopped (autostart disabled). Run start.cmd to bring it back.
timeout /t 8 /nobreak >nul
