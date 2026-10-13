#!/usr/bin/env node
'use strict';
// G741 bridge - node agent. Runs on EVERY PC in the pool (including the one hosting the launcher).
//
//   node bridge/node-agent.js --init     create bridge/bridge.key (once, on one PC) + bridge/bridge-node.json
//   node bridge/node-agent.js            run the agent
//
// What it does:
//   1. Reports this PC's identity and live resources (CPU, RAM, GPU, VRAM, local model state) over a signed HTTP API.
//   2. Finds the other PCs on the LAN (signed UDP beacons, one per real network interface).
//   3. Runs jobs for the hub: ONLY "llm.chat" (forward a prompt to the local llama-server) and "echo" (for tests).
//      It never runs commands, reads files or takes code from the network - a job is data, not instructions.
//
// Every request must carry a valid HMAC signature made with bridge.key (see protocol.js). Anyone on the LAN who
// doesn't hold the key gets a bare 401.
const http = require('http');
const dgram = require('dgram');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { execFile } = require('child_process');
const P = require('./protocol');
const { createSupervisor } = require('./model-supervisor');

const GB = 1024 ** 3;
const MAX_BODY = 256 * 1024, MAX_QUEUE = 20, KEEP_JOBS = 200;
const JOB_TYPES = new Set(['llm.chat', 'echo']);

// ── resource sampling ──
const cpuSnapshot = () => os.cpus().reduce((a, c) => { const t = c.times; a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq; return a; }, { idle: 0, total: 0 });
function makeCpuSampler() {
  let prev = cpuSnapshot();
  return () => { const cur = cpuSnapshot(), dt = cur.total - prev.total, di = cur.idle - prev.idle; prev = cur; return dt > 0 ? Math.round((1 - di / dt) * 100) : 0; };
}
// Fixed arguments, nothing from the network ever reaches this command line.
function readGpu() {
  return new Promise((resolve) => {
    execFile('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'], { timeout: 4000, windowsHide: true }, (err, out) => {
      if (err || !out) return resolve(null);
      const p = String(out).split('\n')[0].split(',').map((s) => s.trim());
      if (p.length < 5) return resolve(null);
      resolve({ name: p[0], utilPct: +p[1], vramUsedGB: +(p[2] / 1024).toFixed(2), vramTotalGB: +(p[3] / 1024).toFixed(2), tempC: +p[4] });
    });
  });
}

// Is anything listening on these LOCAL ports? (Wilbur's streamer port is only open while a client session is being rendered.)
const portOpen = (port) => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port, timeout: 400 });
  const done = (v) => { s.destroy(); resolve(v); };
  s.once('connect', () => done(true)); s.once('timeout', () => done(false)); s.once('error', () => done(false));
});

function createAgent(opts) {
  const { key, alias = os.hostname(), port = 7411, discoveryPort = 7412, bindHost = '0.0.0.0', model = 'local',
    id = crypto.randomBytes(6).toString('hex'), pendingRamGB = 0, discovery = true, statsMs = 2000, log = () => {}, gpuProvider = readGpu,
    hwPatch = null, statsPatch = null,   // hwPatch / statsPatch: only used by tests and the demo server to impersonate other hardware
    llama = null, nightly = undefined, idleMinutes = 15, supervisor: injected = null,   // the ONE local model server this PC may run (from bridge-node.json)
    render = {}, statePath = null } = opts;
  if (!key) throw new Error('agent needs a key');
  const llamaUrl = opts.llamaUrl || ('http://127.0.0.1:' + ((llama && llama.port) || 8097));
  const renderCfg = { enabled: render.enabled !== false, ports: Array.isArray(render.ports) ? render.ports.filter(Number.isInteger) : [8888], canRender: render.canRender !== false };

  const guard = new P.ReplayGuard();
  const peers = new Map();
  const jobs = new Map(), queue = [];
  let running = null, server = null, sock = null, timers = [];
  const sampleCpu = makeCpuSampler();
  const state = { gpu: null, cpuPct: 0, llmUp: false, hwGpu: null, renderProbe: false, hintUntil: 0, reserved: false };
  const supervisor = injected || (llama ? createSupervisor({ llama: { ...llama, alias: model }, window: nightly, idleMinutes, log }) : null);
  if (statePath) { try { state.reserved = !!JSON.parse(fs.readFileSync(statePath, 'utf8')).reserved; } catch (e) { /* first run */ } }
  const saveState = () => { if (statePath) { try { fs.writeFileSync(statePath, JSON.stringify({ reserved: state.reserved })); } catch (e) { /* read-only folder: keep it in memory */ } } };
  // This PC is "rendering" when a client session is up (probe), was just announced by the launcher (hint), or it is reserved for rendering.
  const renderBusy = () => state.reserved || state.hintUntil > Date.now() || state.renderProbe;

  async function sample() {
    state.cpuPct = sampleCpu();
    try { state.gpu = await gpuProvider(); } catch (e) { state.gpu = null; }
    if (state.gpu && !state.hwGpu) state.hwGpu = { name: state.gpu.name, vramTotalGB: state.gpu.vramTotalGB };
    state.renderProbe = renderCfg.enabled ? (await Promise.all(renderCfg.ports.map(portOpen))).some(Boolean) : false;
    if (supervisor) { try { await supervisor.tick({ renderBusy: renderBusy() }); } catch (e) { log('model supervisor: ' + e.message); } }
  }
  async function probeLlm() {
    try { state.llmUp = (await fetch(llamaUrl + '/health', { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { state.llmUp = false; }
  }

  const info = () => ({
    id, alias, version: 1, hostname: os.hostname(),
    hw: { cpu: (os.cpus()[0] || {}).model ? os.cpus()[0].model.trim() : 'unknown', threads: os.cpus().length, ramTotalGB: +(os.totalmem() / GB).toFixed(1), pendingRamGB,
      gpu: state.hwGpu, os: os.type() + ' ' + os.release(), node: process.version, ...(hwPatch || {}) },
  });
  const stats = () => {
    const s = {
      ts: Date.now(), cpuPct: state.cpuPct, ramUsedGB: +((os.totalmem() - os.freemem()) / GB).toFixed(1), ramTotalGB: +(os.totalmem() / GB).toFixed(1), gpu: state.gpu,
      llm: { up: state.llmUp, model, busy: !!running, queued: queue.length },
      render: { busy: renderBusy(), probe: state.renderProbe, hint: state.hintUntil > Date.now(), canRender: renderCfg.canRender, reserved: state.reserved },
      model: supervisor ? supervisor.status() : { phase: state.llmUp ? 'up' : 'stopped', external: true, canStart: false, windowActive: false, demandActive: false, paused: false, error: null, window: null },
      jobs: { done: [...jobs.values()].filter((j) => j.status === 'done').length, failed: [...jobs.values()].filter((j) => j.status === 'failed').length },
    };
    return statsPatch ? statsPatch(s) : s;
  };

  // ── jobs ──
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  function validateJob(b) {
    if (!b || typeof b !== 'object') return 'body must be an object';
    if (!JOB_TYPES.has(b.type)) return 'unsupported job type';
    if (!Array.isArray(b.messages) || b.messages.length < 1 || b.messages.length > 20) return 'messages must be 1-20 items';
    for (const m of b.messages) if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string' || m.content.length > 16000) return 'bad message';
    return null;
  }
  function enqueue(b) {
    const job = { id: crypto.randomBytes(8).toString('hex'), type: b.type, role: clip(b.role, 40), area: clip(b.area, 40), title: clip(b.title, 120), confidential: !!b.confidential,
      messages: b.messages.map((m) => ({ role: m.role, content: m.content })), maxTokens: Math.min(Math.max(parseInt(b.maxTokens, 10) || 512, 1), 2048), thinking: !!b.thinking,
      status: 'queued', createdAt: Date.now(), startedAt: null, doneAt: null, result: null, error: null };
    jobs.set(job.id, job); queue.push(job);
    if (jobs.size > KEEP_JOBS) for (const [k, v] of jobs) { if (v.status === 'done' || v.status === 'failed') { jobs.delete(k); if (jobs.size <= KEEP_JOBS) break; } }
    pump();
    return job;
  }
  async function runJob(job) {
    job.status = 'running'; job.startedAt = Date.now();
    try {
      if (job.type === 'echo') job.result = { text: job.messages.map((m) => m.content).join('\n'), tokens: 0 };
      else {
        if (renderBusy()) throw new Error('rendering: this PC is serving a client, so it does not run the model');
        if (!state.llmUp) throw new Error('llm_unavailable: no local model is running on this PC');
        if (supervisor) supervisor.touch();
        const r = await fetch(llamaUrl + '/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10 * 60 * 1000),
          body: JSON.stringify({ model, messages: job.messages, max_tokens: job.maxTokens, temperature: 0.6, stream: false, chat_template_kwargs: { enable_thinking: job.thinking } }) });
        if (!r.ok) throw new Error('model server answered HTTP ' + r.status);
        const j = await r.json();
        job.result = { text: (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '', tokens: (j.usage && j.usage.completion_tokens) || 0 };
      }
      job.status = 'done';
    } catch (e) {
      job.status = 'failed';
      // A model that disappears mid-job because a client started rendering is not a failure of the task: say so, so the hub re-queues it elsewhere.
      job.error = clip(renderBusy() && !/^rendering:/.test(e.message) ? 'rendering: the model was unloaded because a client session started (' + e.message + ')' : e.message, 300);
    }
    job.doneAt = Date.now();
    if (supervisor) supervisor.touch();
  }
  function pump() {
    if (running || !queue.length) return;
    running = queue.shift();
    runJob(running).finally(() => { running = null; pump(); });
  }
  const jobView = (j, full) => ({ id: j.id, type: j.type, role: j.role, area: j.area, title: j.title, confidential: j.confidential, status: j.status, createdAt: j.createdAt, startedAt: j.startedAt, doneAt: j.doneAt, error: j.error, ...(full ? { result: j.result } : {}) });

  // ── HTTP ──
  function handle(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let body = '', big = false;
    req.on('data', (d) => { body += d; if (body.length > MAX_BODY) { big = true; req.destroy(); } });
    req.on('error', () => {});
    req.on('end', () => {
      if (big) return;
      const v = P.verifyRequest(key, req.method, req.url, req.headers, body, guard);
      if (!v.ok) { log('rejected request from ' + req.socket.remoteAddress + ': ' + v.reason); return send(401, { ok: false, error: 'unauthorized' }); }
      const u = new URL(req.url, 'http://x');
      const p = u.pathname;
      if (req.method === 'GET' && p === '/v1/info') return send(200, { ok: true, ...info() });
      if (req.method === 'GET' && p === '/v1/stats') return send(200, { ok: true, ...stats() });
      if (req.method === 'GET' && p === '/v1/peers') return send(200, { ok: true, peers: [...peers.values()] });
      if (req.method === 'GET' && p === '/v1/jobs') return send(200, { ok: true, jobs: [...jobs.values()].slice(-20).reverse().map((j) => jobView(j, false)) });
      if (req.method === 'GET' && p.startsWith('/v1/jobs/')) { const j = jobs.get(p.slice(9)); return j ? send(200, { ok: true, job: jobView(j, true) }) : send(404, { ok: false, error: 'no such job' }); }
      if (req.method === 'POST' && p === '/v1/jobs') {
        let b; try { b = JSON.parse(body || '{}'); } catch (e) { return send(400, { ok: false, error: 'invalid JSON' }); }
        const bad = validateJob(b); if (bad) return send(400, { ok: false, error: bad });
        if (queue.length >= MAX_QUEUE) return send(503, { ok: false, error: 'queue full' });
        return send(202, { ok: true, jobId: enqueue(b).id });
      }
      // The only controls the network has over this PC's model and render state. None of them can name a file, a command or an argument.
      if (req.method === 'POST' && (p === '/v1/model' || p === '/v1/reserve' || p === '/v1/hint')) {
        let b; try { b = JSON.parse(body || '{}'); } catch (e) { return send(400, { ok: false, error: 'invalid JSON' }); }
        if (p === '/v1/model') {
          if (!supervisor) return send(409, { ok: false, error: 'no model is configured on this PC (llama in bridge-node.json)' });
          if (b.action === 'start' && renderBusy()) return send(409, { ok: false, error: 'rendering: not starting the model while this PC serves a client' });
          if (!supervisor.request(b.action)) return send(400, { ok: false, error: 'action must be start or stop' });
          return send(200, { ok: true, model: supervisor.status() });
        }
        if (p === '/v1/reserve') { state.reserved = !!b.reserved; saveState(); return send(200, { ok: true, reserved: state.reserved }); }
        const ttl = Math.min(Math.max(Number(b.ttlSec) || 90, 5), 300);      // 'hint': the launcher says a client render is about to start
        state.hintUntil = b.render ? Date.now() + ttl * 1000 : 0;
        return send(200, { ok: true, hintUntil: state.hintUntil });
      }
      send(404, { ok: false, error: 'not found' });
    });
  }

  // ── discovery ──
  function sendBeacon() {
    if (!sock) return;
    const msg = P.makeBeacon(key, { id, alias, port: server.address().port });
    for (const a of P.broadcastAddresses()) { try { sock.send(msg, discoveryPort, a, () => {}); } catch (e) { /* interface went away */ } }
  }
  function startDiscovery() {
    sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', (e) => { log('discovery disabled: ' + e.message); try { sock.close(); } catch (x) { /* closed */ } sock = null; });
    sock.on('message', (msg, rinfo) => {
      const b = P.parseBeacon(key, msg);
      if (!b || b.id === id) return;
      peers.set(b.id, { id: b.id, alias: b.alias, address: rinfo.address, port: b.port, lastSeen: Date.now() });
    });
    sock.bind(discoveryPort, () => { try { sock.setBroadcast(true); } catch (e) { return; } sendBeacon(); timers.push(setInterval(sendBeacon, 5000)); });
  }

  async function start() {
    await new Promise((resolve, reject) => { server = http.createServer(handle); server.once('error', reject); server.listen(port, bindHost, resolve); });
    await sample(); await probeLlm();
    timers.push(setInterval(sample, statsMs), setInterval(probeLlm, 3000));
    if (discovery) startDiscovery();
    for (const t of timers) if (t.unref) t.unref();
    return server.address().port;
  }
  async function stop() {
    for (const t of timers) clearInterval(t); timers = [];
    if (supervisor) { try { await supervisor.stop('agent stopping'); } catch (e) { /* nothing to stop */ } }   // never leave a model we started running unattended
    if (sock) { try { sock.close(); } catch (e) { /* closed */ } sock = null; }
    if (server) await new Promise((r) => { server.close(() => r()); if (server.closeAllConnections) server.closeAllConnections(); });
  }
  return { id, start, stop, info, stats, peers: () => [...peers.values()], get port() { return server && server.address() ? server.address().port : port } };
}

// What a fresh PC's config looks like. The `llama` block is where THIS PC's model lives; it is only ever read from this file.
const defaultConfig = (alias) => ({
  alias, id: crypto.randomBytes(6).toString('hex'), port: 7411, discoveryPort: 7412, model: 'qwen3-8b', pendingRamGB: 0,
  llama: { exe: '', model: '', port: 8097, ctx: 16384 },
  nightly: { enabled: true, start: '00:00', end: '07:00', tz: -360 },       // keep the model loaded 00:00-07:00 Mexico City time
  idleMinutes: 15,                                                         // outside the window: unload after this long without work
  render: { ports: [8888], canRender: true },                               // a client is being rendered here while these local ports are open
});

// Everything a second PC needs, in ONE folder: copy it over by hand, then double-click join.bat there.
const BUNDLE_FILES = ['node-agent.js', 'protocol.js', 'model-supervisor.js', 'schedule.js', 'start-node.bat', 'join.bat', 'join.ps1'];
function exportBundle(srcDir, keyFile, target) {
  if (!target) throw new Error('usage: node node-agent.js --export-bundle <empty folder>');
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new Error('that folder is not empty: ' + target);
  fs.mkdirSync(target, { recursive: true });
  for (const f of BUNDLE_FILES) { const from = path.join(srcDir, f); if (!fs.existsSync(from)) throw new Error('missing ' + f + ' next to node-agent.js'); fs.copyFileSync(from, path.join(target, f)); }
  fs.copyFileSync(keyFile, path.join(target, 'bridge.key'));
  fs.writeFileSync(path.join(target, 'bridge-node.json'), JSON.stringify(defaultConfig('Frankenstein'), null, 2) + '\n');
  fs.writeFileSync(path.join(target, 'README-PC2.txt'), [
    'G741 bridge - join this PC to the pool',
    '',
    '1. Copy this whole folder to the other PC (anywhere, e.g. C:\\g741-bridge).',
    '2. Double-click  join.bat  and answer the questions. It checks Node.js, sets the alias,',
    '   gets the local model (copy it from PC-1 or let the script download it, with your OK),',
    '   opens the firewall for PRIVATE networks only (asks first), and starts the agent at every logon.',
    '3. Open the Devices page on the hub: this PC appears within ~10 seconds.',
    '',
    'This folder contains bridge.key - the shared secret. Move it by USB stick or a direct share,',
    'and DELETE this folder from the USB stick afterwards. Never e-mail it, paste it in chat or commit it.',
    '',
  ].join('\r\n'));
  return { files: [...BUNDLE_FILES, 'bridge.key', 'bridge-node.json', 'README-PC2.txt'], fingerprint: P.fingerprint(P.loadKey(keyFile)) };
}

// A config edited with Windows PowerShell or Notepad may start with a UTF-8 byte-order mark, which JSON.parse rejects.
const readConfig = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));

// ── CLI ──
function main() {
  const dir = __dirname, args = process.argv.slice(2);
  const arg = (n) => { const i = args.indexOf('--' + n); return i < 0 ? null : args[i + 1]; };
  const keyFile = arg('key') || process.env.G741_BRIDGE_KEY_FILE || path.join(dir, 'bridge.key');
  const cfgFile = arg('config') || path.join(dir, 'bridge-node.json');

  if (args.includes('--export-bundle')) {
    if (!fs.existsSync(keyFile)) { console.error('No key yet: run --init first.'); process.exit(2); }
    try {
      const r = exportBundle(dir, keyFile, arg('export-bundle'));
      console.log('Bundle written to ' + path.resolve(arg('export-bundle')) + '  (key fingerprint ' + r.fingerprint + ')');
      console.log('Copy that folder to the other PC by hand and double-click join.bat there. It contains the shared key: delete it from the USB stick afterwards.');
    } catch (e) { console.error(e.message); process.exit(2); }
    return;
  }
  if (args.includes('--init')) {
    const k = P.createKeyFile(keyFile);
    let cfg = {};
    if (fs.existsSync(cfgFile)) cfg = readConfig(cfgFile);
    else { cfg = defaultConfig(os.hostname()); fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + '\n'); }
    console.log(k.created ? 'Created the shared key: ' + keyFile : 'Key already exists: ' + keyFile);
    console.log('Key fingerprint: ' + k.fingerprint + '   (both PCs must show the same fingerprint)');
    console.log('Config: ' + cfgFile + '   alias = ' + cfg.alias);
    if (k.created) console.log('\nTo add another PC: node bridge/node-agent.js --export-bundle <empty folder>  (then copy that folder over by hand).');
    return;
  }
  if (!fs.existsSync(keyFile)) { console.error('No key at ' + keyFile + '. Run once with --init (on the first PC), then copy that file to the other PC(s).'); process.exit(2); }
  const cfg = fs.existsSync(cfgFile) ? readConfig(cfgFile) : {};
  const key = P.loadKey(keyFile);
  const agent = createAgent({ ...cfg, key, statePath: path.join(path.dirname(cfgFile), 'bridge-node-state.json'), log: (m) => console.log(new Date().toISOString().slice(11, 19) + ' ' + m) });
  agent.start().then((p) => {
    console.log(`G741 bridge node "${cfg.alias || os.hostname()}" listening on :${p}  (key fingerprint ${P.fingerprint(key)}, discovery ${cfg.discoveryPort || 7412}/udp)`);
    console.log('If Windows asks, allow Node.js on PRIVATE networks only. Ctrl+C to stop.');
  }).catch((e) => { console.error('could not start: ' + e.message); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => agent.stop().then(() => process.exit(0)));
}

module.exports = { createAgent, readGpu, exportBundle, defaultConfig };
if (require.main === module) main();
