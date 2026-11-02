'use strict';
// The owner's own to-do list: the things only the owner can do (decide, approve, press a button on a machine, talk to a person), each with the exact steps.
// Not Task-IO (that records what the roles did): this is a backlog with a priority, a due date, steps to tick off and a history of when it was started and finished.
//
// Stored in owner-tasks.json beside launcher-server.js (gitignored: these are private to-dos, so they never go to the public website repo). The file is read again on
// every request and written whole through a temp file, so editing it by hand or restoring a copy needs no restart. Every route sits behind the Dev Console key (index.js).
const fs = require('fs');
const path = require('path');

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
const STATUSES = ['todo', 'doing', 'blocked', 'done', 'snoozed'];
const AREAS = ['launch', 'infra', 'agents', 'qa', 'sales', 'legal', 'security', 'content', 'money', 'build'];
const ORIGINS = ['roadmap', 'owner', 'state', 'recommended'];
const REPEATS = { daily: 1, weekly: 7, monthly: 30 };
const MAX_TASKS = 300, MAX_STEPS = 40, MAX_HISTORY = 30, MAX_FILE = 2 * 1024 * 1024, DAY = 86400000, MAX_IMPORT = 100;
const ID = /^OT-[A-Z0-9]{1,10}$/, DATE = /^\d{4}-\d{2}-\d{2}$/;

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, n);
const lines = (a, n, m) => (Array.isArray(a) ? a : []).map((x) => clip(x, m)).filter(Boolean).slice(0, n);
// A link may only be an https address or a page of this site (a relative .html/#anchor path): nothing that runs code.
const safeHref = (h) => { if (typeof h !== 'string') return ''; const s = h.trim(); return /^https:\/\/[^\s"'<>]{1,300}$/.test(s) || /^(?!\/)(\.\.\/|\.\/)?[\w\-./]{1,120}(\?[\w\-=&%.]{0,100})?(#[\w\-=&%./]{0,100})?$/.test(s) && !/^(javascript|data|vbscript):/i.test(s) ? s : ''; };

function cleanSteps(a) {
  return (Array.isArray(a) ? a : []).slice(0, MAX_STEPS).map((s) => (typeof s === 'string' ? { t: clip(s, 500) } : { t: clip(s && s.t, 500), code: clip(s && s.code, 700) || undefined, note: clip(s && s.note, 300) || undefined })).filter((s) => s.t);
}
function cleanLinks(a) { return (Array.isArray(a) ? a : []).slice(0, 8).map((l) => ({ label: clip(l && l.label, 60), href: safeHref(l && l.href) })).filter((l) => l.label && l.href); }

// The fields a person writes: the same for a task made in the page and for the ones that were seeded.
function cleanContent(i, base = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(i, k);
  const out = { ...base };
  if (has('title')) out.title = clip(i.title, 140);
  if (has('priority') && PRIORITIES.includes(i.priority)) out.priority = i.priority;
  if (has('area') && AREAS.includes(i.area)) out.area = i.area;
  if (has('due')) out.due = DATE.test(String(i.due || '')) ? String(i.due) : null;
  if (has('est')) out.est = clip(i.est, 24);
  if (has('why')) out.why = clip(i.why, 1400);
  if (has('before')) out.before = lines(i.before, 10, 220);
  if (has('steps')) out.steps = cleanSteps(i.steps);
  if (has('done')) out.done = clip(i.done, 420);
  if (has('links')) out.links = cleanLinks(i.links);
  if (has('repeat')) out.repeat = REPEATS[i.repeat] ? i.repeat : null;
  if (has('tags')) out.tags = lines(i.tags, 6, 20);
  if (has('blockedBy')) out.blockedBy = (Array.isArray(i.blockedBy) ? i.blockedBy : []).filter((x) => ID.test(String(x))).slice(0, 5);
  return out;
}

// A time from a backup: a real epoch-milliseconds number between 2020 and 2100, or nothing.
const stamp = (x) => (Number.isFinite(x) && x > 1577836800000 && x < 4102444800000 ? Math.round(x) : null);
const IMPORT_BASE = { priority: 'P2', area: 'launch', due: null, est: '', why: '', before: [], steps: [], done: '', links: [], repeat: null, tags: [], blockedBy: [] };

function createOwnerTasks({ dir, now = Date.now, log = () => {} }) {
  const file = path.join(dir, 'owner-tasks.json');
  function load() {
    let raw; try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return { tasks: [] }; }
    if (raw.length > MAX_FILE) return { tasks: [] };
    try { const j = JSON.parse(raw); return { tasks: Array.isArray(j.tasks) ? j.tasks.filter((t) => t && ID.test(String(t.id))) : [] }; } catch (e) { return { tasks: [] }; }
  }
  function save(db) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: db.tasks }, null, 1)); fs.renameSync(tmp, file); }
  const note = (t, what) => { t.history = [...(t.history || []), { at: now(), what: clip(what, 160) }].slice(-MAX_HISTORY); };

  // A snoozed task comes back by itself once its time is up.
  function wake(db) { let changed = false; for (const t of db.tasks) if (t.status === 'snoozed' && t.snoozeUntil && t.snoozeUntil <= now()) { t.status = 'todo'; t.snoozeUntil = null; note(t, 'back from snooze'); changed = true; } if (changed) save(db); }
  function list() { const db = load(); wake(db); return { ok: true, now: now(), tasks: db.tasks }; }

  function create(input) {
    const i = input && typeof input === 'object' ? input : {}, db = load();
    if (db.tasks.length >= MAX_TASKS) return { ok: false, error: 'There are already ' + MAX_TASKS + ' tasks: delete some first.' };
    const c = cleanContent(i, { priority: 'P2', area: 'launch', origin: 'owner', due: null, est: '', why: '', before: [], steps: [], done: '', links: [], repeat: null, tags: [], blockedBy: [] });
    if (!c.title) return { ok: false, error: 'A task needs a title.' };
    let n = db.tasks.length + 1; while (db.tasks.some((t) => t.id === 'OT-C' + n)) n++;
    const t = { ...c, origin: 'owner', id: 'OT-C' + n, status: 'todo', checked: [], note: '', snoozeUntil: null, createdAt: now(), updatedAt: now(), startedAt: null, doneAt: null, history: [] };
    note(t, 'created'); db.tasks.push(t); save(db); return { ok: true, task: t };
  }

  // patch: the content fields above, plus status, checked (the steps ticked off), note, snoozeDays.
  function update(id, patch) {
    const p = patch && typeof patch === 'object' ? patch : {}, db = load(), t = db.tasks.find((x) => x.id === id);
    if (!t) return { ok: false, error: 'No such task.' };
    Object.assign(t, cleanContent(p, t));
    if (Object.prototype.hasOwnProperty.call(p, 'checked')) t.checked = [...new Set((Array.isArray(p.checked) ? p.checked : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < (t.steps || []).length))].sort((a, b) => a - b);
    if (Object.prototype.hasOwnProperty.call(p, 'note')) t.note = clip(p.note, 2000);
    t.checked = (t.checked || []).filter((n) => n < (t.steps || []).length);
    if (Object.prototype.hasOwnProperty.call(p, 'status')) {
      if (!STATUSES.includes(p.status)) return { ok: false, error: 'status must be todo, doing, blocked, done or snoozed.' };
      const was = t.status; t.status = p.status;
      if (p.status === 'snoozed') { const days = Math.min(Math.max(parseInt(p.snoozeDays, 10) || 1, 1), 90); t.snoozeUntil = now() + days * DAY; note(t, 'snoozed ' + days + ' day' + (days === 1 ? '' : 's')); }
      else if (p.status !== was) {
        t.snoozeUntil = null;
        if (p.status === 'doing') { t.startedAt = t.startedAt || now(); note(t, 'started'); }
        else if (p.status === 'done') {
          t.doneAt = now(); note(t, 'done');
          if (t.repeat) { t.status = 'snoozed'; t.snoozeUntil = now() + REPEATS[t.repeat] * DAY; t.checked = []; t.startedAt = null; note(t, 'repeats ' + t.repeat + ': back in ' + REPEATS[t.repeat] + ' day' + (REPEATS[t.repeat] === 1 ? '' : 's')); }
        } else if (p.status === 'todo') { t.doneAt = null; note(t, was === 'done' ? 'reopened' : 'back to to-do'); }
        else note(t, p.status);
      }
    }
    t.updatedAt = now(); save(db); return { ok: true, task: t };
  }

  // Adds tasks from a prepared list or from the page's Backup file. A task whose id is already in the list is left exactly as it is (your progress, notes and
  // edits win), so importing the same file twice changes nothing; a new id is added. The content goes through the same cleaning as a task made in the page;
  // from a backup the progress comes back too (status, ticked steps, note, times, history), each piece checked. At most MAX_IMPORT tasks per request (the page
  // sends a big file in batches) and never past MAX_TASKS.
  function importTasks(input) {
    if (!Array.isArray(input)) return { ok: false, error: 'tasks must be a list.' };
    if (input.length > MAX_IMPORT) return { ok: false, error: 'At most ' + MAX_IMPORT + ' tasks per import: send the rest in another batch.' };
    const db = load(), have = new Set(db.tasks.map((t) => t.id)), added = [], skipped = [], refused = [];
    for (const i of input) {
      const id = i && typeof i === 'object' ? String(i.id || '') : '';
      if (!ID.test(id)) { refused.push(clip(id, 20) || '(no id)'); continue; }
      if (have.has(id)) { skipped.push(id); continue; }
      if (db.tasks.length >= MAX_TASKS) { refused.push(id); continue; }
      const c = cleanContent(i, IMPORT_BASE);
      if (!c.title) { refused.push(id); continue; }
      const status = STATUSES.includes(i.status) ? i.status : 'todo', until = stamp(i.snoozeUntil);
      const t = { ...c, id, origin: ORIGINS.includes(i.origin) ? i.origin : 'owner', status: status === 'snoozed' && !until ? 'todo' : status,
        checked: [...new Set((Array.isArray(i.checked) ? i.checked : []).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n < c.steps.length))].sort((a, b) => a - b),
        note: clip(i.note, 2000), snoozeUntil: status === 'snoozed' ? until : null, createdAt: stamp(i.createdAt) || now(), updatedAt: now(), startedAt: stamp(i.startedAt), doneAt: stamp(i.doneAt),
        history: (Array.isArray(i.history) ? i.history : []).map((h) => ({ at: stamp(h && h.at), what: clip(h && h.what, 160) })).filter((h) => h.at && h.what) };      // note() below caps it
      note(t, 'imported'); db.tasks.push(t); have.add(id); added.push(id);
    }
    if (added.length) save(db);
    return { ok: true, added, skipped, refused };
  }

  function remove(id) { const db = load(), n = db.tasks.length; db.tasks = db.tasks.filter((t) => t.id !== id); if (db.tasks.length === n) return { ok: false, error: 'No such task.' }; save(db); return { ok: true }; }

  return { list, create, update, importTasks, remove, file };
}

module.exports = { createOwnerTasks, cleanContent, safeHref, PRIORITIES, STATUSES, AREAS, ORIGINS, REPEATS, MAX_IMPORT };
