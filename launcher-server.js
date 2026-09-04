// ============================================================
//  ArchViz Stream Launcher — Local Server
//  Run: node launcher-server.js
//  Open: http://localhost:3000
// ============================================================

const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// ── CONFIG ───────────────────────────────────────────────────
const PORT = 3000;

// Paths to your bat files — edit if needed
const BAT_DIR = __dirname;
const PS_BAT  = path.join(BAT_DIR, 'launch_pixelstream.bat');
const CF_BAT  = path.join(BAT_DIR, 'expose_cloudflare_tunnel.bat');

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

// ── PROCESS LAUNCHERS ────────────────────────────────────────

function launchPS() {
  if (psProcess) return { ok: false, error: 'Already running' };
  if (!fs.existsSync(PS_BAT)) return { ok: false, error: 'launch_pixelstream.bat not found at: ' + PS_BAT };

  addLog('ps', 'Starting launch_pixelstream.bat…', 'info');
  broadcast('ps-status', { status: 'starting' });

  // Launch bat in a new visible terminal window — fire and forget
  // We poll Wilbur's port to detect when stream is live
  const batProcess = spawn('cmd.exe', ['/k', PS_BAT], {
    cwd: BAT_DIR,
    detached: true,
    shell: false,
    stdio: 'ignore',
  });
  batProcess.unref();
  psProcess = batProcess;

  lastPSStatus = 'starting';
  broadcast('ps-status', { status: 'starting' });
  addLog('ps', 'launch_pixelstream.bat started in terminal window.', 'info');
  addLog('ps', 'Polling for Wilbur on port 80…', 'info');

  // Poll port 80 to detect when Wilbur is live
  let psPolling = true;
  const net = require('net');
  const pollPS = setInterval(() => {
    if (!psPolling) { clearInterval(pollPS); return; }
    const sock = net.createConnection({ port: 80, host: '127.0.0.1' });
    sock.setTimeout(1000);
    sock.on('connect', () => {
      sock.destroy();
      if (!psPolling) return;
      psPolling = false;
      clearInterval(pollPS);
      lastPSStatus = 'running';
      broadcast('ps-status', { status: 'running' });
      addLog('ps', 'Wilbur signaling server detected on port 80 ✓', 'ok');
      addLog('ps', 'Waiting for UE5 streamer to connect…', 'info');

      // Watch Wilbur log for DefaultStreamer connection
      const wilburLogDir = path.join(__dirname,
        'Y:\\Installed Software\\3D\\UE5\\UE_5.7\\Engine\\Plugins\\Media\\PixelStreaming\\Resources\\WebServers\\SignallingWebServer\\logs'
      );
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
        });
        s2.on('error', () => { try { s2.destroy(); } catch(e){} });
        s2.on('timeout', () => { try { s2.destroy(); } catch(e){} });
      }, 3000);
    });
    sock.on('error', () => { try { sock.destroy(); } catch(e){} });
    sock.on('timeout', () => { try { sock.destroy(); } catch(e){} });
  }, 3000);

  return { ok: true };
}

function launchCF() {
  if (cfProcess) return { ok: false, error: 'Already running' };
  if (!fs.existsSync(CF_BAT)) {
    addLog('cf', 'expose_cloudflare_tunnel.bat not found at: ' + CF_BAT, 'err');
    return { ok: false, error: 'expose_cloudflare_tunnel.bat not found at: ' + CF_BAT };
  }

  addLog('cf', 'Starting expose_cloudflare_tunnel.bat…', 'info');
  broadcast('cf-status', { status: 'connecting' });

  // Launch CF bat in a new visible terminal — fire and forget
  const cfBatProcess = spawn('cmd.exe', ['/k', CF_BAT], {
    cwd: BAT_DIR,
    detached: true,
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

function stopPS() {
  lastPSStatus = 'stopped';
  broadcast('ps-status', { status: 'stopped' });
  spawn('taskkill', ['/F', '/IM', 'ArchVizProject3.exe'], { shell: true });
  spawn('taskkill', ['/F', '/IM', 'node.exe', '/FI', 'MEMUSAGE gt 50000'], { shell: true });
  if (psProcess) { try { psProcess.kill(); } catch(e){} }
  psProcess = null;
  addLog('ps', 'Stream stopped.', 'info');
  resetRoom();
  endLobbyTurnIfActive();
  return { ok: true };
}

function stopCF() {
  lastCFStatus = 'stopped';
  tunnelURL = '';
  broadcast('cf-status', { status: 'stopped', url: '' });
  spawn('taskkill', ['/F', '/IM', 'cloudflared.exe'], { shell: true });
  if (cfProcess) { try { cfProcess.kill(); } catch(e){} }
  cfProcess = null;
  addLog('cf', 'Tunnel closed.', 'info');
  return { ok: true };
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

let lobbyQueue = [];       // [{id, name, joinedAt}]
let currentTurn = null;    // {id, name, status: 'confirming'|'active', deadline}
let turnTimer = null;
const lastJoinByIP = new Map();

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
  currentTurn = { id: next.id, name: next.name, status: 'confirming', deadline: Date.now() + CONFIRM_GRACE_MS };
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
      msLeft: Math.max(0, currentTurn.deadline - Date.now()),
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

function joinLobby(name, ip) {
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
  lobbyQueue.push({ id, name: (name || '').slice(0, 80), joinedAt: now });
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
  if (!currentTurn || currentTurn.id !== id || currentTurn.status !== 'confirming') {
    return { ok: false, error: 'Not your turn, or it already expired' };
  }
  clearTurnTimer();
  currentTurn.status = 'active';
  currentTurn.deadline = Date.now() + SESSION_DURATION_MS;
  addLog('lobby', `${currentTurn.name || 'Visitor'} confirmed — launching (15 min turn)`, 'ok');
  resetRoom();
  launchPS();
  turnTimer = setTimeout(() => {
    addLog('lobby', `${currentTurn ? (currentTurn.name || 'Visitor') : 'Session'}'s 15 minutes are up`, 'info');
    stopPS();
  }, SESSION_DURATION_MS);
  return { ok: true };
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
  const ADMIN_ROUTES = ['/api/launch-cf', '/api/stop-ps', '/api/stop-cf', '/api/stop-all', '/api/set-url'];
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
    const result = launchPS();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(result));
    return;
  }

  if (url === '/api/lobby/join' && req.method === 'POST') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let name = '';
      try { name = JSON.parse(body || '{}').name || ''; } catch (e) {}
      const ip = req.socket.remoteAddress || 'unknown';
      const result = joinLobby(name, ip);
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
    const result = launchCF();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(result));
    return;
  }

  if (url === '/api/stop-ps' && req.method === 'POST') {
    const result = stopPS();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(result));
    return;
  }

  if (url === '/api/stop-cf' && req.method === 'POST') {
    const result = stopCF();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify(result));
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
    stopPS();
    stopCF();
    res.writeHead(200, { 'Content-Type': 'application/json', ...CORS_HEADERS });
    res.end(JSON.stringify({ ok: true }));
    // Give processes time to die then kill launcher server itself
    setTimeout(() => {
      addLog('ps', 'Launcher server shutting down.', 'info');
      process.exit(0);
    }, 2000);
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
      roomCount: room.participants.size
    }));
    return;
  }

  // Serve launcher UI
  if (url === '/' || url === '/index.html') {
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

process.on('SIGINT', () => {
  stopPS();
  stopCF();
  process.exit(0);
});

// Keep Node alive regardless of child process state
setInterval(() => {}, 1000 * 60 * 60);
