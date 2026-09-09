@echo off
:: ============================================================
::  listener_service.bat — always-on background listener.
::  Runs launcher-server.js headlessly (no console window, via
::  run_hidden.vbs + Task Scheduler) and relaunches it if it ever
::  exits or crashes, so /api/status stays reachable through the
::  Cloudflare tunnel without anyone needing to keep a window open
::  or manually restart it after a reboot.
:: ============================================================
cd /d "%~dp0"
:loop
node "%~dp0launcher-server.js" >> "%~dp0launcher-server.log" 2>&1
powershell -NoProfile -Command "Start-Sleep -Seconds 5"
goto loop
