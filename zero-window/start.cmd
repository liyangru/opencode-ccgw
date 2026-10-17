@echo off
rem Enable + start the ccgw zero-window chain (all account servers + gateway).
for /f "tokens=1" %%t in ('schtasks /query /fo table 2^>nul ^| findstr /r "^ccgw-"') do schtasks /Change /TN %%t /ENABLE >nul 2>&1
for /f "tokens=1" %%t in ('schtasks /query /fo table 2^>nul ^| findstr /r "^ccgw-serve-"') do schtasks /Run /TN %%t >nul 2>&1
timeout /t 3 /nobreak >nul
schtasks /Run /TN ccgw-gateway >nul 2>&1
timeout /t 5 /nobreak >nul
echo.
echo --- health (retrying up to ~16s) ---
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 8;$i++){ try { (Invoke-RestMethod http://127.0.0.1:8317/health -TimeoutSec 4) | ConvertTo-Json -Depth 6; $ok=$true; break } catch { Start-Sleep -Seconds 2 } }; if(-not $ok){ Write-Host 'gateway not healthy yet - check ccgw\ccgw.log' }"
echo.
echo Done. (Autostart re-enabled.)
timeout /t 8 /nobreak >nul
