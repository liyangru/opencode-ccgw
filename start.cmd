@echo off
rem ccgw launcher - runs the gateway in THIS window (zero-window config: headless server on 4096).
rem Normal operation is handled by the ccgw-gateway scheduled task; use this for debugging.
rem To use the desktop app's service (45278) instead, unset the two vars below (auto-discovery).
cd /d "%~dp0"
if not defined CCGW_MODEL set CCGW_MODEL=deepseek-v4.1-flash-free
if not defined CCGW_OPENCODE_URL set CCGW_OPENCODE_URL=http://127.0.0.1:4096
if not defined CCGW_SERVICE_FILE set CCGW_SERVICE_FILE=%~dp0zero-window\headless-service.json
echo Starting ccgw gateway (Ctrl+C to stop)... default model = %CCGW_MODEL%
echo OpenCode service = %CCGW_OPENCODE_URL%
node server.mjs
pause
