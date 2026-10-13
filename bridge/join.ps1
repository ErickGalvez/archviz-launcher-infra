<#
  G741 bridge - join THIS PC to the pool.   Start it with join.bat (double-click).

  It asks before every change it makes to this PC, and -DryRun shows the whole plan without changing anything.
    1. checks Node.js (offers to install it)           5. gets the local model (copy it, or download with your OK)
    2. checks the shared key + prints its fingerprint  6. opens the firewall for PRIVATE networks only (asks first)
    3. names this PC                                   7. starts the agent at every logon, and now
    4. checks the GPU driver

  Switches:  -DryRun   -Yes (answer yes to every question)   -Alias "Frankenstein"   -NoModel (skip step 5)
             -LlamaExe <path to llama-server.exe>   -ModelFile <path to a .gguf>   (use files that are already on this PC)
#>
param([switch]$DryRun, [switch]$Yes, [string]$Alias, [switch]$NoModel, [string]$LlamaExe, [string]$ModelFile)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $here

# Pinned downloads: official sources, checksums verified when this installer was written.
$LlamaZip   = @{ Name = 'llama-b11537-bin-win-cuda-12.4-x64.zip'; Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b11537/llama-b11537-bin-win-cuda-12.4-x64.zip'; Size = 265219066; Sha = '98318ca06100e7a6a395249dede56ed8e162f1b1dcf1e2ee9330d17d7146aca0' }
$CudaZip    = @{ Name = 'cudart-llama-bin-win-cuda-12.4-x64.zip';    Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b11537/cudart-llama-bin-win-cuda-12.4-x64.zip';    Size = 391443627; Sha = '8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6' }
$ModelDl    = @{ Name = 'Qwen3-8B-Q4_K_M.gguf'; Url = 'https://huggingface.co/Qwen/Qwen3-8B-GGUF/resolve/main/Qwen3-8B-Q4_K_M.gguf'; Size = 5027783488; Sha = 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785' }
$TaskName   = 'G741-Bridge-Node'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Step([string]$m) { Write-Host ''; Write-Host $m -ForegroundColor Cyan }
function Ask([string]$q, [string]$default = 'N') {
  if ($Yes) { Say "  $q -> yes (-Yes)" 'DarkGray'; return $true }
  $a = Read-Host "  $q [$default]"; if ([string]::IsNullOrWhiteSpace($a)) { $a = $default }
  return ($a -match '^[yYsS]')
}
# Runs $act, or in a dry run only says what it would do.
function Act([string]$what, [scriptblock]$act) { if ($DryRun) { Say "  (dry run) would: $what" 'Yellow' } else { Say "  $what" 'Gray'; & $act } }
function WriteJson($obj, [string]$path) { [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false))) }  # no BOM: Node reads it

Say 'G741 bridge - join this PC to the pool' 'White'
if ($DryRun) { Say 'DRY RUN: nothing will be changed.' 'Yellow' }

# ── 1. Node.js ──────────────────────────────────────────────
Step '1/7  Node.js'
$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = @{ Source = 'C:\Program Files\nodejs\node.exe' } }
if (-not $node) {
  Say '  Node.js is not installed (the agent is a small Node program).' 'Yellow'
  if (Ask 'Install Node.js LTS now with winget?' 'Y') {
    Act 'winget install OpenJS.NodeJS.LTS' { winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements }
    if (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = @{ Source = 'C:\Program Files\nodejs\node.exe' } }
  }
  if (-not $node -and -not $DryRun) { Say '  Install Node.js from https://nodejs.org (LTS), then run this again.' 'Red'; exit 1 }
}
$nodeExe = if ($node) { $node.Source } else { 'node' }
if ($node) { Say ("  found: " + $nodeExe + '  (' + (& $nodeExe --version) + ')') 'Green' }

# ── 2. shared key ───────────────────────────────────────────
Step '2/7  Shared key'
if (-not (Test-Path (Join-Path $here 'bridge.key'))) { Say '  bridge.key is missing. It must be copied from the first PC (by USB stick), next to this script.' 'Red'; exit 1 }
if ($node) { & $nodeExe (Join-Path $here 'node-agent.js') --init }       # keeps the key, creates the config if needed, prints the fingerprint only
$cfgPath = Join-Path $here 'bridge-node.json'
if (-not (Test-Path $cfgPath)) { Say '  config was not created; stopping.' 'Red'; exit 1 }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
Say '  Check that this fingerprint is THE SAME on the first PC.' 'Yellow'

# ── 3. name ─────────────────────────────────────────────────
Step '3/7  Name this PC'
if (-not $Alias) { $Alias = if ($Yes) { $cfg.alias } else { $a = Read-Host ("  Name shown on the Devices page [" + $cfg.alias + "]"); if ([string]::IsNullOrWhiteSpace($a)) { $cfg.alias } else { $a } } }
$cfg.alias = ($Alias -replace '[^\p{L}\p{N} ._()+-]', '').Trim()
if (-not $cfg.alias) { $cfg.alias = $env:COMPUTERNAME }
Say ("  alias: " + $cfg.alias) 'Green'
if (-not $Yes -and -not $DryRun) { $r = Read-Host '  GB of RAM on its way back from warranty, if any [0]'; if ($r -match '^\d+$') { $cfg.pendingRamGB = [int]$r } }

# ── 4. GPU ──────────────────────────────────────────────────
Step '4/7  GPU'
$smi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($smi) {
  $gpu = (& nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>$null | Select-Object -First 1)
  Say ("  " + $gpu) 'Green'
  $drv = [double](($gpu -split ',')[1].Trim() -replace '^(\d+\.\d+).*', '$1')
  if ($drv -lt 551.61) { Say '  The NVIDIA driver is older than 551.61: the bundled CUDA 12.4 runtime may not start. Update the driver.' 'Yellow' }
} else { Say '  nvidia-smi not found: the PC will report CPU/RAM only and cannot run the model on a GPU.' 'Yellow' }

# ── 5. local model ──────────────────────────────────────────
Step '5/7  Local model'
function Get-Verified($d, $dest) {
  if ((Test-Path $dest) -and ((Get-Item $dest).Length -eq $d.Size)) { Say ("  already have " + $d.Name) 'DarkGray' }
  else {
    Say ("  downloading " + $d.Name + " (" + [math]::Round($d.Size / 1MB) + " MB) - safe to interrupt and re-run; it resumes") 'Gray'
    for ($i = 0; $i -lt 300; $i++) {
      $have = if (Test-Path $dest) { (Get-Item $dest).Length } else { 0 }
      if ($have -eq $d.Size) { break }
      & curl.exe -L --fail --http1.1 -C - -sS -o $dest $d.Url 2>$null
      if ($LASTEXITCODE -ne 0) { Start-Sleep -Seconds 2 }
    }
  }
  $hash = (Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
  if ($hash -ne $d.Sha) { Remove-Item $dest -Force; throw ("checksum mismatch for " + $d.Name + " - file removed, run again") }
  Say ("  verified: " + $d.Name) 'Green'
}
if (-not $NoModel) {
  if (-not $LlamaExe) { $c = Join-Path $here 'llama\llama-server.exe'; if (Test-Path $c) { $LlamaExe = $c } }
  if (-not $ModelFile) { $c = Get-ChildItem (Join-Path $here 'models') -Filter *.gguf -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $ModelFile = $c.FullName } }
  if (-not ($LlamaExe -and $ModelFile)) {
    Say '  No model on this PC yet. Two ways:' 'Yellow'
    Say '    a) copy these two from the first PC (USB stick - much faster than downloading):' 'Gray'
    Say '         the folder   LocalAgents\llama.cpp\b11537        ->  .\llama\      (next to this script)' 'Gray'
    Say '         the file     LocalAgents\_downloads\Qwen3-8B-Q4_K_M.gguf  ->  .\models\' 'Gray'
    Say '    b) download ~5.5 GB now from the official sources (GitHub: llama.cpp b11537; Hugging Face: Qwen/Qwen3-8B-GGUF, Apache-2.0),' 'Gray'
    Say '       each file checked against a pinned SHA-256.' 'Gray'
    if (Ask 'Download now?' 'N') {
      Act 'download + verify the runtime and the model into .\llama and .\models' {
        New-Item -ItemType Directory -Force (Join-Path $here 'dl'), (Join-Path $here 'llama'), (Join-Path $here 'models') | Out-Null
        Get-Verified $LlamaZip (Join-Path $here ('dl\' + $LlamaZip.Name)); Get-Verified $CudaZip (Join-Path $here ('dl\' + $CudaZip.Name))
        Expand-Archive -Force (Join-Path $here ('dl\' + $LlamaZip.Name)) (Join-Path $here 'llama'); Expand-Archive -Force (Join-Path $here ('dl\' + $CudaZip.Name)) (Join-Path $here 'llama')
        Get-Verified $ModelDl (Join-Path $here ('models\' + $ModelDl.Name))
      }
      $LlamaExe = Join-Path $here 'llama\llama-server.exe'; $ModelFile = Join-Path $here ('models\' + $ModelDl.Name)
    } else { Say '  Skipping: the agent still reports this PC to the Devices page; it just cannot run the model until the files are there. Run join.bat again after copying them.' 'Yellow' }
  }
  if ($LlamaExe -and $ModelFile) {
    $cfg.llama.exe = [string](Resolve-Path -ErrorAction SilentlyContinue $LlamaExe) ; if (-not $cfg.llama.exe) { $cfg.llama.exe = $LlamaExe }
    $cfg.llama.model = [string](Resolve-Path -ErrorAction SilentlyContinue $ModelFile) ; if (-not $cfg.llama.model) { $cfg.llama.model = $ModelFile }
    Say ("  model server: " + $cfg.llama.exe) 'Green'; Say ("  model file:   " + $cfg.llama.model) 'Green'
  }
}
Say '  The model runs from 00:00 to 07:00 Mexico City time (edit "nightly" in bridge-node.json), loads on demand in the daytime, and is unloaded whenever this PC is rendering a client.' 'DarkGray'
Act 'save bridge-node.json' { WriteJson $cfg $cfgPath }

# ── 6. firewall ─────────────────────────────────────────────
Step '6/7  Firewall (private networks only)'
$fwNames = 'G741 bridge (TCP 7411)', 'G741 bridge (UDP 7412)'
$have = @(Get-NetFirewallRule -DisplayName $fwNames -ErrorAction SilentlyContinue)
if ($have.Count -ge 2) { Say '  rules already exist.' 'Green' }
elseif (Ask 'Allow the other PC in? (adds two inbound rules for TCP 7411 + UDP 7412, same subnet only, private network profile only)' 'Y') {
  $cmd = "New-NetFirewallRule -DisplayName '$($fwNames[0])' -Direction Inbound -Protocol TCP -LocalPort 7411 -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null; " +
         "New-NetFirewallRule -DisplayName '$($fwNames[1])' -Direction Inbound -Protocol UDP -LocalPort 7412 -Profile Private -RemoteAddress LocalSubnet -Action Allow | Out-Null"
  Act 'add the two firewall rules (Windows will ask for administrator approval)' {
    $isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if ($isAdmin) { Invoke-Expression $cmd } else { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', $cmd }
    if (@(Get-NetFirewallRule -DisplayName $fwNames -ErrorAction SilentlyContinue).Count -ge 2) { Say '  done.' 'Green' } else { Say '  The rules were not added (approval declined?). Without them the other PC cannot reach this one.' 'Yellow' }
  }
}

# ── 7. start now + at every logon ───────────────────────────
Step '7/7  Start the agent'
if (Ask 'Start the agent now and at every logon of this user? (a scheduled task named G741-Bridge-Node; remove it any time in Task Scheduler)' 'Y') {
  Act 'register the scheduled task and start it' {
    $act = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c start "G741 bridge node" /min "' + (Join-Path $here 'start-node.bat') + '"') -WorkingDirectory $here
    $trg = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $set = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -Description 'G741 bridge node agent (restarts itself if it exits)' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 4
    Say '  started.' 'Green'
  }
}

Step 'Done'
Say '  Open the Devices page on the hub: this PC appears within about ten seconds.' 'White'
if ($DryRun) { Say '  (That was a dry run - run again without -DryRun to apply it.)' 'Yellow' }
