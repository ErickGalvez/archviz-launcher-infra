#!/usr/bin/env node
'use strict';
// Self-test for reports (bridge/reports.js): a set of tickets filed together, and the stamp that moves them.
//   node bridge/reports.test.js
const assert = require('assert');
const T = require('./tickets');
const R = require('./reports');

const results = [];
const test = (name, fn) => { try { fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };
const NOW = Date.parse('2026-10-26T12:00:00Z');
const FIX = { repo: 'website', commit: 'abcdef1234', files: ['archviz/app.js'], rootCause: 'The handler was never attached.', solution: 'Attach it on pointerdown.', by: 'Dex' };
const mkTickets = () => ['a', 'b', 'c', 'd', 'e'].map((k, i) => T.create({ title: 'Ticket ' + k, area: i < 3 ? 'dev' : 'copy', type: 'bug' }, { now: NOW, id: 'bug_00000000000' + k }));
const byId = (list) => new Map(list.map((b) => [b.id, b]));
const ids = (list) => list.map((b) => b.id);
const mk = (list, over) => R.create({ title: 'Test run V1.1 - Oct 25, 2026', kind: 'test-run', run: 'V1.1', summary: 'Findings from the run.', ticketIds: ids(list), by: 'Owner', ...over }, { now: NOW, id: 'rep_000000000001' });
const throwsMsg = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('should have thrown ' + re); };

// ── the report itself ──
test('a report needs a title; kind and stamp fall back; ids are trimmed, unique and capped', () => {
  throwsMsg(() => R.create({ title: '   ' }), /title is required/);
  const r = R.create({ title: 'T', kind: 'wish', stamp: 'closed', ticketIds: ['a', 'a', ' b ', '', null, 'c'] }, { now: NOW });
  assert.equal(r.kind, 'other'); assert.equal(r.stamp, 'new', 'a new report always starts "new", whatever the request says'); assert.deepEqual(r.ticketIds, ['a', 'b', 'c']);
  const big = R.create({ title: 'T', ticketIds: Array.from({ length: 500 }, (_, i) => 'bug_' + i) }, { now: NOW });
  assert.equal(big.ticketIds.length, 300);
  assert.match(r.id, /^rep_[0-9a-f]{12}$/);
});
test('editing: text and tickets change, unknown fields and the stamp do not', () => {
  const list = mkTickets(), r = mk(list);
  const ch = R.patch(r, { title: 'Renamed', summary: 'New summary', kind: 'audit', stamp: 'closed', id: 'rep_hacked', ticketIds: ['x'] }, { now: NOW });
  assert.deepEqual(ch.sort(), ['kind', 'summary', 'title']); assert.equal(r.stamp, 'new'); assert.equal(r.id, 'rep_000000000001'); assert.equal(r.ticketIds.length, 5);
  R.patch(r, { title: '   ' }, { now: NOW }); assert.equal(r.title, 'Renamed', 'the title cannot be emptied');
  R.patch(r, { add: ['bug_zzz', 'bug_00000000000a'], remove: ['bug_00000000000b'] }, { now: NOW });
  assert.ok(r.ticketIds.includes('bug_zzz') && !r.ticketIds.includes('bug_00000000000b')); assert.equal(r.ticketIds.filter((x) => x === 'bug_00000000000a').length, 1, 'adding one that is there changes nothing');
});
test('progress counts the tickets as they are now: queue states, areas, resolved, and tickets that were deleted', () => {
  const list = mkTickets(), r = mk(list, { ticketIds: [...ids(list), 'bug_gone'] });
  T.addFix(list[0], FIX, { now: NOW }); T.patch(list[1], { status: 'wontfix' }, { now: NOW });
  const p = R.progress(r, byId(list), T);
  assert.equal(p.total, 5); assert.equal(p.missing, 1); assert.equal(p.resolved, 2); assert.equal(p.unresolved, 3); assert.equal(p.verified, 0);
  assert.equal(p.byQueue.awaiting, 1); assert.equal(p.byQueue.closed, 1); assert.equal(p.byQueue.open, 3);
  assert.deepEqual(p.byArea.dev, { total: 3, resolved: 2 }); assert.deepEqual(p.byArea.copy, { total: 2, resolved: 0 }); assert.equal(p.readyToClose, false);
  list.forEach((b) => { if (b.status !== 'fixed' && b.status !== 'wontfix') T.patch(b, { status: 'wontfix' }, { now: NOW }); });
  assert.equal(R.progress(r, byId(list), T).readyToClose, true, 'ready to close once nothing is left unresolved');
  assert.equal(R.progress(R.create({ title: 'Empty' }), new Map(), T).readyToClose, false, 'an empty report is never "ready"');
});
test('the list entry carries no tickets; the detail carries them with their fix notes (the keyed view)', () => {
  const list = mkTickets(), r = mk(list); T.addFix(list[0], { ...FIX, snippet: { file: 'archviz/app.js', after: 'el.onpointerdown = start;' } }, { now: NOW });
  const s = R.summary(r, byId(list), T); assert.equal(s.ticketCount, 5); assert.equal(s.tickets, undefined); assert.equal(s.ticketIds, undefined);
  const d = R.detail(r, byId(list), T), row = d.tickets.find((x) => x.id === list[0].id);
  assert.equal(d.tickets.length, 5); assert.equal(row.queue, 'awaiting'); assert.equal(row.fix.commitUrl, 'https://github.com/ErickGalvez/ARCHVIZ/commit/abcdef1234');
  assert.equal(row.fix.rootCause, 'The handler was never attached.'); assert.equal(row.fix.snippet.after, 'el.onpointerdown = start;'); assert.equal(row.fix.by, 'Dex');
  assert.equal(d.tickets.find((x) => x.id === list[1].id).fix, null);
});

// ── the stamp ──
test('"working" puts every open ticket in progress and leaves the others alone', () => {
  const list = mkTickets(), r = mk(list); T.addFix(list[0], FIX, { now: NOW }); T.patch(list[1], { status: 'wontfix' }, { now: NOW });
  const out = R.stamp(r, 'working', { tickets: list, Tk: T, by: 'Erick', note: 'starting', now: NOW });
  assert.equal(out.ok, true); assert.equal(out.moved.inProgress.length, 3);
  assert.deepEqual(list.map((b) => b.status), ['fixed', 'wontfix', 'in_progress', 'in_progress', 'in_progress']);
  assert.equal(r.stamp, 'working'); assert.equal(r.stampedBy, 'Erick'); assert.equal(r.stampNote, 'starting');
  const line = list[2].comments.filter((c) => c.kind === 'activity').pop();
  assert.match(line.text, /Status: Open -> In Progress/); assert.match(line.text, /Test run V1\.1/); assert.match(line.text, /stamped Working/); assert.equal(line.by, 'Erick');
  assert.equal(r.history.length, 1); assert.equal(r.history[0].from, 'new'); assert.equal(r.history[0].to, 'working'); assert.equal(r.history[0].moved.inProgress, 3);
});
test('"closed" marks what is still open or in progress as fixed, and says which of those have no fix note behind them', () => {
  const list = mkTickets(), r = mk(list); T.addFix(list[0], FIX, { now: NOW }); T.patch(list[1], { status: 'wontfix' }, { now: NOW }); T.patch(list[2], { status: 'in_progress' }, { now: NOW });
  const out = R.stamp(r, 'closed', { tickets: list, Tk: T, by: 'Erick', now: NOW });
  assert.equal(out.ok, true); assert.deepEqual(list.map((b) => b.status), ['fixed', 'wontfix', 'fixed', 'fixed', 'fixed']);
  assert.deepEqual(out.handFixed.sort(), [list[2].id, list[3].id, list[4].id].sort(), 'three were closed by hand: no fix note, so no verifier will look at them');
  assert.equal(list[0].fixRev, 1, 'a real fix note is untouched'); assert.equal(T.queueState(list[2]), 'fixed_unnoted'); assert.equal(R.progress(r, byId(list), T).handFixed, 3);
  assert.equal(r.stamp, 'closed'); assert.equal(R.progress(r, byId(list), T).readyToClose, true);
});
test('closing never overrules a failed verification unless it is forced', () => {
  const list = mkTickets(), r = mk(list); T.addFix(list[0], FIX, { now: NOW });
  T.addVerification(list[0], { result: 'failed', fixRev: 1, by: 'Vera', summary: 'the new code is not there' }, { now: NOW });
  assert.equal(T.queueState(list[0]), 'reopened');
  const blocked = R.stamp(r, 'closed', { tickets: list, Tk: T, by: 'Erick', now: NOW });
  assert.equal(blocked.ok, false); assert.deepEqual(blocked.blocking, [list[0].id]); assert.equal(r.stamp, 'new', 'nothing moved and the stamp did not change');
  assert.deepEqual(list.map((b) => b.status), ['open', 'open', 'open', 'open', 'open']); assert.equal(r.history.length, 0);
  const forced = R.stamp(r, 'closed', { tickets: list, Tk: T, by: 'Erick', force: true, now: NOW });
  assert.equal(forced.ok, true); assert.equal(list[0].status, 'fixed'); assert.equal(r.stamp, 'closed');
});
test('going back to "working" re-opens only what was closed by hand; a real fix stays fixed', () => {
  const list = mkTickets(), r = mk(list); T.addFix(list[0], FIX, { now: NOW });
  R.stamp(r, 'closed', { tickets: list, Tk: T, by: 'Erick', now: NOW });
  const back = R.stamp(r, 'working', { tickets: list, Tk: T, by: 'Erick', now: NOW });
  assert.equal(back.ok, true); assert.equal(back.moved.reopened.length, 4); assert.equal(list[0].status, 'fixed', 'the fix with a note stays fixed');
  assert.deepEqual(list.slice(1).map((b) => b.status), ['in_progress', 'in_progress', 'in_progress', 'in_progress']);
  const fresh = mkTickets(), r2 = mk(fresh); fresh[2].status = 'fixed';
  R.stamp(r2, 'working', { tickets: fresh, Tk: T, by: 'Erick', now: NOW }); assert.equal(fresh[2].status, 'fixed', 'a ticket someone fixed by hand before the report was ever closed is not re-opened by "working"');
});
test('"new" only changes the stamp; a bad stamp is refused; tickets that were deleted are skipped', () => {
  const list = mkTickets(), r = mk(list, { ticketIds: [...ids(list), 'bug_gone'] });
  assert.equal(R.stamp(r, 'archived', { tickets: list, Tk: T }).ok, false); assert.equal(r.stamp, 'new');
  R.stamp(r, 'working', { tickets: list, Tk: T, now: NOW });
  const out = R.stamp(r, 'new', { tickets: list, Tk: T, now: NOW }); assert.equal(out.ok, true); assert.deepEqual(list.map((b) => b.status), ['in_progress', 'in_progress', 'in_progress', 'in_progress', 'in_progress']);
  const c = R.stamp(r, 'closed', { tickets: list, Tk: T, now: NOW }); assert.equal(c.ok, true, 'a missing ticket does not stop the stamp'); assert.equal(c.moved.fixed.length, 5);
});
test('a ticket that is in two reports moves with either; the history keeps the last 50 moves, notes and names are clipped', () => {
  const list = mkTickets(), r1 = mk(list), r2 = mk(list, { title: 'Second', ticketIds: [list[0].id] });
  R.stamp(r1, 'working', { tickets: list, Tk: T, now: NOW }); const again = R.stamp(r2, 'working', { tickets: list, Tk: T, now: NOW });
  assert.equal(again.moved.inProgress.length, 0, 'already in progress: nothing to move, no second line in the thread'); assert.equal(list[0].comments.length, 1);
  for (let i = 0; i < 60; i++) R.stamp(r1, i % 2 ? 'working' : 'new', { tickets: list, Tk: T, by: 'x'.repeat(100), note: 'n'.repeat(900), now: NOW });
  assert.equal(r1.history.length, 50); assert.equal(r1.stampedBy.length, 40); assert.equal(r1.stampNote.length, 500);
});

const failed = results.filter((r) => !r[0]).length;
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
