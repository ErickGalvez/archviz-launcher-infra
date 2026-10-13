#!/usr/bin/env node
'use strict';
// A self-contained DEMO of the bridge, for previewing the Devices / Task-IO / Virtual Team pages before the real
// launcher is restarted - and for testing them. Nothing here touches the real launcher, your real keys or your LAN:
// two SIMULATED PCs on loopback (moving stats, their own fake model that really unloads when a "client render" starts),
// the real hub, dispatcher, routines and Task-IO code, sample data, and a throwaway key ("demo-key").
//
//   node bridge/demo-server.js            serves on http://127.0.0.1:8791
//   POST /demo/render?pc=1&on=1           pretend a client starts rendering on PC-1 (pc=2 for PC-2); on=0 ends it
//
// In the browser (page served from localhost only):
//   localStorage.setItem('g741-api-override', 'http://127.0.0.1:8791'); localStorage.setItem('devconsole-key', 'demo-key');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAgent } = require('./node-agent');
const bridge = require('./index');

const KEY = 'd'.repeat(64), PORT = +process.env.PORT || 8791, DEMO_KEY = 'demo-key';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, x-qa-key, x-devconsole-key' };
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-bridge-demo-'));
  fs.mkdirSync(path.join(dir, 'bridge'));
  fs.writeFileSync(path.join(dir, 'bridge', 'bridge.key'), KEY);
  // The demo is "always night", so the routines can be seen running right away.
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ nightly: { enabled: true, start: '00:00', end: '00:00', tz: -360 } }));

  // One fake model server per PC: answers after a short think, and can be "unloaded" (closed) and "reloaded".
  const mkModel = () => {
    const m = { server: null, port: 0, up: false };
    m.load = () => new Promise((resolve) => {
      if (m.up) return resolve();
      m.server = http.createServer((req, res) => {
        if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
        let b = ''; req.on('data', (d) => { b += d; });
        req.on('end', () => setTimeout(() => {
          const user = ((JSON.parse(b || '{}').messages || []).slice(-1)[0] || {}).content || '';
          const lines = String(user).split(/\n+/).filter(Boolean).slice(0, 3).map((l) => '- ' + l.slice(0, 110));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'DEMO DRAFT (a stand-in model, not a real analysis)\n' + lines.join('\n') } }], usage: { completion_tokens: 40 } }));
        }, 1500));
      });
      m.server.listen(m.port || 0, '127.0.0.1', () => { m.port = m.server.address().port; m.up = true; resolve(); });
    });
    m.unload = () => new Promise((resolve) => { if (!m.up) return resolve(); m.up = false; m.server.close(() => resolve()); if (m.server.closeAllConnections) m.server.closeAllConnections(); });
    return m;
  };
  // Stands in for the real model supervisor: loads in the "nightly window", unloads while rendering, honours start/stop.
  const mkSupervisor = (model) => {
    let stoppedByOwner = false;
    return {
      async tick({ renderBusy }) { if (renderBusy && model.up) await model.unload(); else if (!renderBusy && !model.up && !stoppedByOwner) await model.load(); },
      request(action) { if (action === 'start') { stoppedByOwner = false; model.load(); return true; } if (action === 'stop') { stoppedByOwner = true; model.unload(); return true; } return false; },
      demand() {}, touch() {}, stop: async () => {}, command: () => ({ port: model.port }),
      status: () => ({ phase: model.up ? 'up' : 'stopped', external: false, windowActive: true, demandActive: false, paused: stoppedByOwner, canStart: true, error: null, window: { start: '00:00', end: '07:00', tz: -360 }, reason: '' }),
    };
  };

  const wave = (t, lo, hi, period, phase = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin((t / period) * Math.PI * 2 + phase));
  const pcs = [];
  for (const spec of [
    { alias: 'PC-1 · GPU Rig', hw: { cpu: 'AMD Ryzen 9 5900X 12-Core Processor', threads: 24, ramTotalGB: 47.9, pendingRamGB: 0 }, shape: { gpu: [22, 78], vram: [7.9, 9.8], cpu: [14, 46], ram: [19, 27], ph: 0 } },
    { alias: 'PC-2', hw: { cpu: 'Demo CPU · 8 cores', threads: 16, ramTotalGB: 32, pendingRamGB: 16 }, shape: { gpu: [4, 52], vram: [6.7, 8.1], cpu: [6, 30], ram: [11, 17], ph: 2.1 } },
  ]) {
    const model = mkModel(); await model.load();                       // loaded first, so its port is known (it keeps the port across unload/load)
    const renderPort = await freePort();
    const agent = createAgent({ key: KEY, alias: spec.alias, port: 0, bindHost: '127.0.0.1', model: 'qwen3-8b', discovery: false, hwPatch: spec.hw, supervisor: mkSupervisor(model), render: { ports: [renderPort] }, statsMs: 800,
      llamaUrl: 'http://127.0.0.1:' + model.port,
      gpuProvider: async () => { const t = Date.now() / 1000, idle = !model.up; return { name: 'NVIDIA GeForce RTX 3060', utilPct: idle ? 3 : Math.round(wave(t, spec.shape.gpu[0], spec.shape.gpu[1], 23, spec.shape.ph)), vramUsedGB: idle ? 1.1 : +wave(t, spec.shape.vram[0], spec.shape.vram[1], 41, spec.shape.ph).toFixed(2), vramTotalGB: 12, tempC: Math.round(wave(t, 48, 71, 37, spec.shape.ph)) }; },
      statsPatch: (s) => { const t = Date.now() / 1000; return { ...s, cpuPct: Math.round(wave(t, spec.shape.cpu[0], spec.shape.cpu[1], 17, spec.shape.ph)), ramUsedGB: +wave(t, spec.shape.ram[0], spec.shape.ram[1], 53, spec.shape.ph).toFixed(1), ramTotalGB: spec.hw.ramTotalGB }; } });
    pcs.push({ agent, model, renderPort, wilbur: null, ...spec });
  }
  const ports = []; for (const pc of pcs) ports.push(await pc.agent.start());

  // Sample activity for today, so Task-IO and the replay have something real-looking to show.
  const now = Date.now(), iso = (minAgo) => new Date(now - minAgo * 60000).toISOString();
  const w = (f, rows) => fs.writeFileSync(path.join(dir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  w('devconsole-log.jsonl', [{ ts: iso(300), type: 'dispatch', repo: 'website', issueNumber: 88, title: 'Add the favicon to every page' }, { ts: iso(285), type: 'commit', repo: 'website', pr: 89, merged: true, category: 'functional' },
    { ts: iso(120), type: 'dispatch', repo: 'website', issueNumber: 90, title: 'Fix the hub tile spacing on narrow screens' }]);
  w('autotest-runs.jsonl', [{ ts: iso(240), job: 'weekly', summary: { ok: 104, warn: 1, down: 1, total: 106 }, results: [{ id: 'gate-launch-ps', state: 'down', note: 'NOT GATED' }, { id: 'api-banner', state: 'warn', note: 'No banner captured yet' }] }]);
  w('leads-log.jsonl', [{ ts: iso(200), name: 'Demo Person', email: 'demo@example.com', company: 'Demo', message: 'hi', emailVerified: false, device: {} }]);
  const STATUS = ['new', 'new', 'new', 'contacted', 'contacted', 'call-scheduled', 'demo-built', 'pilot', 'lost', 'new', 'contacted', 'new', 'new', 'contacted', 'new', 'call-scheduled'];
  const prospects = STATUS.map((status, i) => ({ id: 'p' + i, name: 'Desarrollos ' + (i + 1), location: ['Roma Norte', 'Polanco', 'Del Valle', 'Condesa'][i % 4], status, fitScore: i % 3 === 0 ? 4 : null, createdAt: iso(60 * 24 * (i + 2)), updatedAt: i < 2 ? iso(40 + i * 25) : iso(60 * 24 * (i + 6)) }));
  const bugs = [{ id: 'bug_demo1', title: 'Wilbur never reconnects', priority: 'critical', status: 'open', component: 'Pixel Streaming', createdAt: iso(150), updatedAt: iso(150) },
    { id: 'bug_demo2', title: 'Hub page: Devices tile wraps badly on phones', priority: 'medium', status: 'open', component: 'Dashboard', description: 'The tile description overflows', createdAt: iso(100), updatedAt: iso(100) }];

  process.env.G741_BRIDGE_KEY_FILE = path.join(dir, 'bridge', 'bridge.key');
  const api = bridge.init({ dir, isAuthed: (req) => req.headers['x-devconsole-key'] === DEMO_KEY, cors: CORS, getProspects: () => prospects, getBugs: () => bugs, getRenderState: () => 'stopped',
    hubOptions: { targets: [{ host: '127.0.0.1', port: ports[0], source: 'local' }, { host: '127.0.0.1', port: ports[1], source: 'configured' }], pollMs: 1500, dispatchMs: 1200 } });
  const mk = (t) => api.taskio.createTask(t);
  mk({ title: 'Reviewed the privacy notice wording', persona: 'Justine', area: 'legal', lane: 'local', status: 'done', advisory: true });
  mk({ title: 'Checked the cookie banner against Mexican consumer rules', persona: 'Ximena', area: 'compliance', lane: 'local', status: 'done', advisory: true });
  setTimeout(() => { try { api.routines.tick(); } catch (e) { console.log('routines: ' + e.message); } }, 4000);   // the demo is always "night": start the routines

  http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    // demo-only: pretend a client starts / stops rendering on a PC (opens / closes its "Wilbur" port)
    if (u.pathname === '/demo/render' && req.method === 'POST') {
      const pc = pcs[(+u.searchParams.get('pc') || 1) - 1], on = u.searchParams.get('on') === '1';
      res.writeHead(pc ? 200 : 400, { 'Content-Type': 'application/json', ...CORS });
      if (!pc) return res.end('{"ok":false}');
      if (on && !pc.wilbur) { pc.wilbur = net.createServer(); pc.wilbur.listen(pc.renderPort, '127.0.0.1'); }
      if (!on && pc.wilbur) { pc.wilbur.close(); if (pc.wilbur.closeAllConnections) pc.wilbur.closeAllConnections(); pc.wilbur = null; }
      return res.end(JSON.stringify({ ok: true, pc: pc.alias, rendering: !!pc.wilbur }));
    }
    // demo-only stand-in for the Dev Console relay, so "Approve & dispatch" can be tried without touching GitHub
    if (u.pathname === '/api/devconsole/dispatch' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; });
      return req.on('end', () => { const ok = req.headers['x-devconsole-key'] === DEMO_KEY; res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json', ...CORS }); res.end(JSON.stringify(ok ? { ok: true, issueNumber: 999, issueUrl: 'demo://not-sent-anywhere' } : { ok: false })); });
    }
    if (api.handle(req, res, u)) return;
    if (u.pathname === '/api/sales/prospects' && req.method === 'GET') {
      if (req.headers['x-devconsole-key'] !== DEMO_KEY) { res.writeHead(401, { 'Content-Type': 'application/json', ...CORS }); return res.end('{"ok":false}'); }
      res.writeHead(200, { 'Content-Type': 'application/json', ...CORS }); return res.end(JSON.stringify({ prospects }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json', ...CORS }); res.end('{"ok":false,"error":"Not found"}');
  }).listen(PORT, '127.0.0.1', () => console.log(`G741 bridge DEMO on http://127.0.0.1:${PORT}  (key: ${DEMO_KEY}; two simulated PCs on :${ports[0]} and :${ports[1]}; POST /demo/render?pc=1&on=1 simulates a client render)`));
})();
