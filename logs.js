'use strict';
// Logs: what the terminals on PC-1 print, gathered in one place for the G741 app's Logs tab (GET /api/logs, admin key) and for the QA console's
// "Get logs" on a run case (GET /api/qa/logs, QA key).
//
// Sources, all read-only (this module starts no process and writes only inside logs/):
//   wilbur       Wilbur's own log files (the signalling server): host.config WILBUR_LOG_DIR, else <SIGNAL_DIR>\logs
//   cloudflared  cloudflared.log next to the launcher (tunnel_service.bat appends cloudflared's output to it)
//   backend      this launcher's own log lines (addLog), also kept in logs/backend.jsonl so a restart does not lose them
//   agent        each PC's node agent (PC-1 and PC-2), read through the hub with a signed request (GET /v1/log)
//
// Every line gets a source, a time, a level and one activity type (TYPES), for the filters. A session is one run of the stream, from the moment the
// launcher starts it until it stops (kept in logs/sessions.json); the agents' lines in that window belong to it too.
const fs = require('fs');
const path = require('path');

const SOURCES = ['wilbur', 'cloudflared', 'backend', 'agent'];
// The activity types, in the order the app's dropdown shows them. 'keepalive' (Wilbur's ping/pong every 30 s per player) is hidden unless asked for.
const TYPES = {
  players:   { label: 'Visitors (players join, leave, subscribe)', sources: ['wilbur'] },
  webrtc:    { label: 'WebRTC negotiation (offer, answer, ICE)', sources: ['wilbur'] },
  streamer:  { label: 'UE5 streamer (connect, identify, disconnect)', sources: ['wilbur'] },
  keepalive: { label: 'Keepalives (ping / pong)', sources: ['wilbur'] },
  http:      { label: 'Web requests', sources: ['wilbur'] },
  stream:    { label: 'Stream launch and stop', sources: ['backend'] },
  lobby:     { label: 'Lobby, turns and the room', sources: ['backend'] },
  tunnel:    { label: 'Tunnel (cloudflared)', sources: ['cloudflared', 'backend'] },
  model:     { label: 'Local AI model (load, unload)', sources: ['agent'] },
  jobs:      { label: 'Agent jobs (started, done, failed)', sources: ['agent'] },
  render:    { label: 'Render handover (a client takes the GPU)', sources: ['agent'] },
  security:  { label: 'Security (refused requests)', sources: ['agent', 'backend'] },
  updates:   { label: 'Updates and restarts', sources: ['backend', 'agent'] },
  bridge:    { label: 'Bridge and Dev Console', sources: ['backend'] },
  startup:   { label: 'Startup and configuration', sources: ['wilbur', 'cloudflared', 'agent'] },
  other:     { label: 'Everything else', sources: SOURCES },
};
// What the dropdown offers besides one type: these name a set of lines, not a type.
const VIEWS = { all: 'Everything but keepalives', everything: 'Everything, keepalives too', problems: 'Problems only (warnings and errors)' };

const MAX_LINES = 20000, MAX_READ = 2 * 1024 * 1024, FIRST_READ = 512 * 1024, DAY = 86400000;
const strip = (s) => String(s == null ? '' : s).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').replace(/\s+$/, '');
const LEVEL = (s) => (/^(err|error|fatal|crit)/i.test(s) ? 'error' : /^(warn|wrn)/i.test(s) ? 'warn' : /^(debug|dbg|trace|verbose)/i.test(s) ? 'debug' : 'info');

// ── what each line is about ──
// Wilbur, as its console shows it: "[15:17:51.933] info: < Player5 :: {"type":"pong","time":...}" (or the same in a JSON file line).
function classifyWilbur(text) {
  const mt = (/"type"\s*:\s*"([A-Za-z]+)"/.exec(text) || [])[1] || '', who = (/[<>]\s*([\w.-]+)\s*::/.exec(text) || [])[1] || '';
  if (/^(ping|pong)$/i.test(mt)) return 'keepalive';
  if (/^(offer|answer|iceCandidate|iceCandidateError|config|peerConnectionOptions)$/i.test(mt)) return 'webrtc';
  if (/^(playerConnected|playerDisconnected|playerCount|subscribe|unsubscribe|listStreamers|streamerList|layerPreference|dataChannelRequest|peerDataChannels|peerDataChannelsReady|streamerDataChannels|subscribeFailed)$/i.test(mt)) return 'players';
  if (/^(identify|endpointId|endpointIdConfirm|streamerDisconnected|disconnectPlayer|stats)$/i.test(mt)) return 'streamer';
  if (mt) return /^player/i.test(who) ? 'players' : who ? 'streamer' : 'other';
  if (/\bplayer\b.*\b(connected|disconnected|joined|left|subscribed)\b/i.test(text)) return 'players';
  if (/\bstreamer\b.*\b(connected|disconnected|registered|identified)\b/i.test(text)) return 'streamer';
  if (/\b(GET|POST|PUT|HEAD|DELETE)\s+\/\S*/.test(text)) return 'http';
  if (/\b(listening|config(uration)?|version|options|started|starting|port \d+)\b/i.test(text)) return 'startup';
  return 'other';
}
function classifyAgent(text) {
  if (/^job \w+ /.test(text)) return 'jobs';
  if (/^model |model supervisor|llama/i.test(text)) return 'model';
  if (/^render:/.test(text)) return 'render';
  if (/rejected request|unauthori[sz]ed/i.test(text)) return 'security';
  if (/restart/i.test(text)) return 'updates';
  if (/^started:|listening on|discovery/i.test(text)) return 'startup';
  return 'other';
}
function classifyCloudflared(text) {
  return /\b(Starting tunnel|Version \d|Settings:|GOOS|Generated Connector ID|Initial protocol|metrics server)\b/i.test(text) ? 'startup' : 'tunnel';
}
// The launcher's own addLog sources: ps (the stream), cf (the tunnel), lobby (turns, the room, and the admin panel / Dev Console notes), bridge.
function classifyBackend(source, text) {
  if (/Unauthorized|rejected|refused .*key|bad key/i.test(text)) return 'security';
  if (/Update & restart|update applied|updater|restarting the launcher|launcher repo updated|\brestart(ing)?\b/i.test(text)) return 'updates';
  if (/^Dev Console|^bridge|fix notes/i.test(text) || source === 'bridge') return 'bridge';
  if (source === 'ps') return 'stream';
  if (source === 'cf') return 'tunnel';
  if (source === 'lobby' || source === 'room') return 'lobby';
  return 'other';
}

// ── parsing one raw line of each file ──
// Wilbur file lines are either JSON ({ "level", "message", "timestamp" }) or the console's "[HH:MM:SS.mmm] level: message"; a time with no date takes
// the file's date (the launcher runs on the same PC, so local time is right), stepping back a day when it would land after the file was written.
function parseWilburLine(raw, fileMtime) {
  const s = strip(raw); if (!s.trim()) return null;
  if (s[0] === '{') {
    try {
      const j = JSON.parse(s), t = Date.parse(j.timestamp || j.time || j.ts || '');
      const msg = typeof j.message === 'string' ? j.message : typeof j.msg === 'string' ? j.msg : JSON.stringify(j.message !== undefined ? j.message : j);
      return { ts: Number.isFinite(t) ? t : fileMtime, level: LEVEL(String(j.level || 'info')), text: strip(msg) };
    } catch (e) { /* not JSON after all */ }
  }
  let m = /^\[?(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?(Z|[+-]\d{2}:?\d{2})?\]?\s*(?:(\w+):?\s+)?([\s\S]*)$/.exec(s);
  if (m) {
    const iso = m[1] + 'T' + m[2] + ':' + m[3] + ':' + m[4] + '.' + (m[5] || '0').padEnd(3, '0') + (m[6] || '');
    const t = m[6] ? Date.parse(iso) : new Date(+m[1].slice(0, 4), +m[1].slice(5, 7) - 1, +m[1].slice(8, 10), +m[2], +m[3], +m[4], +(m[5] || '0').padEnd(3, '0')).getTime();
    const lvl = m[7] && /^(info|warn|warning|error|debug|verbose|log)$/i.test(m[7]) ? m[7] : '';
    return { ts: Number.isFinite(t) ? t : fileMtime, level: LEVEL(lvl || 'info'), text: lvl ? m[8] : ((m[7] ? m[7] + ' ' : '') + m[8]) };
  }
  m = /^\[(\d{2}):(\d{2}):(\d{2})(?:[.,](\d{1,3}))?\]\s*(?:(info|warn|warning|error|debug|verbose|log):\s*)?([\s\S]*)$/i.exec(s);
  if (m) {
    const d = new Date(fileMtime);
    let t = new Date(d.getFullYear(), d.getMonth(), d.getDate(), +m[1], +m[2], +m[3], +(m[4] || '0').padEnd(3, '0')).getTime();
    if (t > fileMtime + 60000) t -= DAY;                                             // written before midnight, file touched after it
    return { ts: t, level: LEVEL(m[5] || 'info'), text: m[6] };
  }
  return { ts: fileMtime, level: /\berror\b/i.test(s) ? 'error' : 'info', text: s, approx: true };
}
// cloudflared: "2026-11-16T21:17:51Z INF Registered tunnel connection connIndex=0 ..."
function parseCloudflaredLine(raw, fileMtime) {
  const s = strip(raw); if (!s.trim()) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\s+(INF|WRN|ERR|DBG|FTL)\s+([\s\S]*)$/.exec(s);
  if (m) return { ts: Date.parse(m[1]), level: LEVEL(m[2] === 'FTL' ? 'fatal' : m[2]), text: m[3] };
  return { ts: fileMtime, level: /\b(ERR|error|failed)\b/.test(s) ? 'error' : 'info', text: s, approx: true };
}

function readHostConfig(file) {
  const out = {};
  try { for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) { const m = /^\s*([A-Z_]+)=(.*)$/.exec(line); if (m) out[m[1]] = m[2].trim(); } } catch (e) { /* no host.config */ }
  return out;
}

function createLogs({ dir, hub = () => null, now = Date.now, maxLines = MAX_LINES } = {}) {
  const logDir = path.join(dir, 'logs');
  const lines = [];                                      // every line held in memory, oldest first, each with a rising seq (the cursor)
  let seq = 0;
  const status = {};                                     // per source: where it reads, and the last problem, said plainly
  const push = (l) => { l.seq = ++seq; l.at = new Date(l.ts).toISOString(); lines.push(l); if (lines.length > maxLines) lines.splice(0, lines.length - maxLines); return l; };
  const ensureDir = () => { try { fs.mkdirSync(logDir, { recursive: true }); } catch (e) { /* read-only: keep it in memory */ } };

  // ── a file read like `tail -f`: only the bytes added since the last read; a file that shrank (rotated, cleared) is read again from its start ──
  const tails = new Map();                               // file -> { offset, carry }
  function tailFile(file, parse, source, classify, extra = {}) {
    let st; try { st = fs.statSync(file); } catch (e) { return 0; }
    let t = tails.get(file);
    if (!t) { t = { offset: Math.max(0, st.size - FIRST_READ), carry: '', skipFirst: st.size > FIRST_READ }; tails.set(file, t); }
    if (st.size < t.offset) { t.offset = 0; t.carry = ''; t.skipFirst = false; }
    if (st.size === t.offset) return 0;
    const len = Math.min(st.size - t.offset, MAX_READ), buf = Buffer.alloc(len);
    const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, buf, 0, len, t.offset); } finally { fs.closeSync(fd); }
    t.offset += len;
    const parts = (t.carry + buf.toString('utf8')).split(/\r?\n/);
    t.carry = parts.pop();
    if (t.skipFirst) { parts.shift(); t.skipFirst = false; }    // the first read started mid-file: its first line is cut
    let n = 0;
    for (const raw of parts) {
      const p = parse(raw, st.mtimeMs); if (!p) continue;
      push({ ts: p.ts, source, level: p.level, type: classify(p.text), text: p.text.slice(0, 2000), ...(p.approx ? { approxTime: true } : {}), ...extra }); n++;
    }
    return n;
  }

  // ── Wilbur: the newest log files in its folder ──
  function wilburDirs() {
    const cfg = readHostConfig(path.join(dir, 'host.config'));
    if (cfg.WILBUR_LOG_DIR) return [cfg.WILBUR_LOG_DIR];
    if (!cfg.SIGNAL_DIR) return [];
    return [path.join(cfg.SIGNAL_DIR, 'logs'), path.join(cfg.SIGNAL_DIR, 'platform_scripts', 'cmd', 'logs')];
  }
  function refreshWilbur() {
    const dirs = wilburDirs();
    if (!dirs.length) { status.wilbur = { ok: false, error: 'host.config has no SIGNAL_DIR or WILBUR_LOG_DIR, so the launcher does not know where Wilbur writes its logs' }; return; }
    const files = [];
    for (const d of dirs) { try { for (const f of fs.readdirSync(d)) if (/\.(log|txt|json)$/i.test(f)) { const p = path.join(d, f), st = fs.statSync(p); if (st.isFile()) files.push({ p, m: st.mtimeMs }); } } catch (e) { /* that folder is not there */ } }
    files.sort((a, b) => b.m - a.m);
    const recent = files.filter((f) => now() - f.m < DAY).slice(0, 2).reverse();     // the current run's file and the one before, oldest first
    if (!files.length) { status.wilbur = { ok: false, where: dirs[0], error: 'no Wilbur log files in ' + dirs.join(' or ') + ' (set WILBUR_LOG_DIR in host.config if Wilbur writes them elsewhere)' }; return; }
    for (const f of recent) tailFile(f.p, parseWilburLine, 'wilbur', classifyWilbur, { file: path.basename(f.p) });
    status.wilbur = { ok: true, where: path.dirname(files[0].p), file: path.basename(files[0].p), lastWrite: new Date(files[0].m).toISOString() };
  }
  function refreshCloudflared() {
    const f = path.join(dir, 'cloudflared.log');
    if (!fs.existsSync(f)) { status.cloudflared = { ok: false, where: f, error: 'no cloudflared.log next to the launcher (tunnel_service.bat writes it)' }; return; }
    tailFile(f, parseCloudflaredLine, 'cloudflared', classifyCloudflared);
    status.cloudflared = { ok: true, where: f };
  }

  // ── the launcher's own lines: kept in memory and in logs/backend.jsonl (rotated at 5 MB) ──
  const backendFile = path.join(logDir, 'backend.jsonl');
  function loadBackend() {
    try {
      const st = fs.statSync(backendFile), len = Math.min(st.size, FIRST_READ), buf = Buffer.alloc(len), fd = fs.openSync(backendFile, 'r');
      try { fs.readSync(fd, buf, 0, len, st.size - len); } finally { fs.closeSync(fd); }
      const rows = buf.toString('utf8').split('\n'); if (st.size > len) rows.shift();
      for (const r of rows) { try { const j = JSON.parse(r); if (j && Number.isFinite(j.ts) && typeof j.text === 'string') push({ ts: j.ts, source: 'backend', level: LEVEL(j.level), type: TYPES[j.type] ? j.type : 'other', text: j.text.slice(0, 2000), area: String(j.area || '').slice(0, 20) }); } catch (e) { /* a torn line */ } }
    } catch (e) { /* no file yet */ }
  }
  function backend(area, text, type = 'info') {
    const l = push({ ts: now(), source: 'backend', level: type === 'error' ? 'error' : type === 'warn' ? 'warn' : 'info', type: classifyBackend(area, String(text)), text: strip(text).slice(0, 2000), area: String(area || '').slice(0, 20) });
    try {
      ensureDir();
      try { if (fs.statSync(backendFile).size > 5 * 1024 * 1024) fs.renameSync(backendFile, path.join(logDir, 'backend.1.jsonl')); } catch (e) { /* first line */ }
      fs.appendFileSync(backendFile, JSON.stringify({ ts: l.ts, level: l.level, type: l.type, area: l.area, text: l.text }) + '\n');
    } catch (e) { /* a full or read-only disk must never stop the launcher */ }
    return l;
  }
  status.backend = { ok: true, where: backendFile };

  // ── the agents, through the hub ──
  const cursors = {};
  async function refreshAgents() {
    const h = hub();
    if (!h || typeof h.agentLogs !== 'function') { status.agent = { ok: false, error: 'the bridge is not set up on this launcher, so there are no agents to read' }; return; }
    const res = await h.agentLogs(cursors);
    const pcs = [];
    for (const a of res) {
      if (a.error) { pcs.push(a.alias + ': ' + a.error); continue; }
      cursors[a.id] = { seq: a.seq, startedAt: a.startedAt };
      for (const e of a.lines || []) if (Number.isFinite(e.ts) && typeof e.text === 'string') push({ ts: e.ts, source: 'agent', level: LEVEL(e.level), type: classifyAgent(e.text), text: e.text.slice(0, 500), device: a.alias, pc: a.pc });
    }
    status.agent = res.length ? { ok: !pcs.length, agents: res.map((a) => ({ alias: a.alias, pc: a.pc, ok: !a.error })), ...(pcs.length ? { error: pcs.join('; ') } : {}) } : { ok: false, error: 'no agent is online' };
  }

  let refreshing = null;
  async function refresh(sources = SOURCES) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      if (sources.includes('wilbur')) { try { refreshWilbur(); } catch (e) { status.wilbur = { ok: false, error: 'could not read Wilbur\'s logs: ' + e.message }; } }
      if (sources.includes('cloudflared')) { try { refreshCloudflared(); } catch (e) { status.cloudflared = { ok: false, error: 'could not read cloudflared.log: ' + e.message }; } }
      if (sources.includes('agent')) { try { await refreshAgents(); } catch (e) { status.agent = { ok: false, error: 'could not read the agents: ' + e.message }; } }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ── stream sessions: from a launch until the stream is stopped ──
  const sessionsFile = path.join(logDir, 'sessions.json');
  let sessions = [];
  try { const j = JSON.parse(fs.readFileSync(sessionsFile, 'utf8')); if (Array.isArray(j)) sessions = j.filter((s) => s && /^s_[0-9a-z]+$/.test(s.id) && Number.isFinite(s.start)).slice(-50); } catch (e) { /* none yet */ }
  const saveSessions = () => { try { ensureDir(); fs.writeFileSync(sessionsFile, JSON.stringify(sessions.slice(-50))); } catch (e) { /* keep them in memory */ } };
  function sessionStart(label) {
    const open = sessions.find((s) => !s.end);
    if (open) return open;
    const s = { id: 's_' + now().toString(36), start: now(), end: null, label: String(label || 'Stream session').slice(0, 60) };
    sessions.push(s); if (sessions.length > 50) sessions.shift(); saveSessions();
    return s;
  }
  // Called with the stream's state every few seconds: a stopped stream closes the open session (after a minute of grace, so a launch in progress
  // that still reads "stopped" for a moment is not cut short).
  function sessionTick(state) {
    const open = sessions.find((s) => !s.end);
    if (state && state !== 'stopped' && !open) sessionStart('Stream session');
    else if (open && state === 'stopped' && now() - open.start > 60000) { open.end = now(); saveSessions(); }
  }
  const sessionView = (s) => ({ id: s.id, label: s.label, start: new Date(s.start).toISOString(), end: s.end ? new Date(s.end).toISOString() : null, open: !s.end });
  function windowFor(session) {
    if (!session || session === 'current') {
      const s = sessions.find((x) => !x.end) || sessions[sessions.length - 1];
      return s ? { from: s.start - 15000, to: s.end ? s.end + 15000 : null, session: sessionView(s) } : { from: now() - DAY, to: null, session: null, note: 'No stream session yet: showing the last 24 hours.' };
    }
    if (session === 'all') return { from: 0, to: null, session: null };
    const s = sessions.find((x) => x.id === session);
    return s ? { from: s.start - 15000, to: s.end ? s.end + 15000 : null, session: sessionView(s) } : null;
  }

  // ── reading ──
  // sources: any of SOURCES; type: a TYPES key, a comma list of them, or a VIEWS key; q: words the line must contain; since: the cursor of a live tail.
  function select({ sources = SOURCES, from = 0, to = null, type = 'all', q = '', since = 0, limit = 1000 } = {}) {
    const want = new Set(sources), words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
    const types = type === 'all' || type === 'everything' || type === 'problems' ? null : new Set(String(type).split(',').filter((t) => TYPES[t]));
    const counts = {};
    const out = [];
    for (const l of lines) {
      if (!want.has(l.source) || l.ts < from || (to && l.ts > to)) continue;
      counts[l.type] = (counts[l.type] || 0) + 1;
      if (type === 'all' && l.type === 'keepalive') continue;
      if (type === 'problems' && l.level !== 'warn' && l.level !== 'error') continue;
      if (types && !types.has(l.type)) continue;
      if (l.seq <= since) continue;
      if (words.length) { const t = (l.text + ' ' + (l.device || '')).toLowerCase(); if (!words.every((w) => t.includes(w))) continue; }
      out.push(l);
    }
    out.sort((a, b) => a.ts - b.ts || a.seq - b.seq);
    const max = Math.min(Math.max(parseInt(limit, 10) || 1000, 1), 5000);
    return { lines: out.slice(-max), truncated: out.length > max, counts };
  }
  const parseSources = (s) => { const list = String(s || '').split(',').map((x) => x.trim()).filter((x) => SOURCES.includes(x)); return list.length ? list : SOURCES; };

  // GET /api/logs (the G741 app's Logs tab): one session (or all), one type or view, words to find, and a cursor to follow it live.
  async function query(params = {}) {
    const sources = parseSources(params.sources);
    await refresh(sources);
    const w = windowFor(params.session);
    if (!w) return { status: 404, body: { ok: false, error: 'no such session' } };
    const type = String(params.type || 'all');
    if (!VIEWS[type] && !String(type).split(',').every((t) => TYPES[t])) return { status: 400, body: { ok: false, error: 'type must be one of ' + [...Object.keys(VIEWS), ...Object.keys(TYPES)].join(', ') } };
    const r = select({ sources, from: w.from, to: w.to, type, q: params.q, since: Math.max(0, parseInt(params.since, 10) || 0), limit: params.limit });
    return { status: 200, body: { ok: true, cursor: seq, session: w.session, note: w.note || null, lines: r.lines.map(view), truncated: r.truncated,
      counts: r.counts, sources: Object.fromEntries(sources.map((s) => [s, status[s] || { ok: true }])),
      sessions: sessions.slice().reverse().slice(0, 20).map(sessionView), types: Object.entries(TYPES).map(([id, t]) => ({ id, label: t.label, sources: t.sources })), views: VIEWS } };
  }
  // GET /api/qa/logs (the QA console's "Get logs" on a run case): every line of the asked sources in a time window, as { source, at, text }.
  async function qa(params = {}) {
    const sources = parseSources(params.sources), from = Date.parse(params.since || ''), to = Date.parse(params.until || '');
    if (!Number.isFinite(from) || (params.until && !Number.isFinite(to)) || (Number.isFinite(to) && to < from)) return { status: 400, body: { ok: false, error: 'since and until must be ISO times, since first' } };
    if ((Number.isFinite(to) ? to : now()) - from > 2 * DAY) return { status: 400, body: { ok: false, error: 'the window may be at most two days' } };
    await refresh(sources);
    const r = select({ sources, from, to: Number.isFinite(to) ? to : null, type: params.type ? String(params.type) : 'everything', limit: 5000 });
    return { status: 200, body: { ok: true, lines: r.lines.map((l) => ({ source: l.source, at: l.at, text: (l.device ? l.device + ': ' : '') + l.text, type: l.type, level: l.level })), truncated: r.truncated,
      sources: Object.fromEntries(sources.map((s) => [s, status[s] || { ok: true }])) } };
  }
  const view = (l) => ({ seq: l.seq, at: l.at, source: l.source, level: l.level, type: l.type, text: l.text, ...(l.device ? { device: l.device, pc: l.pc } : {}), ...(l.area ? { area: l.area } : {}), ...(l.approxTime ? { approxTime: true } : {}) });

  loadBackend();
  return { backend, refresh, query, qa, select, sessionStart, sessionTick, windowFor, sessions: () => sessions.map(sessionView), status: () => ({ ...status }), get cursor() { return seq; } };
}

module.exports = { createLogs, classifyWilbur, classifyAgent, classifyCloudflared, classifyBackend, parseWilburLine, parseCloudflaredLine, SOURCES, TYPES, VIEWS };
