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
set WDIR=Y:\Installed Software\3D\UE5\UE_5.7\Engine\Plugins\Media\PixelStreaming\Resources\WebServers\SignallingWebServer\platform_scripts\cmd
cd /d "!WDIR!"

set TURN_ARGS=
if not "!TURN_SERVER!"=="" set TURN_ARGS=--turn "!TURN_SERVER!" --turn-user "!TURN_USER!" --turn-pass "!TURN_PASS!"

call "!WDIR!\start.bat" !TURN_ARGS!
