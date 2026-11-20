#!/usr/bin/env node
'use strict';
// Tests for femto.js (Femto Group: accounts, email confirmation, password change, audio notes, transcripts, action items) and femto-mail.js.
// Everything is local: a temporary folder, a fake clock, a fake transcriber and model, a fake SMTP server, and the real HTTP handler on 127.0.0.1.
//   node femto.test.js
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const F = require('./femto');
const { createMailer, buildMessage } = require('./femto-mail');
const { main: adminMain } = require('./femto-admin');

const results = [];
const test = async (name, fn) => {
  try { await fn(); results.push(true); console.log('  ok   ' + name); }
  catch (e) { results.push(false); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 4).join('\n       ')); }
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'femto-test-'));
const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 15)); } throw new Error('timed out waiting'); };

// A whole Femto island on a random port. Starting passwords are read back from the file femto-admin would write.
async function rig(opts = {}) {
  const dir = opts.dir || tmp(), clock = { t: 1_800_000_000_000 }, mail = [];
  const mailer = { send: async (m) => { if (opts.mailFails) throw new Error('smtp down'); mail.push(m); return { ok: true, delivered: true }; }, configured: () => true };
  const calls = { transcribe: 0, extract: 0 };
  const transcribe = opts.transcribe || (async () => { calls.transcribe++; return { text: 'Llamar a Grupo Prueba el viernes.\n\nEnviar la cotización a Hugo.', language: 'es', duration: 95 }; });
  const extract = opts.extract || (async ({ transcript }) => { calls.extract++; return { summary: 'Dos pendientes.', items: [{ text: 'Llamar el viernes', owner: 'Hugo', due: '2027-01-15' }, { text: transcript.includes('EDITED') ? 'Revisar la edición' : 'Enviar cotización', owner: '', due: 'mañana' }] }; });
  const femto = F.createFemto({ dir, now: () => clock.t, mailer, transcribe, extract, isOwner: (req) => req.headers['x-devconsole-key'] === 'owner-key', retryMs: opts.retryMs || 30, ...opts.femto });
  await femto.admin.ensureSeed();
  const passwords = Object.fromEntries(fs.readFileSync(femto.admin.file, 'utf8').trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/).slice(1)));
  const server = http.createServer((req, res) => { const u = new URL(req.url, 'http://x'); if (!femto.handle(req, res, u)) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (method, p, { body, session, headers = {}, raw } = {}) => {
    const h = { ...headers };
    if (session) h['x-femto-session'] = session;
    if (body !== undefined) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') || '';
    return { status: res.status, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers };
  };
  const linkToken = (m) => /confirm=([A-Za-z0-9_-]{43})/.exec(m.text)[1];
  // Sign in, give an email, confirm it, set a password: a member ready to use the island.
  const ready = async (id, email = id + '@example.test', next = 'clave-ventas-2027-Q9') => {
    const s = (await call('POST', '/api/femto/login', { body: { user: id, password: passwords[id] } })).body.session;
    await call('POST', '/api/femto/email', { session: s, body: { email } });
    await call('POST', '/api/femto/confirm', { body: { token: linkToken(mail[mail.length - 1]) } });
    await call('POST', '/api/femto/password', { session: s, body: { current: passwords[id], next } });
    return s;
  };
  const upload = async (s, bytes, { name = 'nota.m4a', context = 'Reunión con un cliente', chunk } = {}) => {
    const st = await call('POST', '/api/femto/uploads/start', { session: s, body: { name, size: bytes.length, type: 'audio/mp4', context } });
    if (st.status !== 200) return st;
    const size = chunk || st.body.chunkBytes;
    for (let off = 0; off < bytes.length; off += size) await call('POST', `/api/femto/uploads/chunk?id=${st.body.id}&offset=${off}`, { session: s, raw: bytes.subarray(off, off + size), headers: { 'Content-Type': 'application/octet-stream' } });
    return call('POST', '/api/femto/uploads/finish', { session: s, body: { id: st.body.id } });
  };
  const close = () => { femto.stop(); return new Promise((r) => server.close(r)); };
  return { dir, femto, clock, mail, calls, passwords, call, ready, upload, linkToken, close };
}

(async () => {
  console.log('helpers');
  await test('starting passwords: 4 groups of 4 easy-to-read characters, never the same twice', () => {
    const a = F.tempPassword(), b = F.tempPassword();
    assert.match(a, /^[a-hjkmnp-z2-9]{4}(-[a-hjkmnp-z2-9]{4}){3}$/); assert.notEqual(a, b);
  });
  await test('passwords are hashed with scrypt and checked in constant time; a wrong one fails', async () => {
    const rec = await F.hashPassword('correct horse battery');
    assert.ok(/^[0-9a-f]{32}$/.test(rec.salt) && /^[0-9a-f]{128}$/.test(rec.hash));
    assert.ok(await F.verifyPassword('correct horse battery', rec)); assert.ok(!(await F.verifyPassword('correct horse batterz', rec)));
    assert.ok(!(await F.verifyPassword('x', null)));
  });
  await test('password rules: length, not the starting one, not trivial, not the name', () => {
    const m = { id: 'hugo' };
    assert.match(F.passwordProblem('short', m, 'x'), /10 characters/);
    assert.match(F.passwordProblem('k7mp-q2xw-r9ht-c3vd', m, 'k7mp-q2xw-r9ht-c3vd'), /different/);
    assert.match(F.passwordProblem('aaaaaaaaaaaa', m, 'x'), /easy/);
    assert.match(F.passwordProblem('soyHUGO-del-2026', m, 'x'), /name/);
    assert.equal(F.passwordProblem('ventas-femto-2026!', m, 'x'), null);
  });
  await test('a long transcript is split into parts that fit the node agent (16,000 characters per message)', () => {
    const para = 'Esta es una oración de prueba para el corte. '.repeat(60);
    const text = Array.from({ length: 12 }, () => para).join('\n\n') + '\n' + 'x'.repeat(20000);
    const parts = F.splitTranscript(text);
    assert.ok(parts.length > 3 && parts.every((p) => p.length <= F.PART_CHARS), 'parts: ' + parts.map((p) => p.length).join(','));
    assert.equal(parts.join('').replace(/\s/g, '').length, text.replace(/\s/g, '').length, 'nothing lost');
    assert.deepEqual(F.splitTranscript('  '), []);
  });
  await test('the model reply is read from JSON, a code fence, or a plain list; thinking is ignored', () => {
    assert.deepEqual(F.parseModelJson('<think>hmm {"items":[]}</think>```json\n{"summary":"S","items":[{"text":"A"},"B"]}\n```').items.map((x) => x.text), ['A', 'B']);
    assert.deepEqual(F.parseModelJson('Claro:\n- Llamar a Edgar\n2) Mandar correo').items.map((x) => x.text), ['Llamar a Edgar', 'Mandar correo']);
    assert.equal(F.parseModelJson('{"summary":"Hola","actions":[{"text":"X"}]}').summary, 'Hola');
  });
  await test('action items are cleaned: text required and cut to 300, a due date only as YYYY-MM-DD, duplicates dropped', () => {
    assert.equal(F.normalizeAction({ text: '   ' }), null);
    const a = F.normalizeAction({ text: 'y'.repeat(400), due: 'friday', owner: 'Hugo', done: 'yes' });
    assert.equal(a.text.length, 300); assert.equal(a.due, ''); assert.equal(a.done, false); assert.match(a.id, /^a_[0-9a-f]{8}$/);
    assert.equal(F.dedupeActions([{ text: 'Llamar a Hugo.' }, { text: 'llamar a hugo' }, { text: 'Otra' }]).length, 2);
  });
  await test('the confirmation email is in Spanish and English, with the link and its 24-hour limit', () => {
    const t = F.confirmEmailText({ name: 'Hugo', link: 'https://g-741studio.com/femto/?confirm=abc' });
    assert.match(t, /Hola Hugo/); assert.match(t, /Hi Hugo/); assert.match(t, /24 horas/); assert.match(t, /24 hours/); assert.equal(t.split('confirm=abc').length, 3);
  });

  console.log('the local model, through the bridge');
  await test('each part becomes one local job in the confidential sales area; the answers are merged', async () => {
    const jobs = [];
    const hub = { submit: async (spec) => { jobs.push(spec); return { ok: true, lane: 'local', hubJobId: 'hj_' + jobs.length }; },
      jobStatus: async (id) => ({ ok: true, job: { status: 'done', result: { text: JSON.stringify({ summary: 'S' + id, items: [{ text: 'Tarea común' }, { text: 'Tarea ' + id }] }) } } }) };
    const ex = F.bridgeExtractor({ hub: () => hub, pollMs: 1 });
    const out = await ex({ transcript: ('Hola. '.repeat(1000) + '\n').repeat(4), context: 'ctx', authorName: 'Hugo', agentName: "Hugo's agent" });
    assert.ok(jobs.length >= 2); assert.ok(jobs.every((j) => j.area === 'sales' && j.confidential === true && j.messages[1].content.length <= 16000));
    assert.match(jobs[0].messages[0].content, /Hugo's agent/); assert.match(jobs[0].messages[1].content, /Context from Hugo: ctx/);
    assert.equal(out.items.filter((x) => x.text === 'Tarea común').length, 1, 'deduplicated');
  });
  await test('no PC with the model, or no bridge at all: a "no_model" error the queue waits on', async () => {
    const busy = F.bridgeExtractor({ hub: () => ({ submit: async () => ({ ok: false, error: 'no_local_device_available', note: 'none free' }) }) });
    await assert.rejects(busy({ transcript: 'x', authorName: 'H', agentName: 'A' }), (e) => e.code === 'no_model');
    await assert.rejects(F.bridgeExtractor({ hub: () => null })({ transcript: 'x', authorName: 'H', agentName: 'A' }), (e) => e.code === 'no_model');
    const failed = F.bridgeExtractor({ hub: () => ({ submit: async () => ({ ok: true, hubJobId: 'hj' }), jobStatus: async () => ({ ok: true, job: { status: 'failed', error: 'boom' } }) }), pollMs: 1 });
    await assert.rejects(failed({ transcript: 'x', authorName: 'H', agentName: 'A' }), /boom/);
  });

  console.log('accounts');
  await test('init creates Hugo, Edgar and Erick once; members.json keeps hashes, never a password', async () => {
    const R = await rig();
    try {
      const raw = fs.readFileSync(path.join(R.dir, 'femto-data', 'members.json'), 'utf8');
      assert.deepEqual(JSON.parse(raw).members.map((m) => m.id), ['hugo', 'edgar', 'erick']);
      for (const pw of Object.values(R.passwords)) assert.ok(!raw.includes(pw));
      assert.deepEqual(await R.femto.admin.ensureSeed(), []);
    } finally { await R.close(); }
  });
  await test('a wrong password and an unknown user get the same answer', async () => {
    const R = await rig();
    try {
      const a = await R.call('POST', '/api/femto/login', { body: { user: 'hugo', password: 'nope' } });
      const b = await R.call('POST', '/api/femto/login', { body: { user: 'nobody', password: 'nope' } });
      assert.equal(a.status, 401); assert.equal(b.status, 401); assert.equal(a.body.error, b.body.error);
    } finally { await R.close(); }
  });
  await test('five wrong passwords lock the account for 15 minutes, even with the right one', async () => {
    const R = await rig();
    try {
      for (let i = 0; i < 5; i++) await R.call('POST', '/api/femto/login', { body: { user: 'edgar', password: 'bad' + i } });
      const locked = await R.call('POST', '/api/femto/login', { body: { user: 'edgar', password: R.passwords.edgar } });
      assert.equal(locked.status, 429);
      R.clock.t += 15 * 60 * 1000 + 1;
      assert.equal((await R.call('POST', '/api/femto/login', { body: { user: 'edgar', password: R.passwords.edgar } })).status, 200);
    } finally { await R.close(); }
  });
  await test('ten failures from one address stop that address for 15 minutes', async () => {
    const R = await rig();
    try {
      for (let i = 0; i < 10; i++) await R.call('POST', '/api/femto/login', { body: { user: 'nobody' + i, password: 'x' } });
      assert.equal((await R.call('POST', '/api/femto/login', { body: { user: 'hugo', password: R.passwords.hugo } })).status, 429);
      R.clock.t += 15 * 60 * 1000 + 1;
      assert.equal((await R.call('POST', '/api/femto/login', { body: { user: 'hugo', password: R.passwords.hugo } })).status, 200);
    } finally { await R.close(); }
  });

  console.log('first sign-in: email, confirmation, own password');
  await test('the steps go in order, and nothing else opens before they are done', async () => {
    const R = await rig();
    try {
      const login = await R.call('POST', '/api/femto/login', { body: { user: 'HUGO', password: R.passwords.hugo } });
      assert.equal(login.status, 200); assert.match(login.body.session, F.SESSION_RE); assert.equal(login.body.stage, 'email');
      const s = login.body.session;
      assert.equal((await R.call('GET', '/api/femto/notes', { session: s })).status, 403);
      assert.equal((await R.call('POST', '/api/femto/password', { session: s, body: { current: R.passwords.hugo, next: 'otra-clave-segura-1' } })).status, 409, 'not before the email is confirmed');
      assert.equal((await R.call('POST', '/api/femto/email', { session: s, body: { email: 'not an email' } })).status, 400);
      const em = await R.call('POST', '/api/femto/email', { session: s, body: { email: 'hugo@example.test' } });
      assert.equal(em.status, 200); assert.equal(em.body.stage, 'confirm'); assert.equal(R.mail.length, 1);
      assert.equal(R.mail[0].to, 'hugo@example.test'); assert.match(R.mail[0].text, /https:\/\/g-741studio\.com\/femto\/\?confirm=/);
      const token = R.linkToken(R.mail[0]);
      assert.ok(!fs.readFileSync(path.join(R.dir, 'femto-data', 'members.json'), 'utf8').includes(token), 'only a hash of the link is kept');
      assert.equal((await R.call('GET', '/api/femto/me', { session: s })).body.stage, 'confirm');
      assert.equal((await R.call('POST', '/api/femto/confirm', { body: { token: 'A'.repeat(43) } })).status, 400);
      const ok = await R.call('POST', '/api/femto/confirm', { body: { token } });
      assert.equal(ok.status, 200); assert.equal(ok.body.stage, 'password');
      assert.equal((await R.call('POST', '/api/femto/confirm', { body: { token } })).status, 400, 'a link works once');
      assert.equal((await R.call('POST', '/api/femto/password', { session: s, body: { current: 'wrong', next: 'otra-clave-segura-1' } })).status, 401);
      assert.equal((await R.call('POST', '/api/femto/password', { session: s, body: { current: R.passwords.hugo, next: 'corta' } })).status, 400);
      const pw = await R.call('POST', '/api/femto/password', { session: s, body: { current: R.passwords.hugo, next: 'otra-clave-segura-1' } });
      assert.equal(pw.status, 200); assert.equal(pw.body.stage, 'ready');
      const me = await R.call('GET', '/api/femto/me', { session: s });
      assert.equal(me.body.member.email, 'hugo@example.test'); assert.equal(me.body.team.length, 3); assert.ok(!('pass' in me.body.member));
      assert.equal((await R.call('POST', '/api/femto/login', { body: { user: 'hugo', password: R.passwords.hugo } })).status, 401, 'the starting password is gone');
      assert.equal((await R.call('POST', '/api/femto/login', { body: { user: 'hugo@example.test', password: 'otra-clave-segura-1' } })).status, 200, 'the confirmed email works as the user name');
      assert.equal((await R.call('GET', '/api/femto/notes', { session: s })).status, 200);
    } finally { await R.close(); }
  });
  await test('a confirmation link expires after 24 hours; asking again sends a new one, at most three an hour', async () => {
    const R = await rig();
    try {
      const s = (await R.call('POST', '/api/femto/login', { body: { user: 'edgar', password: R.passwords.edgar } })).body.session;
      await R.call('POST', '/api/femto/email', { session: s, body: { email: 'edgar@example.test' } });
      const old = R.linkToken(R.mail[0]);
      R.clock.t += 24 * 60 * 60 * 1000 + 1;
      assert.equal((await R.call('POST', '/api/femto/confirm', { body: { token: old } })).status, 400);
      const s2 = (await R.call('POST', '/api/femto/login', { body: { user: 'edgar', password: R.passwords.edgar } })).body.session;   // the 12-hour session ran out too
      assert.equal((await R.call('GET', '/api/femto/me', { session: s2 })).body.stage, 'confirm');
      for (const email of ['edgar@example.test', 'edgar2@example.test', 'edgar@example.test']) assert.equal((await R.call('POST', '/api/femto/email', { session: s2, body: { email } })).status, 200);
      assert.equal((await R.call('POST', '/api/femto/email', { session: s2, body: { email: 'edgar@example.test' } })).status, 429);
      assert.equal(R.mail.length, 4);
      assert.equal((await R.call('POST', '/api/femto/confirm', { body: { token: R.linkToken(R.mail[2]) } })).status, 400, 'an older link stops working once a newer one is sent');
      assert.equal((await R.call('POST', '/api/femto/confirm', { body: { token: R.linkToken(R.mail[3]) } })).body.stage, 'password');
    } finally { await R.close(); }
  });
  await test('two members cannot share an email; a failed send says so', async () => {
    const R = await rig();
    try {
      await R.ready('hugo', 'ventas@example.test');
      const s = (await R.call('POST', '/api/femto/login', { body: { user: 'erick', password: R.passwords.erick } })).body.session;
      assert.equal((await R.call('POST', '/api/femto/email', { session: s, body: { email: 'VENTAS@example.test' } })).status, 409);
    } finally { await R.close(); }
    const B = await rig({ mailFails: true });
    try {
      const s = (await B.call('POST', '/api/femto/login', { body: { user: 'hugo', password: B.passwords.hugo } })).body.session;
      const r = await B.call('POST', '/api/femto/email', { session: s, body: { email: 'hugo@example.test' } });
      assert.equal(r.status, 502); assert.ok(!/smtp down/.test(r.body.error), 'no server detail leaks to the page');
    } finally { await B.close(); }
  });

  console.log('sessions and isolation');
  await test('only a real session opens the island; it lasts 12 hours; logout ends it', async () => {
    const R = await rig();
    try {
      const s = await R.ready('erick');
      assert.equal((await R.call('GET', '/api/femto/me')).status, 401);
      assert.equal((await R.call('GET', '/api/femto/me', { session: 'fs_' + 'A'.repeat(43) })).status, 401);
      assert.equal((await R.call('GET', '/api/femto/me', { headers: { 'x-devconsole-key': 'owner-key' } })).status, 401, 'the owner key is not a member session');
      assert.equal((await R.call('GET', '/api/femto/me', { session: s })).status, 200);
      R.clock.t += 12 * 60 * 60 * 1000 + 1;
      assert.equal((await R.call('GET', '/api/femto/me', { session: s })).status, 401);
      const s2 = (await R.call('POST', '/api/femto/login', { body: { user: 'erick', password: 'clave-ventas-2027-Q9' } })).body.session;
      await R.call('POST', '/api/femto/logout', { session: s2 });
      assert.equal((await R.call('GET', '/api/femto/me', { session: s2 })).status, 401);
    } finally { await R.close(); }
  });
  await test('sessions survive a launcher restart (only their hashes are on disk)', async () => {
    const R = await rig();
    let s;
    try { s = await R.ready('hugo'); } finally { await R.close(); }
    const raw = fs.readFileSync(path.join(R.dir, 'femto-data', 'sessions.json'), 'utf8');
    assert.ok(!raw.includes(s));
    const again = await rig({ dir: R.dir });
    try { assert.equal((await again.call('GET', '/api/femto/me', { session: s })).status, 200); } finally { await again.close(); }
  });
  await test('the owner list needs the Dev Console key and shows no hashes; a member session cannot read it', async () => {
    const R = await rig();
    try {
      const s = await R.ready('hugo');
      assert.equal((await R.call('GET', '/api/femto/admin/members', { session: s })).status, 401);
      const list = await R.call('GET', '/api/femto/admin/members', { headers: { 'x-devconsole-key': 'owner-key' } });
      assert.equal(list.status, 200); assert.deepEqual(list.body.members.map((m) => m.stage), ['ready', 'email', 'email']);
      assert.ok(!JSON.stringify(list.body).includes('hash'));
    } finally { await R.close(); }
  });
  await test('a reset gives a new starting password, signs the person out, and keeps their email', async () => {
    const R = await rig();
    try {
      const s = await R.ready('edgar');
      assert.ok((await R.femto.admin.reset('edgar')).ok);
      assert.equal((await R.call('GET', '/api/femto/me', { session: s })).status, 401);
      const lines = fs.readFileSync(R.femto.admin.file, 'utf8').trim().split(/\r?\n/), newPw = lines[lines.length - 1].trim().split(/\s+/)[2];
      const login = await R.call('POST', '/api/femto/login', { body: { user: 'edgar', password: newPw } });
      assert.equal(login.body.stage, 'password', 'the email stays confirmed, only the password must be chosen again');
    } finally { await R.close(); }
  });
  await test('femto-admin.js never prints a password', async () => {
    const dir = tmp(), lines = [], write = process.stdout.write;
    process.stdout.write = (s) => { lines.push(String(s)); return true; };
    try { await adminMain(['node', 'femto-admin.js', 'init', '--dir', dir]); await adminMain(['node', 'femto-admin.js', 'list', '--dir', dir]); await adminMain(['node', 'femto-admin.js', 'reset', 'hugo', '--dir', dir]); }
    finally { process.stdout.write = write; }
    const pws = fs.readFileSync(path.join(dir, 'femto-data', 'starting-passwords.txt'), 'utf8').trim().split(/\r?\n/).map((l) => l.trim().split(/\s+/)[2]);
    assert.equal(pws.length, 4); assert.ok(pws.every((pw) => !lines.join('').includes(pw)));
  });

  console.log('audio notes');
  await test('an upload arrives in order, becomes a note, is transcribed and turned into action items', async () => {
    const R = await rig();
    try {
      const s = await R.ready('hugo');
      const bytes = Buffer.alloc(9 * 1024 * 1024 + 123, 7);
      const fin = await R.upload(s, bytes);
      assert.equal(fin.status, 200, JSON.stringify(fin.body)); const id = fin.body.note.id;
      const note = await waitFor(async () => { const n = (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note; return n.status === 'ready' && n; });
      assert.equal(note.author, 'hugo'); assert.equal(note.context, 'Reunión con un cliente'); assert.equal(note.durationSec, 95); assert.match(note.transcript, /viernes/);
      assert.deepEqual(note.actions.map((a) => a.due), ['2027-01-15', ''], 'a date the model wrote in words is dropped');
      const audio = await R.call('GET', '/api/femto/note/audio?id=' + id, { session: s });
      assert.equal(audio.status, 200); assert.equal(audio.body.length, bytes.length); assert.equal(audio.headers.get('content-type'), 'audio/mp4');
      const list = (await R.call('GET', '/api/femto/notes', { session: s })).body;
      assert.equal(list.notes.length, 1); assert.equal(list.notes[0].openActions, 2); assert.ok(!('transcript' in list.notes[0]));
    } finally { await R.close(); }
  });
  await test('uploads refuse files over 150 MB, things that are not audio, pieces out of order and an early finish', async () => {
    const R = await rig();
    try {
      const s = await R.ready('edgar');
      assert.equal((await R.call('POST', '/api/femto/uploads/start', { session: s, body: { name: 'big.mp3', size: F.MAX_AUDIO_BYTES + 1 } })).status, 400);
      assert.equal((await R.call('POST', '/api/femto/uploads/start', { session: s, body: { name: 'deck.pdf', size: 10, type: 'application/pdf' } })).status, 400);
      const st = (await R.call('POST', '/api/femto/uploads/start', { session: s, body: { name: 'a.mp3', size: 10, type: 'audio/mpeg' } })).body;
      const late = await R.call('POST', `/api/femto/uploads/chunk?id=${st.id}&offset=5`, { session: s, raw: Buffer.alloc(5), headers: { 'Content-Type': 'application/octet-stream' } });
      assert.equal(late.status, 409); assert.equal(late.body.received, 0);
      assert.equal((await R.call('POST', `/api/femto/uploads/chunk?id=${st.id}&offset=0`, { session: s, raw: Buffer.alloc(11), headers: { 'Content-Type': 'application/octet-stream' } })).status, 413, 'more than the declared size');
      await R.call('POST', `/api/femto/uploads/chunk?id=${st.id}&offset=0`, { session: s, raw: Buffer.alloc(4), headers: { 'Content-Type': 'application/octet-stream' } });
      assert.equal((await R.call('POST', '/api/femto/uploads/finish', { session: s, body: { id: st.id } })).status, 400);
      const other = await R.ready('hugo');
      assert.equal((await R.call('POST', `/api/femto/uploads/chunk?id=${st.id}&offset=4`, { session: other, raw: Buffer.alloc(6), headers: { 'Content-Type': 'application/octet-stream' } })).status, 404, 'nobody else can write into your upload');
    } finally { await R.close(); }
  });
  await test('a recording over 30 minutes is rejected and its audio deleted', async () => {
    const R = await rig({ transcribe: async () => ({ tooLong: true, duration: 2400 }) });
    try {
      const s = await R.ready('erick');
      const id = (await R.upload(s, Buffer.alloc(1000, 1))).body.note.id;
      const n = await waitFor(async () => { const x = (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note; return x.status === 'rejected' && x; });
      assert.match(n.error, /30 minutes/); assert.equal(n.hasAudio, false);
      assert.equal(R.calls.extract, 0);
    } finally { await R.close(); }
  });
  await test('no model free: the note waits, and finishes by itself once one is', async () => {
    let free = false;
    const R = await rig({ extract: async () => { if (!free) { const e = new Error('none'); e.code = 'no_model'; throw e; } return { summary: '', items: [{ text: 'Ya quedó' }] }; } });
    try {
      const s = await R.ready('hugo');
      const id = (await R.upload(s, Buffer.alloc(100, 1))).body.note.id;
      await waitFor(async () => (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note.status === 'waiting_model');
      free = true;
      const n = await waitFor(async () => { const x = (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note; return x.status === 'ready' && x; });
      assert.equal(n.actions[0].text, 'Ya quedó');
    } finally { await R.close(); }
  });
  await test('the transcript can be edited; the action items are then marked stale and can be made again from the edit', async () => {
    const R = await rig();
    try {
      const s = await R.ready('hugo');
      const id = (await R.upload(s, Buffer.alloc(100, 1))).body.note.id;
      await waitFor(async () => (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note.status === 'ready');
      const e = await R.call('POST', '/api/femto/note/transcript', { session: s, body: { id, text: 'Texto EDITED por Hugo' } });
      assert.equal(e.status, 200); assert.equal(e.body.note.actionsStale, true); assert.equal(e.body.note.transcriptEditedBy, 'hugo');
      assert.equal((await R.call('POST', '/api/femto/note/regenerate', { session: s, body: { id } })).status, 200);
      const n = await waitFor(async () => { const x = (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note; return x.status === 'ready' && !x.actionsStale && x; });
      assert.ok(n.actions.some((a) => a.text === 'Revisar la edición')); assert.equal(R.calls.transcribe, 1, 'the audio is not transcribed again');
    } finally { await R.close(); }
  });
  await test('action items can be ticked and edited, within limits', async () => {
    const R = await rig();
    try {
      const s = await R.ready('edgar');
      const id = (await R.upload(s, Buffer.alloc(100, 1))).body.note.id;
      const n = await waitFor(async () => { const x = (await R.call('GET', '/api/femto/note?id=' + id, { session: s })).body.note; return x.status === 'ready' && x; });
      const edited = n.actions.map((a, i) => (i === 0 ? { ...a, done: true, text: 'Llamar el viernes a las 10' } : a));
      const r1 = await R.call('POST', '/api/femto/note/actions', { session: s, body: { id, actions: [...edited, { text: 'Nueva tarea', owner: 'Edgar', due: '2027-02-01' }] } });
      assert.equal(r1.status, 200); assert.equal(r1.body.note.actions.length, 3); assert.equal(r1.body.note.actions[0].id, n.actions[0].id, 'ids are kept');
      assert.equal(r1.body.note.actions[0].done, true);
      assert.equal((await R.call('POST', '/api/femto/note/actions', { session: s, body: { id, actions: Array.from({ length: 51 }, () => ({ text: 'x' })) } })).status, 400);
    } finally { await R.close(); }
  });
  await test('the whole group sees every note, but only its author can delete it', async () => {
    const R = await rig();
    try {
      const hugo = await R.ready('hugo'), edgar = await R.ready('edgar');
      const id = (await R.upload(hugo, Buffer.alloc(100, 1))).body.note.id;
      await waitFor(async () => (await R.call('GET', '/api/femto/note?id=' + id, { session: edgar })).body.note.status === 'ready');
      assert.equal((await R.call('POST', '/api/femto/note/delete', { session: edgar, body: { id } })).status, 403);
      assert.equal((await R.call('POST', '/api/femto/note/delete', { session: hugo, body: { id } })).status, 200);
      assert.equal((await R.call('GET', '/api/femto/note?id=' + id, { session: hugo })).status, 404);
      assert.equal(fs.readdirSync(path.join(R.dir, 'femto-data', 'audio')).length, 0);
      assert.equal((await R.call('GET', '/api/femto/note?id=../members', { session: hugo })).status, 404, 'no path tricks');
    } finally { await R.close(); }
  });
  await test('after a restart, a note that was mid-way starts again', async () => {
    const R = await rig({ transcribe: () => new Promise(() => {}) });   // a transcription that never ends: the launcher "stops" mid-way
    let id;
    try {
      const s = await R.ready('hugo');
      id = (await R.upload(s, Buffer.alloc(100, 1))).body.note.id;
      await waitFor(() => R.femto._test.readNote(id).status === 'transcribing');
    } finally { await R.close(); }
    const again = await rig({ dir: R.dir });
    try { await waitFor(() => again.femto._test.readNote(id).status === 'ready'); } finally { await again.close(); }
  });

  console.log('mail');
  await test('the message is UTF-8 plain text in base64, with encoded subject and sender name, and no header injection', () => {
    const msg = buildMessage({ from: 'G741 Studio <no-reply@g-741studio.com>', to: 'a@example.test', subject: 'Confirma tu correo · Femto', text: 'Hola Hugo\n.\nAdiós', date: new Date(0), messageId: '<x@g-741studio.com>' });
    assert.match(msg, /^From: G741 Studio <no-reply@g-741studio.com>\r\n/); assert.match(msg, /Subject: =\?UTF-8\?B\?/);
    const body = msg.split('\r\n\r\n')[1];
    assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hola Hugo\r\n.\r\nAdiós');
    assert.throws(() => buildMessage({ from: 'x', to: 'a@b.co\r\nBcc: evil@x.co', subject: 's', text: 't', date: new Date(0), messageId: '<x>' }));
  });
  await test('with no femto-mail.key the message is kept in the outbox, not sent', async () => {
    const dir = tmp(), m = createMailer({ configFile: path.join(dir, 'femto-mail.key'), outboxDir: path.join(dir, 'outbox') });
    const r = await m.send({ to: 'a@example.test', subject: 'S', text: 'T' });
    assert.equal(r.delivered, false); assert.ok(fs.existsSync(r.outbox)); assert.equal(m.configured(), false);
    await assert.rejects(m.send({ to: 'bad', subject: 'S', text: 'T' }));
  });
  await test('with femto-mail.key it speaks SMTP: login, sender, recipient, message, quit', async () => {
    const dir = tmp(), seen = [];
    fs.writeFileSync(path.join(dir, 'femto-mail.key'), JSON.stringify({ host: '127.0.0.1', port: 465, user: 'no-reply@g-741studio.com', pass: 's3cret', from: 'G741 Studio <no-reply@g-741studio.com>' }));
    const smtp = net.createServer((c) => {
      let buf = '', inData = false, n = 0;                 // n: lines on THIS connection (the last one's QUIT may arrive late)
      c.write('220 fake ready\r\n');
      c.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 2);
          if (inData) { if (line === '.') { inData = false; c.write('250 queued\r\n'); } else seen.push('DATA:' + line); continue; }
          seen.push(line); n++;
          if (/^EHLO/.test(line)) c.write('250-fake\r\n250 AUTH LOGIN\r\n');
          else if (line === 'AUTH LOGIN') c.write('334 VXNlcm5hbWU6\r\n');
          else if (n === 3) c.write('334 UGFzc3dvcmQ6\r\n');
          else if (n === 4) c.write(Buffer.from(line, 'base64').toString() === 's3cret' ? '235 ok\r\n' : '535 no\r\n');
          else if (/^MAIL FROM/.test(line) || /^RCPT TO/.test(line)) c.write('250 ok\r\n');
          else if (line === 'DATA') { inData = true; c.write('354 go\r\n'); }
          else if (line === 'QUIT') { c.write('221 bye\r\n'); c.end(); }
        }
      });
    });
    await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
    try {
      const m = createMailer({ configFile: path.join(dir, 'femto-mail.key'), outboxDir: path.join(dir, 'outbox'), connect: () => net.connect(smtp.address().port, '127.0.0.1') });
      const r = await m.send({ to: 'hugo@example.test', subject: 'Hola', text: 'Línea uno\n.empieza con punto' });
      assert.equal(r.delivered, true);
      assert.ok(seen.includes('MAIL FROM:<no-reply@g-741studio.com>') && seen.includes('RCPT TO:<hugo@example.test>'));
      assert.ok(seen.some((l) => l.startsWith('DATA:Subject: Hola')));
      assert.ok(!fs.existsSync(path.join(dir, 'outbox')));
      // A wrong mailbox password: the server refuses the login, and the send fails without saying the password.
      seen.length = 0;
      fs.writeFileSync(path.join(dir, 'femto-mail.key'), JSON.stringify({ host: '127.0.0.1', port: 465, user: 'no-reply@g-741studio.com', pass: 'wrong-pass', from: 'G741 Studio <no-reply@g-741studio.com>' }));
      await assert.rejects(m.send({ to: 'hugo@example.test', subject: 'Hola', text: 'x' }), (e) => /refused the password/.test(e.message) && !/wrong-pass/.test(e.message));
      assert.ok(!seen.some((l) => /^MAIL FROM/.test(l)), 'nothing is sent after a refused login');
    } finally { smtp.close(); }
  });

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
})();
