#!/usr/bin/env node
'use strict';
// Mutation check for logs.test.js: copy logs.js, qa-seed.js, the shipped cases and the test to a temp dir, deliberately break ONE protection at a time,
// and require the test to go red. A test that cannot fail is worse than no test.
//   node logs.mutation.js        (a few seconds)
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// [name, file, exact text to find, replacement]
const MUTATIONS = [
  ['keepalives are shown in the default view', 'logs.js', "if (type === 'all' && l.type === 'keepalive') continue;", ''],
  ['problems only lets info lines through', 'logs.js', "if (type === 'problems' && l.level !== 'warn' && l.level !== 'error') continue;", ''],
  ['the session window is ignored', 'logs.js', 'if (!want.has(l.source) || l.ts < from || (to && l.ts > to)) continue;', 'if (!want.has(l.source)) continue;'],
  ['the sources asked for are ignored', 'logs.js', 'if (!want.has(l.source) || l.ts < from || (to && l.ts > to)) continue;', 'if (l.ts < from || (to && l.ts > to)) continue;'],
  ['the live cursor is ignored (every line again on each poll)', 'logs.js', 'if (l.seq <= since) continue;', ''],
  ['a file is read from its start on every poll', 'logs.js', 't.offset += len;', ''],
  ['a half-written line is shown cut', 'logs.js', 't.carry = parts.pop();', "t.carry = '';"],
  ['a cleared file is never read again', 'logs.js', "if (st.size < t.offset) { t.offset = 0; t.carry = ''; t.skipFirst = false; }", ''],
  ['ping and pong are not keepalives', 'logs.js', "if (/^(ping|pong)$/i.test(mt)) return 'keepalive';", ''],
  ['an offer is not WebRTC', 'logs.js', "offer|answer|iceCandidate|iceCandidateError|config|peerConnectionOptions", "answer|iceCandidate|iceCandidateError|config|peerConnectionOptions"],
  ['colour codes stay in the text', 'logs.js', "replace(/\\u001b\\[[0-9;]*[A-Za-z]/g, '')", "replace(/\\u001bNEVER/g, '')"],
  ['a time after the file was written is not moved to the day before', 'logs.js', 'if (t > fileMtime + 60000) t -= DAY;', ''],
  ['the agents are read from the start on every poll', 'logs.js', 'cursors[a.id] = { seq: a.seq, startedAt: a.startedAt };', ''],
  ['a launch in progress closes its own session at once', 'logs.js', "else if (open && state === 'stopped' && now() - open.start > 60000)", "else if (open && state === 'stopped')"],
  ['a stopped stream never closes its session', 'logs.js', '{ open.end = now(); saveSessions(); }', '{ saveSessions(); }'],
  ['the sessions are not kept across a restart', 'logs.js', 'fs.writeFileSync(sessionsFile, JSON.stringify(sessions.slice(-50)));', ''],
  ['the launcher\'s own lines are not kept across a restart', 'logs.js', "fs.appendFileSync(backendFile, JSON.stringify({ ts: l.ts, level: l.level, type: l.type, area: l.area, text: l.text }) + '\\n');", ''],
  ['the QA window may be any length', 'logs.js', '> 2 * DAY) return { status: 400', '> 2000 * DAY) return { status: 400'],
  ['a backwards QA window is accepted', 'logs.js', '|| (Number.isFinite(to) && to < from))', ')'],
  ['memory is not bounded', 'logs.js', 'if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);', ''],
  ['a missing Wilbur folder is not said', 'logs.js', "status.wilbur = { ok: false, where: dirs[0], error: 'no Wilbur log files in ' + dirs.join(' or ') + ' (set WILBUR_LOG_DIR in host.config if Wilbur writes them elsewhere)' }; return;", 'return;'],
  ['an unknown type is accepted', 'logs.js', "if (!VIEWS[type] && !String(type).split(',').every((t) => TYPES[t])) return { status: 400", "if (false) return { status: 400"],
  ['a deleted shipped case comes back', 'qa-seed.js', 'if (offered.has(c.id)) continue;', ''],
  ['a shipped case is added over the owner\'s own', 'qa-seed.js', 'if (have.has(c.id)) continue;', ''],
  ['an empty library is seeded (the QA console could no longer import its starting cases)', 'qa-seed.js', 'if (!cases.length) return { cases, seeded, added: [] };', ''],
  ['a seed file\'s unknown fields are taken too', 'qa-seed.js', 'const clean = { id: c.id };', 'const clean = { ...c };'],
  ['a shipped case names a filter the tab does not offer', 'qa-seed/logs-tab.json', 'What = WebRTC negotiation (offer, answer, ICE)', 'What = WebRTC only'],
];

const FILES = ['logs.js', 'qa-seed.js', 'logs.test.js'];
const copy = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-logs-mut-'));
  for (const f of FILES) fs.copyFileSync(path.join(__dirname, f), path.join(d, f));
  fs.mkdirSync(path.join(d, 'qa-seed')); for (const f of fs.readdirSync(path.join(__dirname, 'qa-seed'))) fs.copyFileSync(path.join(__dirname, 'qa-seed', f), path.join(d, 'qa-seed', f));
  return d;
};
const runTest = (dir) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, [path.join(dir, 'logs.test.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 60000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});

(async () => {
  let failures = 0;
  const base = copy(), b = await runTest(base);
  console.log((b.code ? '  FAIL ' : '  pass ') + 'baseline (unmodified copy) passes everything'); if (b.code) { failures++; console.log(b.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n')); }
  fs.rmSync(base, { recursive: true, force: true });
  for (const [name, file, from, to] of MUTATIONS) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;
    const d = copy(), f = path.join(d, file), src = fs.readFileSync(f, 'utf8');
    if (!src.includes(from)) { failures++; console.log('  FAIL "' + name + '" - MUTATION DID NOT APPLY (' + file + ' changed; update this list)'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, src.replace(from, () => to));
    const r = await runTest(d), which = (r.out.match(/FAIL (.+)/g) || []).slice(0, 2).map((s) => s.slice(5, 70)).join(' | ');
    if (!r.code) failures++;
    console.log((r.code ? '  pass ' : '  FAIL ') + 'breaking "' + name + '" is ' + (r.code ? 'caught by: ' + (which || 'a crash') : 'NOT CAUGHT'));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\n' + (failures ? failures + ' problem(s) - some regressions would slip through' : 'every mutation was caught (' + MUTATIONS.length + ')'));
  process.exit(failures ? 1 : 0);
})();
