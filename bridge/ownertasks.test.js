#!/usr/bin/env node
'use strict';
// Tests for the owner's own to-do list (bridge/ownertasks.js and its /api/owner/* routes): what a task may hold, how its status moves and is recorded, snoozing and
// repeating, hostile input (links that run code, markup, huge or corrupt data), and that every route needs the Dev Console key.
//   node bridge/ownertasks.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { createOwnerTasks, safeHref, MAX_IMPORT } = require('./ownertasks.js');
const bridge = require('./index.js');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-owner-tasks-'));
const DAY = 86400000;
const mk = (extra = {}) => { const dir = tmp(); let t = 1800000000000; const clock = { now: () => t, tick: (ms) => { t += ms; } }; return { dir, clock, store: createOwnerTasks({ dir, now: clock.now, ...extra }) }; };

(async () => {
  console.log('making and reading tasks');
  await test('a task needs a title; the rest gets sensible defaults, and the text is cleaned and clipped', () => {
    const { store, dir } = mk();
    assert.equal(store.create({}).ok, false); assert.equal(store.create({ title: '   ' }).ok, false); assert.equal(store.create(null).ok, false); assert.equal(store.create('x').ok, false);
    const r = store.create({ title: 'Buy a domain\u0000\u0007', priority: 'P0', why: 'w'.repeat(5000), steps: ['one', { t: 'two', code: 'echo hi', note: 'n' }, { t: '' }, 5, null], area: 'nonsense', repeat: 'hourly', due: '2026-13-99x' });
    assert.equal(r.ok, true); const t = r.task;
    assert.equal(t.title, 'Buy a domain'); assert.equal(t.priority, 'P0'); assert.equal(t.why.length, 1400); assert.equal(t.area, 'launch', 'an unknown area falls back'); assert.equal(t.repeat, null); assert.equal(t.due, null);
    assert.deepEqual(t.steps.map((s) => s.t), ['one', 'two']); assert.equal(t.steps[1].code, 'echo hi'); assert.equal(t.status, 'todo'); assert.deepEqual(t.checked, []); assert.match(t.id, /^OT-C\d+$/); assert.equal(t.origin, 'owner'); assert.equal(t.history[0].what, 'created');
    assert.equal(store.create({ title: 'x', priority: 'urgent' }).task.priority, 'P2', 'an unknown priority falls back');
    assert.ok(fs.existsSync(path.join(dir, 'owner-tasks.json')));
  });
  await test('tasks survive a restart, a hand edit of the file shows at once, and a missing, corrupt or oversize file gives an empty list instead of an error', () => {
    const { store, dir } = mk(); const a = store.create({ title: 'First' }).task;
    const again = createOwnerTasks({ dir }); assert.equal(again.list().tasks.length, 1);
    const f = path.join(dir, 'owner-tasks.json'), j = JSON.parse(fs.readFileSync(f, 'utf8')); j.tasks.push({ ...a, id: 'OT-HAND', title: 'Added by hand' }); fs.writeFileSync(f, JSON.stringify(j));
    assert.equal(store.list().tasks.length, 2, 'read again on every request');
    fs.writeFileSync(f, '{not json'); assert.deepEqual(store.list().tasks, []); fs.writeFileSync(f, JSON.stringify({ tasks: [{ id: 'OT-BIG', title: 'x'.repeat(3 * 1024 * 1024) }] })); assert.deepEqual(store.list().tasks, [], 'a file over 2 MB is not read'); fs.unlinkSync(f); assert.deepEqual(store.list().tasks, []);
    fs.writeFileSync(f, JSON.stringify({ tasks: [{ id: 'bad id' }, { id: '../x' }, null, 7, { id: 'OT-OK1', title: 'ok' }] })); assert.deepEqual(store.list().tasks.map((t) => t.id), ['OT-OK1'], 'rows with an id that is not ours are ignored');
  });
  await test('there is a limit on how many tasks, steps and links one list can hold', () => {
    const { store } = mk(); const r = store.create({ title: 'big', steps: Array.from({ length: 80 }, (_, i) => 'step ' + i), links: Array.from({ length: 30 }, (_, i) => ({ label: 'l' + i, href: 'https://example.com/' + i })), tags: Array.from({ length: 20 }, (_, i) => 't' + i), before: Array.from({ length: 30 }, (_, i) => 'b' + i) }).task;
    assert.equal(r.steps.length, 40); assert.equal(r.links.length, 8); assert.equal(r.tags.length, 6); assert.equal(r.before.length, 10);
    for (let i = 0; i < 400; i++) if (!store.create({ title: 't' + i }).ok) break; assert.equal(store.list().tasks.length, 300); assert.equal(store.create({ title: 'one more' }).ok, false);
  });

  console.log('status, history, snooze, repeat');
  await test('starting, finishing and reopening a task are recorded with the time; an unknown status is refused', () => {
    const { store, clock } = mk(); const id = store.create({ title: 'Do it', steps: ['a', 'b', 'c'] }).task.id;
    clock.tick(1000); let t = store.update(id, { status: 'doing' }).task; assert.equal(t.status, 'doing'); assert.equal(t.startedAt, 1800000001000);
    clock.tick(1000); t = store.update(id, { status: 'done' }).task; assert.equal(t.doneAt, 1800000002000); assert.deepEqual(t.history.map((h) => h.what), ['created', 'started', 'done']);
    t = store.update(id, { status: 'todo' }).task; assert.equal(t.doneAt, null); assert.equal(t.history.slice(-1)[0].what, 'reopened');
    assert.equal(store.update(id, { status: 'finished' }).ok, false); assert.equal(store.update(id, { status: '__proto__' }).ok, false); assert.equal(store.update('OT-NOPE', { status: 'done' }).ok, false);
    assert.equal(store.update(id, { status: 'doing' }).task.history.length, 5);
    for (let i = 0; i < 60; i++) { store.update(id, { status: i % 2 ? 'doing' : 'blocked' }); } assert.ok(store.list().tasks[0].history.length <= 30, 'the history is capped');
  });
  await test('ticking steps keeps only real step numbers; the note is kept and clipped; stale ticks go when steps are removed', () => {
    const { store } = mk(); const id = store.create({ title: 'Steps', steps: ['a', 'b', 'c'] }).task.id;
    let t = store.update(id, { checked: [2, 0, 0, 7, -1, 1.5, '1', 'x', null] }).task; assert.deepEqual(t.checked, [0, 1, 2]);
    t = store.update(id, { note: 'n'.repeat(5000) }).task; assert.equal(t.note.length, 2000);
    t = store.update(id, { steps: ['only one'] }).task; assert.deepEqual(t.checked, [0], 'step 1 and 2 no longer exist');
  });
  await test('a snoozed task is out of the way until its time is up, then comes back by itself', () => {
    const { store, clock } = mk(); const id = store.create({ title: 'Later' }).task.id;
    const t = store.update(id, { status: 'snoozed', snoozeDays: 3 }).task; assert.equal(t.snoozeUntil, clock.now() + 3 * DAY);
    clock.tick(2 * DAY); assert.equal(store.list().tasks[0].status, 'snoozed'); clock.tick(1.1 * DAY); const back = store.list().tasks[0]; assert.equal(back.status, 'todo'); assert.equal(back.snoozeUntil, null); assert.equal(back.history.slice(-1)[0].what, 'back from snooze');
    assert.equal(store.update(id, { status: 'snoozed', snoozeDays: 9999 }).task.snoozeUntil, clock.now() + 90 * DAY, 'at most 90 days'); assert.equal(store.update(id, { status: 'snoozed', snoozeDays: -5 }).task.snoozeUntil, clock.now() + DAY);
  });
  await test('a repeating task that is finished goes quiet for its period, with its steps unticked, and then comes back', () => {
    const { store, clock } = mk(); const id = store.create({ title: 'Weekly review', repeat: 'weekly', steps: ['a', 'b'] }).task.id;
    store.update(id, { checked: [0, 1], status: 'doing' }); const t = store.update(id, { status: 'done' }).task;
    assert.equal(t.status, 'snoozed'); assert.deepEqual(t.checked, []); assert.equal(t.snoozeUntil, clock.now() + 7 * DAY); assert.ok(t.doneAt, 'the finish is still recorded'); assert.ok(t.history.some((h) => /repeats weekly/.test(h.what)));
    clock.tick(7 * DAY + 1000); assert.equal(store.list().tasks[0].status, 'todo');
    const once = store.create({ title: 'One time' }).task.id; assert.equal(store.update(once, { status: 'done' }).task.status, 'done', 'a task that does not repeat stays done');
  });
  await test('deleting a task removes it, and only it', () => {
    const { store } = mk(); const a = store.create({ title: 'a' }).task.id, b = store.create({ title: 'b' }).task.id;
    assert.equal(store.remove(a).ok, true); assert.deepEqual(store.list().tasks.map((t) => t.id), [b]); assert.equal(store.remove(a).ok, false); assert.equal(store.remove('../../x').ok, false);
  });

  console.log('importing a prepared list or a backup');
  await test('an import adds the new ids and leaves a task that is already there exactly as it is, so the same file twice changes nothing', () => {
    const { store, clock } = mk(); const mine = store.create({ title: 'Mine', steps: ['a', 'b'] }).task;
    store.update(mine.id, { status: 'doing', checked: [1], note: 'half way' }); clock.tick(1000);
    const r = store.importTasks([{ id: 'OT-A01', title: 'Back up PC-1', priority: 'P0', origin: 'recommended', steps: [{ t: 'Copy', code: 'robocopy a b' }], done: 'a dated folder exists', repeat: 'weekly' },
      { id: mine.id, title: 'Overwritten?', priority: 'P3', steps: [] }, { id: 'OT-A02', title: 'Second', area: 'sales' }]);
    assert.equal(r.ok, true); assert.deepEqual(r.added, ['OT-A01', 'OT-A02']); assert.deepEqual(r.skipped, [mine.id]); assert.deepEqual(r.refused, []);
    const all = store.list().tasks, kept = all.find((t) => t.id === mine.id), a = all.find((t) => t.id === 'OT-A01');
    assert.equal(kept.title, 'Mine'); assert.equal(kept.status, 'doing'); assert.deepEqual(kept.checked, [1]); assert.equal(kept.note, 'half way'); assert.equal(kept.steps.length, 2);
    assert.equal(a.priority, 'P0'); assert.equal(a.origin, 'recommended'); assert.equal(a.status, 'todo'); assert.equal(a.repeat, 'weekly'); assert.equal(a.steps[0].code, 'robocopy a b'); assert.equal(a.done, 'a dated folder exists'); assert.equal(a.history.slice(-1)[0].what, 'imported');
    const again = store.importTasks([{ id: 'OT-A01', title: 'Back up PC-1' }, { id: 'OT-A02', title: 'Second' }]); assert.deepEqual(again.added, []); assert.deepEqual(again.skipped, ['OT-A01', 'OT-A02']); assert.equal(store.list().tasks.length, 3);
  });
  await test('an imported task is cleaned like one made in the page: no foreign ids, no links that run code, no unknown priority, origin or status', () => {
    const { store } = mk();
    const r = store.importTasks([{ id: '../x', title: 'bad id' }, { id: 'ot-lower', title: 'bad id' }, { title: 'no id' }, null, 7, { id: 'OT-NOTITLE', title: '  ' },
      { id: 'OT-H1', title: '<b>x</b>', priority: 'urgent', origin: 'hacker', status: 'finished', links: [{ label: 'ok', href: 'https://example.com' }, { label: 'bad', href: 'javascript:alert(1)' }], steps: Array.from({ length: 90 }, (_, i) => 's' + i), why: 'w'.repeat(5000) },
      { id: 'OT-H1', title: 'the same id again' }]);
    assert.deepEqual(r.added, ['OT-H1']); assert.deepEqual(r.skipped, ['OT-H1'], 'a second copy of an id in the same file is skipped'); assert.equal(r.refused.length, 6);
    const t = store.list().tasks[0]; assert.equal(t.title, '<b>x</b>'); assert.equal(t.priority, 'P2'); assert.equal(t.origin, 'owner'); assert.equal(t.status, 'todo'); assert.deepEqual(t.links.map((l) => l.label), ['ok']); assert.equal(t.steps.length, 40); assert.equal(t.why.length, 1400);
    assert.equal(store.importTasks('x').ok, false); assert.equal(store.importTasks({ tasks: [] }).ok, false); assert.equal(store.importTasks(null).ok, false);
  });
  await test('a backup brings its progress back, each piece checked: status, ticked steps, note, times and a capped history', () => {
    const { store, clock } = mk(), T = 1790000000000;
    store.importTasks([{ id: 'OT-B1', title: 'from a backup', steps: ['a', 'b', 'c'], status: 'doing', checked: [2, 0, 9, -1, 'x', 0], note: 'n'.repeat(3000), createdAt: T, startedAt: T + 1000, doneAt: 'yesterday',
      history: [...Array.from({ length: 50 }, (_, k) => ({ at: T + k, what: 'step ' + k })), { at: 'soon', what: 'bad time' }, { at: T, what: '' }, null] },
      { id: 'OT-B2', title: 'snoozed', status: 'snoozed', snoozeUntil: clock.now() + 3 * DAY }, { id: 'OT-B3', title: 'snoozed without a time', status: 'snoozed' }, { id: 'OT-B4', title: 'times from nowhere', createdAt: -5, startedAt: 1e20 }]);
    const [b1, b2, b3, b4] = ['OT-B1', 'OT-B2', 'OT-B3', 'OT-B4'].map((id) => store.list().tasks.find((t) => t.id === id));
    assert.equal(b1.status, 'doing'); assert.deepEqual(b1.checked, [0, 2]); assert.equal(b1.note.length, 2000); assert.equal(b1.createdAt, T); assert.equal(b1.startedAt, T + 1000); assert.equal(b1.doneAt, null);
    assert.ok(b1.history.length <= 30, 'the history is capped'); assert.ok(b1.history.every((h) => Number.isFinite(h.at) && h.what), 'no history line without a real time and text'); assert.equal(b1.history.slice(-1)[0].what, 'imported');
    assert.equal(b2.status, 'snoozed'); assert.equal(b2.snoozeUntil, clock.now() + 3 * DAY); assert.equal(b3.status, 'todo', 'a snooze with no end comes back as to-do'); assert.equal(b3.snoozeUntil, null);
    assert.equal(b4.createdAt, clock.now(), 'a time that cannot be real is replaced'); assert.equal(b4.startedAt, null);
  });
  await test('an import stops at the size of the list, and takes at most ' + MAX_IMPORT + ' tasks at a time', () => {
    const { store } = mk();
    assert.equal(store.importTasks(Array.from({ length: MAX_IMPORT + 1 }, (_, i) => ({ id: 'OT-X' + i, title: 't' + i }))).ok, false, 'one batch too many is refused whole'); assert.equal(store.list().tasks.length, 0);
    for (let b = 0; b < 4; b++) store.importTasks(Array.from({ length: MAX_IMPORT }, (_, i) => ({ id: 'OT-X' + (b * MAX_IMPORT + i), title: 't' }))); assert.equal(store.list().tasks.length, 300);
    const r = store.importTasks([{ id: 'OT-LAST', title: 'one more' }]); assert.deepEqual(r.added, []); assert.deepEqual(r.refused, ['OT-LAST']);
  });

  console.log('hostile input');
  await test('a link may only be an https address or a page of this site: nothing that runs code or leaves by a protocol-relative address', () => {
    for (const ok of ['https://example.com/a?b=c', '../qa/qa-dashboard.html#fixqueue', 'archive.html', './team.html?report=rep_1']) assert.equal(safeHref(ok), ok, ok);
    for (const bad of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<script>x</script>', 'vbscript:x', 'http://example.com', '//evil.example/x', '/etc/passwd', '\\\\evil\\share', 'https://exa mple.com', 'https://x.com/"onmouseover=', '', null, undefined, 5, {}]) assert.equal(safeHref(bad), '', String(bad));
    const { store } = mk(); const t = store.create({ title: 'links', links: [{ label: 'good', href: 'https://example.com' }, { label: 'bad', href: 'javascript:alert(1)' }, { label: '', href: 'https://x.example' }, 'string', null] }).task; assert.deepEqual(t.links, [{ label: 'good', href: 'https://example.com' }]);
  });
  await test('markup in a task is stored as plain text for the page to escape, and prototype keys change nothing', () => {
    const { store } = mk(); const t = store.create({ title: '<img src=x onerror=alert(1)>', why: '<script>alert(1)</script>', __proto__: { polluted: true }, constructor: { x: 1 } }).task;
    assert.equal(t.title, '<img src=x onerror=alert(1)>'); assert.equal(({}).polluted, undefined); assert.equal(Object.prototype.hasOwnProperty.call(t, 'polluted'), false);
    assert.equal(store.update(t.id, JSON.parse('{"__proto__":{"polluted":true},"priority":"P1"}')).task.priority, 'P1'); assert.equal(({}).polluted, undefined);
    const u = store.update(t.id, { origin: 'roadmap', id: 'OT-HIJACK', createdAt: 1, history: [{ what: 'forged' }] }).task; assert.equal(u.origin, 'owner'); assert.equal(u.id, t.id); assert.notEqual(u.createdAt, 1); assert.ok(!u.history.some((h) => h.what === 'forged'), 'origin, id, times and history cannot be set from a request');
  });
  await test('a failed write leaves the earlier list intact (the file is written through a temp file and renamed)', () => {
    const { store, dir } = mk(); store.create({ title: 'keep me' }); const f = path.join(dir, 'owner-tasks.json'), before = fs.readFileSync(f, 'utf8');
    const src = fs.readFileSync(path.join(__dirname, 'ownertasks.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); assert.ok(/renameSync\(tmp, file\)/.test(src) && /writeFileSync\(tmp/.test(src), 'temp file then rename');
    fs.mkdirSync(f + '.tmp'); assert.throws(() => store.create({ title: 'cannot be written' })); assert.equal(fs.readFileSync(f, 'utf8'), before); fs.rmdirSync(f + '.tmp');
  });

  console.log('the routes');
  const dir = tmp(); fs.mkdirSync(path.join(dir, 'bridge')); fs.writeFileSync(path.join(dir, 'bridge', 'bridge.key'), 'f'.repeat(64)); process.env.G741_BRIDGE_KEY_FILE = path.join(dir, 'bridge', 'bridge.key');
  const API = bridge.init({ dir, isAuthed: (req) => req.headers['x-devconsole-key'] === 'k', cors: {}, getProspects: () => [], getBugs: () => [], getRenderState: () => 'stopped', hubOptions: { targets: [], pollMs: 100 }, autoStart: false });
  const srv = http.createServer((req, res) => { if (!API.handle(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const api = async (m, p, b, key = 'k') => { const r = await fetch(base + p, { method: m, headers: { 'x-devconsole-key': key, ...(b !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: b !== undefined ? (typeof b === 'string' ? b : JSON.stringify(b)) : undefined, signal: AbortSignal.timeout(5000) }); return { status: r.status, json: await r.json().catch(() => null) }; };
  await test('every route is closed without the Dev Console key, and to a wrong one', async () => {
    for (const [m, p] of [['GET', '/api/owner/tasks'], ['POST', '/api/owner/tasks/create'], ['POST', '/api/owner/tasks/update'], ['POST', '/api/owner/tasks/delete'], ['POST', '/api/owner/tasks/import']]) for (const key of ['wrong', '']) assert.equal((await api(m, p, m === 'POST' ? {} : undefined, key)).status, 401, m + ' ' + p);
    assert.equal(fs.existsSync(path.join(dir, 'owner-tasks.json')), false, 'nothing was written by the refused calls');
  });
  await test('make, change, list and delete a task through the routes; the list carries the steps and the history', async () => {
    const c = await api('POST', '/api/owner/tasks/create', { title: 'Via the API', priority: 'P1', steps: ['a', 'b'] }); assert.equal(c.status, 200); const id = c.json.task.id;
    const u = await api('POST', '/api/owner/tasks/update', { id, patch: { status: 'doing', checked: [0] } }); assert.equal(u.status, 200); assert.equal(u.json.task.status, 'doing');
    const l = (await api('GET', '/api/owner/tasks')).json; assert.equal(l.ok, true); assert.ok(Number.isFinite(l.now)); const t = l.tasks.find((x) => x.id === id); assert.deepEqual(t.checked, [0]); assert.ok(t.history.length >= 2);
    assert.equal((await api('POST', '/api/owner/tasks/update', { id: 'OT-NOPE', patch: { status: 'done' } })).status, 404); assert.equal((await api('POST', '/api/owner/tasks/update', { id, patch: { status: 'weird' } })).status, 400); assert.equal((await api('POST', '/api/owner/tasks/create', { title: '' })).status, 400);
    assert.equal((await api('POST', '/api/owner/tasks/delete', { id })).status, 200); assert.equal((await api('POST', '/api/owner/tasks/delete', { id })).status, 404);
  });
  await test('a prepared list goes in through the import route, again changes nothing, and a body that is not a list is a 400', async () => {
    const r = await api('POST', '/api/owner/tasks/import', { tasks: [{ id: 'OT-R1', title: 'Via import', priority: 'P0', steps: ['one'] }, { id: 'OT-R2', title: 'Two' }] }); assert.equal(r.status, 200); assert.deepEqual(r.json.added, ['OT-R1', 'OT-R2']);
    const again = await api('POST', '/api/owner/tasks/import', { tasks: [{ id: 'OT-R1', title: 'changed?' }] }); assert.equal(again.status, 200); assert.deepEqual(again.json.skipped, ['OT-R1']);
    assert.equal((await api('GET', '/api/owner/tasks')).json.tasks.find((t) => t.id === 'OT-R1').title, 'Via import');
    assert.equal((await api('POST', '/api/owner/tasks/import', { tasks: 'x' })).status, 400); assert.equal((await api('POST', '/api/owner/tasks/import', {})).status, 400);
    for (const id of ['OT-R1', 'OT-R2']) await api('POST', '/api/owner/tasks/delete', { id });
  });
  await test('hostile bodies never crash a route, leave it hanging, or reach another file; an unknown owner route is a 404', async () => {
    for (const p of ['/api/owner/tasks/create', '/api/owner/tasks/update', '/api/owner/tasks/delete', '/api/owner/tasks/import']) for (const b of ['{', 'null', '[]', '"x"', '{"id":["a"],"patch":"x"}', '{"id":"../../x","patch":{"status":"done"}}', '{"title":{"a":1}}', '{"__proto__":{"polluted":true},"title":"p"}']) { const r = await api('POST', p, b); assert.ok(r.status < 500, p + ' ' + b + ' -> ' + r.status); }
    assert.equal(({}).polluted, undefined); assert.equal((await api('GET', '/api/owner/nope')).status, 404); assert.equal((await api('DELETE', '/api/owner/tasks')).status, 404);
    const big = await fetch(base + '/api/owner/tasks/create', { method: 'POST', headers: { 'x-devconsole-key': 'k', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'x'.repeat(200000) }), signal: AbortSignal.timeout(5000) }).then((r) => r.status).catch(() => 'closed'); assert.ok(big === 400 || big === 413 || big === 'closed', 'an oversize body is refused: ' + big);
  });

  await test('a store that cannot be written answers 500 at once (it does not hang), and reading still works', async () => {
    const blocker = path.join(dir, 'owner-tasks.json.tmp'); fs.mkdirSync(blocker);
    const r = await api('POST', '/api/owner/tasks/create', { title: 'cannot be saved' }); assert.equal(r.status, 500); assert.match(r.json.error, /could not be read or written/); assert.equal((await api('GET', '/api/owner/tasks')).status, 200);
    fs.rmdirSync(blocker); assert.equal((await api('POST', '/api/owner/tasks/create', { title: 'saved now' })).status, 200);
  });

  API.stop(); await new Promise((r) => srv.close(r));
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
