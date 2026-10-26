#!/usr/bin/env node
'use strict';
// Mutation check for updater.test.js: copy updater.js and its test to a temp dir, deliberately break ONE protection at a time, and require the test to go red.
// A test that cannot fail is worse than no test.
//   node updater.mutation.js        (about a minute)
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const raw = String.raw;

// [name, exact text to find in updater.js, replacement]
const MUTATIONS = [
  ['the pull is no longer fast-forward only', "['pull', '--ff-only', '--quiet']", "['pull', '--quiet']"],
  ['a live session no longer blocks an update', 'if (reason && !force && (wantRestart || info.needsRestart))', 'if (false)'],
  ['the new code is not checked before the restart', 'const bad = await preflight(info.changed);', 'const bad = null;'],
  ['a failed check is not rolled back', "rolled = (await git(['reset', '--hard', before])).code === 0;", 'rolled = false;'],
  ['the rollback goes to the wrong commit', "['reset', '--hard', before]", "['reset', '--hard', info.upstream]"],
  ['the restart happens before the answer can be sent', 'setTimeout(restart, restartDelayMs);', 'restart();'],
  ['diverged branches are updated anyway', 'if (info.diverged) return {', 'if (false) return {'],
  ['GitHub is asked on every check', 'if (cache && (t - cache.at < (fresh ? minFreshMs : cacheMs))) return cache;', 'if (false) return cache;'],
  ['a forced check always asks GitHub again', '(fresh ? minFreshMs : cacheMs)', '(fresh ? 0 : cacheMs)'],
  ['a token in the remote address is shown', raw`const redact = (s) => String(s || '').replace(/:\/\/[^/@\s]+@/g, '://***@');`, "const redact = (s) => String(s || '');"],
  ['commits made in this checkout are not counted', 'const target = headInTip ? tip : head;', 'const target = tip;'],
  ['untracked files are listed as uncommitted changes', "['status', '--porcelain', '--untracked-files=no']", "['status', '--porcelain']"],
  ['a launcher change never asks for a restart', 'info.needsRestart = names.some((nm) => RESTART_FILES.includes(nm));', 'info.needsRestart = false;'],
  ['an update that needs no restart restarts anyway', 'const exits = wantRestart || info.needsRestart, was = state.running;', 'const exits = true, was = state.running;'],
  ['a launcher change does not restart when asked not to', 'const exits = wantRestart || info.needsRestart, was = state.running;', 'const exits = wantRestart, was = state.running;'],
  ['two updates can run at once', "if (applying) return { ok: false, error: 'An update is already running.' };", ''],
  ['after a no-restart update the launcher still counts itself behind', 'else { state.running = after;', 'else {'],
  ['a change to reports.js does not count as a launcher change', "'tickets', 'reports', 'verifier'", "'tickets', 'verifier'"],
  ['the bridge load check is dropped', "if (typeof b.init !== 'function') process.exit(3);", ''],
  ['a file that does not parse passes the check', "if (r.code !== 0) return f + ' does not parse: '", 'if (false) return f + \' does not parse: \''],
  ['a missing upstream is not reported', "if (up.code !== 0) { info.error = 'This checkout has no upstream branch to compare with.'; return info; }", ''],
];

// The test also reads bridge/ (to check the restart list against what the launcher really loads), so that folder's .js files come along.
const copy = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-updater-mut-')); for (const f of ['updater.js', 'updater.test.js']) fs.copyFileSync(path.join(__dirname, f), path.join(d, f));
  fs.mkdirSync(path.join(d, 'bridge')); for (const f of fs.readdirSync(path.join(__dirname, 'bridge'))) if (/\.js$/.test(f)) fs.copyFileSync(path.join(__dirname, 'bridge', f), path.join(d, 'bridge', f));
  return d;
};
const runTest = (dir) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, [path.join(dir, 'updater.test.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 240000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});

(async () => {
  let failures = 0;
  const base = copy(), b = await runTest(base);
  console.log((b.code ? '  FAIL ' : '  pass ') + 'baseline (unmodified copy) passes everything'); if (b.code) { failures++; console.log(b.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n')); }
  fs.rmSync(base, { recursive: true, force: true });
  for (const [name, from, to] of MUTATIONS) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    const d = copy(), f = path.join(d, 'updater.js'), src = fs.readFileSync(f, 'utf8');
    if (!src.includes(from)) { failures++; console.log('  FAIL "' + name + '" - MUTATION DID NOT APPLY (updater.js changed; update this list)'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, src.replace(from, () => to));
    const r = await runTest(d), which = (r.out.match(/FAIL (.+)/g) || []).slice(0, 2).map((s) => s.slice(5, 70)).join(' | ');
    if (!r.code) failures++;
    console.log((r.code ? '  pass ' : '  FAIL ') + 'breaking "' + name + '" is ' + (r.code ? 'caught by: ' + (which || 'a crash') : 'NOT CAUGHT'));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\n' + (failures ? failures + ' problem(s) - some regressions would slip through' : 'every mutation was caught (' + MUTATIONS.length + ')'));
  process.exit(failures ? 1 : 0);
})();
