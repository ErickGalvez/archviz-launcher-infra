#!/usr/bin/env node
'use strict';
// Self-test for the ticket model (bridge/tickets.js): fix notes, verification, the fix queue, and what is allowed to leave without the QA key.
//   node bridge/tickets.test.js
const assert = require('assert');
const T = require('./tickets');

const results = [];
const test = (name, fn) => { try { fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };
const NOW = Date.parse('2026-10-25T12:00:00Z');
const fresh = (over) => T.create({ title: 'Slide-unlock sticks on iOS', description: 'Seen on iPhone 11.', component: 'Slide unlock', priority: 'high', reportedBy: 'EG run V1.1', ...over }, { now: NOW, id: 'bug_000000000001' });
const FIX = { repo: 'website', commit: 'ABCDEF1234', files: ['archviz/app.js'], rootCause: 'The touchend handler was never attached.', solution: 'Attach it on pointerdown.', context: 'Runs when the slider is dragged.', notes: 'Check Safari 17 too.', by: 'Dex', role: 'Developer', snippet: { file: 'archviz/app.js', lang: 'js', before: '  el.onmousedown = start;', after: '  el.onpointerdown = start;' } };
const throwsMsg = (fn, re) => { try { fn(); } catch (e) { assert.match(e.message, re); return; } assert.fail('should have thrown ' + re); };

// ── the ticket itself ──
test('an old ticket (no new fields) is given harmless defaults', () => {
  const n = T.normalize({ id: 'bug_x', title: 'Old', status: 'open', priority: 'low' });
  assert.equal(n.type, 'bug'); assert.equal(n.area, ''); assert.deepEqual(n.comments, []); assert.equal(n.fixRev, 0); assert.equal(n.fix, null); assert.equal(n.verification, null); assert.equal(n.source, null);
});
test('a ticket needs a title; the status is always "open"; unknown type, area and priority fall back', () => {
  throwsMsg(() => T.create({ title: '   ' }), /title is required/);
  const b = T.create({ title: 'T', status: 'fixed', priority: 'nonsense', type: 'wish', area: 'plumbing' }, { now: NOW });
  assert.equal(b.status, 'open'); assert.equal(b.priority, 'medium'); assert.equal(b.type, 'bug'); assert.equal(b.area, '');
  const ok = T.create({ title: 'T', type: 'request', area: 'copy', assignee: 'Wren' }, { now: NOW });
  assert.equal(ok.type, 'request'); assert.equal(ok.area, 'copy'); assert.equal(ok.assignee, 'Wren');
});
test('the source of a ticket (run + case) is kept, trimmed, and dropped when empty', () => {
  const b = T.create({ title: 'T', source: { run: 'V1.1 - Oct 25, 2026', caseId: 'TC-014', result: 'Fail', kind: 'run-comment', extra: 'x' } }, { now: NOW });
  assert.deepEqual(b.source, { run: 'V1.1 - Oct 25, 2026', caseId: 'TC-014', result: 'Fail', kind: 'run-comment' });
  assert.equal(T.create({ title: 'T', source: { run: '', caseId: '' } }, { now: NOW }).source, null);
});
test('editing: only known fields change, bad values are ignored, the title cannot be emptied', () => {
  const b = fresh();
  T.patch(b, { priority: 'urgent', status: 'closed', title: '   ', area: 'plumbing', secret: 'x', id: 'bug_hacked' }, { now: NOW });
  assert.equal(b.priority, 'high'); assert.equal(b.status, 'open'); assert.equal(b.title, 'Slide-unlock sticks on iOS'); assert.equal(b.area, ''); assert.equal(b.id, 'bug_000000000001'); assert.equal(b.secret, undefined);
});
test('a change to status, priority, assignee, area or type leaves one line in the thread; an unchanged value leaves none', () => {
  const b = fresh();
  T.patch(b, { status: 'in_progress', priority: 'critical', assignee: 'Dex', area: 'dev' }, { now: NOW, by: 'Erick' });
  assert.equal(b.comments.length, 1); const c = b.comments[0];
  assert.equal(c.kind, 'activity'); assert.equal(c.by, 'Erick'); assert.match(c.text, /Status: Open -> In Progress/); assert.match(c.text, /Priority: high -> critical/); assert.match(c.text, /Assignee: nobody -> Dex/); assert.match(c.text, /Area: none -> dev/);
  T.patch(b, { status: 'in_progress', priority: 'critical' }, { now: NOW });
  assert.equal(b.comments.length, 1);
});
test('the thread is capped so one ticket cannot grow without limit', () => {
  const b = fresh();
  for (let i = 0; i < 325; i++) T.addComment(b, { by: 'x', text: 'c' + i }, { now: NOW });
  assert.equal(b.comments.length, 300); assert.equal(b.comments[b.comments.length - 1].text, 'c324'); assert.equal(b.comments[0].text, 'c25');
});
test('a comment needs text; control characters go, line breaks stay; the author defaults', () => {
  const b = fresh();
  throwsMsg(() => T.addComment(b, { text: '  ' }, { now: NOW }), /text is required/);
  const c = T.addComment(b, { text: 'line one\r\nline\u0007 two' }, { now: NOW });
  assert.equal(c.text, 'line one\nline  two'); assert.equal(c.by, 'QA console'); assert.equal(c.kind, 'comment');
});

// ── fix notes ──
test('a fix note needs a root cause and a solution', () => {
  const b = fresh();
  throwsMsg(() => T.addFix(b, { ...FIX, rootCause: ' ' }, { now: NOW }), /rootCause is required/);
  throwsMsg(() => T.addFix(b, { ...FIX, solution: '' }, { now: NOW }), /solution is required/);
  assert.equal(b.fixRev, 0); assert.equal(b.status, 'open');
});
test('a change in the website or launcher repo must name a real git sha; the app repo (no remote yet) may omit it', () => {
  const b = fresh();
  throwsMsg(() => T.addFix(b, { ...FIX, commit: '' }, { now: NOW }), /commit is required/);
  throwsMsg(() => T.addFix(b, { ...FIX, commit: 'not-a-sha' }, { now: NOW }), /git sha/);
  throwsMsg(() => T.addFix(b, { ...FIX, commit: 'abc123; rm -rf' }, { now: NOW }), /git sha/);
  const c = T.addFix(b, { ...FIX, repo: 'app', commit: '' }, { now: NOW });
  assert.equal(c.fix.commit, ''); assert.equal(c.fix.commitUrl, null);
});
test('the commit link is built from the sha for the right repo and cannot be supplied by the request', () => {
  const b = fresh();
  const c = T.addFix(b, { ...FIX, commitUrl: 'https://evil.example/x' }, { now: NOW });
  assert.equal(c.fix.commitUrl, 'https://github.com/ErickGalvez/ARCHVIZ/commit/abcdef1234'); assert.equal(c.fix.commit, 'abcdef1234');
  const l = fresh(); assert.equal(T.addFix(l, { ...FIX, repo: 'launcher' }, { now: NOW }).fix.commitUrl, 'https://github.com/ErickGalvez/archviz-launcher-infra/commit/abcdef1234');
  assert.equal(T.commitUrl('nope', 'abcdef1'), null);
});
test('recording a fix moves the ticket to fixed, bumps the revision and keeps the note in the thread and on the ticket', () => {
  const b = fresh(); const c = T.addFix(b, FIX, { now: NOW });
  assert.equal(b.status, 'fixed'); assert.equal(b.fixRev, 1); assert.equal(b.fix.rev, 1); assert.equal(c.kind, 'fix'); assert.equal(c.by, 'Dex');
  assert.equal(b.fix.rootCause, FIX.rootCause); assert.equal(b.fix.snippet.after, FIX.snippet.after); assert.equal(b.fix.snippet.before, FIX.snippet.before); assert.deepEqual(b.fix.files, ['archviz/app.js']);
  assert.ok(b.comments.includes(c));
  T.addFix(b, { ...FIX, solution: 'Second attempt.' }, { now: NOW }); assert.equal(b.fixRev, 2);
});
test('a partial fix keeps the ticket in progress instead of closing it', () => {
  const b = fresh(); T.addFix(b, { ...FIX, partial: true }, { now: NOW });
  assert.equal(b.status, 'in_progress'); assert.equal(b.fixRev, 1);
});
test('snippets, file lists and prose are bounded; an empty snippet is dropped; code keeps its indentation', () => {
  const b = fresh();
  const c = T.addFix(b, { ...FIX, files: Array.from({ length: 40 }, (_, i) => 'f' + i + '.js'), rootCause: 'x'.repeat(9000), snippet: { after: '\n\n    if (x) {\n      y();\n    }\n   ', before: 'z'.repeat(9000) } }, { now: NOW });
  assert.equal(c.fix.files.length, 20); assert.equal(c.fix.rootCause.length, 2000); assert.equal(c.fix.snippet.before.length, 4000);
  assert.equal(c.fix.snippet.after, '    if (x) {\n      y();\n    }');
  assert.equal(T.addFix(fresh(), { ...FIX, snippet: { after: '  ', before: '' } }, { now: NOW }).fix.snippet, null);
});

// ── verification ──
test('a verdict needs a known result and a fix note, and is refused for an older revision', () => {
  const b = fresh();
  throwsMsg(() => T.addVerification(b, { result: 'verified', fixRev: 1, by: 'Vera' }, { now: NOW }), /no fix note/);
  T.addFix(b, FIX, { now: NOW });
  throwsMsg(() => T.addVerification(b, { result: 'great', fixRev: 1, by: 'Vera' }, { now: NOW }), /result must be/);
  T.addFix(b, FIX, { now: NOW });                                                  // now at revision 2
  throwsMsg(() => T.addVerification(b, { result: 'verified', fixRev: 1, by: 'Vera' }, { now: NOW }), /stale/);
});
test('"verified" and "unsure" leave the ticket fixed; "failed" reopens it', () => {
  const v = fresh(); T.addFix(v, FIX, { now: NOW }); T.addVerification(v, { result: 'verified', fixRev: 1, by: 'Vera', summary: 'Matches.' }, { now: NOW });
  assert.equal(v.status, 'fixed'); assert.equal(v.verification.result, 'verified');
  const u = fresh(); T.addFix(u, FIX, { now: NOW }); T.addVerification(u, { result: 'unsure', fixRev: 1, by: 'Vera' }, { now: NOW }); assert.equal(u.status, 'fixed');
  const f = fresh(); T.addFix(f, FIX, { now: NOW }); const c = T.addVerification(f, { result: 'failed', fixRev: 1, by: 'Vera', summary: 'The new line is not in the file.', checks: [{ name: 'file contains the change', ok: false, detail: 'not found' }] }, { now: NOW });
  assert.equal(f.status, 'open'); assert.equal(c.kind, 'verification'); assert.equal(c.verification.checks[0].ok, false);
});
test('the fix queue state follows the ticket through fix, verdict and reopen', () => {
  const b = fresh(); assert.equal(T.queueState(b), 'open');
  T.patch(b, { status: 'in_progress' }, { now: NOW }); assert.equal(T.queueState(b), 'in_progress');
  T.patch(b, { status: 'fixed' }, { now: NOW }); assert.equal(T.queueState(b), 'fixed_unnoted');
  T.addFix(b, FIX, { now: NOW }); assert.equal(T.queueState(b), 'awaiting');
  T.addVerification(b, { result: 'failed', fixRev: 1, by: 'Vera' }, { now: NOW }); assert.equal(T.queueState(b), 'reopened');
  T.addFix(b, FIX, { now: NOW }); assert.equal(T.queueState(b), 'awaiting');                    // a new revision is waiting again
  T.addVerification(b, { result: 'verified', fixRev: 2, by: 'Vera' }, { now: NOW }); assert.equal(T.queueState(b), 'verified');
  const u = fresh(); T.addFix(u, FIX, { now: NOW }); T.addVerification(u, { result: 'unsure', fixRev: 1, by: 'Vera' }, { now: NOW }); assert.equal(T.queueState(u), 'unsure');
  T.patch(u, { status: 'wontfix' }, { now: NOW }); assert.equal(T.queueState(u), 'closed');
});
test('a verifier is asked only for fixed tickets with a note, never twice for the same revision, and again for a new one', () => {
  const b = fresh(); assert.equal(T.needsVerification(b, 'Vera'), false);                      // open
  T.patch(b, { status: 'fixed' }, { now: NOW }); assert.equal(T.needsVerification(b, 'Vera'), false);   // fixed by hand: nothing to check
  T.addFix(b, FIX, { now: NOW }); assert.equal(T.needsVerification(b, 'Vera'), true);
  T.addVerification(b, { result: 'verified', fixRev: 1, by: 'Vera' }, { now: NOW });
  assert.equal(T.needsVerification(b, 'Vera'), false);                                        // already verified by her
  assert.equal(T.needsVerification(b, 'Priya'), true);                                        // someone else may still check
  T.addFix(b, FIX, { now: NOW }); assert.equal(T.needsVerification(b, 'Vera'), true);         // a new revision is new work
  const u = fresh(); T.addFix(u, FIX, { now: NOW }); T.addVerification(u, { result: 'unsure', fixRev: 1, by: 'Vera' }, { now: NOW });
  assert.equal(T.needsVerification(u, 'Vera'), false);                                        // "unsure" waits for a human, it does not loop every night
});

// ── notes from a merge, and "check again" ──
test('a note recorded from a merged pull request is marked as such, and only when the caller says exactly true', () => {
  assert.equal(T.addFix(fresh(), { ...FIX, viaMerge: true }, { now: NOW }).fix.viaMerge, true);
  assert.equal(T.addFix(fresh(), FIX, { now: NOW }).fix.viaMerge, false);
  assert.equal(T.addFix(fresh(), { ...FIX, viaMerge: 'yes' }, { now: NOW }).fix.viaMerge, false);
});
test('a check can be asked for again: only a fixed note, never on a won\'t-fix ticket, and it is recorded in the thread', () => {
  const b = fresh();
  throwsMsg(() => T.requestRecheck(b, { by: 'Erick' }, { now: NOW }), /no fix note/);
  T.addFix(b, FIX, { now: NOW });
  const c = T.requestRecheck(b, { by: 'Erick' }, { now: NOW });
  assert.equal(c.kind, 'recheck'); assert.equal(c.fixRev, 1); assert.equal(c.by, 'Erick'); assert.ok(b.comments.includes(c));
  T.patch(b, { status: 'wontfix' }, { now: NOW }); throwsMsg(() => T.requestRecheck(b, { by: 'x' }, { now: NOW }), /won't fix/);
});
test('asking again is the one way the same revision is checked twice: after the verdict, and only for that revision', () => {
  const b = fresh(); T.addFix(b, FIX, { now: NOW });
  T.addVerification(b, { result: 'unsure', fixRev: 1, by: 'Vera' }, { now: NOW });
  assert.equal(T.needsVerification(b, 'Vera'), false);
  T.requestRecheck(b, { by: 'Erick' }, { now: NOW }); assert.equal(T.needsVerification(b, 'Vera'), true);
  T.addVerification(b, { result: 'unsure', fixRev: 1, by: 'Vera' }, { now: NOW }); assert.equal(T.needsVerification(b, 'Vera'), false, 'the new verdict answers the request');
  const o = fresh(); T.addFix(o, FIX, { now: NOW }); T.requestRecheck(o, { by: 'Erick' }, { now: NOW }); T.addVerification(o, { result: 'verified', fixRev: 1, by: 'Vera' }, { now: NOW });
  T.addFix(o, FIX, { now: NOW }); T.addVerification(o, { result: 'verified', fixRev: 2, by: 'Vera' }, { now: NOW });
  assert.equal(T.needsVerification(o, 'Vera'), false, 'a request for revision 1 does not trigger a check of revision 2');
});
test('a reopened ticket is checked again only when someone asks, and a confirmed fix puts it back to fixed', () => {
  const b = fresh(); T.addFix(b, FIX, { now: NOW }); T.addVerification(b, { result: 'failed', fixRev: 1, by: 'Vera' }, { now: NOW });
  assert.equal(b.status, 'open'); assert.equal(T.needsVerification(b, 'Vera'), false);
  T.requestRecheck(b, { by: 'Erick' }, { now: NOW }); assert.equal(T.needsVerification(b, 'Vera'), true);
  T.addVerification(b, { result: 'verified', fixRev: 1, by: 'Vera' }, { now: NOW });
  assert.equal(b.status, 'fixed'); assert.equal(T.queueState(b), 'verified');
});

// ── what leaves without the key ──
test('without the QA key a ticket shows counts and the commit link, but no thread, root cause or code', () => {
  const b = fresh(); T.addFix(b, FIX, { now: NOW }); T.addVerification(b, { result: 'verified', fixRev: 1, by: 'Vera', summary: 'secret detail', checks: [{ name: 'x', ok: true, detail: 'y' }] }, { now: NOW });
  const p = T.publicView(b), text = JSON.stringify(p);
  assert.equal(p.comments, undefined); assert.equal(p.commentCount, 2); assert.equal(p.queue, 'verified');
  assert.equal(p.fix.commitUrl, 'https://github.com/ErickGalvez/ARCHVIZ/commit/abcdef1234'); assert.equal(p.verification.result, 'verified');
  for (const s of [FIX.rootCause, FIX.solution, FIX.snippet.after, FIX.notes, FIX.context, 'secret detail']) assert.ok(!text.includes(s), 'leaked: ' + s);
  const f = T.fullView(b); assert.equal(f.comments.length, 2); assert.equal(f.fix.rootCause, FIX.rootCause);
});

console.log('\n' + results.filter((r) => r[0]).length + ' passed, ' + results.filter((r) => !r[0]).length + ' failed');
process.exit(results.some((r) => !r[0]) ? 1 : 0);
