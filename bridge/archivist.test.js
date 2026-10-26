#!/usr/bin/env node
'use strict';
// Tests for the Archivist engine (bridge/archivist.js): which folders it may read, what it never reads, how it interprets, groups and finds duplicates,
// and that a scan is resumable and changes nothing on disk. The model is a fake that records every prompt it is shown.
//   node bridge/archivist.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const A = require('./archivist');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-archivist-'));
const put = (root, rel, data) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); return f; };
const LOREM = (topic, n = 60) => Array.from({ length: n }, (_, i) => topic + ' word' + (i % 17) + ' detail' + (i % 5)).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// a store/deflate zip with the given entries, enough for docx/xlsx
function zipOf(entries) {
  const locals = [], central = []; let off = 0;
  for (const [name, text, deflate] of entries) {
    const raw = Buffer.from(text), data = deflate ? zlib.deflateRawSync(raw) : raw, nm = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
    locals.push(lh, nm, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    central.push(ch, nm); off += 30 + nm.length + data.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}

// A fake Qwen: answers from what the prompt says, and keeps every prompt so a test can look at what was (not) shown.
function fakeModel(opts = {}) {
  const prompts = []; let calls = 0;
  const llm = async ({ messages }) => {
    calls++; const sys = messages[0].content, user = messages[messages.length - 1].content; prompts.push(sys + '\n' + user);
    if (opts.fail && opts.fail(calls)) throw new Error(opts.failMessage || 'model server answered HTTP 500');
    if (opts.garbage) return 'I am sorry, I cannot do that.';
    if (/group labels into projects/.test(sys)) {
      const labels = [...user.matchAll(/^(.+?) \(\d+\)$/gm)].map((m) => m[1]);
      return JSON.stringify({ projects: [{ name: 'Travel', description: 'trips', labels: labels.filter((l) => /^topic [0-4]$|trip|cancun/.test(l)) }, { name: 'Studies', description: 'school work', labels: labels.filter((l) => /^topic [5-8]$|school|essay/.test(l)) }] });
    }
    const tn = /topic (\d+)/i.exec(user), topic = tn ? 'Topic ' + tn[1] : /cancun/i.test(user) ? 'Cancun trip' : /essay|school/i.test(user) ? 'School essay' : /report/i.test(user) ? 'Reports' : 'Notes';
    if (/ONE folder/.test(sys)) return '```json\n{"summary": "Photos from the ' + topic + '", "topic": "photos", "project": "' + topic + '", "g741": false}\n```';
    return JSON.stringify({ summary: 'About ' + topic + ' (' + (user.match(/Path: (.+)/) || [, ''])[1].split('/').pop() + ')', topic, project: topic, tags: ['t1', 'T2', 'x'.repeat(50)], g741: /g741/i.test(user) });
  };
  return { llm, prompts, get calls() { return calls; } };
}
const mk = (root, model, extra = {}) => createArch(root, model, extra);
function createArch(root, model, extra = {}) { return A.createArchivist({ roots: [root], stateDir: path.join(tmp(), 'archive'), llm: model.llm, ...extra }); }

// the tree most tests use
function tree() {
  const root = tmp();
  put(root, 'Trip Cancun 2023/notes.txt', LOREM('cancun hotel beach trip') + '\n');
  put(root, 'Trip Cancun 2023/itinerary.md', '# Cancun itinerary\n' + LOREM('cancun flights and tours', 40));
  put(root, 'Trip Cancun 2023/photos/IMG_0001.jpg', crypto.randomBytes(3000));
  const same = crypto.randomBytes(2500); put(root, 'Trip Cancun 2023/photos/IMG_0002.jpg', crypto.randomBytes(2800)); put(root, 'Trip Cancun 2023/photos/IMG_0003.jpg', same); put(root, 'Trip Cancun 2023/photos/IMG_0003 copy.jpg', same);
  put(root, 'School/essay.docx', zipOf([['word/document.xml', '<w:document><w:body><w:p><w:r><w:t>The school essay on ocean currents: ' + LOREM('ocean current', 30) + '</w:t></w:r></w:p></w:body></w:document>', true], ['[Content_Types].xml', '<x/>', false]]));
  put(root, 'School/essay (1).txt', 'The school essay on ocean currents: ' + LOREM('ocean current', 30) + '\n');
  put(root, 'School/essay.txt', 'The school essay on ocean currents: ' + LOREM('ocean current', 30) + ' revised\n');
  put(root, 'versions/report_v1.txt', LOREM('quarterly report alpha', 50)); put(root, 'versions/report_v2.txt', LOREM('quarterly report beta', 55)); put(root, 'versions/report - Copy.txt', LOREM('quarterly report gamma', 52));
  put(root, 'dup/a.txt', 'identical content for exact duplicates test ' + LOREM('same', 20)); put(root, 'dup/b.txt', 'identical content for exact duplicates test ' + LOREM('same', 20));
  put(root, 'Work/g741-notes.txt', 'G741 Studio pixel streaming notes ' + LOREM('stream', 30));
  put(root, 'node_modules/pkg/index.js', 'module.exports = 1;');
  put(root, '.ssh/id_rsa', 'SECRET-SSH-KEY-CONTENT'); put(root, 'keys/server.pem', 'SECRET-PEM-CONTENT'); put(root, 'cfg/.env', 'TOKEN=SECRET-ENV-CONTENT');
  put(root, 'Docs/passwords list.txt', 'SECRET-PRIVATE-NAME-CONTENT ' + LOREM('bank', 20));
  return root;
}

(async () => {
  console.log('which folders may be scanned');
  await test('a scan needs a full path inside a folder this PC allows; anything else is refused with what to do about it', () => {
    const root = tree(), outside = tmp(), a = mk(root, fakeModel());
    assert.equal(a.check(root).ok, true); assert.equal(a.check(path.join(root, 'School')).ok, true, 'a sub-folder of an allowed folder');
    for (const [bad, code] of [['', 'bad_path'], ['relative/path', 'bad_path'], [path.join(root, 'nope'), 'not_found'], [path.join(root, 'School', 'essay.txt'), 'not_dir'], [outside, 'not_allowed'], [path.join(root, '..'), 'not_allowed'], [path.join(root, 'School', '..', '..'), 'not_allowed'], ['x'.repeat(600), 'bad_path'], [root + '\u0000', 'bad_path']]) { const r = a.check(bad); assert.equal(r.ok, false, JSON.stringify(bad)); assert.equal(r.code, code, JSON.stringify(bad)); }
    assert.match(a.check(outside).error, /archive-allow\.js/, 'it says how to allow a folder');
    const sibling = root + '-sibling'; fs.mkdirSync(sibling); assert.equal(a.check(sibling).code, 'not_allowed', 'a folder whose name merely starts like the allowed one is not inside it');
    const none = A.createArchivist({ roots: [], stateDir: path.join(tmp(), 'a'), llm: async () => '' }); assert.equal(none.check(root).code, 'no_roots');
  });
  await test('a link inside the folder never leads out of it', () => {
    const root = tree(), secret = tmp(); put(secret, 'outside.txt', 'OUTSIDE-SECRET ' + LOREM('x', 20));
    let linked = true; try { fs.symlinkSync(secret, path.join(root, 'Linked'), process.platform === 'win32' ? 'junction' : 'dir'); } catch (e) { linked = false; }
    if (!linked) return;                                                      // the OS would not make a link here: nothing to prove
    const w = mk(root, fakeModel()).walk(root);
    assert.ok(!w.files.some((f) => /outside\.txt|Linked/.test(f.rel)), 'the walk did not enter the link');
  });

  console.log('what it will not read');
  await test('dependency trees, secret folders and key files are skipped or listed by name only, and their content never reaches the model', async () => {
    const root = tree(), m = fakeModel(), a = mk(root, m), d = await a.scan({ path: root });
    const files = a.getFiles(d.runId, { limit: 500 }).files, by = (rel) => files.find((f) => f.rel === rel);
    assert.ok(!files.some((f) => /node_modules|\.ssh/.test(f.rel)), 'node_modules and .ssh are not in the catalog');
    assert.equal(by('keys/server.pem').flags.sensitive, true); assert.equal(by('cfg/.env').flags.sensitive, true); assert.equal(by('Docs/passwords list.txt').flags.private, true);
    for (const rel of ['keys/server.pem', 'cfg/.env', 'Docs/passwords list.txt']) assert.equal(by(rel).interpreted, 'name', rel + ' is name-only');
    const shown = m.prompts.join('\n'); for (const secret of ['SECRET-SSH', 'SECRET-PEM', 'SECRET-ENV', 'SECRET-PRIVATE-NAME', 'module.exports']) assert.ok(!shown.includes(secret), secret + ' reached the model');
    assert.ok(!/passwords list|server\.pem/.test(shown.replace(/Some names:[\s\S]*/g, '')), 'not even the names of private files are sent as a file to read');
    const s = a.getSummary(d.runId); assert.ok(s.counts.dependencyFolders >= 1 && s.counts.secretFolders >= 1 && s.counts.sensitive === 2 && s.counts.private === 1);
  });
  await test('an unknown extension is read only when it is small and really text', async () => {
    const root = tmp(); put(root, 'README', LOREM('plain text readme', 30)); put(root, 'blob.zzz', crypto.randomBytes(4000)); put(root, 'big.zzz', Buffer.alloc(3 * 1024 * 1024, 65));
    const m = fakeModel(), a = mk(root, m), d = await a.scan({ path: root }), f = a.getFiles(d.runId, { limit: 50 }).files;
    assert.equal(f.find((x) => x.name === 'README').interpreted, 'content'); assert.equal(f.find((x) => x.name === 'blob.zzz').interpreted, 'name'); assert.equal(f.find((x) => x.name === 'big.zzz').interpreted, 'name'); assert.equal(m.prompts.filter((p) => /blob\.zzz|big\.zzz/.test(p) && /start of the file/.test(p)).length, 0);
  });

  await test('only a clipped head of a big file reaches the model, never the rest of it', async () => {
    const root = tmp(); put(root, 'long.txt', LOREM('beginning of the long file', 40) + ' ' + 'filler '.repeat(3000) + ' TAIL-MARKER-NEVER-SENT');
    const m = fakeModel(), a = mk(root, m); await a.scan({ path: root });
    const p = m.prompts.find((x) => /long\.txt/.test(x) && /start of the file/.test(x)); assert.ok(p, 'the file was asked about'); assert.ok(p.length < 3200, 'the prompt is clipped: ' + p.length + ' characters'); assert.ok(!p.includes('TAIL-MARKER'));
  });

  console.log('interpreting');
  await test('text and office files are read one by one; pictures are described from their folder; the prompt carries a clipped sample', async () => {
    const root = tree(), m = fakeModel(), a = mk(root, m), d = await a.scan({ path: root }), f = a.getFiles(d.runId, { limit: 500 }).files, by = (rel) => f.find((x) => x.rel === rel);
    assert.equal(d.done, true); assert.equal(by('Trip Cancun 2023/notes.txt').interpreted, 'content'); assert.match(by('Trip Cancun 2023/notes.txt').summary, /Cancun trip/); assert.equal(by('Trip Cancun 2023/notes.txt').project, 'Cancun trip');
    assert.equal(by('Trip Cancun 2023/photos/IMG_0001.jpg').interpreted, 'folder'); assert.match(by('Trip Cancun 2023/photos/IMG_0001.jpg').summary, /Photos/);
    const docx = m.prompts.find((p) => /essay\.docx/.test(p)); assert.ok(docx && /ocean currents/.test(docx), 'the text inside the .docx was read'); assert.equal(by('School/essay.docx').interpreted, 'content');
    assert.ok(m.prompts.every((p) => p.length < 4200), 'every prompt is clipped'); assert.deepEqual(by('Trip Cancun 2023/notes.txt').tags, ['t1', 'T2', 'x'.repeat(24)], 'tags are clipped');
    const folderPrompt = m.prompts.find((p) => /ONE folder/.test(p) && /photos/.test(p)); assert.match(folderPrompt, /IMG_0001\.jpg/); assert.match(folderPrompt, /Readable files next to them|Unread files/);
    assert.equal(a.getSummary(d.runId).counts.pending, 0);
  });
  await test('the company\'s own files are set aside, not sorted into the other projects', async () => {
    const root = tree(), a = mk(root, fakeModel()), d = await a.scan({ path: root }), s = a.getSummary(d.runId), f = a.getFiles(d.runId, { limit: 500 }).files;
    assert.equal(f.find((x) => x.name === 'g741-notes.txt').group, 'g741'); const aside = s.projects.find((p) => p.id === 'g741'); assert.ok(aside && aside.files >= 1 && /set aside/.test(aside.name));
    assert.ok(!s.projects.filter((p) => p.id[0] === 'p').some((p) => p.examples.some((e) => /g741/.test(e))));
  });
  await test('a model that answers nonsense does not break the catalog: the file keeps a short sample as its summary; five misses in a row stop the slice', async () => {
    const root = tmp(); for (let i = 0; i < 4; i++) put(root, 'f' + i + '.txt', LOREM('doc number ' + i, 30));
    const m = fakeModel({ garbage: true }), a = mk(root, m), d = await a.scan({ path: root }); assert.equal(d.done, true);
    const f = a.getFiles(d.runId, { limit: 20 }).files; assert.ok(f.every((x) => x.summary.length > 0 && x.interpreted === 'content'), 'summaries fall back to the text itself');
    const root2 = tmp(); for (let i = 0; i < 8; i++) put(root2, 'g' + i + '.txt', LOREM('other ' + i, 30));
    const bad = fakeModel({ fail: () => true }), b = mk(root2, bad);
    await assert.rejects(() => b.scan({ path: root2 }), /HTTP 500/); assert.ok(bad.calls <= 5, 'it gave up after five failures, not eight');
  });
  await test('one failed question does not end the scan: that file keeps a sample, the others are read', async () => {
    const root = tmp(); for (let i = 0; i < 6; i++) put(root, 'h' + i + '.txt', LOREM('doc number ' + i, 30));
    const m = fakeModel({ fail: (n) => n === 2 }), a = mk(root, m), d = await a.scan({ path: root }); assert.equal(d.done, true);
    const f = a.getFiles(d.runId, { limit: 20 }).files; assert.equal(f.filter((x) => x.interpreted === 'content').length, 5); assert.equal(f.filter((x) => x.interpreted === 'name' && x.summary).length, 1);
  });

  console.log('duplicates and projects');
  await test('exact copies, near copies and versions are suggested separately; nothing is claimed that was not found', async () => {
    const root = tree(), a = mk(root, fakeModel()), d = await a.scan({ path: root }), s = a.getSummary(d.runId), dup = s.duplicates;
    const exactSets = dup.exact.map((g) => g.files.map((x) => x.rel).sort().join('|'));
    assert.ok(exactSets.includes('dup/a.txt|dup/b.txt'), 'identical text files'); assert.ok(exactSets.includes('Trip Cancun 2023/photos/IMG_0003 copy.jpg|Trip Cancun 2023/photos/IMG_0003.jpg'), 'identical pictures');
    assert.ok(dup.exact.every((g) => g.count >= 2 && g.wasted === g.size * (g.count - 1)) && dup.wastedBytes === dup.exact.reduce((n, g) => n + g.wasted, 0));
    assert.ok(!exactSets.some((x) => /IMG_0001|IMG_0002/.test(x)), 'two different pictures of the same size are not duplicates');
    const nearSets = dup.near.map((g) => g.files.map((x) => x.rel).sort().join('|')); assert.ok(nearSets.some((x) => /School\/essay \(1\)\.txt/.test(x) && /School\/essay\.txt/.test(x)), 'a text and its revised copy are near duplicates: ' + nearSets.join(' ; '));
    assert.ok(dup.near.every((g) => g.similarity >= 0.9 && g.similarity <= 1));
    const stems = dup.versions.map((g) => g.stem); assert.ok(stems.includes('report'), 'report_v1 / report_v2 / report - Copy are versions of one name: ' + stems.join(','));
    assert.ok(!dup.versions.some((g) => g.files.some((x) => /^dup\//.test(x.rel))), 'files already reported as exact copies are not repeated as versions');
  });
  await test('two identical files that share a size with an unrelated one are told apart by their hash', async () => {
    const root = tmp(); put(root, 'a.bin', Buffer.alloc(900, 1)); put(root, 'b.bin', Buffer.alloc(900, 1)); put(root, 'c.bin', Buffer.alloc(900, 2)); put(root, 'd.bin', Buffer.alloc(901, 3));
    const a = mk(root, fakeModel()), d = await a.scan({ path: root }), x = a.getSummary(d.runId).duplicates.exact; assert.equal(x.length, 1); assert.deepEqual(x[0].files.map((f) => f.rel).sort(), ['a.bin', 'b.bin']);
    const fl = a.getFiles(d.runId, { limit: 20 }).files; assert.equal(fl.find((f) => f.name === 'd.bin').hash, undefined, 'a file whose size is unique is not even read for a hash'); assert.ok(fl.find((f) => f.name === 'a.bin').hash);
  });
  await test('texts that are alike but not near-identical are not called near copies', async () => {
    const words = LOREM('quarterly budget review', 60).split(' '), alt = words.slice(); for (let k = 0; k < 10; k++) alt[(48 * 7 + k * 11) % alt.length] = 'alt48x' + k;       // ten words changed: close enough to share a fingerprint band, too far to be a copy
    const root = tmp(); put(root, 'budget-draft.txt', words.join(' ')); put(root, 'forecast-notes.txt', alt.join(' '));
    const a = mk(root, fakeModel()), d = await a.scan({ path: root }), dup = a.getSummary(d.runId).duplicates; assert.equal(dup.near.length, 0, JSON.stringify(dup.near)); assert.equal(dup.exact.length, 0);
  });
  await test('projects: a few labels become projects as they are; many labels are grouped by one question to the model, and unmapped ones land in Misc', async () => {
    const few = tree(), m1 = fakeModel(), a1 = mk(few, m1), d1 = await a1.scan({ path: few }), s1 = a1.getSummary(d1.runId);
    assert.ok(!m1.prompts.some((p) => /group labels into projects/.test(p)), 'a handful of labels needs no grouping question'); assert.ok(s1.projects.some((p) => p.name === 'Cancun trip' && p.files >= 3));
    const many = tmp(); for (let i = 0; i < 22; i++) put(many, 'd' + i + '/n.txt', LOREM('topic ' + i, 20) + (i < 5 ? ' cancun trip' : i < 9 ? ' school essay' : ''));
    const m2 = fakeModel(), a2 = mk(many, m2, { limits: { maxProjects: 3 } }), d2 = await a2.scan({ path: many }), s2 = a2.getSummary(d2.runId);
    assert.equal(m2.prompts.filter((p) => /group labels into projects/.test(p)).length, 1, 'one grouping question for the whole run: ' + m2.prompts.filter((p) => /group labels into projects/.test(p)).length + ' of ' + m2.prompts.length + ' prompts; summary ' + JSON.stringify(s2.counts) + ' ' + JSON.stringify(s2.projects.map((p) => [p.id, p.files]))); assert.ok(s2.projects.filter((p) => p.id[0] === 'p').length <= 3); assert.ok(s2.projects.some((p) => p.name === 'Travel' && p.files === 5) && s2.projects.some((p) => p.name === 'Studies' && p.files === 4), 'the grouping the model gave'); assert.equal(s2.projects.find((p) => p.id === 'misc').files, 13, 'the labels it left out land in Misc');
    assert.ok(s2.projects.every((p) => p.files > 0)); assert.equal(s2.projects.reduce((n, p) => n + p.files, 0), s2.counts.files, 'every file is in exactly one group');
  });

  console.log('slices, resuming, cancelling');
  await test('a slice that runs out of time stops cleanly, and the next one carries on without asking the model about the same files again', async () => {
    const root = tmp(); for (let i = 0; i < 9; i++) put(root, 'n' + i + '.txt', LOREM('document ' + i, 30));
    let t = 1000000; const m = fakeModel(), base = m.llm; m.llm = async (x) => { t += 1000; return base(x); };
    const a = A.createArchivist({ roots: [root], stateDir: path.join(tmp(), 'archive'), llm: m.llm, now: () => t });
    const first = await a.scan({ path: root }, { deadline: t + 3500 });
    assert.equal(first.done, false); assert.equal(first.status, 'partial'); assert.ok(first.remaining > 0 && first.remaining < 9); const calls1 = m.calls; assert.ok(calls1 >= 3 && calls1 <= 5, 'about 3 files in 3.5 s of fake time: ' + calls1);
    const second = await a.scan({ path: root, runId: first.runId }, { deadline: t + 100000 });
    assert.equal(second.done, true); assert.equal(second.runId, first.runId); assert.equal(m.calls - calls1 <= 9 - calls1 + 2, true, 'only the remaining files were asked: ' + (m.calls - calls1));
    const f = a.getFiles(first.runId, { limit: 20 }).files; assert.ok(f.every((x) => x.interpreted === 'content') && f.length === 9);
  });
  await test('cancelling stops at once, keeps what was done, and a later scan of the same folder continues the same run', async () => {
    const root = tmp(); for (let i = 0; i < 6; i++) put(root, 'c' + i + '.txt', LOREM('cancel test ' + i, 30));
    const m = fakeModel(), a = mk(root, m); let n = 0; const stop = () => n >= 2;
    const base = m.llm; m.llm = async (x) => { n++; return base(x); }; a.constructor;
    const arch = A.createArchivist({ roots: [root], stateDir: path.join(tmp(), 'archive'), llm: m.llm });
    const c = await arch.scan({ path: root }, { cancelled: stop }); assert.equal(c.status, 'cancelled'); assert.equal(c.done, false);
    const kept = arch.getFiles(c.runId, { limit: 20 }).files.filter((x) => x.interpreted === 'content').length; assert.equal(kept, 2, 'the two finished files are kept');
    const again = await arch.scan({ path: root }); assert.equal(again.runId, c.runId, 'same folder, same run'); assert.equal(again.done, true); assert.equal(m.calls <= 6 + 1, true);
  });
  await test('a model that disappears (a client started rendering) stops the slice with the reason, keeps the progress, and the next try resumes', async () => {
    const root = tmp(); for (let i = 0; i < 6; i++) put(root, 'r' + i + '.txt', LOREM('render test ' + i, 30));
    let down = false; const m = fakeModel({ fail: () => down, failMessage: 'rendering: this PC is serving a client' }), arch = A.createArchivist({ roots: [root], stateDir: path.join(tmp(), 'archive'), llm: async (x) => { if (arch._count === 2) down = true; arch._count = (arch._count || 0) + 1; return m.llm(x); } });
    await assert.rejects(() => arch.scan({ path: root }), (e) => /^rendering:/.test(e.message));
    const id = arch.listRuns()[0].runId, done = arch.getFiles(id, { limit: 20 }).files.filter((x) => x.interpreted === 'content').length; assert.ok(done >= 2, 'progress was saved before it stopped: ' + done);
    down = false; const r = await arch.scan({ path: root, runId: id }); assert.equal(r.done, true);
  });
  await test('changed files are read again, unchanged ones are not; a new file is picked up', async () => {
    const root = tmp(); put(root, 'a.txt', LOREM('alpha', 30)); put(root, 'b.txt', LOREM('beta', 30));
    const m = fakeModel(), a = mk(root, m); const d = await a.scan({ path: root }); const c0 = m.calls;
    await sleep(15); put(root, 'b.txt', LOREM('beta changed a lot', 40)); put(root, 'c.txt', LOREM('gamma', 30));
    const d2 = await a.scan({ path: root }); assert.equal(d2.runId, d.runId); assert.equal(m.calls - c0 - (m.prompts.slice(c0).filter((p) => /group labels/.test(p)).length), 2, 'b.txt and c.txt only');
    assert.equal(a.getFiles(d.runId, { limit: 10 }).total, 3);
  });

  await test('while a scan is still reading, the summary on disk is refreshed with provisional projects, so the page can show the map filling in', async () => {
    const root = tmp(); for (let i = 0; i < 8; i++) put(root, 'live/n' + i + '.txt', LOREM('cancun live ' + i, 30));
    const m = fakeModel(); let mid = null, a;
    const spy = async (x) => { if (m.calls === 5 && !mid) mid = a.getSummary(a.runIdFor(root)); return m.llm(x); };
    a = A.createArchivist({ roots: [root], stateDir: path.join(tmp(), 'archive'), llm: spy, limits: { saveEvery: 2 } });
    const d = await a.scan({ path: root });
    assert.ok(mid, 'a summary existed in the middle of the scan'); assert.equal(mid.status, 'running'); assert.ok(mid.counts.interpretedContent >= 2 && mid.counts.pending > 0, 'it shows the part that is done'); assert.ok(mid.projects.some((p) => p.id[0] === 'p'), 'with provisional projects');
    assert.equal(a.getSummary(d.runId).status, 'done'); assert.equal(a.getSummary(d.runId).counts.pending, 0);
  });

  console.log('read-only, limits and reading back');
  await test('a scan changes nothing on disk: same files, same bytes, same times, nothing new in the folder', async () => {
    const root = tree(), snap = () => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(root, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') + ':' + fs.statSync(p).mtimeMs; } }; walk(root); return out; };
    const before = snap(), a = mk(root, fakeModel()); await a.scan({ path: root }); await a.scan({ path: root, fresh: true }); assert.deepEqual(snap(), before);
  });
  await test('the engine itself cannot write anywhere but its own state folder, start a process or reach the network', () => {
    const src = fs.readFileSync(path.join(__dirname, 'archivist.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/require\(['"](child_process|http|https|net|dgram|dns)['"]\)|\bfetch\s*\(|\bspawn\s*\(|\bexec(Sync|File)?\s*\(|\beval\s*\(|new Function/.test(src), 'no process, network or eval');
    const writes = [...src.matchAll(/fs\.(writeFileSync|renameSync|rmSync|mkdirSync|unlinkSync|appendFileSync|copyFileSync)\(([^)]*)/g)].map((m) => m[1] + '(' + m[2].slice(0, 40));
    assert.ok(writes.every((w) => /stateDir|tmp|f \+ '\.tmp'|dir|runDir|path\.join\(dir/.test(w)), 'every write goes to the state folder: ' + writes.join(' | '));
  });
  await test('the catalog is capped: a folder with more files than the limit is walked and counted, but only the limit is catalogued', async () => {
    const root = tmp(); for (let i = 0; i < 12; i++) put(root, 'x/f' + String(i).padStart(2, '0') + '.txt', LOREM('item ' + i, 25)); put(root, 'y/z.txt', LOREM('other', 25));
    const a = mk(root, fakeModel()), d = await a.scan({ path: root, maxFiles: 5 }), s = a.getSummary(d.runId);
    assert.equal(s.counts.files, 5); assert.equal(s.counts.walked, 13); assert.equal(s.counts.beyondLimit, 8); assert.equal(s.folders.find((f) => f.dir === 'x').files, 12, 'the folder map still counts every file');
    assert.ok(s.folders.every((f) => f.name && typeof f.bytes === 'number' && ['dir', 'files', 'catalogued', 'interpreted', 'kind', 'project', 'private', 'dup'].every((k) => k in f)));
    const h = A.createArchivist({ roots: [root], stateDir: path.join(tmp(), 'archive'), llm: fakeModel().llm, limits: { maxFilesHard: 4 } }), dh = await h.scan({ path: root, maxFiles: 1e9 });
    assert.equal(h.getSummary(dh.runId).counts.files, 4, 'a request cannot lift the hard limit');
  });
  await test('a run id sent with a scan can never become a folder name outside the archive folder', async () => {
    const root = tmp(); put(root, 'a.txt', LOREM('a', 30)); const base = tmp(), a = A.createArchivist({ roots: [root], stateDir: path.join(base, 'archive'), llm: fakeModel().llm });
    for (const bad of ['../evil', '..\\evil', '/evil', 'ar_x']) { const d = await a.scan({ path: root, runId: bad }); assert.match(d.runId, /^ar_[0-9a-f]{10}$/, bad); }
    assert.deepEqual(fs.readdirSync(base), ['archive'], 'nothing was made next to the archive folder');
  });
  await test('hashing also stops when the slice time is up, and the next slice finishes the job', async () => {
    const root = tmp(); for (let i = 0; i < 6; i++) put(root, 'same' + i + '.bin', Buffer.alloc(800, i % 3));
    const a = mk(root, fakeModel()), d = await a.scan({ path: root }, { deadline: Date.now() - 1 }); assert.equal(d.done, false);
    assert.ok(!a.getFiles(d.runId, { limit: 20 }).files.some((f) => f.hash), 'nothing was hashed after the deadline');
    const d2 = await a.scan({ path: root, runId: d.runId }); assert.equal(d2.done, true); assert.equal(a.getSummary(d2.runId).duplicates.exact.length, 3);
  });
  await test('runs are listed, summarised and paged; a run id can never point outside the archive folder', async () => {
    const root = tree(), a = mk(root, fakeModel()), d = await a.scan({ path: root });
    const runs = a.listRuns(); assert.equal(runs.length, 1); assert.equal(runs[0].runId, d.runId); assert.equal(runs[0].status, 'done'); assert.ok(runs[0].files > 10 && runs[0].projects >= 2);
    const p1 = a.getFiles(d.runId, { limit: 5 }), p2 = a.getFiles(d.runId, { offset: 5, limit: 5 }); assert.equal(p1.files.length, 5); assert.notEqual(p1.files[0].rel, p2.files[0].rel); assert.ok(p1.total > 10);
    assert.ok(a.getFiles(d.runId, { dir: 'School' }).files.every((f) => f.dir === 'School')); assert.ok(a.getFiles(d.runId, { kind: 'image', limit: 100 }).files.every((f) => f.kind === 'image')); assert.ok(a.getFiles(d.runId, { q: 'essay' }).total >= 2);
    assert.ok(!('sim' in p1.files[0]), 'the internal fingerprint is not sent out');
    for (const bad of ['../x', '..\\..\\x', 'ar_zzzz', '/etc/passwd', 'ar_0123456789/../../x', null]) { assert.equal(a.getSummary(bad), null); assert.equal(a.getFiles(bad), null); assert.equal(a.deleteRun(bad), false); }
    const other = tmp(); put(other, 'o.txt', LOREM('other', 20)); const two = A.createArchivist({ roots: [root, other], stateDir: path.join(tmp(), 'archive'), llm: fakeModel().llm }), first = await two.scan({ path: root });
    await assert.rejects(() => two.scan({ path: other, runId: first.runId }), (e) => e.code === 'bad_run', 'a run id of one folder cannot be used for another');
    assert.equal(a.deleteRun(d.runId), true); assert.equal(a.listRuns().length, 0);
  });
  await test('a scan of a folder that is not allowed is refused before anything is read', async () => {
    const root = tree(), outside = tmp(); put(outside, 'x.txt', LOREM('x', 20)); const m = fakeModel(), a = mk(root, m);
    await assert.rejects(() => a.scan({ path: outside }), (e) => e.code === 'not_allowed'); assert.equal(m.calls, 0); assert.equal(a.listRuns().length, 0);
  });

  console.log('small pieces');
  await test('file kinds, dependency folders, secret names, name stems', () => {
    assert.equal(A.kindOf('.JPG'), 'image'); assert.equal(A.kindOf('.docx'), 'document'); assert.equal(A.kindOf('.blend'), 'creative'); assert.equal(A.kindOf('.js'), 'code'); assert.equal(A.kindOf('.zzz'), 'other');
    assert.equal(A.classifyDependency('node_modules', []), 'npm package'); assert.equal(A.classifyDependency('dist', ['index.html']), null, 'a dist folder with no manifest next to it is the owner\'s'); assert.equal(A.classifyDependency('dist', ['package.json']), 'build output');
    for (const n of ['.env', '.env.local', 'id_rsa', 'server.pem', 'vault.kdbx', 'cert.pfx']) assert.equal(A.secretFile(n), true, n); for (const n of ['notes.txt', 'environment.md', 'keynote.pdf']) assert.equal(A.secretFile(n), false, n);
    assert.equal(A.privateName('Docs/passwords list.txt'), true); assert.equal(A.privateName('Trips/Cancun.txt'), false);
    for (const [a, b] of [['report (1).txt', 'report.txt'], ['Report - Copy.docx', 'report.docx'], ['plan_v2.md', 'plan.md'], ['photo FINAL.psd', 'photo.psd'], ['budget_2024-03-05.xlsx', 'budget.xlsx']]) assert.equal(A.nameStem(a), A.nameStem(b), a + ' ~ ' + b);
    assert.notEqual(A.nameStem('chapter1.txt'), A.nameStem('chapter2.txt') + 'x');
  });
  await test('simhash: near texts are close, unrelated texts are far, tiny texts say nothing', () => {
    const a = A.simhash(LOREM('alpha beta gamma', 80)), b = A.simhash(LOREM('alpha beta gamma', 80) + ' extra'), c = A.simhash(Array.from({ length: 200 }, (_, i) => 'zebra' + ((i * 7919) % 211) + ' unrelated' + ((i * 104729) % 97)).join(' '));
    assert.ok(A.hamming(a, b) <= 3 && A.hamming(a, c) > 10 && A.hamming(a, a) === 0); assert.equal(A.simhash('too short'), null);
  });
  await test('the model\'s JSON is found in code fences, with thinking text, trailing commas and chatter around it; garbage gives null', () => {
    assert.deepEqual(A.jsonFrom('```json\n{"a": 1}\n```'), { a: 1 }); assert.deepEqual(A.jsonFrom('<think>hmm {x}</think>Sure! {"a": 1, "b": [1,2,],}'), { a: 1, b: [1, 2] }); assert.equal(A.jsonFrom('no json here'), null); assert.equal(A.jsonFrom('{broken'), null);
  });

  const failed = results.filter((r) => !r[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
