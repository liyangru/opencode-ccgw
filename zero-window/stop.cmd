@echo off
rem Stop the ccgw zero-window chain completely (also disables autostart until start.cmd re-enables).
schtasks /Change /TN ccgw-serve-headless /DISABLE >nul 2>&1
schtasks /Change /TN ccgw-gateway /DISABLE >nul 2>&1
schtasks /End /TN ccgw-gateway >nul 2>&1
schtasks /End /TN ccgw-serve-headless >nul 2>&1
timeout /t 2 /nobreak >nul
rem Fallback: kill anything still listening on the two ports (only if the tasks left strays).
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8317 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":4096 " ^| findstr LISTENING') do taskkill /F /PID %%p >nul 2>&1
echo.
echo Zero-window chain stopped (autostart disabled). Run start.cmd to bring it back.
timeout /t 8 /nobreak >nul
