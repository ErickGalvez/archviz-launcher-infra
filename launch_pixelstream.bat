@echo off
setlocal EnableDelayedExpansion
:: ============================================================
::  UE5 Pixel Streaming — Self-Hosted Launch Script
::  ArchViz client presentations · UE5.7
:: ============================================================
:: ── CONFIG ──────────────────────────────────────────────────
set UE5_EXE=Y:\ArchVizChallenge\UE5ProjectV2\ArchVizProject3\PKGV3\Windows\ArchVizProject3.exe
set SIGNAL_DIR=Y:\Installed Software\3D\UE5\UE_5.7\Engine\Plugins\Media\PixelStreaming\Resources\WebServers\SignallingWebServer
set HTTP_PORT=80
set STREAMER_PORT=8888
set STREAM_W=1920
set STREAM_H=1080
set STREAM_FPS=60
set BITRATE_TARGET=20000000
set BITRATE_MAX=25000000
:: ── PREFLIGHT ───────────────────────────────────────────────
echo.
echo  =====================================================
echo   UE5 Pixel Streaming — ArchViz Launcher (UE5.7)
echo  =====================================================
echo.
where node >nul 2>&1
if errorlevel 1 ( echo  [ERROR] Node.js not found. & pause & exit /b 1 )
echo  [OK] Node.js found
if not exist "%UE5_EXE%" ( echo  [ERROR] UE5 build not found at: %UE5_EXE% & pause & exit /b 1 )
echo  [OK] UE5 build found
if not exist "%SIGNAL_DIR%\platform_scripts\cmd\start.bat" (
    echo  [ERROR] Signaling server not found.
    pause & exit /b 1
)
echo  [OK] Signaling server found
:: ── CLEANUP ─────────────────────────────────────────────────
:: NOTE: this used to also run `taskkill /f /im "node.exe"` here — a blanket
:: kill with no scoping at all. Since this bat is spawned BY
:: launcher-server.js (itself a node.exe process), and Wilbur is ALSO a
:: node.exe process, that one line killed the launcher's own backend and the
:: signaling server on every single launch — the root cause of the launcher
:: "dying" after every Launch click. Wilbur is now killed precisely by port
:: (port 80) from launcher-server.js's killPSProcesses() before this script
:: even runs, so it's no longer needed here at all.
echo  [INFO] Cleaning up previous instances...
for %%i in ("%UE5_EXE%") do set UE5_NAME=%%~nxi
taskkill /f /im "%UE5_NAME%" >nul 2>&1
:: `timeout` doesn't actually wait when this script is spawned detached with
:: stdio:'ignore' (proven directly — it returns instantly regardless of /t),
:: so it's replaced everywhere in this file with PowerShell's Start-Sleep,
:: which uses .NET timing instead of a console-dependent wait and was
:: confirmed to work correctly in this exact context.
powershell -NoProfile -Command "Start-Sleep -Seconds 2"
echo  [OK] Cleanup done
:: ── CLOUDFLARE TURN CREDENTIALS ──────────────────────────────
:: TURN_SERVER / TURN_USER / TURN_PASS arrive here ALREADY RESOLVED, as
:: environment variables set by launcher-server.js before it spawned this
:: script. They used to be fetched right here instead — proven by direct
:: testing that cmd's own wait mechanisms (timeout, ping-as-delay, a manual
:: polling loop) all return instantly with zero elapsed time when this batch
:: is spawned detached with stdio:'ignore', so nothing done here could ever
:: reliably wait for the fetch to finish. Node's exec() has no such problem,
:: so the fetch now happens on the Node side; this script just reads what it
:: was handed. If you're running this .bat manually (not through the
:: launcher), TURN_SERVER will simply be empty and common.bat's own VPS
:: fallback applies, same as always.
if "%TURN_SERVER%"=="" (
    echo  [WARN] No Cloudflare TURN credentials were passed in — falling back to whatever default is baked into common.bat.
) else (
    echo  [OK] Using Cloudflare TURN: %TURN_SERVER%
)
:: ── LAUNCH WILBUR ───────────────────────────────────────────
echo  [INFO] Starting Wilbur signaling server on port %HTTP_PORT%...
start "PS Signalling Server" cmd /k "%~dp0start_wilbur.bat"
powershell -NoProfile -Command "Start-Sleep -Seconds 5"
:: ── LAUNCH UE5 ──────────────────────────────────────────────
echo  [INFO] Launching UE5 build...
start "UE5 PixelStream" "%UE5_EXE%" ^
    -PixelStreamingURL=ws://127.0.0.1:%STREAMER_PORT% ^
    -RenderOffScreen ^
    -ResX=%STREAM_W% ^
    -ResY=%STREAM_H% ^
    -ForceRes ^
    -fps=%STREAM_FPS% ^
    -AudioMixer ^
    -PixelStreamingEncoderTargetBitrate=%BITRATE_TARGET% ^
    -PixelStreamingEncoderMaxBitrate=%BITRATE_MAX% ^
    -PixelStreamingEncoderMinQP=20 ^
    -PixelStreamingEncoderMaxQP=40 ^
    -PixelStreamingWebRTCMaxFps=%STREAM_FPS% ^
    -PixelStreamingWebRTCFps=%STREAM_FPS% ^
    -PixelStreamingEncoderCodec=H264 ^
    -PixelStreamingEncoderProfile=BASELINE
:: ── ACCESS INFO ─────────────────────────────────────────────
echo.
echo  =====================================================
echo   Stream starting up (~15-30 seconds)
echo  =====================================================
echo.
echo   Local:   http://localhost
echo   Remote:  run expose_cloudflare_tunnel.bat
echo            then visit https://api.g-741studio.com
echo  =====================================================
echo.
