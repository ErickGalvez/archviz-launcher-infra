# ============================================================
#  sync_repo.ps1 — keeps THIS host's copy of archviz-launcher-infra
#  current with origin/main, with no manual "which host has the
#  latest code" bookkeeping.
#
#  Runs on a schedule (registered by setup_new_host.ps1 as the
#  ArchViz-Sync task) on every host that can run the stream - both
#  the primary and any standby machine. Each host is a pure mirror
#  of origin/main: nobody should ever hand-edit files or commit
#  locally on a host, only through the Dev Console or a normal PR,
#  so a plain fast-forward pull is always safe here and this script
#  refuses to do anything else if that assumption is ever violated.
#
#  On a real change, it kills launcher-server.js's node process by
#  its exact command line (same precise-PID pattern used everywhere
#  else on this host) rather than anything broader - listener_service.bat's
#  own retry loop relaunches it fresh with the new code within seconds.
#  This is the same effect the Dev Console's own "commit to the
#  launcher repo" path already has on whichever host received that
#  request; this script is what gives every OTHER host the same
#  update without needing to be the one that was talked to.
# ============================================================

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$logFile = Join-Path $root "sync-repo.log"

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $logFile -Value $line
}

Set-Location $root

try {
    git fetch origin main --quiet 2>&1 | Out-Null
} catch {
    Log "fetch failed: $($_.Exception.Message)"
    exit 0
}

$local  = (git rev-parse HEAD).Trim()
$remote = (git rev-parse origin/main).Trim()

if ($local -eq $remote) {
    exit 0  # already current - the common case, deliberately silent
}

$status = (git status --porcelain)
if ($status) {
    Log "SKIPPED: local uncommitted changes present - this host should never have any. Investigate manually before this can sync again."
    exit 1
}

try {
    git merge --ff-only origin/main 2>&1 | Out-Null
} catch {
    Log "SKIPPED: fast-forward merge failed ($($_.Exception.Message)) - local history has diverged from origin/main, which should never happen on a host. Investigate manually."
    exit 1
}

Log "Updated $local -> $remote. Restarting launcher-server.js..."

$proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like '*launcher-server.js*' }
if ($proc) {
    Stop-Process -Id $proc.ProcessId -Force
    Log "Stopped launcher-server.js (PID $($proc.ProcessId)) - listener_service.bat will relaunch it with the new code."
} else {
    Log "launcher-server.js wasn't running - nothing to restart (it'll start fresh with the new code next time the listener task runs)."
}
