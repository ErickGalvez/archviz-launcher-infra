#!/usr/bin/env node
'use strict';
// Hex's range: one contained attack a day against a throwaway copy of the launcher, results kept classified in redteam-data/.
//
//   node redteam/range.js                 today's attack (skips if Hex's autopilot is off or a walkthrough is streaming)
//   node redteam/range.js --now           run even so (autopilot off, or a stream is live: the range is small, but you asked)
//   node redteam/range.js --attack ssrf   a chosen attack instead of today's
//   node redteam/range.js --list          the attacks, in the order the days follow
//   node redteam/range.js --keep          keep the range folder afterwards (to look at it); it is still stopped
//
// Exit codes: 0 ran (findings or not), 2 skipped, 1 could not run. Scheduled daily by the Windows task "G741-RedTeam-Range" (see README.md).
// Containment is in sandbox.js and guard.js; this file only orchestrates, and it never sends a request anywhere but the range.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { startRange } = require('./sandbox');
const { ATTACKS, byId } = require('./attacks');
const { createRedteamStore, mxDay } = require('./store');

const LAUNCHER = path.resolve(__dirname, '..');
const REQUEST_BUDGET = 3000, TIME_BUDGET_MS = 8 * 60 * 1000, RECORD_REQUESTS = 400;
const SEV = ['critical', 'high', 'medium', 'low', 'info'];
// Hosts the launcher itself always calls, from fixed code (never from a request): the Dev Console relay (GitHub) and Google's sign-in keys.
const EXPECTED_EGRESS = [/^(network connection|name lookup) api\.github\.com(:443)?$/, /^(network connection|name lookup) www\.googleapis\.com(:443)?$/];

const args = process.argv.slice(2);
const flag = (f) => args.includes(f), opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const launcherDir = path.resolve(opt('--launcher') || LAUNCHER);
const logFile = path.join(launcherDir, 'redteam-data', 'range.log');
const log = (m) => { const line = new Date().toISOString() + ' ' + m; console.log(line); try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, line + '\n'); } catch (e) { /* console only */ } };

class BudgetError extends Error {}

function streaming() {
  if (process.platform !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => execFile('tasklist', ['/FI', 'IMAGENAME eq ArchVizProject3.exe', '/NH'], { timeout: 8000, windowsHide: true }, (err, out) => resolve(!err && /ArchVizProject3\.exe/i.test(out || ''))));
}
function autopilotOn(name) {
  try { const j = JSON.parse(fs.readFileSync(path.join(launcherDir, 'agents-state.json'), 'utf8')); const v = j.autopilot && j.autopilot[name]; return v === undefined ? true : v.on !== false; } catch (e) { return true; }
}
function commitOf(dir) { return new Promise((resolve) => execFile('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'], { timeout: 5000, windowsHide: true }, (e, out) => resolve(e ? null : String(out).trim()))); }

// Femto (when this build has it) is given its three members inside the range, with the range's own starting passwords.
async function seedFemto(dir) {
  const admin = path.join(launcherDir, 'femto-admin.js');
  if (!fs.existsSync(path.join(dir, 'femto.js')) || !fs.existsSync(admin)) return null;
  await new Promise((resolve) => execFile(process.execPath, [admin, 'init', '--dir', dir], { timeout: 60000, windowsHide: true }, () => resolve()));
  const pw = {};
  try { for (const line of fs.readFileSync(path.join(dir, 'femto-data', 'starting-passwords.txt'), 'utf8').split(/\r?\n/)) { const m = /^\S+\s+([a-z]+)\s+(\S+)$/.exec(line.trim()); if (m) pw[m[1]] = m[2]; } } catch (e) { return null; }
  return Object.keys(pw).length ? pw : null;
}

function routesOf(range) {
  const out = new Map();
  for (const f of range.files) {
    let src = ''; try { src = fs.readFileSync(path.join(range.dir, f), 'utf8'); } catch (e) { continue; }
    for (const m of src.matchAll(/['"](\/api\/[a-z0-9/_-]*[a-z0-9])['"]/gi)) if (!out.has(m[1])) out.set(m[1], { path: m[1], file: f });
  }
  out.set('/events', { path: '/events', file: 'launcher-server.js' });
  out.set('/', { path: '/', file: 'launcher-server.js' });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

async function main() {
  if (flag('--list')) { ATTACKS.forEach((a, i) => console.log(String(i + 1).padStart(2) + '  ' + a.id.padEnd(18) + a.title)); return 0; }
  const store = createRedteamStore({ dir: launcherDir });
  const today = mxDay(Date.now());
  const attack = opt('--attack') ? byId(opt('--attack')) : store.attackForDay(today);
  if (!attack) { log('no such attack: ' + opt('--attack')); return 1; }
  if (!flag('--now')) {
    if (!autopilotOn('Hex')) { log('skipped: Hex\'s autopilot is off (run with --now to attack anyway)'); return 2; }
    if (await streaming()) { log('skipped: a walkthrough is streaming (ArchVizProject3.exe is running); the range waits for tomorrow'); return 2; }
  }
  const id = 'rt_' + today.replace(/-/g, '') + '_' + attack.id + '_' + crypto.randomBytes(3).toString('hex');
  const t0 = Date.now();
  const run = { id, attack: attack.id, title: attack.title, summary: attack.summary, classification: 'RESTRICTED · owner only', startedAt: new Date(t0).toISOString(), status: 'running',
    launcherCommit: await commitOf(launcherDir), findings: [], notes: [], counts: {}, requests: [], guard: { atStart: [], duringAttack: [] } };
  log('range: ' + attack.id + ' (' + id + ')');

  let range = null, seed = null, canary = null;
  try {
    range = await startRange({ launcherDir, log, keepDir: flag('--keep'), seed: async (dir) => { seed = { femto: await seedFemto(dir) }; } });
    const startHits = range.guardHits().length;
    run.guard.atStart = range.guardHits();
    run.counts.files = range.files.length;
    const secrets = range.secrets(), routes = routesOf(range), known = new Set(routes.map((r) => r.path));
    let used = 0;
    const leaked = new Set();
    const finding = (f) => {
      const sev = SEV.includes(f.severity) ? f.severity : 'info';
      if (run.findings.some((x) => x.id === f.id)) return;
      run.findings.push({ id: String(f.id).slice(0, 160), severity: sev, title: String(f.title).slice(0, 200), where: String(f.where || '').slice(0, 200), detail: String(f.detail || '').slice(0, 600), fix: String(f.fix || '').slice(0, 400) });
    };
    const req = async (method, p, { headers = {}, body, timeoutMs = 8000 } = {}) => {
      if (typeof p !== 'string' || !p.startsWith('/') || p.startsWith('//')) throw new Error('the range only takes paths on its own address');
      const url = new URL(p, range.base);
      if (url.origin !== range.base) throw new Error('the range only talks to ' + range.base);
      if (++used > REQUEST_BUDGET) throw new BudgetError('request budget reached');
      const init = { method, headers: { ...headers }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) };
      if (body !== undefined && method !== 'GET' && method !== 'HEAD') { init.body = typeof body === 'string' ? body : JSON.stringify(body); if (!Object.keys(init.headers).some((k) => k.toLowerCase() === 'content-type')) init.headers['Content-Type'] = 'application/json'; }
      const s = Date.now(); let res;
      try { res = await fetch(url, init); } catch (e) { if (run.requests.length < RECORD_REQUESTS) run.requests.push([method, p.slice(0, 120), 0, Date.now() - s]); return { status: 0, error: e.message, headers: new Headers(), text: '', json: null, ms: Date.now() - s }; }
      const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
      const ms = Date.now() - s;
      if (run.requests.length < RECORD_REQUESTS) run.requests.push([method, p.slice(0, 120), res.status, ms]);
      const hay = text + '\n' + [...res.headers].map(([k, v]) => k + ': ' + v).join('\n');
      // The one place a key is handed out on purpose: the admin panel, to a request made on the PC itself (loopback, no Cloudflare headers).
      const onThisPc = (url.pathname === '/' || url.pathname === '/index.html') && !Object.keys(headers).some((k) => /^cf-/i.test(k));
      for (const sec of onThisPc ? [] : secrets) if (hay.includes(sec) && !leaked.has(p)) {
        leaked.add(p);
        finding({ id: 'leak:' + url.pathname, severity: 'critical', title: 'A secret came back in an answer from ' + url.pathname, where: method + ' ' + p.slice(0, 120), detail: 'The answer contained ' + (sec === range.canary ? 'the canary file\'s contents' : 'one of the range\'s keys') + ' (HTTP ' + res.status + '). On the real launcher that would be a real key.', fix: 'Find how this route reached the file or the key and close it; then rotate the real key to be safe.' });
      }
      let json = null; try { json = JSON.parse(text); } catch (e) { /* not JSON */ }
      return { status: res.status, headers: res.headers, text, json, ms };
    };
    const servers = [];
    // The same range port, reached through this PC's own network addresses: what a phone on the same Wi-Fi would see. Still only the range copy.
    const reqLan = async (p) => {
      const out = [];
      for (const list of Object.values(os.networkInterfaces())) for (const a of list || []) {
        if (a.internal || a.family !== 'IPv4') continue;
        const s = Date.now();
        try { const r = await fetch('http://' + a.address + ':' + range.port + p, { signal: AbortSignal.timeout(4000), redirect: 'manual' }); const text = await r.text(); out.push({ address: a.address, status: r.status, text, ms: Date.now() - s }); } catch (e) { out.push({ address: a.address, status: 0, error: e.message }); }
        if (++used > REQUEST_BUDGET) throw new BudgetError('request budget reached');
      }
      for (const o of out) if (o.text && secrets.some((sec) => o.text.includes(sec))) finding({ id: 'leak:lan:' + p, severity: 'high', title: 'A key is handed to the local network at ' + p, where: 'http://<this PC>:' + '<port>' + p, detail: 'Asked through this PC\'s address ' + o.address + ' (as a phone on the same Wi-Fi would), the answer contained one of the range\'s keys.', fix: 'Serve ' + p + ' only to requests made on this PC (isLocalDirect), or listen on 127.0.0.1 only.' });
      return out;
    };
    const ctx = {
      req, reqLan, keys: range.keys, routes, has: (p) => known.has(p), files: range.files, dir: range.dir, seed,
      finding, note: (t) => run.notes.push(String(t).slice(0, 800)), count: (k, n) => { run.counts[k] = (run.counts[k] || 0) + n; },
      ip: (n) => '203.0.113.' + ((Math.abs(n) % 250) + 1), alive: range.alive, guardHits: () => range.guardHits().slice(startHits),
      source: (f) => { try { return fs.readFileSync(path.join(range.dir, f), 'utf8'); } catch (e) { return ''; } },
      requireCopy: (f) => { try { return require(path.join(range.dir, f)); } catch (e) { return null; } },
      canaryServer: () => new Promise((resolve) => {
        const hits = [], token = crypto.randomBytes(6).toString('hex');
        const s = http.createServer((q, r) => { hits.push(q.method + ' ' + q.url); r.writeHead(200); r.end('ok'); });
        servers.push(s);
        s.listen(0, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + s.address().port + '/hex-' + token, hits: () => hits.slice() }));
      }),
    };
    canary = servers;
    let timer;
    await Promise.race([attack.run(ctx), new Promise((_, rej) => { timer = setTimeout(() => rej(new BudgetError('time budget reached (' + TIME_BUDGET_MS / 60000 + ' min)')), TIME_BUDGET_MS); })])
      .catch((e) => { if (e instanceof BudgetError) { run.notes.push('Stopped early: ' + e.message + '.'); run.status = 'stopped'; } else throw e; })
      .finally(() => clearTimeout(timer));
    // What the copy tried to touch outside its folder or the machine during the attack (the guard stopped each one).
    const seenAtStart = new Set(run.guard.atStart);
    run.guard.duringAttack = range.guardHits().slice(startHits).filter((h) => !seenAtStart.has(h));
    // The launcher's own, fixed calls out (the Dev Console relay talks to GitHub; the app download checks Google's keys) are expected: noted, not findings.
    const expected = run.guard.duringAttack.filter((h) => EXPECTED_EGRESS.some((rx) => rx.test(h)));
    if (expected.length) run.notes.push(`The copy made ${expected.length} call(s) the launcher always makes (${[...new Set(expected.map((h) => h.split(' ').pop()))].join(', ')}): its fixed calls to GitHub or Google. The guard kept them inside the range.`);
    for (const h of run.guard.duringAttack.filter((x) => !expected.includes(x)).slice(0, 20)) {
      const write = /file write/.test(h), netw = /network connection|name lookup|pipe/.test(h), proc = /process start|worker/.test(h);
      if (write || netw || proc || /file read/.test(h)) finding({ id: 'guard:' + h.slice(0, 120), severity: write || proc ? 'high' : 'medium', title: 'During the attack the launcher tried: ' + h.split(' ').slice(0, 4).join(' '), where: h, detail: 'The range guard blocked it. On the real launcher nothing would have blocked it.', fix: 'Find which request caused it (the run\'s request list, same minute) and make that route refuse the input instead.' });
    }
    if (!range.alive()) finding({ id: 'crash', severity: 'critical', title: 'The launcher crashed during the attack', where: 'the range process', detail: range.output().slice(-500), fix: 'The tail of the range log above shows the error.' });
    run.counts.requests = used;
    if (run.status === 'running') run.status = 'done';
  } catch (e) {
    run.status = 'error'; run.error = String(e.message || e).slice(0, 500);
    log('range error: ' + run.error);
  } finally {
    for (const s of canary || []) try { s.close(); } catch (e) { /* closed */ }
    if (range) await range.stop();
  }
  run.ms = Date.now() - t0;
  run.findings.sort((a, b) => SEV.indexOf(a.severity) - SEV.indexOf(b.severity));
  const cmp = store.compare(attack.id, run.findings);
  run.previous = cmp.previous; run.fixed = cmp.fixed;
  run.bySeverity = Object.fromEntries(SEV.map((s) => [s, run.findings.filter((f) => f.severity === s).length]));
  store.saveRun(run);
  log('range ' + run.status + ': ' + attack.id + ' · ' + run.findings.length + ' finding(s) ' + JSON.stringify(run.bySeverity) + ' · ' + (run.counts.requests || 0) + ' requests · ' + Math.round(run.ms / 1000) + ' s · ' + id);
  return run.status === 'error' ? 1 : 0;
}

if (require.main === module) main().then((c) => { process.exitCode = c; }, (e) => { log('range failed: ' + (e && e.stack || e)); process.exitCode = 1; });
module.exports = { main, routesOf };
