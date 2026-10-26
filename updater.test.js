#!/usr/bin/env node
'use strict';
// Tests for the launcher's "Update & restart" (updater.js) against REAL git: a bare "GitHub", the checkout the launcher runs from, and a second clone that pushes.
//   node updater.test.js
const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createUpdater, describe, RESTART_FILES } = require('./updater');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The same shape as the launcher's own runner, plus a record of every command so a test can look at exactly what was run.
function runner(log = []) {
  const fn = (cmd, args, { cwd, timeout = 20000, env } = {}) => new Promise((resolve) => {
    log.push([cmd, ...args]);
    let out = '', err = '', done = false;
    const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, stdout: out, stderr: err }); };
    let child; try { child = cp.spawn(cmd, args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env }, windowsHide: true }); } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
    const t = setTimeout(() => { try { child.kill(); } catch (e) { /* gone */ } finish(-2); }, timeout);
    child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { err += e.message; finish(-1); });
    child.on('close', (code) => finish(code));
  });
  fn.log = log; return fn;
}
const sh = (cwd, ...args) => { const r = cp.spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + r.stderr); return r.stdout.trim(); };
const put = (dir, file, text) => { fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), text); };
const GOOD_SERVER = "'use strict';\nconsole.log('launcher');\n";

// origin (bare) + host (what the launcher runs from) + dev (pushes updates)
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-updater-')), origin = path.join(root, 'origin.git'), host = path.join(root, 'host'), dev = path.join(root, 'dev');
  sh(root, 'init', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, host); sh(host, 'config', 'user.email', 't@example.com'); sh(host, 'config', 'user.name', 'Host');
  put(host, 'launcher-server.js', GOOD_SERVER); put(host, 'updater.js', fs.readFileSync(path.join(__dirname, 'updater.js'), 'utf8'));
  put(host, 'bridge/index.js', "module.exports = { init() { return {}; } };\n"); put(host, 'README.md', 'docs\n'); put(host, 'bridge/hub.test.js', '// a test\n');
  sh(host, 'add', '.'); sh(host, 'commit', '-q', '-m', 'first'); sh(host, 'push', '-q', 'origin', 'main');
  fs.writeFileSync(path.join(host, 'bridge.json'), '{"verify":{"roots":{}}}');           // untracked config next to the launcher, like the real host
  sh(root, 'clone', '-q', origin, dev); sh(dev, 'config', 'user.email', 't@example.com'); sh(dev, 'config', 'user.name', 'Dev');
  const push = (files, msg) => { for (const [f, t] of Object.entries(files)) put(dev, f, t); sh(dev, 'add', '.'); sh(dev, 'commit', '-q', '-m', msg); sh(dev, 'push', '-q', 'origin', 'main'); };
  return { root, origin, host, dev, push, head: () => sh(host, 'rev-parse', 'HEAD'), cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) { /* temp */ } } };
}
async function boot(w, extra = {}) {
  let T = 1000000, restarts = 0, reason = null;
  const run = runner(), up = createUpdater({ run, dir: w.host, now: () => T, busy: () => reason, restart: () => { restarts++; }, restartDelayMs: 20, ...extra });
  await up.start();
  return { up, run, tick: (ms) => { T += ms; }, restarts: () => restarts, setBusy: (r) => { reason = r; } };
}

(async () => {
  console.log('checking how far behind the launcher is');
  await test('up to date: nothing ahead, and the sentence says so', async () => {
    const w = world(), b = await boot(w), i = await b.up.check();
    assert.equal(i.ok, true); assert.equal(i.ahead, 0); assert.equal(i.needsRestart, false); assert.equal(i.diverged, false); assert.match(i.legend.headline, /^Up to date · running [0-9a-f]{7}$/); assert.equal(i.legend.level, 'ok');
    w.cleanup();
  });
  await test('a push elsewhere is counted: how many changes, which files, the commit titles, and that the launcher itself changed', async () => {
    const w = world(), b = await boot(w);
    w.push({ 'launcher-server.js': GOOD_SERVER + '// one\n' }, 'Fix the thing'); w.push({ 'bridge/hub.js': '// hub\n', 'README.md': 'more docs\n' }, 'Add a hub');
    const i = await b.up.check({ fresh: true });
    assert.equal(i.ahead, 2); assert.equal(i.canPull, true); assert.equal(i.unpushed, false); assert.equal(i.files, 3); assert.equal(i.needsRestart, true);
    assert.deepEqual(i.commits.map((c) => c.subject), ['Add a hub', 'Fix the thing']); assert.ok(i.insertions >= 3);
    assert.match(i.legend.headline, /^2 changes ahead · 3 files changed \(\+\d+ −\d+\)$/); assert.ok(i.legend.lines.some((l) => /Add a hub/.test(l)) && i.legend.lines.some((l) => /needs a restart/.test(l)) && i.legend.lines.some((l) => /pulls them first/.test(l)));
    assert.equal(w.head(), sh(w.host, 'rev-parse', 'HEAD'), 'checking never changes the checkout'); w.cleanup();
  });
  await test('a push that touches only tests and docs says no restart is needed', async () => {
    const w = world(), b = await boot(w);
    w.push({ 'README.md': 'docs 2\n', 'bridge/hub.test.js': '// more tests\n' }, 'Docs and tests');
    const i = await b.up.check({ fresh: true });
    assert.equal(i.ahead, 1); assert.equal(i.needsRestart, false); assert.ok(i.legend.lines.some((l) => /does not need a restart/.test(l))); w.cleanup();
  });
  await test('commits made in THIS checkout (not pushed, or pushed from here) count too: what a restart would load', async () => {
    const w = world(), b = await boot(w);
    put(w.host, 'launcher-server.js', GOOD_SERVER + '// local\n'); sh(w.host, 'add', '.'); sh(w.host, 'commit', '-q', '-m', 'Local change');
    const i = await b.up.check({ fresh: true });
    assert.equal(i.ahead, 1); assert.equal(i.unpushed, true); assert.equal(i.canPull, false); assert.ok(i.legend.lines.some((l) => /not pushed to GitHub yet/.test(l)));
    sh(w.host, 'push', '-q', 'origin', 'main'); b.tick(10000);
    const j = await b.up.check({ fresh: true }); assert.equal(j.ahead, 1); assert.equal(j.unpushed, false, 'pushed from here: still one change the running launcher does not have'); w.cleanup();
  });
  await test('uncommitted edits to tracked files are listed (a restart loads them), untracked files like bridge.json are not', async () => {
    const w = world(), b = await boot(w); put(w.host, 'README.md', 'edited\n');
    const i = await b.up.check({ fresh: true });
    assert.deepEqual(i.dirty, ['README.md']); assert.ok(i.legend.lines.some((l) => /1 uncommitted file/.test(l) && /README\.md/.test(l)) && !JSON.stringify(i.dirty).includes('bridge.json')); w.cleanup();
  });
  await test('GitHub is asked at most once a minute (and a forced check at most every 5 seconds)', async () => {
    const w = world(), b = await boot(w), fetches = () => b.run.log.filter((c) => c[0] === 'git' && c[1] === 'fetch').length;
    await b.up.check(); await b.up.check(); await b.up.check(); assert.equal(fetches(), 1, 'three checks, one fetch');
    await b.up.check({ fresh: true }); assert.equal(fetches(), 1, 'a forced check right after is still the same answer');
    b.tick(6000); await b.up.check({ fresh: true }); assert.equal(fetches(), 2);
    b.tick(30000); await b.up.check(); assert.equal(fetches(), 2, 'still cached inside the minute'); b.tick(31000); await b.up.check(); assert.equal(fetches(), 3);
    const [x, y] = await Promise.all([b.up.check({ fresh: true }), b.up.check({ fresh: true })]); assert.equal(x, y); w.cleanup();
  });
  await test('diverged branches are reported and never touched', async () => {
    const w = world(), b = await boot(w);
    put(w.host, 'launcher-server.js', GOOD_SERVER + '// mine\n'); sh(w.host, 'add', '.'); sh(w.host, 'commit', '-q', '-m', 'mine'); w.push({ 'launcher-server.js': GOOD_SERVER + '// theirs\n' }, 'theirs');
    const i = await b.up.check({ fresh: true }), before = w.head();
    assert.equal(i.diverged, true); assert.equal(i.legend.level, 'warn'); assert.match(i.legend.headline, /diverged/);
    const r = await b.up.apply({}); assert.equal(r.ok, false); assert.match(r.error, /diverged/); assert.equal(w.head(), before); assert.equal(b.restarts(), 0); w.cleanup();
  });
  await test('no git, or not a repository: a clear message, never a crash, and nothing is applied', async () => {
    const dead = createUpdater({ run: async () => ({ code: -1, stdout: '', stderr: 'spawn git ENOENT' }), dir: os.tmpdir() }); await dead.start();
    const i = await dead.check(); assert.equal(i.ok, false); assert.match(i.error, /Git is not available/); assert.equal(describe(i).level, 'warn');
    const r = await dead.apply({}); assert.equal(r.ok, false);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-nogit-')), notRepo = createUpdater({ run: runner(), dir: plain }); await notRepo.start(); assert.equal((await notRepo.check()).ok, false);
    assert.equal(describe(null).level, 'warn'); fs.rmSync(plain, { recursive: true, force: true });
  });
  await test('a checkout with no upstream branch is told so, and cannot be updated', async () => {
    const w = world(), b = await boot(w); sh(w.host, 'branch', '--unset-upstream');
    const i = await b.up.check({ fresh: true }); assert.equal(i.ok, false); assert.match(i.error, /no upstream branch/); assert.equal(describe(i).level, 'warn');
    const r = await b.up.apply({}); assert.equal(r.ok, false); assert.match(r.error, /no upstream branch/); assert.equal(b.restarts(), 0); w.cleanup();
  });
  await test('an unreachable GitHub is said plainly, without showing a token from the remote address', async () => {
    const fakeToken = 'gh' + 'p_' + 'NOTAREALTOKEN'.repeat(2);                // built at run time: a made-up value, and nothing a secret scanner could mistake for a real one
    const w = world(), real = runner(), run = async (cmd, args, o) => (cmd === 'git' && args[0] === 'fetch' ? { code: 128, stdout: '', stderr: "fatal: unable to access 'https://user:" + fakeToken + "@github.com/x/y.git/': Could not resolve host" } : real(cmd, args, o));
    const up = createUpdater({ run, dir: w.host }); await up.start(); const i = await up.check({ fresh: true });
    assert.equal(i.ok, true); assert.match(i.fetchError, /Could not resolve host/); assert.ok(!JSON.stringify(i).includes('NOTAREALTOKEN') && /\*\*\*@/.test(i.fetchError)); assert.ok(i.legend.lines.some((l) => /Could not reach GitHub/.test(l))); w.cleanup();
  });

  console.log('applying an update');
  await test('while a session or a queue is live it refuses and changes nothing; forced, it goes ahead', async () => {
    const w = world(), b = await boot(w); w.push({ 'launcher-server.js': GOOD_SERVER + '// two\n' }, 'Two'); b.setBusy('a client session is running');
    const before = w.head(), r = await b.up.apply({});
    assert.equal(r.ok, false); assert.equal(r.busy, 'a client session is running'); assert.equal(w.head(), before, 'nothing pulled'); assert.equal(b.restarts(), 0);
    const f = await b.up.apply({ force: true }); assert.equal(f.ok, true); assert.equal(f.restarting, true); await sleep(120); assert.equal(b.restarts(), 1); w.cleanup();
  });
  await test('an update is pulled fast-forward only, checked, and then the process is asked to restart', async () => {
    const w = world(), b = await boot(w), startSha = w.head();
    w.push({ 'launcher-server.js': GOOD_SERVER + '// three\n' }, 'Three'); w.push({ 'bridge/hub.js': '// hub\n' }, 'Four');
    const r = await b.up.apply({});
    assert.equal(r.ok, true); assert.equal(r.restarting, true); assert.equal(r.changes, 2); assert.equal(r.pulled, 2); assert.equal(r.from, startSha.slice(0, 7)); assert.equal(r.to, sh(w.host, 'rev-parse', 'HEAD').slice(0, 7));
    assert.equal(sh(w.host, 'rev-parse', 'HEAD'), sh(w.origin, 'rev-parse', 'main'), 'the checkout is on GitHub\'s tip'); assert.equal(b.restarts(), 0, 'not before the answer has had time to be sent'); await sleep(120); assert.equal(b.restarts(), 1);
    assert.ok(fs.existsSync(path.join(w.host, 'bridge.json')), 'the host\'s own untracked config is left alone');
    const cmds = b.run.log.map((c) => c.slice(0, 2).join(' ')); assert.ok(cmds.includes('git pull') && b.run.log.find((c) => c[1] === 'pull').includes('--ff-only') && !b.run.log.some((c) => c.includes('--force') || c.includes('merge') && c[1] === 'merge'));
    assert.ok(b.run.log.filter((c) => c[0] !== 'git').every((c) => c[1] === '--check' || c[1] === '-e'), 'the only other commands are node --check and the load check'); w.cleanup();
  });
  await test('an update that does not parse is rolled back and the launcher is NOT restarted into it', async () => {
    const w = world(), b = await boot(w), before = w.head(); w.push({ 'launcher-server.js': 'const = ;\n' }, 'Broken');
    const r = await b.up.apply({});
    assert.equal(r.ok, false); assert.equal(r.step, 'preflight'); assert.equal(r.rolledBack, true); assert.match(r.error, /launcher-server\.js does not parse/); assert.match(r.error, /rolled back/);
    assert.equal(w.head(), before, 'back on the commit it was on'); await sleep(120); assert.equal(b.restarts(), 0);
    const again = await b.up.check({ fresh: true }); assert.equal(again.ahead, 1, 'and it still sees the broken update waiting rather than hiding it'); w.cleanup();
  });
  await test('an update that leaves the bridge unloadable (the bridge.json mix-up) is caught by the load check and rolled back', async () => {
    const w = world(), b = await boot(w), before = w.head(); w.push({ 'bridge/index.js': 'module.exports = {};\n' }, 'Bridge without init');
    const r = await b.up.apply({}); assert.equal(r.ok, false); assert.equal(r.rolledBack, true); assert.match(r.error, /bridge or the updater no longer loads/); assert.equal(w.head(), before); await sleep(120); assert.equal(b.restarts(), 0); w.cleanup();
  });
  await test('a pull that cannot be done (an edit of the same file here) is reported and nothing restarts', async () => {
    const w = world(), b = await boot(w); w.push({ 'launcher-server.js': GOOD_SERVER + '// theirs\n' }, 'Theirs'); put(w.host, 'launcher-server.js', GOOD_SERVER + '// my unsaved edit\n');
    const before = w.head(), r = await b.up.apply({});
    assert.equal(r.ok, false); assert.equal(r.step, 'pull'); assert.match(r.error, /git pull failed/); assert.equal(w.head(), before); assert.match(fs.readFileSync(path.join(w.host, 'launcher-server.js'), 'utf8'), /my unsaved edit/, 'the edit is still there'); await sleep(60); assert.equal(b.restarts(), 0); w.cleanup();
  });
  await test('tests-and-docs-only updates are pulled without restarting, and the launcher then counts itself up to date', async () => {
    const w = world(), b = await boot(w); w.push({ 'README.md': 'docs 3\n' }, 'Docs');
    const r = await b.up.apply({ restart: false }); assert.equal(r.ok, true); assert.equal(r.restarting, false); await sleep(60); assert.equal(b.restarts(), 0);
    const i = await b.up.check({ fresh: true }); assert.equal(i.ahead, 0); assert.equal(sh(w.host, 'show', 'HEAD:README.md'), 'docs 3'); w.cleanup();
  });
  await test('"Restart" with nothing new still restarts (after the same checks); a launcher change restarts even if asked not to', async () => {
    const w = world(), b = await boot(w); const r = await b.up.apply({ restart: true }); assert.equal(r.ok, true); assert.equal(r.restarting, true); assert.equal(r.changes, 0); await sleep(120); assert.equal(b.restarts(), 1);
    const w2 = world(), b2 = await boot(w2); w2.push({ 'launcher-server.js': GOOD_SERVER + '// x\n' }, 'x'); const r2 = await b2.up.apply({ restart: false }); assert.equal(r2.restarting, true, 'the running code changed: it must restart'); w.cleanup(); w2.cleanup();
  });
  await test('two updates at once: the second is told one is already running', async () => {
    const w = world(), b = await boot(w); w.push({ 'launcher-server.js': GOOD_SERVER + '// y\n' }, 'y');
    const [a, c] = await Promise.all([b.up.apply({}), b.up.apply({})]); assert.equal([a, c].filter((x) => x.ok).length, 1); assert.ok([a, c].some((x) => /already running/.test(x.error || ''))); w.cleanup();
  });
  await test('the files that need a restart are exactly what the launcher loads: tests, mutation lists and the node agent are not among them', () => {
    for (const f of ['launcher-server.js', 'updater.js', 'bridge/index.js', 'bridge/hub.js', 'bridge/reports.js', 'bridge/verifier.js']) assert.ok(RESTART_FILES.includes(f), f);
    for (const f of ['bridge/hub.test.js', 'bridge/bridge.mutation.js', 'bridge/tickets.mutations.js', 'bridge/node-agent.js', 'bridge/join.ps1', 'README.md', 'launcher-client.html', 'updater.test.js']) assert.ok(!RESTART_FILES.includes(f), f);
  });
  await test('every real file the launcher loads from bridge/ is in that list', () => {
    const src = fs.readFileSync(path.join(__dirname, 'bridge', 'index.js'), 'utf8') + fs.readFileSync(path.join(__dirname, 'bridge', 'hub.js'), 'utf8');
    const loaded = new Set(); for (const f of fs.readdirSync(path.join(__dirname, 'bridge'))) if (/\.js$/.test(f) && !/(test|mutation|mutations)\.js$/.test(f)) loaded.add(f);
    const needed = [...src.matchAll(/require\('\.\/([a-z-]+)'\)/g)].map((m) => m[1] + '.js').filter((f) => loaded.has(f) && !/^(node-agent|model-supervisor)\.js$/.test(f));
    for (const f of needed) assert.ok(RESTART_FILES.includes('bridge/' + f), 'bridge/' + f + ' is loaded by the launcher but a change to it would not ask for a restart');
  });
  await test('the sentence under the button reads well for 0, 1 and many changes, with a cap on the list', () => {
    const base = { ok: true, running: 'abc1234', ahead: 1, files: 1, insertions: 2, deletions: 1, needsRestart: true, canPull: true, commits: [{ sha: 'def5678', subject: 'One thing' }] };
    assert.equal(describe(base).headline, '1 change ahead · 1 file changed (+2 −1)');
    const many = describe({ ...base, ahead: 30, files: 9, commits: Array.from({ length: 12 }, (_, k) => ({ sha: 'aaaaaa' + k, subject: 's' + k })) });
    assert.match(many.headline, /^30 changes ahead · 9 files changed/); assert.ok(many.lines.includes('… and 18 more'));
    assert.equal(describe({ ok: true, running: 'abc1234', ahead: 0 }).headline, 'Up to date · running abc1234');
  });

  const failed = results.filter((r) => !r[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
