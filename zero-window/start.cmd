@echo off
rem Enable + start the ccgw zero-window chain (headless OpenCode server + gateway).
schtasks /Change /TN ccgw-serve-headless /ENABLE >nul 2>&1
schtasks /Change /TN ccgw-gateway /ENABLE >nul 2>&1
schtasks /Run /TN ccgw-serve-headless
timeout /t 3 /nobreak >nul
schtasks /Run /TN ccgw-gateway
timeout /t 5 /nobreak >nul
echo.
echo --- health (retrying up to ~16s) ---
powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 8;$i++){ try { (Invoke-RestMethod http://127.0.0.1:8317/health -TimeoutSec 4) | ConvertTo-Json -Depth 3; $ok=$true; break } catch { Start-Sleep -Seconds 2 } }; if(-not $ok){ Write-Host 'gateway not healthy yet - check ccgw\ccgw.log' }"
echo.
echo Done. (Autostart re-enabled.)
timeout /t 8 /nobreak >nul
