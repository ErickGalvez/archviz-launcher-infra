@echo off
:: ============================================================
::  tunnel_service.bat — always-on Cloudflare tunnel.
::  Same headless/self-restarting pattern as listener_service.bat,
::  for the arkwiz-api named tunnel (api.g-741studio.com).
:: ============================================================
cd /d "%~dp0"
:loop
"%~dp0cloudflared.exe" tunnel run arkwiz-api >> "%~dp0cloudflared.log" 2>&1
powershell -NoProfile -Command "Start-Sleep -Seconds 5"
goto loop
