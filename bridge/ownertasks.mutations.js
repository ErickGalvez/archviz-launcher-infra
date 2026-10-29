'use strict';
// Mutations for the owner's task list: bridge.mutation.js breaks ONE protection at a time in a copy of bridge/ and requires ownertasks.test.js to go red.
// [name, file, exact text to find, replacement]
module.exports = [
  // ── what a task may hold ──
  ['a task is made without a title', 'ownertasks.js', "if (!c.title) return { ok: false, error: 'A task needs a title.' };", ''],
  ['a link may be a plain http address', 'ownertasks.js', 'return /^https:\\/\\/[^\\s"\'<>]{1,300}$/.test(s)', 'return /^https?:\\/\\/[^\\s"\'<>]{1,300}$/.test(s)'],
  ['a link may leave by a protocol-relative address', 'ownertasks.js', '/^(?!\\/)(\\.\\.\\/|\\.\\/)?[\\w', '/^(\\.\\.\\/|\\.\\/)?[\\w'],
  ['any text is accepted as a link', 'ownertasks.js', "? s : ''; };", '? s : s; };'],
  ['a link that is not text is accepted', 'ownertasks.js', "if (typeof h !== 'string') return '';", ''],
  ['a task may hold any number of steps', 'ownertasks.js', '.slice(0, MAX_STEPS).map', '.slice(0, 100000).map'],
  ['the list has no size limit', 'ownertasks.js', 'if (db.tasks.length >= MAX_TASKS)', 'if (false)'],
  ['an oversize file is read', 'ownertasks.js', 'if (raw.length > MAX_FILE) return { tasks: [] };', ''],
  ['rows with an id that is not ours are kept', 'ownertasks.js', 'j.tasks.filter((t) => t && ID.test(String(t.id)))', 'j.tasks.filter((t) => t)'],
  ['an unknown owner-task priority is stored as it is', 'ownertasks.js', "if (has('priority') && PRIORITIES.includes(i.priority)) out.priority = i.priority;", "if (has('priority')) out.priority = i.priority;"],
  ['a request can set the id, origin, times or history', 'ownertasks.js', 'const out = { ...base };', 'const out = { ...base, ...i };'],

  // ── status, steps, history ──
  ['any status is accepted', 'ownertasks.js', "if (!STATUSES.includes(p.status)) return { ok: false, error: 'status must be todo, doing, blocked, done or snoozed.' };", ''],
  ['ticked steps that do not exist are kept', 'ownertasks.js', '.filter((n) => Number.isInteger(n) && n >= 0 && n < (t.steps || []).length)', '.filter(() => true)'],
  ['ticks of removed steps stay', 'ownertasks.js', "t.checked = (t.checked || []).filter((n) => n < (t.steps || []).length);", ''],
  ['finishing a task records no time', 'ownertasks.js', "t.doneAt = now(); note(t, 'done');", "note(t, 'done');"],
  ['a reopened task keeps its finish time', 'ownertasks.js', "t.doneAt = null; note(t, was === 'done'", "note(t, was === 'done'"],
  ['the history grows without limit', 'ownertasks.js', '.slice(-MAX_HISTORY)', ''],
  ['the note is not clipped', 'ownertasks.js', 't.note = clip(p.note, 2000);', 't.note = String(p.note);'],

  // ── snooze and repeat ──
  ['a task can be snoozed for years', 'ownertasks.js', 'Math.min(Math.max(parseInt(p.snoozeDays, 10) || 1, 1), 90)', 'Math.max(parseInt(p.snoozeDays, 10) || 1, 1)'],
  ['a snoozed task never comes back', 'ownertasks.js', 't.snoozeUntil && t.snoozeUntil <= now()', 'false'],
  ['a repeating task stays done', 'ownertasks.js', 'if (t.repeat) { t.status = \'snoozed\';', 'if (false) { t.status = \'snoozed\';'],
  ['a repeating task keeps its ticked steps', 'ownertasks.js', 't.checked = []; t.startedAt = null;', 't.startedAt = null;'],

  // ── the file, and who may reach it ──
  ['the list is written in place instead of through a temp file', 'ownertasks.js', "const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: db.tasks }, null, 1)); fs.renameSync(tmp, file);", 'fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: db.tasks }, null, 1));'],
  ['the task routes need no key', 'index.js', "!p.startsWith('/api/archive/') && !p.startsWith('/api/owner/')) return false;\n    if (!isAuthed(req)) {", "!p.startsWith('/api/archive/') && !p.startsWith('/api/owner/')) return false;\n    if (false) {"],
  ['a store error leaves the request hanging', 'index.js', "log('owner tasks: ' + e.message); json(res, 500, { ok: false, error: 'The task store could not be read or written.' });", "log('owner tasks: ' + e.message);"],
  ['a task that does not exist is a 400, not a 404', 'index.js', "/no such/i.test(r.error || '') ? 404 : 400, r); } catch (e) { log('owner tasks: '", "/no such/i.test(r.error || '') ? 400 : 400, r); } catch (e) { log('owner tasks: '"],
];
module.exports.TESTS = ['ownertasks.test.js'];
