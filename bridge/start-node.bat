@echo off
rem Keeps the G741 bridge node agent running on this PC (restarts it 5 seconds after any exit).
rem Needs Node.js on PATH and bridge.key + bridge-node.json in this folder (see README.md).
cd /d "%~dp0"
:loop
node node-agent.js
echo [%date% %time%] bridge node agent exited - restarting in 5 seconds (Ctrl+C to stop)
timeout /t 5 /nobreak >nul
goto loop
