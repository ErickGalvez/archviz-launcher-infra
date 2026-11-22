'use strict';
// Builds and starts the range: a throwaway copy of the launcher that Hex is allowed to attack.
//
//   - CODE ONLY. launcher-server.js and exactly the local modules it requires (followed require by require), plus the admin panel page. Never a key,
//     a .json/.jsonl data file, a log, the owner's tasks, the sales data or anything else from the real launcher folder. The copy makes its own keys.
//   - IN A TEMP FOLDER, ON LOOPBACK, ON A RANDOM PORT. Never port 3000 and never inside the real launcher folder (both refused).
//   - TWO LOCKS ON PROCESSES. The copy's child_process line is replaced with a stub (as the test harness does), and guard.js is preloaded, which also
//     confines files to the temp folder and the network to loopback. The environment is rebuilt from scratch: no token or key from this shell leaks in.
//   - stop() kills the copy and deletes the folder.
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const STUB = `// -- RANGE SANDBOX: child_process is stubbed; nothing in this copy can start, kill or inspect a process --
const { spawn, exec } = (() => {
  const { EventEmitter } = require('events');
  const refuse = () => new Error('child_process is disabled in the range');
  return {
    spawn: () => { const e = new EventEmitter(); e.unref = () => {}; e.kill = () => {}; e.stdout = new EventEmitter(); e.stderr = new EventEmitter(); process.nextTick(() => e.emit('error', refuse())); return e; },
    exec: (cmd, opts, cb) => { if (typeof opts === 'function') cb = opts; if (cb) process.nextTick(() => cb(refuse(), '', '')); return { on() {}, kill() {}, unref() {} }; },
  };
})();`;
const PORT_LINE = 'const PORT = 3000;';
const CP_LINE = "const { spawn, exec } = require('child_process');";
const EXTRA_FILES = ['launcher-client.html'];                         // served by the copy itself (the admin panel)
const NEVER = /\.(key|pem|pfx|env|jsonl?|log|txt|db|sqlite)$|^\.|node_modules|femto-data|redteam-data|owner-tasks|sales-data|qa-data/i;

const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every local module launcher-server.js reaches, by following require('./x') and require('./x/y.js') through the files themselves.
function localModules(launcherDir) {
  const seen = new Set(), queue = ['launcher-server.js'];
  while (queue.length) {
    const rel = queue.shift(); if (seen.has(rel)) continue;
    const abs = path.join(launcherDir, rel); if (!fs.existsSync(abs)) continue;
    seen.add(rel);
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\(\s*'(\.{1,2}\/[^']+)'\s*\)/g)) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));   // forward slashes on every OS
      if (target.startsWith('..')) continue;                            // nothing outside the launcher folder
      if (!/\.js$/.test(target)) target = fs.existsSync(path.join(launcherDir, target + '.js')) ? target + '.js' : path.posix.join(target, 'index.js');
      if (!NEVER.test(path.basename(target)) && !seen.has(target)) queue.push(target);
    }
  }
  return [...seen];
}

async function startRange({ launcherDir, guardFile = path.join(__dirname, 'guard.js'), log = () => {}, seed = () => {}, keepDir = false } = {}) {
  launcherDir = path.resolve(launcherDir);
  let src = fs.readFileSync(path.join(launcherDir, 'launcher-server.js'), 'utf8');
  if (!src.includes(PORT_LINE) || !src.includes(CP_LINE)) throw new Error('the range is out of date: launcher-server.js no longer has the PORT / child_process lines it patches. Refusing to run an unsandboxed copy.');
  const port = await freePort();
  if (port === 3000) throw new Error('refusing to put the range on the live launcher\'s port');
  src = src.replace(PORT_LINE, 'const PORT = ' + port + ';').replace(CP_LINE, STUB);
  if (/require\(\s*['"]child_process['"]\s*\)/.test(src.replace(STUB, ''))) throw new Error('the range is out of date: launcher-server.js requires child_process somewhere else. Refusing to run.');

  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g741-range-')));
  const rel = path.relative(launcherDir, dir);
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) throw new Error('refusing to build the range inside the launcher folder');
  const files = localModules(launcherDir);
  for (const f of files) {
    if (f === 'launcher-server.js') continue;
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.copyFileSync(path.join(launcherDir, f), path.join(dir, f));
  }
  for (const f of EXTRA_FILES) if (fs.existsSync(path.join(launcherDir, f))) fs.copyFileSync(path.join(launcherDir, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'launcher-server.js'), src);
  fs.copyFileSync(guardFile, path.join(dir, '.range-guard.js'));
  fs.mkdirSync(path.join(dir, 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bridge', 'bridge.key'), crypto.randomBytes(32).toString('hex'));     // throwaway: lets the bridge routes exist so they can be attacked
  fs.writeFileSync(path.join(dir, 'bridge.json'), JSON.stringify({ verify: { roots: {} } }));
  fs.mkdirSync(path.join(dir, 'tmp'));
  // A canary: random text in a file named like a secret. If any answer from the copy ever contains it, something read a file it should not have.
  const canary = 'RANGE-CANARY-' + crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(path.join(dir, 'range-canary.key'), canary);
  await seed(dir);                                                     // e.g. Femto members, when this build has Femto

  const env = { PATH: process.env.PATH || '', SystemRoot: process.env.SystemRoot || '', windir: process.env.windir || '', TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'),
    G741_RANGE_DIR: dir, G741_BRIDGE_DISABLED: '1', G741_BRIDGE_KEY_FILE: path.join(dir, 'bridge', 'bridge.key'), NODE_ENV: 'range' };
  const child = spawn(process.execPath, ['--require', path.join(dir, '.range-guard.js'), 'launcher-server.js'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let output = '';
  const guardHits = [];
  const take = (d) => { output += d; if (output.length > 2e6) output = output.slice(-1e6); for (const line of String(d).split('\n')) if (line.startsWith('RANGE-GUARD ')) guardHits.push(line.slice(12).trim()); };
  child.stdout.on('data', take); child.stderr.on('data', take);

  const base = 'http://127.0.0.1:' + port;
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(250);
    if (child.exitCode !== null) break;
    try { up = (await fetch(base + '/api/status', { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { /* not up yet */ }
  }
  const stop = async () => {
    try { child.kill(); } catch (e) { /* already gone */ }
    for (let i = 0; i < 20 && child.exitCode === null && child.signalCode === null; i++) await sleep(100);   // Windows frees the files only once the process is gone
    if (!keepDir) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (e) { log('could not delete the range folder ' + dir + ': ' + e.message); }
  };
  if (!up) { const tail = output.slice(-400); await stop(); throw new Error('the range did not come up: ' + tail); }
  const key = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8').trim(); } catch (e) { return ''; } };
  const keys = { admin: key('admin.key'), qa: key('qa.key'), dev: key('devconsole.key') };
  log('range up on ' + base + ' (' + files.length + ' files copied)');
  return {
    base, port, dir, keys, canary, files,
    alive: () => child.exitCode === null,
    guardHits: () => guardHits.slice(),
    output: () => output,
    secrets: () => [keys.admin, keys.qa, keys.dev, canary, key(path.join('bridge', 'bridge.key'))].filter((s) => s && s.length >= 16),
    stop,
  };
}

module.exports = { startRange, localModules, STUB, NEVER };
