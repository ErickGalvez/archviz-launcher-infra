#!/usr/bin/env node
'use strict';
// Mutation check for redteam.test.js: copy the launcher's code to a temp folder, break ONE protection at a time, and require the tests to go red.
//   node redteam/redteam.mutation.js        (several minutes: each copy builds real ranges)     ONLY=<part of a name> runs just those
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// [name, file, exact text to find, replacement]
const MUTATIONS = [
  ['the guard lets files out of the range', 'redteam/guard.js', 'return abs === ROOT || abs.startsWith(ROOT + path.sep);', 'return true;'],
  ['the guard lets connections leave the machine', 'redteam/guard.js', "if (!LOOP.has(host)) { const err = refusal('network connection'", "if (false) { const err = refusal('network connection'"],
  ['the guard lets processes start', 'redteam/guard.js', "for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {", "for (const n of []) {"],
  ['the guard lets names be looked up', 'redteam/guard.js', 'if (LOOP.has(String(host))) return origLookup.call(this, host, ...rest);', 'return origLookup.call(this, host, ...rest);'],
  ['the guard starts without a range folder', 'redteam/guard.js', "console.error('RANGE-GUARD no G741_RANGE_DIR: refusing to start'); process.exit(97);", ''],
  ['the copy keeps its real child_process', 'redteam/sandbox.js', ".replace(CP_LINE, STUB);", ';'],
  ['the range may sit inside the launcher folder', 'redteam/sandbox.js', "const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'g741-range-')));", "const dir = fs.realpathSync(fs.mkdtempSync(path.join(launcherDir, 'g741-range-')));"],
  ['the range folder is left behind', 'redteam/sandbox.js', "if (!keepDir) try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }", 'if (false) try { }'],
  ['lessons pile up unread', 'redteam/store.js', 'return Math.min(LESSONS.length, days, readInARow + 1);', 'return Math.min(LESSONS.length, days);'],
  ['the quiz answer shows before reading', 'redteam/store.js', "lesson: { ...l, quiz: done ? l.quiz : quiz }", 'lesson: { ...l }'],
  ['a locked lesson can be marked read', 'redteam/store.js', "if (LESSONS.indexOf(l) >= unlockedCount()) return { ok: false, error: 'this lesson is not open yet' };", ''],
  ['a run id may be a path', 'redteam/store.js', "const RUN_ID_RE = /^rt_\\d{8}_[a-z-]{2,30}_[0-9a-f]{6}$/;", 'const RUN_ID_RE = /^.+$/;'],
  ['Hex\'s answers may be cached', 'bridge/index.js', "'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors }); res.end(JSON.stringify(obj)); };", "...cors }); res.end(JSON.stringify(obj)); };"],
  ['autopilot takes any name', 'bridge/agents.js', 'const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/;', 'const NAME_RE = /^.+$/;'],
  ['the schedule ignores autopilot', 'bridge/routines.js', 'if (!autopilotOn(r.persona)) continue;', ''],
  ['any file is taken as an image', 'bridge/mesh.js', "if (!MAGIC[ext](buf)) return json(400,", "if (false) return json(400,"],
  ['a mesh file is fetched by any id', 'bridge/mesh.js', "if (!MESH_ID_RE.test(id)) return no(400, 'bad id');", ''],
  ['images of any size are taken', 'bridge/mesh.js', 'const MAX_IMAGE = 10 * 1024 * 1024;', 'const MAX_IMAGE = 100 * 1024 * 1024;'],
];

function copy() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-rt-mut-'));
  for (const f of fs.readdirSync(ROOT)) if (/\.(js|html)$/.test(f) || f === '.gitignore') fs.copyFileSync(path.join(ROOT, f), path.join(d, f));
  for (const sub of ['bridge', 'redteam']) { fs.mkdirSync(path.join(d, sub)); for (const f of fs.readdirSync(path.join(ROOT, sub))) if (/\.js$/.test(f)) fs.copyFileSync(path.join(ROOT, sub, f), path.join(d, sub, f)); }
  return d;
}
const runTest = (dir) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, [path.join(dir, 'redteam', 'redteam.test.js')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 240000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});

(async () => {
  let failures = 0;
  const base = copy(), b = await runTest(base);
  console.log((b.code ? '  FAIL ' : '  pass ') + 'baseline (unmodified copy) passes everything'); if (b.code) { failures++; console.log(b.out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 8).join('\n')); }
  fs.rmSync(base, { recursive: true, force: true });
  for (const [name, file, from, to] of MUTATIONS) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    const d = copy(), f = path.join(d, file), src = fs.readFileSync(f, 'utf8');
    if (!src.includes(from)) { failures++; console.log('  FAIL "' + name + '" - MUTATION DID NOT APPLY (' + file + ' changed; update this list)'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, src.replace(from, () => to));
    const r = await runTest(d), which = (r.out.match(/FAIL (.+)/g) || []).slice(0, 2).map((s) => s.slice(5, 80)).join(' | ');
    if (!r.code) failures++;
    console.log((r.code ? '  pass ' : '  FAIL ') + 'breaking "' + name + '" is ' + (r.code ? 'caught by: ' + (which || 'a crash') : 'NOT CAUGHT'));
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* a range process may still hold it for a moment */ }
  }
  console.log('\n' + (failures ? failures + ' problem(s) - some regressions would slip through' : 'every mutation was caught (' + MUTATIONS.length + ')'));
  process.exit(failures ? 1 : 0);
})();
