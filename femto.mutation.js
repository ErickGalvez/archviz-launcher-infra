#!/usr/bin/env node
'use strict';
// Mutation check for femto.test.js: copy femto.js, femto-mail.js, femto-admin.js and the test to a temp dir, deliberately break ONE protection at a
// time, and require the test to go red. A test that cannot fail is worse than no test.
//   node femto.mutation.js        (a few minutes: every run hashes real passwords)     ONLY=<part of a name> runs just those
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// [name, file, exact text to find, replacement]
const MUTATIONS = [
  // signing in
  ['any password is right', 'femto.js', 'return sameHex(got.hash, rec.hash);', 'return true;'],
  ['a locked account still signs in', 'femto.js', 'if (m && m.lockedUntil > t) {', 'if (false) {'],
  ['five wrong passwords never lock', 'femto.js', 'if (x.failed >= MEMBER_MAX_FAILS) { x.failed = 0; x.lockedUntil = t + LOCK_MS; }', ''],
  ['one address may guess for ever', 'femto.js', "if (ipLimited(ip)) return r(429, { ok: false, error: 'Too many attempts. Try again in 15 minutes.' });\n    const user", 'const user'],
  ['a session is kept in clear', 'femto.js', 'sessions.set(sha(token), {', 'sessions.set(token, {'],
  ['a session never expires', 'femto.js', 'if (s.expiresAt <= now()) { sessions.delete(h); saveSessions(); return null; }', ''],
  ['sessions are forgotten on a restart', 'femto.js', "try { j = JSON.parse(fs.readFileSync(files.sessions, 'utf8')); } catch (e) { return; }", 'return;'],
  ['a reset leaves the old sessions open', 'femto.js', '      dropSessions(id);\n', '\n'],
  // the first sign-in steps
  ['the island opens before the set-up is done', 'femto.js', "    if (stage !== 'ready') { req.resume(); json(403, { ok: false, error: 'Finish setting up your account first.', stage }); return true; }\n", ''],
  ['the password can be chosen before the email is confirmed', 'femto.js', "if (st === 'email' || st === 'confirm') return r(409, { ok: false, error: 'Confirm your email first.' });", ''],
  ['the current password is not checked', 'femto.js', 'if (!(await verifyPassword(current, m.pass))) return', 'if (false) return'],
  ['any new password is accepted', 'femto.js', 'const problem = passwordProblem(next, m, current);', 'const problem = null;'],
  ['the confirmation link is stored in clear', 'femto.js', 'x.confirmHash = sha(token);', 'x.confirmHash = token;'],
  ['a confirmation link never expires', 'femto.js', 'if (!m || !(m.confirmExpires > now()) || !m.emailPending) return bad();', 'if (!m || !m.emailPending) return bad();'],
  ['emails can be sent without limit', 'femto.js', 'if (sends.length >= MAX_EMAILS_PER_HOUR) return r(429', 'if (false) return r(429'],
  ['two members may share an email', 'femto.js', 'if (readMembers().some((x) => x.id !== m.id &&', 'if (false && readMembers().some((x) => x.id !== m.id &&'],
  ['the owner list opens without the key', 'femto.js', "if (!isOwner(req)) { json(401, { ok: false, error: 'Unauthorized' }); return true; }", ''],
  // audio notes
  ['an upload over 150 MB is accepted', 'femto.js', 'if (size > MAX_AUDIO_BYTES) return r(400,', 'if (false) return r(400,'],
  ['any kind of file is accepted', 'femto.js', 'if (!AUDIO_TYPES[ext] && !/^audio\\//.test(type)) return r(400,', 'if (false) return r(400,'],
  ['pieces are accepted out of order', 'femto.js', 'const inOrder = () => offset === up.received;', 'const inOrder = () => true;'],
  ['a piece bigger than declared is accepted', 'femto.js', 'if (n > CHUNK_BYTES || up.received + n > up.size) { tooBig = true; return; }', 'if (n > CHUNK_BYTES) { tooBig = true; return; }'],
  ['someone else can write into your upload', 'femto.js', 'if (!up || up.memberId !== m.id) { req.resume(); json(404,', 'if (!up) { req.resume(); json(404,'],
  ['an unfinished upload becomes a note', 'femto.js', 'if (up.received !== up.size) return r(400,', 'if (false) return r(400,'],
  ['a recording over 30 minutes is kept', 'femto.js', 'if (t.tooLong || t.duration > MAX_AUDIO_SECONDS + 5) {', 'if (false) {'],
  ['a note waiting for the model is never retried', 'femto.js', 'later(() => enqueue(n.id), retryMs);', ''],
  ['anyone can delete a note', 'femto.js', 'if (n.author !== m.id) return r(403,', 'if (false) return r(403,'],
  ['a note id can be a path', 'femto.js', 'const readNote = (id) => { if (!NOTE_ID_RE.test(id)) return null;', 'const readNote = (id) => {'],
  // the model
  ['the jobs go out as a non-confidential area', 'femto.js', "area: 'sales', role: agentName, title: `Femto: action items for ${authorName}`, confidential: true,", "area: 'dev', role: agentName, title: `Femto: action items for ${authorName}`, confidential: false,"],
  ['a transcript part may be longer than the node agent takes', 'femto.js', 'const PART_CHARS = 9000;', 'const PART_CHARS = 40000;'],
  ['any due date the model writes is kept', 'femto.js', "const due = typeof a.due === 'string' && DUE_RE.test(a.due) ? a.due : '';", "const due = typeof a.due === 'string' ? a.due : '';"],
  ['duplicate action items are kept', 'femto.js', 'if (!key || seen.has(key)) continue;', 'if (!key) continue;'],
  // mail
  ['a header value may carry a line break', 'femto-mail.js', "for (const v of [from, to, subject]) if (hasLineBreak(v)) throw new Error('header value with a line break');", ''],
  ['a bad recipient is accepted', 'femto-mail.js', "if (typeof to !== 'string' || to.length > 254 || !ADDRESS_RE.test(to)) throw new Error('bad recipient');", ''],
  ['the mail server\'s refusal is ignored', 'femto-mail.js', "if (!st.expect.includes(code)) { finish(new Error('the mail server refused the ' + what[step] + ' (' + line.slice(0, 80) + ')')); return; }", ''],
  ['a send failure leaks the server\'s message to the page', 'femto.js', "return r(502, { ok: false, error: 'The confirmation email could not be sent. Try again in a minute.' });", "return r(502, { ok: false, error: 'The confirmation email could not be sent: ' + e.message });"],
];

const FILES = ['femto.js', 'femto-mail.js', 'femto-admin.js', 'femto.test.js'];
const copy = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-femto-mut-'));
  for (const f of FILES) fs.copyFileSync(path.join(__dirname, f), path.join(d, f));
  return d;
};
const runTest = (dir) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, [path.join(dir, 'femto.test.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 120000);
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
