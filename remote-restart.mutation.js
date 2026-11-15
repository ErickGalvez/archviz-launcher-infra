#!/usr/bin/env node
'use strict';
// Mutation check for remote-restart.test.js: copy remote-restart.js and its test to a temp dir, deliberately break ONE protection at a time, and require
// the test to go red. A test that cannot fail is worse than no test.
//   node remote-restart.mutation.js        (a few seconds)
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// [name, exact text to find in remote-restart.js, replacement]
const MUTATIONS = [
  ['a live session no longer blocks restarting PC 1', "if (reason) return { status: 409, body: { ok: false, busy: reason,", "if (false) return { status: 409, body: { ok: false, busy: reason,"],
  ['restart all goes ahead with PC 2 during a live session', "if (wantPc1) {\n      const reason = busy();", "if (pc === 1) {\n      const reason = busy();"],
  ['the launcher restart is forced past the updater\'s own session check', 'await updater.apply({ restart: true });', 'await updater.apply({ restart: true, force: true });'],
  ['the request body reaches the updater', 'await updater.apply({ restart: true });', 'await updater.apply({ ...body, restart: true });'],
  ['any pc value is accepted', "return v === 1 || v === 2 || v === '1' || v === '2' ? { pc: Number(v) }", 'return true ? { pc: Number(v) }'],
  ['restarts are not rate-limited', 'if (t - lastRestart < restartGapMs) return', 'if (false) return'],
  ['model starts are not rate-limited', 'if (t - lastStart < startGapMs) return', 'if (false) return'],
  ['a refused request uses up the turn', 'const { pc, error } = parsePc(body);', 'const { pc, error } = parsePc(body); lastRestart = now();'],
  ['PC 1\'s agent restarts before the pull (it would come back on the old code)', 'const u = await updater.apply({ restart: true });', 'if (h) await h.restartAgents(1); const u = await updater.apply({ restart: true });'],
  ['PC 1\'s agent restarts even when the launcher did not', 'parts.pc1 = { ok: false, busy: u.busy, error: u.error };', 'parts.pc1 = { ok: false, busy: u.busy, error: u.error }; if (h) await h.restartAgents(1);'],
  ['restart all never asks PC 2', 'if (wantPc2) {                                     // first', 'if (false) {                                     // first'],
  ['a failed agent is reported as success', 'parts.pc2 = { ok: rs.every((r) => r.ok), agents: rs };', 'parts.pc2 = { ok: true, agents: rs };'],
  ['no free PC is reported as success', 'const ok = r.starting.length + r.ready.length > 0, message', 'const ok = true, message'],
];

const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-remote-mut-')); for (const f of ['remote-restart.js', 'remote-restart.test.js']) fs.copyFileSync(path.join(__dirname, f), path.join(d, f)); return d; };
const runTest = (dir) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, [path.join(dir, 'remote-restart.test.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 60000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});

(async () => {
  let failures = 0;
  const base = copy(), b = await runTest(base);
  console.log((b.code ? '  FAIL ' : '  pass ') + 'baseline (unmodified copy) passes everything'); if (b.code) { failures++; console.log(b.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n')); }
  fs.rmSync(base, { recursive: true, force: true });
  for (const [name, from, to] of MUTATIONS) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    const d = copy(), f = path.join(d, 'remote-restart.js'), src = fs.readFileSync(f, 'utf8');
    if (!src.includes(from)) { failures++; console.log('  FAIL "' + name + '" - MUTATION DID NOT APPLY (remote-restart.js changed; update this list)'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, src.replace(from, () => to));
    const r = await runTest(d), which = (r.out.match(/FAIL (.+)/g) || []).slice(0, 2).map((s) => s.slice(5, 70)).join(' | ');
    if (!r.code) failures++;
    console.log((r.code ? '  pass ' : '  FAIL ') + 'breaking "' + name + '" is ' + (r.code ? 'caught by: ' + (which || 'a crash') : 'NOT CAUGHT'));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\n' + (failures ? failures + ' problem(s) - some regressions would slip through' : 'every mutation was caught (' + MUTATIONS.length + ')'));
  process.exit(failures ? 1 : 0);
})();
