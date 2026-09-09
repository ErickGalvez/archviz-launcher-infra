@echo off
:: ============================================================
::  start_wilbur.bat — invokes Wilbur (Epic's signaling server)
::  with the correct working directory AND real TURN credentials.
:: ============================================================
:: Two things this exists to work around, both confirmed by direct testing:
::
:: 1. Running "start.bat" as a bare command after `cd /d` into its folder
::    inline (e.g. `cd /d "path" && start.bat`) intermittently failed with
::    "'start.bat' is not recognized" in this project's exact spawn context
::    (launcher-server.js's detached/stdio:'ignore' spawn) — even though `cd`
::    itself succeeded and `dir` could see the file right there. Invoking it
::    via its full explicit path instead sidesteps whatever that lookup issue
::    actually is.
::
:: 2. common.bat (Epic's own script) unconditionally resets TURN_SERVER/
::    TURN_USER/TURN_PASS to empty at the top of its own arg parsing,
::    regardless of any inherited environment variable — so setting those as
::    env vars before launching, as this project used to do, can never work.
::    The only way a custom value survives is via its own --turn/--turn-user/
::    --turn-pass CLI flags. (--turn-user and --turn-pass had their own bug in
::    common.bat — they never consumed their value argument — fixed alongside
::    this file.) So the already-resolved credentials (set as env vars by
::    launcher-server.js before spawning launch_pixelstream.bat, which this
::    script inherits normally) are passed through here as real arguments.
setlocal EnableDelayedExpansion
:: SIGNAL_DIR comes from host.config (same file launch_pixelstream.bat
:: reads) — falls back to today's known-good path if that file is missing.
set SIGNAL_DIR=Y:\Installed Software\3D\UE5\UE_5.7\Engine\Plugins\Media\PixelStreaming\Resources\WebServers\SignallingWebServer
if exist "%~dp0host.config" (
    for /f "usebackq tokens=1,2 delims==" %%A in ("%~dp0host.config") do (
        if "%%A"=="SIGNAL_DIR" set SIGNAL_DIR=%%B
    )
)
set WDIR=!SIGNAL_DIR!\platform_scripts\cmd
cd /d "!WDIR!"

:: NOTE: deliberately unquoted. common.bat's ParseArgs reads these with bare
:: %2 (not %~2), so a quoted value like "turn.cloudflare.com:3478" keeps its
:: quote characters as part of TURN_SERVER's actual value. Those stray quotes
:: then land inside the --peer_options JSON string start.bat builds, breaking
:: cmd's quoting and killing Wilbur before it starts, with "The syntax of the
:: command is incorrect." as the only symptom. Safe to leave unquoted since
:: these values (hostname:port, hex tokens) never contain spaces.
set TURN_ARGS=
if not "!TURN_SERVER!"=="" set TURN_ARGS=--turn !TURN_SERVER! --turn-user !TURN_USER! --turn-pass !TURN_PASS!

call "!WDIR!\start.bat" !TURN_ARGS!
