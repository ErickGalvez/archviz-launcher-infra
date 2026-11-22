#!/usr/bin/env node
'use strict';
// Tests for Hex (the red team), autopilot and Zed's mesh routes. Run: node redteam/redteam.test.js   (about half a minute: it builds two ranges)
// The containment checks are the point: if the guard, the sandbox or the store loosen, these fail before Hex ever attacks anything.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
let failures = 0, passed = 0;
const check = (name, ok, extra) => { if (ok) { passed++; console.log('  pass ' + name); } else { failures++; console.log('  FAIL ' + name + (extra ? ' - ' + extra : '')); } };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const runNode = (args, opts = {}) => new Promise((resolve) => { const c = spawn(process.execPath, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); const t = setTimeout(() => c.kill(), 60000); c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); }); });

async function guardTests() {
  console.log('the range guard (guard.js)');
  const dir = tmp('g741-guard-'), outside = tmp('g741-outside-');
  fs.writeFileSync(path.join(outside, 'secret.key'), 'OUTSIDE-SECRET');
  fs.writeFileSync(path.join(dir, 'probe.js'), `
    const fs = require('fs'), path = require('path'), net = require('net'), dns = require('dns'), cp = require('child_process'), http = require('http');
    const r = {};
    try { r.readOut = fs.readFileSync(${JSON.stringify(path.join(outside, 'secret.key'))}, 'utf8'); } catch (e) { r.readOut = e.code; }
    try { fs.writeFileSync(${JSON.stringify(path.join(outside, 'planted.txt'))}, 'x'); r.writeOut = 'wrote'; } catch (e) { r.writeOut = e.code; }
    try { fs.writeFileSync(path.join(__dirname, 'inside.txt'), 'x'); r.writeIn = fs.readFileSync(path.join(__dirname, 'inside.txt'), 'utf8'); } catch (e) { r.writeIn = e.code; }
    try { fs.writeFileSync(path.join(__dirname, '..', path.basename(__dirname) + '-sibling.txt'), 'x'); r.writeUp = 'wrote'; } catch (e) { r.writeUp = e.code; }
    r.exists = fs.existsSync(${JSON.stringify(path.join(outside, 'secret.key'))});
    try { cp.execSync('whoami'); r.exec = 'ran'; } catch (e) { r.exec = e.code; }
    try { require('worker_threads').Worker('x'); r.worker = 'made'; } catch (e) { r.worker = e.code; }
    const s = net.connect(9, '192.0.2.1'); s.on('error', (e) => { r.net = e.code; });       // a raw address: no name lookup to stop it first
    dns.lookup('example.com', (e) => { r.dns = e ? e.code : 'resolved'; });
    const srv = http.createServer((q, res) => res.end('loop')).listen(0, '127.0.0.1', () => {
      http.get('http://127.0.0.1:' + srv.address().port + '/', (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { r.loopback = b; srv.close(); setTimeout(() => console.log('RESULT ' + JSON.stringify(r)), 200); }); });
    });`);
  const { out } = await runNode(['--require', path.join(__dirname, 'guard.js'), path.join(dir, 'probe.js')], { cwd: dir, env: { ...process.env, G741_RANGE_DIR: dir } });
  const m = /RESULT (.+)/.exec(out), r = m ? JSON.parse(m[1]) : {};
  check('a file outside the range cannot be read', r.readOut === 'ERANGEGUARD', JSON.stringify(r.readOut));
  check('a file outside the range cannot be written, not even beside it', r.writeOut === 'ERANGEGUARD' && r.writeUp === 'ERANGEGUARD' && !fs.existsSync(path.join(outside, 'planted.txt')), r.writeOut + ' ' + r.writeUp);
  check('inside the range, files work as usual', r.writeIn === 'x');
  check('existsSync says no outside the range (it does not throw or leak)', r.exists === false);
  check('no process can start, and no worker thread', r.exec === 'ERANGEGUARD' && r.worker === 'ERANGEGUARD', r.exec + ' ' + r.worker);
  check('no connection leaves the machine, and no name is looked up', r.net === 'ERANGEGUARD' && r.dns === 'ERANGEGUARD', r.net + ' ' + r.dns);
  check('loopback still works (the range must answer itself)', r.loopback === 'loop');
  check('every refusal is reported as a RANGE-GUARD line', (out.match(/RANGE-GUARD /g) || []).length >= 6);
  const noDir = await runNode(['--require', path.join(__dirname, 'guard.js'), '-e', 'console.log("ran")'], { env: { ...process.env, G741_RANGE_DIR: '' } });
  check('without a range folder the guard refuses to start anything', noDir.code === 97 && !/ran/.test(noDir.out));
  fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true });
}

async function sandboxTests() {
  console.log('\nthe range (sandbox.js)');
  const { startRange, localModules } = require('./sandbox');
  const files = localModules(ROOT);
  check('the range copies the launcher and the modules it requires', files.includes('launcher-server.js') && files.includes('bridge/index.js') && files.includes('redteam/store.js'));
  check('the range never copies a key, a data file or a log', !files.some((f) => /\.(key|jsonl?|log|txt)$/.test(f)));
  const range = await startRange({ launcherDir: ROOT });
  try {
    check('the range runs on loopback, on a random port, never 3000', range.port !== 3000 && /^http:\/\/127\.0\.0\.1:\d+$/.test(range.base));
    const rel = path.relative(ROOT, range.dir);
    check('the range lives outside the launcher folder', rel.startsWith('..') || path.isAbsolute(rel));
    const real = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8').trim(); } catch (e) { return null; } };
    check('the range has its own throwaway keys, never the launcher\'s', range.keys.admin && range.keys.dev && range.keys.admin !== real('admin.key') && range.keys.dev !== real('devconsole.key'));
    const st = await fetch(range.base + '/api/status'); check('the range answers', st.ok);
    const copy = fs.readFileSync(path.join(range.dir, 'launcher-server.js'), 'utf8');
    check('the copy\'s child_process is stubbed', /RANGE SANDBOX: child_process is stubbed/.test(copy) && !/require\('child_process'\)/.test(copy.replace(/[\s\S]*?\}\)\(\);/, '')));
    check('the copy runs with the guard preloaded', fs.existsSync(path.join(range.dir, '.range-guard.js')));
  } finally { await range.stop(); }
  check('stopping the range deletes its folder', !fs.existsSync(range.dir));
}

function storeTests() {
  console.log('\nthe course and the run store (store.js)');
  const { createRedteamStore, RUN_ID_RE } = require('./store');
  const { LESSONS } = require('./lessons');
  const { ATTACKS } = require('./attacks');
  const dir = tmp('g741-rt-store-'); let t = Date.parse('2026-12-01T18:00:00Z');
  const s = createRedteamStore({ dir, now: () => t });
  check('day one: one lesson is open', s.lessonsView().open === 1 && s.lessonsView().today === 1);
  t += 3 * 86400000;
  check('lessons do not pile up: three days later, unread, still one', s.lessonsView().open === 1);
  const one = s.getLesson(1);
  check('the quiz answer is hidden until the lesson is read', one.ok && one.lesson.quiz.answer === undefined && Array.isArray(one.lesson.quiz.options));
  check('a lesson that is not open cannot be read or marked', s.getLesson(5).locked === true && s.markRead(5, 0).ok === false);
  check('an answer must be one of the options', s.markRead(1, 9).ok === false && s.markRead(1, 'x').ok === false);
  const r = s.markRead(1, LESSONS[0].quiz.answer);
  check('reading lesson 1 records the answer and opens lesson 2 (days have passed)', r.ok && r.correct === true && s.lessonsView().open === 2);
  check('after reading, the quiz answer and why are shown', s.getLesson(1).lesson.quiz.answer === LESSONS[0].quiz.answer);
  check('there are 28 lessons, each tied to an attack that exists', LESSONS.length === 28 && LESSONS.every((l) => ATTACKS.some((a) => a.id === l.attack)));
  const d0 = s.attackForDay('2026-12-01').id, d1 = s.attackForDay('2026-12-02').id;
  check('every day is a different attack', d0 !== d1 && ATTACKS.length >= 14);
  check('run ids cannot be paths', !RUN_ID_RE.test('../progress') && !RUN_ID_RE.test('rt_20261201_x_000000/../../a') && s.getRun('..\\..\\admin') === null);
  s.saveRun({ id: 'rt_20261201_cors_abcdef', attack: 'cors', findings: [{ id: 'a', severity: 'high', title: 'A' }] });
  const cmp = s.compare('cors', [{ id: 'b', severity: 'low', title: 'B' }]);
  check('a finding is "new" the first time and the one that went away is "fixed"', cmp.fixed.length === 1 && cmp.fixed[0].id === 'a');
  check('the results live in redteam-data/ (gitignored)', s.root === path.join(dir, 'redteam-data') && fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8').includes('redteam-data/'));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function routeTests() {
  console.log('\nthe launcher routes (bridge/index.js: agents, redteam, mesh)');
  const dir = tmp('g741-rt-routes-'); fs.mkdirSync(path.join(dir, 'bridge')); fs.writeFileSync(path.join(dir, 'bridge', 'bridge.key'), 'e'.repeat(64));
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ nightly: { enabled: true, start: '00:00', end: '00:00', tz: -360 } }));   // always night: the schedule would start everything
  process.env.G741_BRIDGE_KEY_FILE = path.join(dir, 'bridge', 'bridge.key');
  const KEY = 'route-test-key';
  const bridge = require('../bridge/index.js').init({ dir, isAuthed: (req) => req.headers['x-devconsole-key'] === KEY, cors: { 'Access-Control-Allow-Origin': '*' }, getProspects: () => [], getBugs: () => [], getRenderState: () => ({}), autoStart: false });
  const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); if (!bridge.handle(req, res, u)) { res.writeHead(404); res.end(); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + srv.address().port, H = { 'x-devconsole-key': KEY };
  const call = async (m, p, { headers = H, body, raw } = {}) => { const r = await fetch(base + p, { method: m, headers: { ...headers, ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}) }, body: raw ? body : body !== undefined ? JSON.stringify(body) : undefined }); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch (e) { /* binary */ } return { status: r.status, headers: r.headers, json, text }; };
  try {
    for (const p of ['/api/redteam/status', '/api/redteam/runs', '/api/redteam/lessons', '/api/agents/state', '/api/mesh/jobs']) check(p + ' needs the Dev Console key', (await call('GET', p, { headers: {} })).status === 401);
    const st = await call('GET', '/api/redteam/status');
    check('Hex\'s status is classified and never cached', st.status === 200 && /RESTRICTED/.test(st.json.classification) && st.headers.get('cache-control') === 'no-store');
    check('a run id that is a path is refused', (await call('GET', '/api/redteam/run?id=' + encodeURIComponent('../progress'))).status === 404);
    check('a lesson that is not open is refused', (await call('GET', '/api/redteam/lesson?n=9')).status === 403);
    const ap = await call('POST', '/api/agents/autopilot', { body: { name: 'Nadia', on: false } });
    check('autopilot switches per agent', ap.status === 200 && (await call('GET', '/api/agents/state')).json.autopilot.Nadia.on === false);
    check('autopilot refuses a name that is not a name', (await call('POST', '/api/agents/autopilot', { body: { name: '<img src=x>', on: true } })).status === 400 && (await call('POST', '/api/agents/autopilot', { body: { name: 'Nadia', on: 'yes' } })).status === 400);
    const started = bridge.routines.tick().map((x) => x.id);
    check('with Nadia\'s autopilot off, her routine does not start by itself (the others do)', !started.includes('nadia-pipeline') && started.includes('ward-digest'), started.join(','));
    check('"Run now" still works with autopilot off', bridge.routines.run('nadia-pipeline', { manual: true }).ok !== undefined);
    // mesh
    check('an upload that is not an image is refused by its bytes', (await call('POST', '/api/mesh/upload?ext=png&name=x', { raw: true, body: Buffer.from('not a png at all') })).status === 400);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    const up = await call('POST', '/api/mesh/upload?ext=png&name=' + encodeURIComponent('<b>chair</b>'), { raw: true, body: png });
    const queued = (await call('GET', '/api/mesh/jobs')).json.jobs[0] || {};
    check('a PNG is queued for the worker, its name cleaned of markup', up.status === 200 && /^mj_[0-9a-f]{12}$/.test(up.json.id) && queued.status === 'queued' && /chair/.test(queued.name) && !/[<>]/.test(queued.name));
    check('files come back only by a valid id and kind', (await call('GET', '/api/mesh/file?id=../x&kind=glb')).status === 400 && (await call('GET', '/api/mesh/file?id=' + up.json.id + '&kind=../../admin')).status === 400);
    const img = await call('GET', '/api/mesh/file?id=' + up.json.id + '&kind=image');
    check('the reference image comes back as itself, not sniffable', img.status === 200 && img.headers.get('content-type') === 'image/png' && img.headers.get('x-content-type-options') === 'nosniff');
    check('a model that is not made yet is a 404', (await call('GET', '/api/mesh/file?id=' + up.json.id + '&kind=glb')).status === 404);
    const big = await call('POST', '/api/mesh/upload?ext=png', { raw: true, body: Buffer.concat([png, Buffer.alloc(11 * 1024 * 1024)]) }).catch(() => ({ status: 413 }));
    check('an image over 10 MB is refused', big.status === 413);
    check('a model can be deleted, with its files', (await call('POST', '/api/mesh/delete', { body: { id: up.json.id } })).status === 200 && (await call('GET', '/api/mesh/jobs')).json.jobs.length === 0);
  } finally { srv.close(); bridge.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

async function rangeRunTest() {
  console.log('\na whole range run (range.js)');
  const dir = tmp('g741-rt-run-');
  const ranges = () => new Set(fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('g741-range-')));
  const before = ranges();
  const { out, code } = await runNode([path.join(__dirname, 'range.js'), '--now', '--attack', 'cors'], { cwd: ROOT });
  check('a run finishes and is saved, classified', code === 0 && /range done: cors/.test(out), out.slice(-200));
  const runs = fs.readdirSync(path.join(ROOT, 'redteam-data', 'runs')).filter((f) => /cors/.test(f)).sort();
  const run = JSON.parse(fs.readFileSync(path.join(ROOT, 'redteam-data', 'runs', runs[runs.length - 1]), 'utf8'));
  check('the run says what Hex did, in plain words', run.classification.includes('RESTRICTED') && run.notes.length > 0 && Array.isArray(run.requests));
  const left = [...ranges()].filter((f) => !before.has(f));
  check('no range folder is left behind', left.length === 0, left.join(', '));
  const skip = await runNode([path.join(__dirname, 'range.js'), '--attack', 'cors', '--launcher', dir]);
  check('with no launcher there, the range says so and stops', skip.code !== 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

(async () => {
  await guardTests();
  await sandboxTests();
  storeTests();
  await routeTests();
  await rangeRunTest();
  console.log('\n' + (failures ? failures + ' of ' + (passed + failures) + ' FAILED' : 'all ' + passed + ' checks passed'));
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
