@echo off
cd /d "%~dp0"

echo.
echo  ArchViz Stream Launcher
echo  ========================
echo.

where node >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found.
    pause
    exit /b 1
)

:: Kill any previous server on port 3000
for /f "tokens=5" %%a in ('netstat -aon 2^>nul ^| findstr ":3000 "') do (
    taskkill /f /pid %%a >nul 2>&1
)

timeout /t 1 /nobreak >nul

:: Start Node server
start "ArchViz Launcher Server" cmd /k "cd /d "%~dp0" && node launcher-server.js"

:: Wait for it to bind
:waitloop
timeout /t 1 /nobreak >nul
netstat -aon 2>nul | findstr ":3000 " >nul
if errorlevel 1 goto waitloop

:: Open browser
start "" http://localhost:3000
exit
