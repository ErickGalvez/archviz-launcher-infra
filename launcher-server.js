// ============================================================
//  ArchViz Stream Launcher — Local Server
//  Run: node launcher-server.js
//  Open: http://localhost:3000
// ============================================================

const http = require('http');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── CONFIG ───────────────────────────────────────────────────
const PORT = 3000;
const WILBUR_HTTP_PORT = 80;
const WILBUR_STREAMER_PORT = 8888;

// Paths to your bat files — edit if needed
const BAT_DIR = __dirname;
const PS_BAT  = path.join(BAT_DIR, 'launch_pixelstream.bat');
const CF_BAT  = path.join(BAT_DIR, 'expose_cloudflare_tunnel.bat');

// Machine-specific settings (host.config, shared with launch_pixelstream.bat
// and start_wilbur.bat) — one file to edit if this ever runs on a different
// machine. Only HOST_NAME is actually used here (shown via /api/status so
// the admin panel/landing page can display which machine is live); the
// path values exist for the batch scripts, not this file.
const HOST_CONFIG_FILE = path.join(BAT_DIR, 'host.config');
let HOST_NAME = "Erick's GPU Rig";
if (fs.existsSync(HOST_CONFIG_FILE)) {
  fs.readFileSync(HOST_CONFIG_FILE, 'utf8').split('\n').forEach(line => {
    const m = line.trim().match(/^HOST_NAME=(.+)$/);
    if (m) HOST_NAME = m[1].trim();
  });
}

// ── ADMIN AUTH ───────────────────────────────────────────────
// This server is reachable from the public internet via the
// api.g-741studio.com Cloudflare tunnel (see config.yml). /api/launch-ps
// and /api/status are meant to be public — the landing page calls them
// directly so visitors can self-serve a demo session. Everything else
// (stop/kill controls, tunnel management) is only ever meant to be used
// from launcher-client.html running locally, so those routes require
// this key. Generated once and persisted so it survives restarts.
const KEY_FILE = path.join(BAT_DIR, 'admin.key');
let ADMIN_KEY;
if (fs.existsSync(KEY_FILE)) {
  ADMIN_KEY = fs.readFileSync(KEY_FILE, 'utf8').trim();
} else {
  ADMIN_KEY = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(KEY_FILE, ADMIN_KEY);
}

function isAdmin(req, url) {
  const headerKey = req.headers['x-admin-key'];
  const queryKey = url.searchParams.get('key');
  return headerKey === ADMIN_KEY || queryKey === ADMIN_KEY;
}

// ── STATE ────────────────────────────────────────────────────
let psProcess  = null;
let cfProcess  = null;
let tunnelURL  = '';
let psLog      = [];
let cfLog      = [];
let clients    = []; // SSE clients
let lastPSStatus = 'stopped';
let lastCFStatus = 'stopped';

function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  clients = clients.filter(c => {
    try { c.write(msg); return true; }
    catch(e) { return false; }
  });
}

function addLog(source, msg, type='info') {
  const entry = { ts: new Date().toLocaleTimeString('en-GB'), msg, type, source };
  if (source === 'ps') psLog.push(entry);
  else cfLog.push(entry);
  broadcast('log', entry);
  console.log(`[${source.toUpperCase()}] ${msg}`);
}

// ── PROCESS CONTROL — precise, verified kills instead of fragile heuristics ──
// The old approach killed Wilbur with `taskkill /IM node.exe /FI "MEMUSAGE gt
// 50000"` — a guess that silently does nothing if Wilbur happens to be under
// 50MB, leaving it bound to port 80 forever and blocking every future launch.
// This instead finds whatever's actually LISTENING on our known ports and
// kills that PID directly — works regardless of memory usage, and can never
// accidentally hit launcher-server.js's own process (port 3000) or an
// unrelated node process elsewhere on the machine.

// Observed directly during testing: a heavily-churned process/handle table
// (many repeated launch/kill cycles in a short span) can leave netstat/
// taskkill/tasklist hanging indefinitely rather than erroring. Without a
// timeout, that hangs the returned Promise forever — which hangs whatever
// admin API call was waiting on it, silently, since the rest of the server
// stays responsive (other requests aren't blocked, just that one).
const EXEC_TIMEOUT_MS = 8000;

function killByImageName(name) {
  return new Promise(resolve => {
    exec(`taskkill /F /IM ${name}`, { timeout: EXEC_TIMEOUT_MS }, err => resolve(!err)); // resolves true if something was actually found and killed
  });
}

function isProcessRunning(name) {
  return new Promise(resolve => {
    exec(`tasklist /FI "IMAGENAME eq ${name}" /NH`, { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      resolve(!err && !!stdout && stdout.toLowerCase().includes(name.toLowerCase()));
    });
  });
}

function killByPort(port) {
  return new Promise(resolve => {
    exec('netstat -ano', { timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      if (err || !stdout) return resolve([]);
      const pids = new Set();
      stdout.split('\n').forEach(line => {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 4 || !/^TCP$/i.test(parts[0])) return;
        const localAddr = parts[1] || '';
        const state = parts[parts.length - 2];
        const pid = parts[parts.length - 1];
        const localPort = localAddr.substring(localAddr.lastIndexOf(':') + 1);
        if (localPort === String(port) && /LISTENING/i.test(state) && pid && pid !== '0') pids.add(pid);
      });
      if (pids.size === 0) return resolve([]);
      Promise.all([...pids].map(pid => new Promise(res => exec(`taskkill /F /PID ${pid}`, { timeout: EXEC_TIMEOUT_MS }, () => res(pid)))))
        .then(resolve);
    });
  });
}

// Full teardown of the UE5 + Wilbur pair. Used both by the Stop button and,
// pre-emptively, by launchPS() itself — so a stale process from a crash, a
// manually-closed terminal, or a previous launcher-server.js restart can
// never block a fresh launch. Launch and Stop are idempotent either way.
async function killPSProcesses() {
  const foundUE5 = await killByImageName('ArchVizProject3.exe');
  const foundHttp = await killByPort(WILBUR_HTTP_PORT);
  const foundStreamer = await killByPort(WILBUR_STREAMER_PORT);
  if (psProcess) { try { psProcess.kill(); } catch (e) {} }
  psProcess = null;
  const foundAnything = foundUE5 || foundHttp.length > 0 || foundStreamer.length > 0;
  if (foundAnything) {
    // A large loaded UE5 process can take several seconds to actually exit
    // even after taskkill reports success (observed ~3s for a 2GB+ process)
    // — poll for real death instead of guessing a fixed delay, so a
    // subsequent launch never races a still-dying process for port 80.
    for (let i = 0; i < 10; i++) {
      if (!(await isProcessRunning('ArchVizProject3.exe'))) break;
      await new Promise(r => setTimeout(r, 500));
    }
  }
  return foundAnything;
}

async function killCFProcesses() {
  const found = await killByImageName('cloudflared.exe');
  if (cfProcess) { try { cfProcess.kill(); } catch (e) {} }
  cfProcess = null;
  if (found) await new Promise(r => setTimeout(r, 400));
  return found;
}

// ── TURN CREDENTIALS ─────────────────────────────────────────
// This used to be fetched INSIDE launch_pixelstream.bat, which needed to
// wait for the result before starting Wilbur. Proven by direct testing: cmd
// batch scripts spawned with detached:true/stdio:'ignore' (exactly what this
// server uses below) cannot reliably wait at all — `timeout`, `ping`-as-delay,
// and a manual polling loop all returned instantly with zero elapsed time in
// that exact context, for reasons not worth chasing into the Windows console
// subsystem further. Node's own exec() has no such problem (proven throughout
// this file already), so the fetch now happens here, and the *already
// resolved* credentials are handed to the batch file as environment
// variables it just reads — no waiting logic needed on the batch side at all.
const TURN_CREDS_PS1 = path.join(BAT_DIR, 'get_cf_turn_creds.ps1');
const TURN_FETCH_TIMEOUT_MS = 15000;

function fetchTurnCredentials() {
  return new Promise(resolve => {
    if (!fs.existsSync(TURN_CREDS_PS1)) return resolve(null);
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${TURN_CREDS_PS1}"`, { timeout: TURN_FETCH_TIMEOUT_MS }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const creds = {};
      stdout.split('\n').forEach(line => {
        const m = line.trim().match(/^(TURN_SERVER|TURN_USER|TURN_PASS)=(.+)$/);
        if (m) creds[m[1]] = m[2].trim();
      });
      resolve(creds.TURN_SERVER ? creds : null);
    });
  });
}

// ── PROCESS LAUNCHERS ────────────────────────────────────────

// Observed directly: overlapping Launch calls (a double-click, or two people/
// tabs hitting Launch within a few seconds of each other) each ran their own
// full cleanup+relaunch cycle on top of one already in flight — one launch's
// Wilbur would still be mid-startup when the next one's cleanup killed it,
// producing exactly the port-conflict/EADDRINUSE crashes and duplicate
// DefaultStreamer/DefaultStreamer1 sessions seen in testing. This lock makes
// a second Launch call while one is already running a clean no-op instead.
let psLaunchInProgress = false;

async function launchPS() {
  if (psLaunchInProgress) {
    addLog('ps', 'Launch already in progress — ignoring duplicate request.', 'info');
    return { ok: false, error: 'A launch is already in progress' };
  }
  psLaunchInProgress = true;
  // Safety valve — never let this lock stick forever if something downstream
  // hangs; force-reset also clears it immediately regardless of this timer.
  const unlockSafety = setTimeout(() => { psLaunchInProgress = false; }, 60000);

  if (!fs.existsSync(PS_BAT)) {
    clearTimeout(unlockSafety);
    psLaunchInProgress = false;
    return { ok: false, error: 'launch_pixelstream.bat not found at: ' + PS_BAT };
  }

  const clearedStale = await killPSProcesses();
  if (clearedStale) addLog('ps', 'Cleared a lingering previous session before relaunching.', 'info');

  addLog('ps', 'Fetching fresh Cloudflare TURN credentials…', 'info');
  const turnCreds = await fetchTurnCredentials();
  const spawnEnv = { ...process.env };
  if (turnCreds) {
    Object.assign(spawnEnv, turnCreds);
    addLog('ps', `Using Cloudflare TURN: ${turnCreds.TURN_SERVER}`, 'ok');
  } else {
    // Explicitly blank rather than leaving unset, so a stale value from an
    // earlier run can never leak through — launch_pixelstream.bat's own
    // fallback (the VPS default in common.bat) kicks in on an empty value.
    spawnEnv.TURN_SERVER = '';
    spawnEnv.TURN_USER = '';
    spawnEnv.TURN_PASS = '';
    addLog('ps', 'Could not fetch Cloudflare TURN credentials — falling back to the VPS default.', 'info');
  }

  addLog('ps', 'Starting launch_pixelstream.bat…', 'info');
  broadcast('ps-status', { status: 'starting' });

  // Wilbur intermittently never comes up at all with zero error output —
  // observed directly, root cause not pinned down despite extensive testing
  // (suspected Windows-level flakiness in the `start "Title" cmd /k "path"`
  // invocation under repeated/rapid cycling, not something fixable from here
  // with confidence). Rather than leave a session stuck on a silent failure,
  // this retries once automatically if Wilbur doesn't answer within 20s.
  const WILBUR_TIMEOUT_MS = 20000;
  let attempt = 1;

  function startAttempt() {
    // Launch bat in a new visible terminal window — fire and forget
    // We poll Wilbur's port to detect when stream is live
    // `detached` (Windows: CREATE_NEW_PROCESS_GROUP) was suspected as a
    // contributor to Wilbur intermittently failing to start at all under
    // this spawn (never reproduced when launched by hand) — .unref() alone
    // already covers "don't let this block Node from exiting", so detached
    // was dropped as a cheap, low-risk thing to try. Not proven to fully
    // fix it; the auto-retry above remains the real safety net.
    const batProcess = spawn('cmd.exe', ['/k', PS_BAT], {
      cwd: BAT_DIR,
      env: spawnEnv,
      shell: false,
      stdio: 'ignore',
    });
    batProcess.unref();
    psProcess = batProcess;

    lastPSStatus = 'starting';
    broadcast('ps-status', { status: 'starting' });
    if (attempt > 1) addLog('ps', `Retry attempt ${attempt}: starting launch_pixelstream.bat…`, 'info');
    else addLog('ps', 'launch_pixelstream.bat started in terminal window.', 'info');
    addLog('ps', 'Polling for Wilbur on port 80…', 'info');

    // Poll port 80 to detect when Wilbur is live
    let psPolling = true;
    const net = require('net');

    const wilburTimeout = setTimeout(async () => {
      if (!psPolling) return;
      psPolling = false;
      clearInterval(pollPS);
      if (attempt === 1) {
        addLog('ps', `Wilbur did not come up within ${WILBUR_TIMEOUT_MS / 1000}s — retrying once automatically.`, 'err');
        await killPSProcesses();
        attempt = 2;
        startAttempt();
      } else {
        addLog('ps', 'Wilbur still did not come up after a retry — giving up. Check the "PS Signalling Server" window manually.', 'err');
        lastPSStatus = 'stopped';
        broadcast('ps-status', { status: 'stopped' });
        clearTimeout(unlockSafety);
        psLaunchInProgress = false;
      }
    }, WILBUR_TIMEOUT_MS);

    const pollPS = setInterval(() => {
    if (!psPolling) { clearInterval(pollPS); return; }
    const sock = net.createConnection({ port: 80, host: '127.0.0.1' });
    sock.setTimeout(1000);
    sock.on('connect', () => {
      sock.destroy();
      if (!psPolling) return;
      psPolling = false;
      clearInterval(pollPS);
      clearTimeout(wilburTimeout);
      lastPSStatus = 'running';
      broadcast('ps-status', { status: 'running' });
      addLog('ps', 'Wilbur signaling server detected on port 80 ✓', 'ok');
      addLog('ps', 'Waiting for UE5 streamer to connect…', 'info');

      let streamerDetected = false;
      const pollStreamer = setInterval(() => {
        if (streamerDetected) { clearInterval(pollStreamer); return; }
        // Poll port 8888 to detect UE5 streamer
        const s2 = net.createConnection({ port: 8888, host: '127.0.0.1' });
        s2.setTimeout(500);
        s2.on('connect', () => {
          s2.destroy();
          if (streamerDetected) return;
          streamerDetected = true;
          clearInterval(pollStreamer);
          lastPSStatus = 'streaming';
      broadcast('ps-status', { status: 'streaming' });
          addLog('ps', 'UE5 streamer connected ✓ Stream is live!', 'ok');
          clearTimeout(unlockSafety);
          psLaunchInProgress = false;
        });
        s2.on('error', () => { try { s2.destroy(); } catch(e){} });
        s2.on('timeout', () => { try { s2.destroy(); } catch(e){} });
      }, 3000);
    });
    sock.on('error', () => { try { sock.destroy(); } catch(e){} });
    sock.on('timeout', () => { try { sock.destroy(); } catch(e){} });
    }, 3000);
  }

  startAttempt();
  return { ok: true };
}

let cfLaunchInProgress = false;

async function launchCF() {
  if (cfLaunchInProgress) {
    addLog('cf', 'Tunnel launch already in progress — ignoring duplicate request.', 'info');
    return { ok: false, error: 'A tunnel launch is already in progress' };
  }
  cfLaunchInProgress = true;
  const cfUnlockSafety = setTimeout(() => { cfLaunchInProgress = false; }, 45000);

  if (!fs.existsSync(CF_BAT)) {
    clearTimeout(cfUnlockSafety);
    cfLaunchInProgress = false;
    addLog('cf', 'expose_cloudflare_tunnel.bat not found at: ' + CF_BAT, 'err');
    return { ok: false, error: 'expose_cloudflare_tunnel.bat not found at: ' + CF_BAT };
  }

  const clearedStale = await killCFProcesses();
  if (clearedStale) addLog('cf', 'Cleared a lingering previous tunnel before relaunching.', 'info');

  addLog('cf', 'Starting expose_cloudflare_tunnel.bat…', 'info');
  broadcast('cf-status', { status: 'connecting' });

  // Launch CF bat in a new visible terminal — fire and forget
  const cfBatProcess = spawn('cmd.exe', ['/k', CF_BAT], {
    cwd: BAT_DIR,
    shell: false,
    stdio: 'ignore',
  });
  cfBatProcess.unref();
  cfProcess = cfBatProcess;

  lastCFStatus = 'connecting';
  broadcast('cf-status', { status: 'connecting' });
  addLog('cf', 'expose_cloudflare_tunnel.bat started (named tunnel: arkwiz-api).', 'info');

  // The tunnel now serves FIXED named routes (api.g-741studio.com,
  // stream.g-741studio.com) from config.yml — there's no random URL to
  // detect or paste anymore. We just confirm the tunnel process came up
  // by checking its own local metrics port, then mark it active.
  tunnelURL = 'https://stream.g-741studio.com';
  const net = require('net');
  let cfPolling = true;
  const pollCF = setInterval(() => {
    if (!cfPolling) { clearInterval(pollCF); return; }
    const sock = net.createConnection({ port: 20241, host: '127.0.0.1' }); // cloudflared metrics port
    sock.setTimeout(1000);
    sock.on('connect', () => {
      sock.destroy();
      if (!cfPolling) return;
      cfPolling = false;
      clearInterval(pollCF);
      lastCFStatus = 'active';
      addLog('cf', 'Tunnel connected — api.g-741studio.com / stream.g-741studio.com live.', 'ok');
      broadcast('cf-status', { status: 'active', url: tunnelURL });
      clearTimeout(cfUnlockSafety);
      cfLaunchInProgress = false;
    });
    sock.on('error', () => { try { sock.destroy(); } catch(e){} });
    sock.on('timeout', () => { try { sock.destroy(); } catch(e){} });
  }, 2000);

  setTimeout(() => {
    if (cfPolling) {
      cfPolling = false;
      clearInterval(pollCF);
      addLog('cf', 'Could not confirm tunnel connection — check the terminal window.', 'info');
    }
  }, 30000);

  return { ok: true };
}

async function stopPS() {
  psLaunchInProgress = false; // a manual stop always clears this, regardless of the safety timer
  broadcast('ps-status', { status: 'stopping' });
  addLog('ps', 'Stopping stream…', 'info');

  await killPSProcesses();

  lastPSStatus = 'stopped';
  broadcast('ps-status', { status: 'stopped' });
  addLog('ps', 'Stream stopped — UE5 and Wilbur confirmed killed.', 'ok');
  resetRoom();
  endLobbyTurnIfActive();
  return { ok: true };
}

async function stopCF() {
  cfLaunchInProgress = false;
  broadcast('cf-status', { status: 'stopping' });
  addLog('cf', 'Closing tunnel…', 'info');

  await killCFProcesses();
  tunnelURL = '';

  lastCFStatus = 'stopped';
  broadcast('cf-status', { status: 'stopped', url: '' });
  addLog('cf', 'Tunnel closed.', 'ok');
  return { ok: true };
}

// Nuclear option for when something's genuinely stuck — kills everything
// unconditionally and resets all in-memory state (lobby queue, current turn,
// room/control state), independent of whatever the launcher currently thinks
// is running.
async function forceReset() {
  psLaunchInProgress = false;
  cfLaunchInProgress = false;
  addLog('ps', 'Force reset requested — clearing all processes and state.', 'info');
  await Promise.all([killPSProcesses(), killCFProcesses()]);
  lastPSStatus = 'stopped';
  lastCFStatus = 'stopped';
  tunnelURL = '';
  broadcast('ps-status', { status: 'stopped' });
  broadcast('cf-status', { status: 'stopped', url: '' });
  lobbyQueue = [];
  clearTurnTimer();
  currentTurn = null;
  resetRoom();
  addLog('ps', 'Force reset complete — clean slate.', 'ok');
  return { ok: true };
}

// ── HEALTH CHECK — catch drift between assumed and actual state ──
// Nothing above ever rechecks its own assumptions once a status is set, so a
// UE5 crash or a manually-closed terminal window used to leave the UI lying
// about state indefinitely (showing "streaming" forever with nothing behind
// it). This periodically verifies against the real OS process list and
// self-corrects — the launcher never again reports a truth it hasn't checked.
setInterval(async () => {
  // 'starting' is deliberately excluded too — UE5 genuinely isn't running yet
  // during the TURN fetch + Wilbur boot delay that precedes it (~10-15s), and
  // this fired mid-startup during testing, incorrectly declaring a crash and
  // resetting status back to 'stopped' before UE5 ever got the chance to
  // launch. Only 'running' and 'streaming' mean UE5 is expected to exist.
  if (lastPSStatus !== 'running' && lastPSStatus !== 'streaming') return;
  const stillUp = await isProcessRunning('ArchVizProject3.exe');
  if (!stillUp) {
    addLog('ps', 'UE5 process is gone but was never stopped through the launcher — correcting status.', 'err');
    lastPSStatus = 'stopped';
    psProcess = null;
    broadcast('ps-status', { status: 'stopped' });
    resetRoom();
    endLobbyTurnIfActive();
  }
}, 8000);

// ── SESSION MODE ─────────────────────────────────────────────
// 'turns'  — today's default: public visitors queue via /api/lobby/*, each
//            gets a confirmed, exclusive 15-minute turn, then the next
//            queued visitor is served. Good for unattended public access.
// 'free'   — no queue, no forced turn timer. Meant for when you (or an
//            agent) are actively driving a session yourself and want it to
//            just stay up — multi-viewer coordination is handled entirely
//            by the room/raise-hand system instead of the lobby.
let sessionMode = 'turns';

function setSessionMode(mode) {
  if (mode !== 'turns' && mode !== 'free') return { ok: false, error: 'mode must be "turns" or "free"' };
  sessionMode = mode;
  addLog('ps', `Session mode set to "${mode}".`, 'ok');
  broadcast('session-mode', { mode });
  return { ok: true, mode };
}

// ── LOBBY QUEUE ──────────────────────────────────────────────
// Only one UE5 instance runs at a time, so once it's busy, new visitors
// queue up and get served back-to-back in fixed 15-minute turns instead
// of just hitting "already running" and giving up. When it's someone's
// turn they get a short window to confirm they're still there before
// we skip to the next person, so an abandoned tab doesn't burn a slot.
const SESSION_DURATION_MS = 15 * 60 * 1000;
const CONFIRM_GRACE_MS = 30 * 1000;
const MAX_QUEUE_LENGTH = 20;
const JOIN_COOLDOWN_MS = 5 * 1000;

let lobbyQueue = [];       // [{id, name, joinedAt, userAgent, device}]
let currentTurn = null;    // {id, name, status: 'confirming'|'active', deadline, userAgent, device}
let turnTimer = null;
const lastJoinByIP = new Map();

// ── SESSION LOG — durable record of who connected, on what, and how the
// launch actually went. Requested after a real iOS visit couldn't be
// diagnosed: the backend already tracked launch success/timing, but never
// captured what device made the request, and never wrote either to
// anything that survived past the in-memory log's last-30-entries window.
// One JSON line per concluded session (not committed to git - runtime data,
// see .gitignore), covering both outcomes that actually matter: the launch
// never came up, or it did and ran to completion.
const SESSION_LOG_FILE = path.join(BAT_DIR, 'session-log.jsonl');
function logSessionEvent(record) {
  try {
    fs.appendFileSync(SESSION_LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch (e) { /* logging must never be why a session fails */ }
}

// Deliberately simple regex parsing, not a full UA-database library - this
// only needs to answer "what OS/browser was this" for a handful of real
// combinations (iOS/Android/desktop x Safari/Chrome/Firefox/Edge), not every
// device that has ever existed.
function parseUserAgent(ua) {
  ua = ua || '';
  let os = 'Unknown', osVersion = '', deviceType = 'desktop', m;

  if ((m = ua.match(/iPhone OS (\d+)_(\d+)/)) || (m = ua.match(/CPU OS (\d+)_(\d+)/))) {
    os = 'iOS'; osVersion = `${m[1]}.${m[2]}`; deviceType = 'mobile';
  } else if ((m = ua.match(/iPad.*?OS (\d+)_(\d+)/))) {
    os = 'iPadOS'; osVersion = `${m[1]}.${m[2]}`; deviceType = 'tablet';
  } else if ((m = ua.match(/Android (\d+(?:\.\d+)?)/))) {
    os = 'Android'; osVersion = m[1]; deviceType = /Mobile/.test(ua) ? 'mobile' : 'tablet';
  } else if ((m = ua.match(/Windows NT (\d+\.\d+)/))) {
    os = 'Windows'; osVersion = m[1];
  } else if ((m = ua.match(/Mac OS X (\d+[_.]\d+)/))) {
    os = 'macOS'; osVersion = m[1].replace('_', '.');
  } else if (/Linux/.test(ua)) {
    os = 'Linux';
  }

  let browser = 'Unknown', browserVersion = '';
  if ((m = ua.match(/EdgA?\/(\d+)/))) { browser = 'Edge'; browserVersion = m[1]; }
  else if ((m = ua.match(/OPR\/(\d+)/))) { browser = 'Opera'; browserVersion = m[1]; }
  else if ((m = ua.match(/CriOS\/(\d+)/))) { browser = 'Chrome'; browserVersion = m[1]; }
  else if ((m = ua.match(/FxiOS\/(\d+)/))) { browser = 'Firefox'; browserVersion = m[1]; }
  else if ((m = ua.match(/Chrome\/(\d+)/))) { browser = 'Chrome'; browserVersion = m[1]; }
  else if ((m = ua.match(/Firefox\/(\d+)/))) { browser = 'Firefox'; browserVersion = m[1]; }
  else if ((m = ua.match(/Version\/(\d+)[.\d]*.*Safari/))) { browser = 'Safari'; browserVersion = m[1]; }

  return { os, osVersion, deviceType, browser, browserVersion };
}

function genTicketId() {
  return crypto.randomBytes(8).toString('hex');
}

function clearTurnTimer() {
  if (turnTimer) { clearTimeout(turnTimer); turnTimer = null; }
}

function advanceQueue() {
  clearTurnTimer();
  if (lobbyQueue.length === 0) {
    currentTurn = null;
    return;
  }
  const next = lobbyQueue.shift();
  currentTurn = { id: next.id, name: next.name, status: 'confirming', deadline: Date.now() + CONFIRM_GRACE_MS, userAgent: next.userAgent, device: next.device };
  addLog('lobby', `Ticket up for ${next.name || 'a visitor'} — waiting to confirm (30s)`, 'info');
  turnTimer = setTimeout(() => {
    addLog('lobby', `${currentTurn.name || 'Visitor'} didn't confirm in time, skipping`, 'info');
    advanceQueue();
  }, CONFIRM_GRACE_MS);
}

// Called whenever a session ends, whether via the 15-min timer or an
// admin manually stopping it early — either way the slot is free now.
function endLobbyTurnIfActive() {
  if (currentTurn && currentTurn.status === 'active') {
    clearTurnTimer();
    currentTurn = null;
    advanceQueue();
  }
}

function lobbyStatusFor(id) {
  if (currentTurn && currentTurn.id === id) {
    return {
      state: currentTurn.status, // 'confirming' | 'active'
      // deadline isn't set until the stream actually confirms live (see
      // watchLaunchOutcome) — null here means "still launching", not "no
      // time left", so this can't collapse to NaN/0 while a visitor's
      // launch is still in flight.
      msLeft: currentTurn.deadline ? Math.max(0, currentTurn.deadline - Date.now()) : null,
      launching: currentTurn.status === 'active' && !currentTurn.deadline,
      position: 0,
      queueLength: lobbyQueue.length,
      psStatus: lastPSStatus,
    };
  }
  const idx = lobbyQueue.findIndex(t => t.id === id);
  if (idx === -1) return null;
  return {
    state: 'waiting',
    position: idx + 1, // ahead: currentTurn holder + anyone earlier in queue
    queueLength: lobbyQueue.length,
    psStatus: lastPSStatus,
  };
}

function joinLobby(name, ip, userAgent) {
  if (sessionMode === 'free') {
    return { ok: true, free: true, psStatus: lastPSStatus, message: 'Open session — no queue, connect directly.' };
  }
  const now = Date.now();
  const lastJoin = lastJoinByIP.get(ip) || 0;
  if (now - lastJoin < JOIN_COOLDOWN_MS) {
    return { ok: false, error: 'Please wait a few seconds before trying again' };
  }
  if (lobbyQueue.length >= MAX_QUEUE_LENGTH) {
    return { ok: false, error: 'Queue is full right now, please try again later' };
  }
  lastJoinByIP.set(ip, now);
  const id = genTicketId();
  const device = parseUserAgent(userAgent);
  lobbyQueue.push({ id, name: (name || '').slice(0, 80), joinedAt: now, userAgent, device });
  addLog('lobby', `${name || 'A visitor'} joined the queue (position ${lobbyQueue.length})`, 'info');
  if (!currentTurn) advanceQueue();
  return { ok: true, id };
}

function leaveLobby(id) {
  const before = lobbyQueue.length;
  lobbyQueue = lobbyQueue.filter(t => t.id !== id);
  return { ok: lobbyQueue.length !== before };
}

function confirmTurn(id) {
  if (sessionMode === 'free') return { ok: false, error: 'Free mode has no turn queue to confirm.' };
  if (!currentTurn || currentTurn.id !== id || currentTurn.status !== 'confirming') {
    return { ok: false, error: 'Not your turn, or it already expired' };
  }
  clearTurnTimer();
  currentTurn.status = 'active';
  currentTurn.deadline = null; // clear the leftover 30s confirm-grace deadline from advanceQueue()
  // No deadline set yet — the real 15-minute clock only starts once the
  // stream actually confirms live (see watchLaunchOutcome below). Launch can
  // legitimately take 20-40s+ with the retry logic, and can fail outright;
  // charging that against the visitor's session, or leaving their "turn"
  // occupying the queue for the full 15 minutes on a launch that never came
  // up, both wasted real queue time for the next person for no reason.
  const confirmedName = currentTurn.name || 'Visitor';
  addLog('lobby', `${confirmedName} confirmed — launching…`, 'ok');
  resetRoom();
  launchPS();
  watchLaunchOutcome(id, confirmedName);
  return { ok: true };
}

// Polls the real launch outcome instead of assuming launchPS() succeeded
// just because it returned — that promise resolves as soon as the attempt
// is *kicked off*, not once Wilbur/UE5 are actually confirmed live.
function watchLaunchOutcome(turnId, name) {
  const startedAt = Date.now();
  const MAX_WAIT_MS = 60000; // comfortably past launchPS()'s own ~40s retry ceiling
  const check = setInterval(() => {
    const stillThisTurn = currentTurn && currentTurn.id === turnId && currentTurn.status === 'active';
    if (!stillThisTurn) { clearInterval(check); return; } // turn already ended some other way

    if (lastPSStatus === 'streaming') {
      clearInterval(check);
      const launchMs = Date.now() - startedAt;
      const { userAgent, device } = currentTurn;
      currentTurn.deadline = Date.now() + SESSION_DURATION_MS;
      addLog('lobby', `${name}'s stream is live — 15 minute turn starts now`, 'ok');
      turnTimer = setTimeout(() => {
        addLog('lobby', `${currentTurn ? (currentTurn.name || 'Visitor') : 'Session'}'s 15 minutes are up`, 'info');
        logSessionEvent({ name, userAgent, device, outcome: 'completed', launchMs, sessionMs: SESSION_DURATION_MS });
        stopPS();
      }, SESSION_DURATION_MS);
      return;
    }

    if (lastPSStatus === 'stopped' || Date.now() - startedAt > MAX_WAIT_MS) {
      clearInterval(check);
      addLog('lobby', `${name}'s launch never came up — releasing their turn to the next person in queue.`, 'err');
      logSessionEvent({ name, userAgent: currentTurn.userAgent, device: currentTurn.device, outcome: 'launch_failed', launchMs: Date.now() - startedAt });
      endLobbyTurnIfActive();
    }
  }, 2000);
}

// ── ROOM — in-session participants, raised hands, camera control ──
// Multiple people can watch the same running turn (Wilbur doesn't stop
// extra viewers from connecting once a stream is live) — this tracks who's
// actually present, logs occupancy over time, and arbitrates who currently
// drives the shared camera. First person to join a turn is the "host" (the
// agent/seller); everyone after is a "guest" (buyer) who can raise a hand
// and be granted control, then hand it back.
const ROOM_HEARTBEAT_TIMEOUT_MS = 20 * 1000;
const ROOM_PRUNE_INTERVAL_MS = 10 * 1000;

let room = {
  participants: new Map(), // id -> {id, name, role, joinedAt, lastSeen, raisedHand}
  hostId: null,
  controllerId: null,
};
let occupancyLog = [];

function logOccupancy(event, name) {
  const entry = { ts: new Date().toISOString(), event, name, count: room.participants.size };
  occupancyLog.push(entry);
  if (occupancyLog.length > 500) occupancyLog.shift();
  addLog('room', `${name || 'Someone'} ${event} — ${room.participants.size} in session`, 'info');
}

function resetRoom() {
  room.participants.clear();
  room.hostId = null;
  room.controllerId = null;
}

function promoteNextHost() {
  const next = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
  if (next) {
    room.hostId = next.id;
    room.controllerId = next.id;
    next.role = 'host';
    next.raisedHand = false;
  } else {
    room.hostId = null;
    room.controllerId = null;
  }
}

function roomJoin(name) {
  const id = genTicketId();
  const isFirst = room.participants.size === 0;
  const p = { id, name: (name || '').slice(0, 40) || 'Guest', role: isFirst ? 'host' : 'guest', joinedAt: Date.now(), lastSeen: Date.now(), raisedHand: false };
  room.participants.set(id, p);
  if (isFirst) { room.hostId = id; room.controllerId = id; }
  logOccupancy('joined', p.name);
  return { ok: true, id, role: p.role };
}

function roomHeartbeat(id) {
  const p = room.participants.get(id);
  if (p) p.lastSeen = Date.now();
  return { ok: !!p };
}

function roomLeave(id) {
  const p = room.participants.get(id);
  if (!p) return { ok: false };
  room.participants.delete(id);
  logOccupancy('left', p.name);
  if (room.controllerId === id || room.hostId === id) promoteNextHost();
  return { ok: true };
}

function roomRaiseHand(id, raised) {
  const p = room.participants.get(id);
  if (!p) return { ok: false, error: 'Not in session' };
  if (id === room.controllerId) return { ok: false, error: 'Already in control' };
  p.raisedHand = !!raised;
  return { ok: true };
}

function roomGrantControl(granterId, targetId) {
  if (granterId !== room.controllerId) return { ok: false, error: 'Only the current controller can grant control' };
  const target = room.participants.get(targetId);
  if (!target) return { ok: false, error: 'That participant is no longer here' };
  room.controllerId = targetId;
  target.raisedHand = false;
  addLog('room', `Control granted to ${target.name}`, 'ok');
  return { ok: true };
}

function roomReleaseControl(id) {
  if (id !== room.controllerId || id === room.hostId) return { ok: false, error: 'Nothing to release' };
  const p = room.participants.get(id);
  room.controllerId = room.hostId;
  addLog('room', `${p ? p.name : 'Guest'} handed control back to host`, 'info');
  return { ok: true };
}

function roomState() {
  return {
    hostId: room.hostId,
    controllerId: room.controllerId,
    count: room.participants.size,
    participants: [...room.participants.values()].map(p => ({ id: p.id, name: p.name, role: p.role, raisedHand: p.raisedHand })),
  };
}

// Prune anyone whose tab went away without a clean /leave call (closed tab,
// lost connection, crash) so a ghost participant never blocks control forever.
setInterval(() => {
  const now = Date.now();
  for (const [id, p] of room.participants) {
    if (now - p.lastSeen > ROOM_HEARTBEAT_TIMEOUT_MS) {
      room.participants.delete(id);
      logOccupancy('timed out', p.name);
      if (room.controllerId === id || room.hostId === id) promoteNextHost();
    }
  }
}, ROOM_PRUNE_INTERVAL_MS);

// ── HTTP SERVER ──────────────────────────────────────────────

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer((req, res) => {
  const url = req.url;
  const parsedUrl = new URL(req.url, 'http://localhost');

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  // Admin-only routes — anything that stops/kills processes or manages the
  // tunnel. Not called by the public landing page, only by the local
  // launcher-client.html admin UI, which sends the key automatically.
  const ADMIN_ROUTES = ['/api/launch-cf', '/api/stop-ps', '/api/stop-cf', '/api/stop-all', '/api/set-url', '/api/force-reset', '/api/session-mode/set'];
  if (ADMIN_ROUTES.includes(parsedUrl.pathname) && !isAdmin(req, parsedUrl)) {
    res.writeHead(401, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    return;
  }
  if (parsedUrl.pathname === '/events' && !isAdmin(req, parsedUrl)) {
    res.writeHead(401);
    res.end('Unauthorized');
    return;
  }

  // Serve SSE stream
  if (parsedUrl.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...CORS_HEADERS,
    });
    res.write('retry: 3000\n\n');

    // Send current state immediately on connect
    res.write('event: ps-status\ndata: ' + JSON.stringify({ status: psProcess ? lastPSStatus : 'stopped' }) + '\n\n');
    res.write('event: cf-status\ndata: ' + JSON.stringify({ status: cfProcess ? lastCFStatus : 'stopped', url: tunnelURL }) + '\n\n');
    res.write('event: session-mode\ndata: ' + JSON.stringify({ mode: sessionMode }) + '\n\n');
    if (tunnelURL) {
      res.write('event: cf-status\ndata: ' + JSON.stringify({ status: 'active', url: tunnelURL }) + '\n\n');
    }

    // Send existing logs
    [...psLog, ...cfLog].slice(-30).forEach(entry => {
      res.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
    });

    clients.push(res);
    req.on('close', () => { clients = clients.filter(c => c !== res); });
    return;
  }

  // API endpoints
  if (url === '/api/launch-ps' && req.method === 'POST') {
    launchPS().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/lobby/join' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let name = '';
      try { name = JSON.parse(body || '{}').name || ''; } catch (e) {}
      const ip = req.socket.remoteAddress || 'unknown';
      const result = joinLobby(name, ip, req.headers['user-agent']);
      res.writeHead(result.ok ? 200 : 429, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/lobby/status' && req.method === 'GET') {
    const id = parsedUrl.searchParams.get('id') || '';
    const status = lobbyStatusFor(id);
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(status || { state: 'unknown' }));
    return;
  }

  if (url === '/api/lobby/confirm' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let id = '';
      try { id = JSON.parse(body || '{}').id || ''; } catch (e) {}
      const result = confirmTurn(id);
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/lobby/leave' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let id = '';
      try { id = JSON.parse(body || '{}').id || ''; } catch (e) {}
      const result = leaveLobby(id);
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/room/join' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let name = '';
      try { name = JSON.parse(body || '{}').name || ''; } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(roomJoin(name)));
    });
    return;
  }

  if (url === '/api/room/heartbeat' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let id = '';
      try { id = JSON.parse(body || '{}').id || ''; } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(roomHeartbeat(id)));
    });
    return;
  }

  if (url === '/api/room/leave' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let id = '';
      try { id = JSON.parse(body || '{}').id || ''; } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(roomLeave(id)));
    });
    return;
  }

  if (url === '/api/room/raise-hand' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let id = '', raised = true;
      try { const b = JSON.parse(body || '{}'); id = b.id || ''; raised = b.raised !== false; } catch (e) {}
      const result = roomRaiseHand(id, raised);
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/room/grant-control' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let granterId = '', targetId = '';
      try { const b = JSON.parse(body || '{}'); granterId = b.granterId || ''; targetId = b.targetId || ''; } catch (e) {}
      const result = roomGrantControl(granterId, targetId);
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/room/release-control' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let id = '';
      try { id = JSON.parse(body || '{}').id || ''; } catch (e) {}
      const result = roomReleaseControl(id);
      res.writeHead(result.ok ? 200 : 409, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/room/state' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(roomState()));
    return;
  }

  if (url === '/api/launch-cf' && req.method === 'POST') {
    launchCF().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/stop-ps' && req.method === 'POST') {
    stopPS().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/stop-cf' && req.method === 'POST') {
    stopCF().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (parsedUrl.pathname === '/api/session-mode' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ mode: sessionMode }));
    return;
  }

  if (url === '/api/session-mode/set' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let mode = '';
      try { mode = JSON.parse(body || '{}').mode || ''; } catch (e) {}
      const result = setSessionMode(mode);
      res.writeHead(result.ok ? 200 : 400, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/force-reset' && req.method === 'POST') {
    forceReset().then(result => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify(result));
    });
    return;
  }

  if (url === '/api/set-url' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const { url: u } = JSON.parse(body);
        if (u && u.includes('trycloudflare')) {
          tunnelURL = u.trim();
          broadcast('cf-status', { status: 'active', url: tunnelURL });
          addLog('cf', 'Tunnel URL set: ' + tunnelURL, 'ok');
        }
      } catch(e) {}
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url === '/api/stop-all' && req.method === 'POST') {
    // This used to also kill launcher-server.js itself 2 seconds after
    // responding — meaning the UI would show "ready to launch" right as the
    // entire backend was about to disappear, so the next Launch click hit a
    // dead server. Stop All now does exactly what its name says: stop the
    // stream and tunnel, nothing else. The admin server stays up so
    // launch/stop can be repeated indefinitely in one session. To actually
    // shut the launcher down, close its terminal window or Ctrl+C it.
    Promise.all([stopPS(), stopCF()]).then(() => {
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (url === '/api/tunnel-url') {
    const os = require('os');
    const logFile = path.join(os.tmpdir(), 'archviz_cf_log.txt');
    let foundURL = tunnelURL;
    if (!foundURL && fs.existsSync(logFile)) {
      try {
        const data = fs.readFileSync(logFile, 'utf8');
        const match = data.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) foundURL = match[0];
      } catch(e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ url: foundURL }));
    return;
  }

  if (url === '/api/api-tunnel-url') {
    // Returns the URL of the launcher API tunnel (port 3000 tunnel)
    // so the landing page can auto-discover it if needed
    const os = require('os');
    const apiLogFile = path.join(os.tmpdir(), 'archviz_cf_api_log.txt');
    let apiURL = '';
    if (fs.existsSync(apiLogFile)) {
      try {
        const data = fs.readFileSync(apiLogFile, 'utf8');
        const match = data.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) apiURL = match[0];
      } catch(e) {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ url: apiURL }));
    return;
  }

  if (url === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({
      ps: lastPSStatus,
      cf: lastCFStatus,
      tunnelURL,
      roomCount: room.participants.size,
      sessionMode,
      hostName: HOST_NAME
    }));
    return;
  }

  // Serve launcher UI — LOCAL ACCESS ONLY. This page embeds the real
  // ADMIN_KEY directly in its HTML/JS source. This same server is tunneled
  // publicly as api.g-741studio.com, and this route had no gate at all: any
  // visitor could load it over the public tunnel, view-source, and get full
  // admin control (stop-all, force-reset, tunnel management). Cloudflare
  // stamps every request that actually traversed its edge with a `cf-ray`
  // header — a direct local request never has one — so that's used here to
  // block the admin page specifically from the public path while leaving
  // local access (how you actually use this panel) completely unaffected.
  if (url === '/' || url === '/index.html') {
    if (req.headers['cf-ray']) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const uiPath = path.join(BAT_DIR, 'launcher-client.html');
    if (fs.existsSync(uiPath)) {
      const html = fs.readFileSync(uiPath, 'utf8').replace('__ADMIN_KEY__', ADMIN_KEY);
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } else {
      res.writeHead(404);
      res.end('launcher-client.html not found — place it next to launcher-server.js');
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ArchViz Stream Launcher');
  console.log('  ---------------------------------');
  console.log('  Open: http://localhost:' + PORT);
  console.log('  Press Ctrl+C to stop');
  console.log('');
});

// Prevent unhandled errors from crashing the server
process.on('uncaughtException', err => {
  console.error('[Server] Uncaught error (non-fatal):', err.message);
});
process.on('unhandledRejection', err => {
  console.error('[Server] Unhandled rejection (non-fatal):', err);
});

process.on('SIGINT', async () => {
  // Now that stopPS/stopCF are async and actually verify the kill, awaiting
  // them here matters — exiting immediately used to race the taskkill calls,
  // sometimes leaving Wilbur or UE5 orphaned on Ctrl+C.
  await Promise.all([stopPS(), stopCF()]);
  process.exit(0);
});

// Keep Node alive regardless of child process state
setInterval(() => {}, 1000 * 60 * 60);
