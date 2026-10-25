#!/usr/bin/env node
'use strict';
// Self-test for bridge/fixnote.js: a diff and a pull request description become the structured fix note a ticket takes.
//   node bridge/fixnote.test.js
const assert = require('assert');
const F = require('./fixnote');
const T = require('./tickets');
const V = require('./verifier');

const results = [];
const test = (name, fn) => { try { fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.message).split('\n')[0]); } };

const DIFF = [
  'diff --git a/archviz/app.js b/archviz/app.js',
  'index 111..222 100644',
  '--- a/archviz/app.js',
  '+++ b/archviz/app.js',
  '@@ -10,7 +10,8 @@ function wire(el) {',
  '   const start = begin;',
  '-  el.onmousedown = start;',
  '+  el.onpointerdown = start;',
  '+  el.onpointerup = stop;',
  '   return el;',
  ' }',
  '@@ -80,4 +81,4 @@ function other() {',
  '   a();',
  '-  b();',
  '+  c();',
  '   d();',
  'diff --git a/archviz/app.test.js b/archviz/app.test.js',
  '--- a/archviz/app.test.js',
  '+++ b/archviz/app.test.js',
  '@@ -1,2 +1,12 @@',
  ' x',
  '+a1', '+a2', '+a3', '+a4', '+a5', '+a6', '+a7', '+a8', '+a9', '+a10',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  'diff --git a/old.js b/old.js',
  'deleted file mode 100644',
  '--- a/old.js',
  '+++ /dev/null',
  '@@ -1,2 +0,0 @@',
  '-gone();',
  '-gone2();',
].join('\n');

test('a diff is split into files and hunks; binary files are left out and deletions are marked', () => {
  const f = F.parseDiff(DIFF);
  assert.deepEqual(f.map((x) => x.file), ['archviz/app.js', 'archviz/app.test.js', 'old.js']);
  assert.equal(f[0].hunks.length, 2); assert.equal(f[0].hunks[0].added, 2); assert.equal(f[0].hunks[0].removed, 1); assert.equal(f[2].deleted, true);
  assert.deepEqual(f[0].hunks[0].newLines, ['  const start = begin;', '  el.onpointerdown = start;', '  el.onpointerup = stop;', '  return el;', '}']);
  assert.deepEqual(f[0].hunks[0].oldLines, ['  const start = begin;', '  el.onmousedown = start;', '  return el;', '}']);
});
test('the file header lines and "no newline" markers are never taken for code', () => {
  const f = F.parseDiff('diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n');
  assert.deepEqual(f[0].hunks[0].newLines, ['b']); assert.deepEqual(f[0].hunks[0].oldLines, ['a']);
  assert.deepEqual(F.parseDiff(''), []); assert.deepEqual(F.parseDiff(undefined), []);
});
test('the snippet shows the biggest change outside tests and docs: old side, new side, language from the extension', () => {
  const s = F.snippetFromDiff(F.parseDiff(DIFF));
  assert.equal(s.file, 'archviz/app.js'); assert.equal(s.lang, 'js');
  assert.ok(s.after.includes('el.onpointerdown = start;') && s.before.includes('el.onmousedown = start;') && !s.after.includes('onmousedown'));
});
test('a file the fixer names wins, deleted files are never shown, and an empty diff gives no snippet', () => {
  const files = F.parseDiff(DIFF);
  assert.equal(F.snippetFromDiff(files, ['archviz/app.test.js']).file, 'archviz/app.test.js');
  assert.equal(F.snippetFromDiff(files, ['old.js']).file, 'archviz/app.js');
  assert.equal(F.snippetFromDiff([]), null);
});
test('a long change keeps its start and end, with a "..." line where the middle went, and stays under the ticket\'s limit', () => {
  const lines = Array.from({ length: 300 }, (_, i) => 'const value' + i + ' = compute(' + i + ');');
  const out = F.fitLines(lines);
  assert.ok(out.length <= 61); assert.ok(out.includes('...')); assert.equal(out[0], lines[0]); assert.equal(out[out.length - 1], lines[299]);
  assert.ok(out.join('\n').length <= 3600);
  const wide = F.fitLines(Array.from({ length: 10 }, () => 'x'.repeat(900)));
  assert.ok(wide.join('\n').length <= 3600 && wide.includes('...'));
  assert.deepEqual(F.fitLines(['a', 'b']), ['a', 'b']);
});
test('a snippet cut down to fit still passes the verifier\'s check against the real file (the "..." parts are looked for one by one)', () => {
  const body = Array.from({ length: 200 }, (_, i) => 'const value' + i + ' = compute(' + i + ');');
  const diff = 'diff --git a/big.js b/big.js\n--- a/big.js\n+++ b/big.js\n@@ -1,0 +1,200 @@\n' + body.map((l) => '+' + l).join('\n') + '\n';
  const snip = F.snippetFromDiff(F.parseDiff(diff)), segs = V.segments(snip.after);
  const fileNorm = body.join(' ').replace(/\s+/g, ' ');
  assert.ok(segs.length >= 2 && segs.every((p) => fileNorm.includes(p.replace(/\s+/g, ' ').trim())));
});

const BODY = [
  'Fixes two things from the run.', '',
  '### Fix note: bug_0123456789ab',
  'Root cause: The drag handler was never attached on touch screens.',
  'How it was solved: Switched to pointer events so touch and mouse share one path.',
  'It also stops the page scrolling while dragging.',
  'Context: Runs when the slider is dragged.',
  'Dev notes: Check Safari 17 too.',
  'Files: archviz/app.js', '',
  '### Fix note: bug_aaaaaaaaaaaa',
  'Root cause: Wrong hint text.',
  '', '### Something else', 'Not part of any note.',
].join('\n');

test('each "### Fix note: bug_..." section becomes one note with its labelled fields; wrapped lines belong to the field above', () => {
  const n = F.parsePrBody(BODY);
  assert.equal(n.length, 2); assert.equal(n[0].ticket, 'bug_0123456789ab');
  assert.equal(n[0].rootCause, 'The drag handler was never attached on touch screens.');
  assert.equal(n[0].solution, 'Switched to pointer events so touch and mouse share one path.\nIt also stops the page scrolling while dragging.');
  assert.equal(n[0].context, 'Runs when the slider is dragged.'); assert.equal(n[0].notes, 'Check Safari 17 too.'); assert.deepEqual(n[0].files, ['archviz/app.js']);
  assert.equal(n[1].rootCause, 'Wrong hint text.'); assert.equal(n[1].solution, '');
});
test('a description with no notes, odd labels or other headings gives nothing, and a ticket id must look like one', () => {
  assert.deepEqual(F.parsePrBody('Just a description'), []); assert.deepEqual(F.parsePrBody(''), []); assert.deepEqual(F.parsePrBody(null), []);
  assert.deepEqual(F.parsePrBody('### Fix note: QA-3\nRoot cause: x'), []); assert.deepEqual(F.parsePrBody('### Fix note: bug_zzzz\nRoot cause: x'), []);
  assert.equal(F.parsePrBody('## fix note: BUG_0123456789AB\nSolution: done\nRoot cause: why')[0].ticket, 'bug_0123456789ab');
});
const mkT = (id, status) => ({ id, status: status || 'open' });
test('the notes a merge leaves: only for real, open tickets with a root cause and a solution; the commit, files and snippet come from the merge', () => {
  const r = F.buildFixNotes({ body: BODY + '\n### Fix note: bug_bbbbbbbbbbbb\nRoot cause: x\nSolution: y\n### Fix note: bug_cccccccccccc\nRoot cause: x\nSolution: y',
    diff: DIFF, sha: 'abcdef1234', repoKey: 'website', tickets: [mkT('bug_0123456789ab'), mkT('bug_aaaaaaaaaaaa'), mkT('bug_cccccccccccc', 'wontfix')] });
  assert.deepEqual(r.notes.map((n) => n.ticketId), ['bug_0123456789ab']);
  const i = r.notes[0].input;
  assert.equal(i.commit, 'abcdef1234'); assert.equal(i.repo, 'website'); assert.deepEqual(i.files, ['archviz/app.js']); assert.equal(i.snippet.file, 'archviz/app.js'); assert.equal(i.by, 'Dex');
  assert.deepEqual(r.skipped.map((s) => s.ticket + ':' + s.reason.split(' ')[0]), ['bug_aaaaaaaaaaaa:the', 'bug_bbbbbbbbbbbb:no', 'bug_cccccccccccc:marked']);
});
test('without a "Files:" line the files the diff touched are used (never a deleted one), at most twenty', () => {
  const r = F.buildFixNotes({ body: '### Fix note: bug_0123456789ab\nRoot cause: a\nSolution: b', diff: DIFF, sha: 'abcdef1', repoKey: 'launcher', tickets: [mkT('bug_0123456789ab')] });
  assert.deepEqual(r.notes[0].input.files, ['archviz/app.js', 'archviz/app.test.js']);
  const many = Array.from({ length: 30 }, (_, i) => 'diff --git a/f' + i + '.js b/f' + i + '.js\n--- a/f' + i + '.js\n+++ b/f' + i + '.js\n@@ -1 +1 @@\n-a\n+b').join('\n');
  assert.equal(F.buildFixNotes({ body: '### Fix note: bug_0123456789ab\nRoot cause: a\nSolution: b', diff: many, sha: 'abcdef1', repoKey: 'website', tickets: [mkT('bug_0123456789ab')] }).notes[0].input.files.length, 20);
});
test('the built note is accepted by the ticket model as it is, and the commit link points at the right repo', () => {
  const r = F.buildFixNotes({ body: BODY, diff: DIFF, sha: 'abcdef1234', repoKey: 'launcher', tickets: [mkT('bug_0123456789ab')] });
  const b = T.create({ title: 'T' }, { id: 'bug_0123456789ab' });
  const c = T.addFix(b, r.notes[0].input);
  assert.equal(b.status, 'fixed'); assert.equal(c.fix.commitUrl, 'https://github.com/ErickGalvez/archviz-launcher-infra/commit/abcdef1234'); assert.ok(c.fix.snippet.after.includes('onpointerdown'));
});

test('recording a merge puts a note on each named ticket (marked as from a merge), skips the rest, and never throws', () => {
  const mk = (id, status) => T.create({ title: 'T ' + id }, { id, now: Date.parse('2026-10-25T12:00:00Z') }) && Object.assign(T.create({ title: 'T ' + id }, { id }), status ? { status } : {});
  const tickets = [mk('bug_0123456789ab'), mk('bug_aaaaaaaaaaaa'), mk('bug_cccccccccccc', 'wontfix')];
  const body = BODY + '\n### Fix note: bug_cccccccccccc\nRoot cause: x\nSolution: y\n### Fix note: bug_dddddddddddd\nRoot cause: x\nSolution: y';
  const r = F.recordFromMerge({ tickets, Tk: T, body, diff: DIFF, sha: 'abcdef1234', repoKey: 'website' });
  assert.deepEqual(r.recorded, [{ ticketId: 'bug_0123456789ab', rev: 1 }]);
  assert.deepEqual(r.skipped.map((s) => s.ticket).sort(), ['bug_aaaaaaaaaaaa', 'bug_cccccccccccc', 'bug_dddddddddddd']);
  const t = tickets[0]; assert.equal(t.status, 'fixed'); assert.equal(t.fix.viaMerge, true); assert.equal(t.fix.commitUrl, 'https://github.com/ErickGalvez/ARCHVIZ/commit/abcdef1234'); assert.equal(tickets[1].fixRev, 0);
  assert.deepEqual(F.recordFromMerge({ tickets, Tk: T, body: 'no notes', diff: DIFF, sha: 'abcdef1234', repoKey: 'website' }), { recorded: [], skipped: [] });
  const bad = F.recordFromMerge({ tickets, Tk: T, body: BODY, diff: DIFF, sha: 'not-a-sha', repoKey: 'website' });      // an invalid sha is refused by the ticket model: reported, not thrown
  assert.equal(bad.recorded.length, 0); assert.ok(bad.skipped.some((s) => /git sha/.test(s.reason)));
});

console.log('\n' + results.filter((r) => r[0]).length + ' passed, ' + results.filter((r) => !r[0]).length + ' failed');
process.exit(results.some((r) => !r[0]) ? 1 : 0);
