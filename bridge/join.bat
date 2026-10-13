@echo off
rem Join this PC to the G741 pool. Double-click this file; it asks before changing anything.
rem Add -DryRun to see the plan without changing anything:   join.bat -DryRun
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0join.ps1" %*
echo.
pause
