'use strict';
// Femto Group: a separate island for a three-person sales team (Hugo, Edgar and Erick), each with their own AI agent.
//
//   - Accounts are for the three PEOPLE; the agents have none. The owner gives each person a starting password (femto-admin.js writes it to a
//     file on this PC; it is never shown anywhere else). On the first sign-in the person gives their email, confirms it through a link sent from
//     the studio's domain (femto-mail.js), then picks their own password. Until those three steps are done the session can do nothing else.
//   - Audio notes: a person attaches a recording (30 minutes at most) with a few words of context. It is transcribed on this PC
//     (femto-transcribe.py, faster-whisper on the CPU), the transcript can be edited, and the person's agent turns it into action items with the
//     local model through the device bridge. Sales is a confidential area: this text never goes to the cloud.
//   - Isolation: a Femto session opens /api/femto/* and nothing else. No other key opens the Femto data, except that the owner's Dev Console key
//     can read the member list (who has finished signing up). Everything lives in femto-data/ beside launcher-server.js (gitignored).
//
// Routes (the session goes in the x-femto-session header):
//   POST /api/femto/login {user, password}         -> {session, expiresAt, stage}       user = the member id (hugo) or their confirmed email
//   GET  /api/femto/me                              -> {member, stage, team}
//   POST /api/femto/logout
//   POST /api/femto/email {email}                   stage email|confirm: sends the confirmation link
//   POST /api/femto/confirm {token}                 no session (the link may be opened on another device)
//   POST /api/femto/password {current, next}        stage password|ready
//   POST /api/femto/uploads/start {name, size, type, context}   -> {id, chunkBytes}     stage ready, for everything below
//   POST /api/femto/uploads/chunk?id=&offset=       raw bytes, chunkBytes at most, in order
//   POST /api/femto/uploads/finish {id}             -> {note}
//   GET  /api/femto/notes | /api/femto/note?id= | /api/femto/note/audio?id=
//   POST /api/femto/note/transcript {id, text} | /api/femto/note/actions {id, actions} | /api/femto/note/regenerate {id} | /api/femto/note/delete {id}
//   GET  /api/femto/admin/members                   the owner's Dev Console key
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CONFIRM_TTL_MS = 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 15 * 60 * 1000;
const IP_MAX_FAILS = 10;
const MEMBER_MAX_FAILS = 5;
const MAX_SESSIONS_PER_MEMBER = 10;
const MAX_EMAILS_PER_HOUR = 3;
const MAX_AUDIO_BYTES = 150 * 1024 * 1024;
const CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 30 * 60;
const UPLOAD_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_CONTEXT = 2000;
const MAX_TRANSCRIPT = 200000;
const MAX_ACTIONS = 50;
const MAX_JSON_BODY = 300 * 1024;
const PART_CHARS = 9000;                       // the node agent takes 16,000 characters per message; leave room for the prompt and the context

const SESSION_RE = /^fs_[A-Za-z0-9_-]{43}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const NOTE_ID_RE = /^n_[0-9a-f]{16}$/;
const UPLOAD_ID_RE = /^u_[0-9a-f]{16}$/;
const MEMBER_ID_RE = /^[a-z][a-z0-9]{1,19}$/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
const DUE_RE = /^\d{4}-\d{2}-\d{2}$/;
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.webm': 'audio/webm', '.flac': 'audio/flac', '.amr': 'audio/amr', '.3gp': 'audio/3gpp', '.mp4': 'audio/mp4' };
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';    // no 0/o, 1/l/i: easy to read out and type
const SEED = [{ id: 'hugo', name: 'Hugo' }, { id: 'edgar', name: 'Edgar' }, { id: 'erick', name: 'Erick' }];
const BUSY = ['queued', 'transcribing', 'extracting', 'waiting_model'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const sameHex = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));

// ── passwords ──
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function hashPassword(password, salt = crypto.randomBytes(16)) {
  return new Promise((resolve, reject) => crypto.scrypt(String(password), salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve({ salt: salt.toString('hex'), hash: key.toString('hex') }))));
}
async function verifyPassword(password, rec) {
  if (!rec || typeof rec.salt !== 'string' || typeof rec.hash !== 'string') return false;
  const got = await hashPassword(password, Buffer.from(rec.salt, 'hex'));
  return sameHex(got.hash, rec.hash);
}
const DUMMY = { salt: '00'.repeat(16), hash: '00'.repeat(64) };    // a user that doesn't exist costs the same scrypt as one that does

// 16 characters in four groups (about 79 bits), e.g. k7mp-q2xw-r9ht-c3vd. Rejection sampling keeps every character equally likely.
function tempPassword(randomBytes = crypto.randomBytes) {
  let out = '';
  while (out.length < 16) {
    for (const b of randomBytes(32)) {
      if (b >= 248) continue;                  // 248 = 8 * 31
      out += TEMP_ALPHABET[b % 31];
      if (out.length === 16) break;
    }
  }
  return out.match(/.{4}/g).join('-');
}

function passwordProblem(next, member, current) {
  if (typeof next !== 'string' || next.length < 10) return 'Use at least 10 characters.';
  if (next.length > 128) return 'Use 128 characters or fewer.';
  if (next === current) return 'Pick a password different from the starting one.';
  if (/^(.)\1+$/.test(next) || /^(0123456789|1234567890|password|contrase)/i.test(next)) return 'That password is too easy to guess.';
  if (member && next.toLowerCase().includes(member.id)) return 'Leave your name out of the password.';
  return null;
}

const stageOf = (m) => (!m.emailConfirmed ? (m.emailPending ? 'confirm' : 'email') : (m.mustChange ? 'password' : 'ready'));

// ── the transcript to action items ──
// Split on paragraph and line breaks, then on sentences, so no part is longer than max characters.
function splitTranscript(text, max = PART_CHARS) {
  const parts = [];
  let cur = '';
  const push = () => { if (cur.trim()) parts.push(cur.trim()); cur = ''; };
  const add = (piece, sep) => {
    if (piece.length > max) {
      push();
      const bits = piece.match(/[^.!?¡¿]+[.!?]*\s*/g) || [piece];
      for (const bit of bits) {
        if (bit.length > max) { for (let i = 0; i < bit.length; i += max) { push(); cur = bit.slice(i, i + max); } continue; }
        if ((cur + bit).length > max) push();
        cur += bit;
      }
      return;
    }
    if ((cur + sep + piece).length > max) push();
    cur = cur ? cur + sep + piece : piece;
  };
  for (const para of String(text).split(/\n+/)) if (para.trim()) add(para.trim(), '\n');
  push();
  return parts;
}

const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
function normalizeAction(a, randomBytes = crypto.randomBytes) {
  if (!a || typeof a !== 'object') return null;
  const text = cleanText(a.text, 300);
  if (!text) return null;
  const due = typeof a.due === 'string' && DUE_RE.test(a.due) ? a.due : '';
  const id = typeof a.id === 'string' && /^a_[0-9a-f]{8}$/.test(a.id) ? a.id : 'a_' + randomBytes(4).toString('hex');
  return { id, text, owner: cleanText(a.owner, 40), due, done: a.done === true };
}

// The model is asked for JSON, but a small local model sometimes wraps it in prose or a code fence, or answers with a plain list.
function parseModelJson(text) {
  const raw = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const j = JSON.parse(raw.slice(a, b + 1));
      const items = Array.isArray(j.items) ? j.items : Array.isArray(j.actions) ? j.actions : [];
      return { summary: cleanText(j.summary, 600), items: items.map((x) => (typeof x === 'string' ? { text: x } : x)) };
    } catch (e) { /* fall through to the list reading */ }
  }
  const items = raw.split(/\n/).map((l) => /^\s*(?:[-*•]|\d+[.)])\s+(.+)$/.exec(l)).filter(Boolean).map((m) => ({ text: m[1] }));
  return { summary: '', items };
}

function dedupeActions(items) {
  const seen = new Set(), out = [];
  for (const it of items) {
    const key = String(it.text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key); out.push(it);
  }
  return out;
}

// A small local model gets weekdays wrong when it has to count ("el viernes" from a Friday). So the prompt carries the next two weeks, named
// in English and Spanish, and the model only has to look the day up.
const DAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAYS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function calendarFrom(today) {
  const t0 = Date.parse(today + 'T12:00:00Z');
  return Array.from({ length: 15 }, (_, i) => {
    const d = new Date(t0 + i * 86400000), w = d.getUTCDay();
    return `${d.toISOString().slice(0, 10)} ${DAYS_EN[w]} / ${DAYS_ES[w]}${i === 0 ? ' (today / hoy)' : i === 1 ? ' (tomorrow / mañana)' : ''}`;
  }).join('\n');
}

function promptFor({ part, index, total, context, authorName, agentName, today }) {
  const system = [
    `You are ${agentName}, the AI assistant of ${authorName} in Femto Group, a three-person sales team.`,
    `You read the transcript of a voice note that ${authorName} recorded and turn it into concrete action items: who should do what, and by when if a date was said.`,
    'Only include things that were said or clearly implied. Write in the same language as the transcript.',
    'Reply with JSON only, no other text: {"summary": "two sentences at most", "items": [{"text": "the action, starting with a verb", "owner": "a name, or empty", "due": "YYYY-MM-DD, or empty"}]}',
    'Dates: when a weekday is named ("el viernes", "on Tuesday"), use the first date with that weekday AFTER today in the calendar below. "Before Monday" means the day before that Monday. If no day was said, leave due empty.',
    `At most 12 items. Calendar:\n${calendarFrom(today)}`,
  ].join('\n');
  const user = (context ? `Context from ${authorName}: ${context}\n\n` : '') + `Transcript${total > 1 ? ` (part ${index + 1} of ${total})` : ''}:\n${part}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

const noModel = (note) => { const e = new Error(note || 'No PC with the local model is free right now.'); e.code = 'no_model'; return e; };

// Action items through the device bridge: one local-model job per part of the transcript, in the 'sales' area (confidential, so local only).
function bridgeExtractor({ hub, now = () => Date.now(), pollMs = 2000, timeoutMs = 10 * 60 * 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  async function waitJob(h, id) {
    const t0 = now();
    for (;;) {
      const r = await h.jobStatus(id);
      if (!r) throw new Error('the bridge lost track of the job');
      if (!r.ok) throw noModel('The PC running the job went offline.');
      const job = r.job || {};
      if (job.status === 'done') return (job.result && job.result.text) || '';
      if (job.status === 'failed') throw new Error(job.error || 'the model job failed');
      if (now() - t0 > timeoutMs) throw new Error('the model took longer than 10 minutes');
      await sleep(pollMs);
    }
  }
  return async ({ transcript, context, authorName, agentName }) => {
    const h = hub();
    if (!h) throw noModel('The device bridge is not running on the launcher.');
    const parts = splitTranscript(transcript);
    if (!parts.length) return { summary: '', items: [] };
    const today = new Date(now()).toISOString().slice(0, 10), items = [], summaries = [];
    for (let i = 0; i < parts.length; i++) {
      const sub = await h.submit({ area: 'sales', role: agentName, title: `Femto: action items for ${authorName}`, confidential: true, maxTokens: 1200,
        messages: promptFor({ part: parts[i], index: i, total: parts.length, context, authorName, agentName, today }) });
      if (!sub || !sub.ok) { if (sub && sub.error === 'no_local_device_available') throw noModel(sub.note); throw new Error((sub && sub.error) || 'the bridge refused the job'); }
      if (!sub.hubJobId) throw new Error('the bridge did not run the job locally');
      const parsed = parseModelJson(await waitJob(h, sub.hubJobId));
      items.push(...parsed.items);
      if (parsed.summary) summaries.push(parsed.summary);
    }
    return { summary: summaries.join(' ').slice(0, 1500), items: dedupeActions(items).slice(0, 30) };
  };
}

// The transcriber: femto-transcribe.py in its own process, below normal priority, one at a time (the queue below sees to that).
function pythonTranscriber({ python = process.env.G741_PYTHON || 'python', script, model = 'small', timeoutMs = 75 * 60 * 1000, spawnImpl = spawn }) {
  return (audioFile) => new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(python, [script, audioFile, '--model', model, '--max-seconds', String(MAX_AUDIO_SECONDS + 5)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new Error('could not start Python: ' + e.message)); return; }
    try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch (e) { /* normal priority, then */ }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; if (out.length > 5e6) child.kill(); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('could not start Python (' + python + '): ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      let j = null;
      try { j = JSON.parse(out.trim().split('\n').pop()); } catch (e) { /* not JSON */ }
      if (j && j.ok) { resolve({ text: String(j.text || ''), language: j.language || null, duration: Number(j.duration) || 0 }); return; }
      if (j && j.error === 'too_long') { resolve({ tooLong: true, duration: Number(j.duration) || 0 }); return; }
      const last = err.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
      reject(new Error(String((j && j.error) || ('the transcriber stopped (exit ' + code + ')' + (last ? ': ' + last : ''))).slice(0, 240)));
    });
  });
}

function confirmEmailText({ name, link }) {
  return [
    `Hola ${name}:`,
    '',
    'Confirma tu correo para terminar de crear tu cuenta de Femto Group en G741 Studio:',
    link,
    '',
    'El enlace vale 24 horas. Después de confirmarlo elegirás tu propia contraseña.',
    'Si no fuiste tú, ignora este correo: sin el enlace nadie puede usarlo.',
    '',
    '---',
    '',
    `Hi ${name},`,
    '',
    'Confirm your email to finish setting up your Femto Group account at G741 Studio:',
    link,
    '',
    'The link works for 24 hours. After confirming, you will choose your own password.',
    'If this wasn\'t you, ignore this email: nobody can use it without the link.',
    '',
    'G741 Studio',
  ].join('\n');
}

function createFemto({
  dir, log = () => {}, cors = {}, isOwner = () => false, mailer = null, siteUrl = 'https://g-741studio.com',
  transcribe = null, extract = null, hub = () => null, now = () => Date.now(), randomBytes = crypto.randomBytes, autoStart = true, retryMs = 2 * 60 * 1000,
} = {}) {
  const root = path.join(dir, 'femto-data');
  const files = { members: path.join(root, 'members.json'), sessions: path.join(root, 'sessions.json'), notes: path.join(root, 'notes'), audio: path.join(root, 'audio'),
    uploads: path.join(root, 'uploads'), outbox: path.join(root, 'outbox'), passwords: path.join(root, 'starting-passwords.txt') };
  for (const d of [root, files.notes, files.audio, files.uploads]) fs.mkdirSync(d, { recursive: true });
  const transcribeFn = transcribe || pythonTranscriber({ script: path.join(dir, 'femto-transcribe.py') });
  const extractFn = extract || bridgeExtractor({ hub, now });

  const atomicWrite = (file, text) => {
    const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, text);
    try { fs.renameSync(tmp, file); } catch (e) { fs.writeFileSync(file, text); try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ } }
  };

  // ── members (read fresh on every use, so femto-admin.js can change them while the launcher runs) ──
  const readMembers = () => { try { const j = JSON.parse(fs.readFileSync(files.members, 'utf8')); return Array.isArray(j.members) ? j.members.filter((m) => m && MEMBER_ID_RE.test(m.id)) : []; } catch (e) { return []; } };
  const writeMembers = (list) => atomicWrite(files.members, JSON.stringify({ v: 1, members: list }, null, 2));
  const findMember = (id) => readMembers().find((m) => m.id === id) || null;
  const updateMember = (id, fn) => { const list = readMembers(), m = list.find((x) => x.id === id); if (!m) return null; fn(m); writeMembers(list); return m; };
  // The model is told its name; the page shows a custom name as is and otherwise says "Hugo's agent" / "Agente de Hugo" in the reader's language.
  const agentNameOf = (m) => m.agentName || `${m.name}'s agent`;
  const publicMember = (m) => ({ id: m.id, name: m.name, agentName: m.agentName || null, email: m.emailConfirmed ? m.email : null, emailPending: m.emailConfirmed ? null : m.emailPending || null });
  const team = () => readMembers().map((m) => ({ id: m.id, name: m.name, agentName: m.agentName || null }));

  // ── admin (femto-admin.js on this PC) ──
  async function newMember({ id, name }) {
    const password = tempPassword(randomBytes);
    return { record: { id, name, pass: await hashPassword(password), mustChange: true, email: null, emailPending: null, emailConfirmed: false, confirmHash: null, confirmExpires: 0,
      emailSends: [], failed: 0, lockedUntil: 0, createdAt: now(), agentName: null }, password };
  }
  function rememberPasswords(rows) {
    const lines = rows.map((r) => `${new Date(now()).toISOString()}  ${r.id.padEnd(8)} ${r.password}`);
    fs.appendFileSync(files.passwords, lines.join(os.EOL) + os.EOL);
  }
  const admin = {
    file: files.passwords,
    // Creates any of Hugo, Edgar and Erick who don't exist yet. Their starting passwords go to starting-passwords.txt only.
    async ensureSeed() {
      const list = readMembers(), made = [];
      for (const s of SEED) if (!list.some((m) => m.id === s.id)) { const { record, password } = await newMember(s); list.push(record); made.push({ id: s.id, password }); }
      if (made.length) { writeMembers(list); rememberPasswords(made); }
      return made.map((r) => r.id);
    },
    // A new starting password: the person signs in with it and must pick their own again. Their confirmed email stays.
    async reset(id) {
      const m = findMember(id);
      if (!m) return { ok: false, error: 'no such member' };
      const password = tempPassword(randomBytes), pass = await hashPassword(password);
      updateMember(id, (x) => { x.pass = pass; x.mustChange = true; x.failed = 0; x.lockedUntil = 0; });
      dropSessions(id);
      rememberPasswords([{ id, password }]);
      return { ok: true };
    },
    setAgentName(id, name) { const clean = cleanText(name, 40); return updateMember(id, (x) => { x.agentName = clean || null; }) ? { ok: true } : { ok: false, error: 'no such member' }; },
    list: () => readMembers().map((m) => ({ ...publicMember(m), stage: stageOf(m), locked: m.lockedUntil > now(), lastLoginAt: m.lastLoginAt || null })),
  };

  // ── sessions (only a SHA-256 of each is kept, in memory and in sessions.json, so a launcher restart doesn't sign everyone out) ──
  const sessions = new Map();
  const saveSessions = () => { try { atomicWrite(files.sessions, JSON.stringify({ v: 1, sessions: [...sessions].map(([h, s]) => ({ h, ...s })) })); } catch (e) { /* kept in memory only */ } };
  (function loadSessions() {
    let j = null;
    try { j = JSON.parse(fs.readFileSync(files.sessions, 'utf8')); } catch (e) { return; }
    const t = now();
    for (const s of (j && Array.isArray(j.sessions) ? j.sessions : [])) {
      if (s && /^[0-9a-f]{64}$/.test(s.h) && MEMBER_ID_RE.test(s.memberId) && Number.isFinite(s.expiresAt) && s.expiresAt > t && s.expiresAt <= t + SESSION_TTL_MS) sessions.set(s.h, { memberId: s.memberId, createdAt: Number(s.createdAt) || 0, expiresAt: s.expiresAt });
    }
  }());
  function issueSession(memberId) {
    const t = now(), token = 'fs_' + randomBytes(32).toString('base64url');
    const mine = [...sessions].filter(([, s]) => s.memberId === memberId).sort((a, b) => a[1].createdAt - b[1].createdAt);
    while (mine.length >= MAX_SESSIONS_PER_MEMBER) sessions.delete(mine.shift()[0]);
    sessions.set(sha(token), { memberId, createdAt: t, expiresAt: t + SESSION_TTL_MS });
    saveSessions();
    return { token, expiresAt: t + SESSION_TTL_MS };
  }
  function sessionOf(req) {
    const token = req.headers['x-femto-session'];
    if (typeof token !== 'string' || !SESSION_RE.test(token)) return null;
    const h = sha(token), s = sessions.get(h);
    if (!s) return null;
    if (s.expiresAt <= now()) { sessions.delete(h); saveSessions(); return null; }
    return { ...s, hash: h };
  }
  function dropSessions(memberId, keepHash = null) {
    let changed = false;
    for (const [h, s] of sessions) if (s.memberId === memberId && h !== keepHash) { sessions.delete(h); changed = true; }
    if (changed) saveSessions();
  }

  // ── failed attempts per address (Cloudflare's cf-connecting-ip when it came through the tunnel) ──
  const ipFails = new Map();
  const clientIp = (req) => String(req.headers['cf-connecting-ip'] || (req.socket && req.socket.remoteAddress) || '?').slice(0, 64);
  const recentFails = (ip) => { const t = now(), list = (ipFails.get(ip) || []).filter((x) => t - x < IP_WINDOW_MS); if (list.length) ipFails.set(ip, list); else ipFails.delete(ip); return list; };
  const ipLimited = (ip) => recentFails(ip).length >= IP_MAX_FAILS;
  const noteFail = (ip) => { const list = recentFails(ip); list.push(now()); ipFails.set(ip, list); if (ipFails.size > 5000) ipFails.delete(ipFails.keys().next().value); };
  const r = (code, body) => ({ code, body });

  async function login(body, ip) {
    if (ipLimited(ip)) return r(429, { ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
    const user = cleanText(body.user, 254).toLowerCase(), password = typeof body.password === 'string' ? body.password.slice(0, 200) : '';
    const m = readMembers().find((x) => x.id === user || (x.emailConfirmed && typeof x.email === 'string' && x.email.toLowerCase() === user)) || null;
    const t = now();
    if (m && m.lockedUntil > t) { noteFail(ip); await verifyPassword(password, DUMMY); return r(429, { ok: false, error: 'Too many wrong passwords: this account is locked for 15 minutes.' }); }
    const good = await verifyPassword(password, m ? m.pass : DUMMY) && !!m;
    if (!good) {
      noteFail(ip);
      if (m) updateMember(m.id, (x) => { x.failed = (x.failed || 0) + 1; if (x.failed >= MEMBER_MAX_FAILS) { x.failed = 0; x.lockedUntil = t + LOCK_MS; } });
      return r(401, { ok: false, error: 'Wrong user or password.' });
    }
    const fresh = updateMember(m.id, (x) => { x.failed = 0; x.lockedUntil = 0; x.lastLoginAt = t; });
    const s = issueSession(m.id);
    log(`Femto: ${m.name} signed in.`);
    return r(200, { ok: true, session: s.token, expiresAt: s.expiresAt, stage: stageOf(fresh) });
  }

  async function setEmail(m, body) {
    const st = stageOf(m);
    if (st !== 'email' && st !== 'confirm') return r(409, { ok: false, error: 'Your email is already confirmed.' });
    const email = cleanText(body.email, 254);
    if (!EMAIL_RE.test(email)) return r(400, { ok: false, error: 'That doesn\'t look like an email address.' });
    if (readMembers().some((x) => x.id !== m.id && [x.email, x.emailPending].some((e) => typeof e === 'string' && e.toLowerCase() === email.toLowerCase()))) return r(409, { ok: false, error: 'Another member already uses that email.' });
    const t = now(), sends = (m.emailSends || []).filter((x) => t - x < 60 * 60 * 1000);
    if (sends.length >= MAX_EMAILS_PER_HOUR) return r(429, { ok: false, error: 'Three emails were sent in the last hour. Wait a little and try again.' });
    const token = randomBytes(32).toString('base64url');
    updateMember(m.id, (x) => { x.emailPending = email; x.confirmHash = sha(token); x.confirmExpires = t + CONFIRM_TTL_MS; x.emailSends = [...sends, t]; });
    const link = `${siteUrl.replace(/\/+$/, '')}/femto/?confirm=${token}`;
    let sent;
    try {
      if (!mailer) throw new Error('no mailer');
      sent = await mailer.send({ to: email, subject: 'Confirma tu correo · Confirm your email — Femto Group', text: confirmEmailText({ name: m.name, link }) });
    } catch (e) {
      log(`Femto: the confirmation email for ${m.name} was not sent (${e.message}).`, 'warn');
      return r(502, { ok: false, error: 'The confirmation email could not be sent. Try again in a minute.' });
    }
    log(sent.delivered ? `Femto: confirmation email sent to ${m.name}.` : `Femto: mail is not set up (femto-mail.key), so ${m.name}'s confirmation email was saved in femto-data/outbox.`);
    return r(200, { ok: true, stage: 'confirm', emailPending: email, delivered: !!sent.delivered });
  }

  function confirm(body, ip) {
    if (ipLimited(ip)) return r(429, { ok: false, error: 'Too many attempts. Try again in 15 minutes.' });
    const token = typeof body.token === 'string' ? body.token : '';
    const bad = () => { noteFail(ip); return r(400, { ok: false, error: 'This link doesn\'t work any more. Sign in and ask for a new one.' }); };
    if (!TOKEN_RE.test(token)) return bad();
    const h = sha(token), list = readMembers(), m = list.find((x) => sameHex(x.confirmHash, h));
    if (!m || !(m.confirmExpires > now()) || !m.emailPending) return bad();
    m.email = m.emailPending; m.emailPending = null; m.emailConfirmed = true; m.emailConfirmedAt = now(); m.confirmHash = null; m.confirmExpires = 0;
    writeMembers(list);
    log(`Femto: ${m.name} confirmed their email.`);
    return r(200, { ok: true, name: m.name, stage: stageOf(m) });
  }

  async function changePassword(m, body, session) {
    const st = stageOf(m);
    if (st === 'email' || st === 'confirm') return r(409, { ok: false, error: 'Confirm your email first.' });
    const current = typeof body.current === 'string' ? body.current.slice(0, 200) : '', next = typeof body.next === 'string' ? body.next : '';
    if (!(await verifyPassword(current, m.pass))) return r(401, { ok: false, error: 'Your current password isn\'t right.' });
    const problem = passwordProblem(next, m, current);
    if (problem) return r(400, { ok: false, error: problem });
    const pass = await hashPassword(next);
    updateMember(m.id, (x) => { x.pass = pass; x.mustChange = false; x.passwordChangedAt = now(); });
    dropSessions(m.id, session.hash);
    log(`Femto: ${m.name} set their own password.`);
    return r(200, { ok: true, stage: 'ready' });
  }

  // ── notes ──
  const notePath = (id) => path.join(files.notes, id + '.json');
  const readNote = (id) => { if (!NOTE_ID_RE.test(id)) return null; try { return JSON.parse(fs.readFileSync(notePath(id), 'utf8')); } catch (e) { return null; } };
  const saveNote = (n) => { n.updatedAt = now(); atomicWrite(notePath(n.id), JSON.stringify(n)); return n; };
  const audioPath = (n) => path.join(files.audio, n.id + n.ext);
  const allNotes = () => { let names = []; try { names = fs.readdirSync(files.notes); } catch (e) { /* none */ } return names.filter((f) => /^n_[0-9a-f]{16}\.json$/.test(f)).map((f) => readNote(f.slice(0, -5))).filter(Boolean); };
  const summaryOf = (n) => ({ id: n.id, author: n.author, createdAt: n.createdAt, updatedAt: n.updatedAt, fileName: n.fileName, size: n.size, durationSec: n.durationSec, status: n.status,
    statusNote: n.statusNote || '', error: n.error || null, context: n.context, summary: n.summary || '', actionCount: (n.actions || []).length, openActions: (n.actions || []).filter((a) => !a.done).length });
  const fullOf = (n) => ({ ...summaryOf(n), language: n.language || null, transcript: n.transcript || '', transcriptEditedBy: n.transcriptEditedBy || null, transcriptEditedAt: n.transcriptEditedAt || null,
    actions: n.actions || [], actionsStale: !!n.actionsStale, hasAudio: fs.existsSync(audioPath(n)) });

  // One job at a time: a transcription is minutes of CPU, and the model serves one request at a time anyway.
  const queue = [];
  let busy = false, stopped = false;
  const timers = new Set();
  const later = (fn, ms) => { const t = setTimeout(() => { timers.delete(t); fn(); }, ms); if (t.unref) t.unref(); timers.add(t); };
  function enqueue(id) { if (!queue.includes(id)) queue.push(id); setImmediate(pump); }
  async function pump() {
    if (busy || stopped) return;
    const id = queue.shift();
    if (!id) return;
    busy = true;
    try { await processNote(id); } catch (e) { log('Femto: note ' + id + ' failed: ' + e.message, 'warn'); }
    busy = false;
    setImmediate(pump);
  }
  async function processNote(id) {
    const n = readNote(id);
    if (!n || !BUSY.includes(n.status)) return;
    if (!n.transcript) {
      n.status = 'transcribing'; n.statusNote = 'Transcribing on the studio PC…'; saveNote(n);
      let t;
      try { t = await transcribeFn(audioPath(n)); } catch (e) { n.status = 'failed'; n.error = 'Transcription failed: ' + e.message; n.statusNote = ''; saveNote(n); return; }
      if (t.tooLong || t.duration > MAX_AUDIO_SECONDS + 5) {
        n.status = 'rejected'; n.error = 'This recording is longer than 30 minutes. Split it and attach the parts.'; n.durationSec = Math.round(t.duration) || null; n.statusNote = '';
        try { fs.unlinkSync(audioPath(n)); } catch (e) { /* already gone */ }
        saveNote(n); return;
      }
      n.transcript = cleanText(t.text, MAX_TRANSCRIPT); n.language = t.language; n.durationSec = Math.round(t.duration) || null; saveNote(n);
    }
    await makeActions(n);
  }
  async function makeActions(n) {
    const author = findMember(n.author) || { id: n.author, name: n.author };
    n.status = 'extracting'; n.statusNote = `${agentNameOf(author)} is writing the action items…`; saveNote(n);
    try {
      const out = await extractFn({ transcript: n.transcript, context: n.context, authorName: author.name, agentName: agentNameOf(author), language: n.language });
      n.actions = (out.items || []).map((a) => normalizeAction(a, randomBytes)).filter(Boolean).slice(0, MAX_ACTIONS);
      n.summary = cleanText(out.summary, 1500); n.actionsStale = false; n.status = 'ready'; n.statusNote = ''; n.error = null;
      saveNote(n);
    } catch (e) {
      if (e.code === 'no_model') {
        n.status = 'waiting_model'; n.statusNote = 'Waiting for a studio PC with the local model. It will try again by itself.'; saveNote(n);
        later(() => enqueue(n.id), retryMs);
        return;
      }
      n.status = 'failed'; n.error = 'Could not write the action items: ' + e.message; n.statusNote = ''; saveNote(n);
    }
  }

  // ── uploads: in order, chunk by chunk (Cloudflare refuses bodies over 100 MB, so a recording comes in 4 MB pieces) ──
  const uploads = new Map();
  function pruneUploads() {
    const t = now();
    for (const [id, u] of uploads) if (t - u.createdAt > UPLOAD_TTL_MS) { uploads.delete(id); try { fs.unlinkSync(u.file); } catch (e) { /* gone */ } }
  }
  function startUpload(m, body) {
    pruneUploads();
    const size = Number(body.size);
    if (!Number.isInteger(size) || size <= 0) return r(400, { ok: false, error: 'Missing file size.' });
    if (size > MAX_AUDIO_BYTES) return r(400, { ok: false, error: 'Recordings can be up to 150 MB. Export it as MP3 or M4A and try again.' });
    const name = cleanText(body.name, 120).replace(/[\\/:*?"<>|]/g, '_') || 'audio';
    const ext = path.extname(name).toLowerCase(), type = cleanText(body.type, 80).toLowerCase();
    if (!AUDIO_TYPES[ext] && !/^audio\//.test(type)) return r(400, { ok: false, error: 'That isn\'t an audio file. Attach an MP3, M4A, WAV, OGG, OPUS, WEBM or FLAC recording.' });
    if ([...uploads.values()].filter((u) => u.memberId === m.id).length >= 3) return r(429, { ok: false, error: 'Finish the uploads you already started first.' });
    const id = 'u_' + randomBytes(8).toString('hex'), file = path.join(files.uploads, id + '.part');
    fs.writeFileSync(file, '');
    uploads.set(id, { id, memberId: m.id, name, ext: AUDIO_TYPES[ext] ? ext : '.audio', size, received: 0, context: cleanText(body.context, MAX_CONTEXT), file, createdAt: now() });
    return r(200, { ok: true, id, chunkBytes: CHUNK_BYTES });
  }
  function receiveChunk(m, req, u, json) {
    const id = u.searchParams.get('id') || '', offset = Number(u.searchParams.get('offset')), up = UPLOAD_ID_RE.test(id) ? uploads.get(id) : null;
    if (!up || up.memberId !== m.id) { req.resume(); json(404, { ok: false, error: 'Unknown upload.' }); return; }
    const inOrder = () => offset === up.received;           // checked before reading, and again at the end in case another request got there first
    if (!inOrder()) { req.resume(); json(409, { ok: false, error: 'Out of order.', received: up.received }); return; }
    const chunks = [];
    let n = 0, tooBig = false;
    req.on('data', (d) => { if (tooBig) return; n += d.length; if (n > CHUNK_BYTES || up.received + n > up.size) { tooBig = true; return; } chunks.push(d); });
    req.on('end', () => {
      if (tooBig) { json(413, { ok: false, error: 'That piece is too big.' }); return; }
      if (!inOrder()) { json(409, { ok: false, error: 'Out of order.', received: up.received }); return; }
      fs.appendFileSync(up.file, Buffer.concat(chunks));
      up.received += n;
      json(200, { ok: true, received: up.received });
    });
    req.on('error', () => { /* the client went away; it can resend from up.received */ });
  }
  function finishUpload(m, body) {
    const id = typeof body.id === 'string' ? body.id : '', up = UPLOAD_ID_RE.test(id) ? uploads.get(id) : null;
    if (!up || up.memberId !== m.id) return r(404, { ok: false, error: 'Unknown upload.' });
    if (up.received !== up.size) return r(400, { ok: false, error: 'The upload isn\'t complete yet.', received: up.received });
    uploads.delete(id);
    const n = { id: 'n_' + randomBytes(8).toString('hex'), author: m.id, createdAt: now(), fileName: up.name, ext: up.ext, size: up.size, context: up.context,
      status: 'queued', statusNote: 'In the queue…', durationSec: null, language: null, transcript: '', summary: '', actions: [], actionsStale: false, error: null };
    fs.renameSync(up.file, audioPath(n));
    saveNote(n);
    log(`Femto: ${m.name} attached an audio note (${(up.size / 1048576).toFixed(1)} MB).`);
    enqueue(n.id);
    return r(200, { ok: true, note: summaryOf(n) });
  }

  // ── the HTTP side ──
  function readJson(req) {
    return new Promise((resolve) => {
      let body = '', big = false;
      req.setEncoding('utf8');
      req.on('data', (d) => { if (big) return; body += d; if (body.length > MAX_JSON_BODY) { big = true; body = ''; } });
      req.on('end', () => { if (big) { resolve({ tooBig: true }); return; } try { const j = JSON.parse(body || '{}'); resolve(j && typeof j === 'object' && !Array.isArray(j) ? { body: j } : { body: null }); } catch (e) { resolve({ body: null }); } });
      req.on('error', () => resolve({ body: null }));
    });
  }

  function handle(req, res, u) {
    const p = u.pathname;
    if (!p.startsWith('/api/femto/')) return false;
    const json = (code, obj) => { if (res.headersSent) return; res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors }); res.end(JSON.stringify(obj)); };
    const ip = clientIp(req);
    const reply = (fn) => {
      Promise.resolve().then(fn).then((out) => json(out.code, out.body)).catch((e) => { log('Femto: ' + e.message, 'warn'); json(500, { ok: false, error: 'Something went wrong on the studio side.' }); });
      return true;
    };
    const post = (fn) => reply(async () => {
      const got = await readJson(req);
      if (got.tooBig) return r(413, { ok: false, error: 'Too large.' });
      if (!got.body) return r(400, { ok: false, error: 'Invalid body.' });
      return fn(got.body);
    });

    // No session needed
    if (p === '/api/femto/login' && req.method === 'POST') return post((b) => login(b, ip));
    if (p === '/api/femto/confirm' && req.method === 'POST') return post((b) => confirm(b, ip));
    if (p === '/api/femto/admin/members' && req.method === 'GET') {
      if (!isOwner(req)) { json(401, { ok: false, error: 'Unauthorized' }); return true; }
      json(200, { ok: true, members: admin.list(), mail: mailer && mailer.configured ? mailer.configured() : false });
      return true;
    }

    // Everything else is for a signed-in member
    const s = sessionOf(req), m = s ? findMember(s.memberId) : null;
    if (!m) { req.resume(); json(401, { ok: false, error: 'Please sign in again.', code: 'signed_out' }); return true; }
    const stage = stageOf(m);

    if (p === '/api/femto/me' && req.method === 'GET') { json(200, { ok: true, member: publicMember(m), stage, team: team() }); return true; }
    if (p === '/api/femto/logout' && req.method === 'POST') { req.resume(); sessions.delete(s.hash); saveSessions(); json(200, { ok: true }); return true; }
    if (p === '/api/femto/email' && req.method === 'POST') return post((b) => setEmail(m, b));
    if (p === '/api/femto/password' && req.method === 'POST') return post((b) => changePassword(m, b, s));

    if (stage !== 'ready') { req.resume(); json(403, { ok: false, error: 'Finish setting up your account first.', stage }); return true; }

    if (p === '/api/femto/uploads/start' && req.method === 'POST') return post((b) => startUpload(m, b));
    if (p === '/api/femto/uploads/chunk' && req.method === 'POST') { receiveChunk(m, req, u, json); return true; }
    if (p === '/api/femto/uploads/finish' && req.method === 'POST') return post((b) => finishUpload(m, b));
    if (p === '/api/femto/notes' && req.method === 'GET') {
      json(200, { ok: true, notes: allNotes().sort((a, b) => b.createdAt - a.createdAt).map(summaryOf), team: team() });
      return true;
    }
    if (p === '/api/femto/note' && req.method === 'GET') {
      const n = readNote(u.searchParams.get('id') || '');
      json(n ? 200 : 404, n ? { ok: true, note: fullOf(n) } : { ok: false, error: 'No such note.' });
      return true;
    }
    if (p === '/api/femto/note/audio' && req.method === 'GET') {
      const n = readNote(u.searchParams.get('id') || ''), file = n ? audioPath(n) : null;
      let st = null;
      try { st = file ? fs.statSync(file) : null; } catch (e) { st = null; }
      if (!st) { json(404, { ok: false, error: 'No audio for that note.' }); return true; }
      res.writeHead(200, { 'Content-Type': AUDIO_TYPES[n.ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...cors });
      fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
      return true;
    }
    const withNote = (fn) => post((b) => {
      const n = readNote(typeof b.id === 'string' ? b.id : '');
      if (!n) return r(404, { ok: false, error: 'No such note.' });
      return fn(n, b);
    });
    if (p === '/api/femto/note/transcript' && req.method === 'POST') return withNote((n, b) => {
      if (['queued', 'transcribing'].includes(n.status) && !n.transcript) return r(409, { ok: false, error: 'It is still being transcribed.' });
      if (typeof b.text !== 'string') return r(400, { ok: false, error: 'Missing text.' });
      n.transcript = cleanText(b.text, MAX_TRANSCRIPT); n.transcriptEditedBy = m.id; n.transcriptEditedAt = now(); n.actionsStale = true;
      return r(200, { ok: true, note: fullOf(saveNote(n)) });
    });
    if (p === '/api/femto/note/actions' && req.method === 'POST') return withNote((n, b) => {
      if (!Array.isArray(b.actions) || b.actions.length > MAX_ACTIONS) return r(400, { ok: false, error: `Up to ${MAX_ACTIONS} action items.` });
      n.actions = b.actions.map((a) => normalizeAction(a, randomBytes)).filter(Boolean);
      return r(200, { ok: true, note: fullOf(saveNote(n)) });
    });
    if (p === '/api/femto/note/regenerate' && req.method === 'POST') return withNote((n) => {
      if (BUSY.includes(n.status) && n.status !== 'waiting_model') return r(409, { ok: false, error: 'It is already being worked on.' });
      if (!n.transcript) return r(409, { ok: false, error: 'There is no transcript yet.' });
      n.status = 'queued'; n.statusNote = 'In the queue…'; n.error = null; saveNote(n); enqueue(n.id);
      return r(200, { ok: true, note: fullOf(n) });
    });
    if (p === '/api/femto/note/delete' && req.method === 'POST') return withNote((n) => {
      if (n.author !== m.id) return r(403, { ok: false, error: 'Only the person who attached it can delete it.' });
      if (['transcribing', 'extracting'].includes(n.status)) return r(409, { ok: false, error: 'Wait until it finishes, then delete it.' });
      try { fs.unlinkSync(audioPath(n)); } catch (e) { /* no audio */ }
      try { fs.unlinkSync(notePath(n.id)); } catch (e) { /* gone */ }
      const i = queue.indexOf(n.id); if (i >= 0) queue.splice(i, 1);
      return r(200, { ok: true });
    });

    req.resume();
    json(404, { ok: false, error: 'Not found' });
    return true;
  }

  // After a restart: anything that was mid-way starts again (a transcription from the top).
  function resume() { for (const n of allNotes()) if (BUSY.includes(n.status)) { if (n.status === 'transcribing') { n.status = 'queued'; saveNote(n); } enqueue(n.id); } }
  if (autoStart) resume();

  return {
    handle, admin, resume,
    idle: () => !busy && queue.length === 0,
    stop: () => { stopped = true; for (const t of timers) clearTimeout(t); timers.clear(); },
    _test: { sessions, readNote, allNotes, files },
  };
}

module.exports = {
  createFemto, hashPassword, verifyPassword, tempPassword, passwordProblem, stageOf, splitTranscript, parseModelJson, dedupeActions, normalizeAction,
  bridgeExtractor, pythonTranscriber, promptFor, confirmEmailText,
  SEED, SESSION_RE, SESSION_TTL_MS, CONFIRM_TTL_MS, MAX_AUDIO_BYTES, CHUNK_BYTES, MAX_AUDIO_SECONDS, PART_CHARS,
};
