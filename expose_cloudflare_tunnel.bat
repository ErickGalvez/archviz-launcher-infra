@echo off
echo.
echo  ARKWIZ — Cloudflare Tunnel
echo  ===========================
echo  Starting persistent API tunnel...
echo  URL: https://api.g-741studio.com
echo.

cd /d "%~dp0"

where cloudflared >nul 2>&1
if errorlevel 1 (
    if exist "%~dp0cloudflared.exe" (
        set CLOUDFLARED=%~dp0cloudflared.exe
    ) else (
        echo [ERROR] cloudflared.exe not found.
        pause & exit /b 1
    )
) else (
    set CLOUDFLARED=cloudflared
)

:: Run named tunnel — uses C:\Users\erick\.cloudflared\config.yml automatically
%CLOUDFLARED% tunnel run arkwiz-api
pause
