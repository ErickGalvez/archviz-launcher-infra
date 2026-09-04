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
echo  [INFO] Cleaning up previous instances...
for %%i in ("%UE5_EXE%") do set UE5_NAME=%%~nxi
taskkill /f /im "%UE5_NAME%" >nul 2>&1
taskkill /f /im "node.exe" >nul 2>&1
timeout /t 2 /nobreak >nul
echo  [OK] Cleanup done
:: ── FETCH CLOUDFLARE TURN CREDENTIALS ───────────────────────
:: Sets TURN_SERVER / TURN_USER / TURN_PASS as env vars for this
:: process. Wilbur's own script (common.bat) only falls back to
:: its defaults when TURN_SERVER is empty, so setting it here
:: BEFORE Wilbur starts overrides it cleanly — no edits needed
:: to common.bat itself.
echo  [INFO] Fetching fresh Cloudflare TURN credentials...
for /f "usebackq tokens=1,2 delims==" %%A in (`powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0get_cf_turn_creds.ps1" 2^>nul`) do set "%%A=%%B"
if "%TURN_SERVER%"=="" (
    echo  [WARN] Could not fetch Cloudflare TURN credentials.
    echo  [WARN] Falling back to whatever default is baked into common.bat.
) else (
    echo  [OK] Using Cloudflare TURN: %TURN_SERVER%
)
:: ── LAUNCH WILBUR ───────────────────────────────────────────
echo  [INFO] Starting Wilbur signaling server on port %HTTP_PORT%...
start "PS Signalling Server" cmd /k "cd /d "%SIGNAL_DIR%\platform_scripts\cmd" && start.bat"
timeout /t 5 /nobreak >nul
:: ── LAUNCH UE5 ──────────────────────────────────────────────
echo  [INFO] Launching UE5 build...
start "UE5 PixelStream" "%UE5_EXE%" ^
    -PixelStreamingURL=ws://localhost:%STREAMER_PORT% ^
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
