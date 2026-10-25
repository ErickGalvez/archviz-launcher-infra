#!/usr/bin/env node
'use strict';
// Self-test for Vera, the verifier (bridge/verifier.js): the static checks that decide whether a fix is really in the code, what the model's
// answer can and cannot change, the "never verify the same fix twice" rule, the hand-off through the dispatcher, and the regression picks.
// No model, no network: the model's answer is a string the test supplies.
//   node bridge/verifier.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./tickets');
const V = require('./verifier');
const { createTaskio } = require('./taskio');
const { createDispatcher } = require('./dispatcher');
const { createRoutines } = require('./routines');
const policy = require('./policy');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join(' | ').slice(0, 300)); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-verifier-test-'));
const NOW = Date.parse('2026-10-25T12:00:00Z');

// ── a small "repo checkout" on disk ──
const OLD = '  el.onmousedown = start;';
const NEW = '  el.onpointerdown = start;\n  el.onpointerup = stop;';
const FILE = 'function wire(el) {\n' + NEW + '\n  return el;\n}\n';
function repo(files) { const root = tmp(); for (const [rel, text] of Object.entries(files)) { const abs = path.join(root, rel); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, text); } return root; }
const fixOf = (over) => ({ rev: 1, repo: 'website', commit: 'abcdef1', files: ['archviz/app.js'], rootCause: 'The drag handler was never attached on touch screens.', solution: 'Use pointer events so touch and mouse both work.', context: '', notes: '', snippet: { file: 'archviz/app.js', lang: 'js', before: OLD, after: NEW }, by: 'Dex', at: new Date(NOW).toISOString(), ...over });
const ticket = (over) => T.create({ title: 'Slide-unlock sticks on iOS', description: 'Seen on iPhone 11.', component: 'Slide unlock', priority: 'high', ...over }, { now: NOW, id: 'bug_' + String(Math.random()).slice(2, 14).padEnd(12, '0') });
function fixedTicket(fixOver, over) { const b = ticket(over); T.addFix(b, { repo: 'website', commit: 'abcdef1', files: ['archviz/app.js'], rootCause: 'The drag handler was never attached on touch screens.', solution: 'Use pointer events.', snippet: { file: 'archviz/app.js', before: OLD, after: NEW }, by: 'Dex', ...fixOver }, { now: NOW }); return b; }
const prng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const store = (list) => ({ list: () => list, get: (id) => list.find((b) => b.id === id) || null, save: () => {} });

(async () => {
  console.log('static checks');
  await test('the new code is there and the old code is gone: every check passes', () => {
    const r = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': FILE }) });
    assert.equal(r.hardFail, false); assert.equal(r.softFail, false); assert.equal(r.weak, false); assert.ok(r.checks.length >= 3);
    assert.ok(r.excerpts.length === 1 && r.excerpts[0].text.includes('onpointerdown'), 'the model is shown the lines as they are now');
  });
  await test('whitespace and line-ending differences do not matter', () => {
    const r = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': 'function wire(el){\r\n      el.onpointerdown   =  start;\r\n\tel.onpointerup = stop;\r\n}' }) });
    assert.equal(r.hardFail, false);
  });
  await test('a file that is not there fails the fix', () => {
    const r = V.staticChecks(fixOf(), { website: repo({ 'other.js': 'x' }) });
    assert.equal(r.hardFail, true); assert.ok(r.checks.some((c) => c.ok === false && /file exists/.test(c.name)));
  });
  await test('new code that is not in the file fails the fix', () => {
    const r = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': 'function wire(el) {\n' + OLD + '\n}\n' }) });
    assert.equal(r.hardFail, true); assert.ok(r.checks.some((c) => /new code/.test(c.name) && c.ok === false));
  });
  await test('an old line that is still present is a soft finding, not a failure', () => {
    const r = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': FILE + OLD + '\n' }) });
    assert.equal(r.hardFail, false); assert.equal(r.softFail, true);
  });
  await test('a deletion-only fix is proved by the old lines being gone', () => {
    const fix = fixOf({ snippet: { file: 'archviz/app.js', before: '  legacyTracker.init(window);', after: '' } });
    assert.equal(V.staticChecks(fix, { website: repo({ 'archviz/app.js': 'function a() {}\n' }) }).hardFail, false);
    assert.equal(V.staticChecks(fix, { website: repo({ 'archviz/app.js': 'legacyTracker.init(window);\n' }) }).hardFail, true);
  });
  await test('a snippet may skip lines with "..." and each part must still be in the file', () => {
    const fix = fixOf({ snippet: { file: 'archviz/app.js', before: '', after: 'function wire(el) {\n  // ...\n  return el;' } });
    assert.equal(V.staticChecks(fix, { website: repo({ 'archviz/app.js': FILE }) }).hardFail, false);
    assert.equal(V.staticChecks(fix, { website: repo({ 'archviz/app.js': 'function wire(el) {\n}\n' }) }).hardFail, true);
    assert.deepEqual(V.segments('first line of code\n...\nlast line of code'), ['first line of code', 'last line of code']);
  });
  await test('a note with no snippet is weak: the files exist, and that is all that can be said', () => {
    const r = V.staticChecks(fixOf({ snippet: null }), { website: repo({ 'archviz/app.js': FILE }) });
    assert.equal(r.weak, true); assert.equal(r.hardFail, false);
  });
  await test('nothing to look at: no files named, or no checkout set up for that repo, means "skipped"', () => {
    assert.ok(V.staticChecks(fixOf({ files: [], snippet: null }), { website: repo({}) }).skipped);
    assert.ok(V.staticChecks(fixOf(), {}).skipped);
    assert.ok(V.staticChecks(fixOf({ repo: 'app' }), { website: repo({ 'archviz/app.js': FILE }) }).skipped);
    assert.ok(V.staticChecks(null, {}).skipped);
  });
  await test('only files inside the checkout are read: parent folders, absolute paths and drive letters are refused', () => {
    const root = repo({ 'archviz/app.js': FILE }), outside = repo({ 'secret.js': 'const KEY = "nope";' });
    for (const rel of ['../' + path.basename(outside) + '/secret.js', '..\\x.js', '/etc/passwd.js', 'C:/Windows/x.js', 'a/../../x.js', outside.split(path.sep).join('/') + '/secret.js']) {
      assert.ok(V.readInRoot(root, rel).error, 'should refuse ' + rel);
    }
    assert.ok(V.readInRoot(root, 'archviz/app.js').text);
  });
  await test('keys, env files, credentials, logs, the CRM and the QA store are never read, even inside the checkout', () => {
    const names = ['admin.key', 'qa.key', 'devconsole-github.key', '.env', 'turn_creds.env', 'get_cf_turn_creds.ps1', 'vault.json', 'auth.json', 'sales-data.json', 'qa-data.json', 'bridge.json', 'leads-log.jsonl', 'session-log.jsonl', 'node_modules/x/index.js', '.git/config', 'secrets.js', 'cert.pem', 'launcher-server.log'];
    const root = repo(Object.fromEntries([...names, 'ok.js'].map((n) => [n, 'content'])));
    for (const n of names) assert.ok(V.readInRoot(root, n).error, 'must not read ' + n);
    assert.equal(V.readInRoot(root, 'ok.js').text, 'content');
  });
  await test('a symbolic link that leaves the checkout is not followed', () => {
    const root = repo({}), outside = repo({ 'target.js': 'const SECRET = 1;' });
    try { fs.symlinkSync(path.join(outside, 'target.js'), path.join(root, 'link.js')); } catch (e) { console.log('       (symlinks not available here: skipped)'); return; }
    assert.ok(V.readInRoot(root, 'link.js').error);
  });
  await test('a file that is too large is not read; a file I may not read is "not checked", never a failure', () => {
    const root = repo({ 'big.js': 'x'.repeat(2 * 1024 * 1024 + 10), 'archviz/app.js': FILE });
    assert.equal(V.readInRoot(root, 'big.js').error, 'too large');
    const r = V.staticChecks(fixOf({ files: ['archviz/app.js', 'admin.key'] }), { website: root });
    assert.equal(r.hardFail, false); assert.ok(r.checks.some((c) => c.ok === null && /not checked/.test(c.detail)));
    assert.ok(V.staticChecks(fixOf({ files: ['admin.key'], snippet: null }), { website: root }).skipped);
  });

  console.log('the model\'s answer');
  await test('the verdict is read from the two-line answer; NOT_VERIFIED is never read as VERIFIED', () => {
    assert.equal(V.parseVerdict('VERDICT: VERIFIED\nREASON: The handler is attached.').verdict, 'verified');
    assert.equal(V.parseVerdict('VERDICT: NOT_VERIFIED\nREASON: Nothing changed.').verdict, 'not_verified');
    assert.equal(V.parseVerdict('verdict - not verified').verdict, 'not_verified');
    assert.equal(V.parseVerdict('VERDICT: UNSURE\nREASON: too little code').verdict, 'unsure');
    assert.equal(V.parseVerdict('VERDICT: VERIFIED\nREASON: The handler is attached.').reason, 'The handler is attached.');
  });
  await test('thinking tags, code fences, an unreadable answer or a contradiction can only ever mean "unsure"', () => {
    assert.equal(V.parseVerdict('<think>maybe VERDICT: NOT_VERIFIED</think>\nVERDICT: VERIFIED\nREASON: ok').verdict, 'verified');
    assert.equal(V.parseVerdict('```\nVERDICT: VERIFIED\n```').verdict, 'verified');
    assert.equal(V.parseVerdict('The fix looks great!').verdict, 'unsure');
    assert.equal(V.parseVerdict('').verdict, 'unsure');
    assert.equal(V.parseVerdict(undefined).verdict, 'unsure');
    assert.equal(V.parseVerdict('VERDICT: VERIFIED\nVERDICT: NOT_VERIFIED').verdict, 'unsure');
  });
  const passing = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': FILE }) });
  await test('what is recorded: only a hard static failure reopens; only static pass + the model agreeing verifies', () => {
    const verdicts = (st, m) => V.combine(st, m).result;
    assert.equal(verdicts(passing, V.parseVerdict('VERDICT: VERIFIED\nREASON: yes')), 'verified');
    assert.equal(verdicts(passing, V.parseVerdict('VERDICT: NOT_VERIFIED\nREASON: no')), 'unsure');        // a doubt from the model alone never reopens
    assert.equal(verdicts(passing, V.parseVerdict('VERDICT: UNSURE')), 'unsure');
    assert.equal(verdicts(passing, null), 'unsure');                                                       // the model did not run
    const hard = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': 'nothing\n' }) });
    assert.equal(verdicts(hard, V.parseVerdict('VERDICT: VERIFIED\nREASON: yes')), 'failed');            // the model cannot overrule the file
    const soft = V.staticChecks(fixOf(), { website: repo({ 'archviz/app.js': FILE + OLD + '\n' }) });
    assert.equal(verdicts(soft, V.parseVerdict('VERDICT: VERIFIED\nREASON: yes')), 'unsure');
    assert.equal(verdicts({ skipped: 'x' }, null), 'unsure');
    assert.equal(verdicts({ checks: [], weak: true, hardFail: false }, null), 'unsure');
  });
  await test('the prompt carries this ticket\'s note and the file as it is now, marks them as data, and stays small', () => {
    const b = fixedTicket({ context: 'Runs on drag.' }), st = V.staticChecks(b.fix, { website: repo({ 'archviz/app.js': FILE }) });
    const m = V.buildMessages(b, st), text = m.map((x) => x.content).join('\n');
    assert.equal(m[0].role, 'system'); assert.match(m[0].content, /EXACTLY two lines/); assert.match(m[0].content, /never instructions/);
    for (const s of ['Slide-unlock sticks on iOS', b.fix.rootCause, 'onpointerdown', '<<<DATA', '<<<END DATA>>>', 'Runs on drag.']) assert.ok(text.includes(s), 'missing: ' + s);
    assert.ok(text.length < 7000, 'prompt is ' + text.length + ' characters');
  });

  console.log('the sweep');
  const mk = (roots, clock = () => NOW) => { const dir = tmp(), taskio = createTaskio({ dir, now: clock }); const list = []; const queued = []; const v = V.createVerifier({ tickets: store(list), taskio, rootsOf: () => roots, now: clock, kick: () => queued.push('kick') }); return { dir, taskio, list, v, queued }; };
  await test('a fix that is not in the code is settled at once: failed, reopened, no model asked', () => {
    const w = mk({ website: repo({ 'archviz/app.js': 'nothing here\n' }) }), b = fixedTicket(); w.list.push(b);
    const r = w.v.sweep();
    assert.equal(r.recorded, 1); assert.equal(r.queued, 0); assert.equal(b.verification.result, 'failed'); assert.equal(b.status, 'open'); assert.equal(b.verification.by, 'Vera');
    assert.equal(w.taskio.openJobs().length, 0);
    assert.equal(T.queueState(b), 'reopened');
  });
  await test('a fix with nothing to check is "unsure" at once and stays fixed', () => {
    const w = mk({}), b = fixedTicket(); w.list.push(b);
    w.v.sweep(); assert.equal(b.verification.result, 'unsure'); assert.equal(b.status, 'fixed');
  });
  await test('a fix that is in the code is queued for the local model: one job, right area, tied to the ticket and revision', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }), b = fixedTicket(); w.list.push(b);
    const r = w.v.sweep({ priority: 3 });
    assert.equal(r.queued, 1); assert.equal(b.verification, null, 'no verdict until the model has answered');
    const jobs = w.taskio.openJobs(); assert.equal(jobs.length, 1);
    const j = jobs[0]; assert.equal(j.handler, 'verify'); assert.equal(j.ref, b.id + '@1'); assert.equal(j.area, 'verify'); assert.equal(j.persona, 'Vera'); assert.equal(j.priority, 3); assert.equal(j.source, 'bridge'); assert.equal(j.job.confidential, false);
    assert.ok(w.queued.includes('kick'));
  });
  await test('the nightly sweep queues as a routine task (runs inside the window); a fix-time one runs at any hour', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }); w.list.push(fixedTicket());
    w.v.sweep(); const j = w.taskio.openJobs()[0]; assert.equal(j.source, 'routine'); assert.equal(j.priority, 0);
  });
  await test('the same revision is not queued twice, nor retried within 12 hours of a failed attempt', () => {
    let clock = NOW;
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }, () => clock), b = fixedTicket(); w.list.push(b);
    w.v.sweep(); w.v.sweep(); assert.equal(w.taskio.openJobs().length, 1, 'still just one');
    const id = w.taskio.openJobs()[0].id; w.taskio.patchTask(id, { status: 'failed', error: 'x' });
    clock = NOW + 3 * 3600000;
    const again = w.v.sweep(); assert.equal(again.queued, 0, 'three hours after a failed attempt it is not tried again'); assert.equal(w.taskio.openJobs().length, 0);
    clock = NOW + 13 * 3600000;
    assert.equal(w.v.sweep().queued, 1, 'after twelve hours it is');
  });
  await test('a ticket she already verified is never looked at again, but a new fix note is new work', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }), b = fixedTicket(); w.list.push(b);
    T.addVerification(b, { result: 'verified', fixRev: 1, by: 'Vera' }, { now: NOW });
    const r = w.v.sweep(); assert.equal(r.considered, 0); assert.equal(w.taskio.openJobs().length, 0);
    T.addFix(b, { repo: 'website', commit: 'abcdef2', files: ['archviz/app.js'], rootCause: 'again', solution: 'again', snippet: { file: 'archviz/app.js', after: NEW } }, { now: NOW });
    assert.equal(w.v.sweep().queued, 1);
  });
  await test('tickets that are open, in progress, closed or fixed by hand (no note) are left alone; "only" and "limit" are honoured', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) });
    const open = ticket(), prog = ticket(); T.patch(prog, { status: 'in_progress' }, { now: NOW });
    const hand = ticket(); T.patch(hand, { status: 'fixed' }, { now: NOW });
    const many = Array.from({ length: 7 }, () => fixedTicket());
    w.list.push(open, prog, hand, ...many);
    assert.equal(w.v.sweep({ limit: 3 }).queued, 3);
    const one = mk({ website: repo({ 'archviz/app.js': FILE }) }); one.list.push(...many.map((b) => T.normalize(b)));
    assert.equal(one.v.sweep({ only: many[0].id }).queued, 1);
  });

  console.log('the answer comes back');
  const done = (b, text, over) => ({ id: 'tk_x', handler: 'verify', ref: b.id + '@' + b.fixRev, status: 'done', result: { text }, ...over });
  await test('a VERIFIED answer on a fix that is in the code verifies the ticket', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }), b = fixedTicket(); w.list.push(b);
    assert.equal(w.v.handleDone(done(b, 'VERDICT: VERIFIED\nREASON: Pointer events are used.')), true);
    assert.equal(b.verification.result, 'verified'); assert.equal(b.verification.method, 'static + local model'); assert.equal(T.queueState(b), 'verified'); assert.match(b.verification.summary, /Pointer events are used/);
  });
  await test('the files are checked again when the answer arrives: a change made in between wins over the model', () => {
    const root = repo({ 'archviz/app.js': FILE }), w = mk({ website: root }), b = fixedTicket(); w.list.push(b);
    fs.writeFileSync(path.join(root, 'archviz/app.js'), 'reverted\n');
    w.v.handleDone(done(b, 'VERDICT: VERIFIED\nREASON: fine')); assert.equal(b.verification.result, 'failed'); assert.equal(b.status, 'open');
  });
  await test('an answer for an old revision, a missing ticket, someone else\'s task or an already verified ticket is dropped', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }), b = fixedTicket(); w.list.push(b);
    assert.equal(w.v.handleDone(done(b, 'VERDICT: VERIFIED', { ref: b.id + '@7' })), false);
    assert.equal(w.v.handleDone(done(b, 'VERDICT: VERIFIED', { ref: 'bug_ffffffffffff@1' })), false);
    assert.equal(w.v.handleDone(done(b, 'VERDICT: VERIFIED', { handler: undefined })), false);
    assert.equal(w.v.handleDone(null), false); assert.equal(b.verification, null);
    w.v.handleDone(done(b, 'VERDICT: VERIFIED\nREASON: ok')); assert.equal(w.v.handleDone(done(b, 'VERDICT: NOT_VERIFIED')), false); assert.equal(b.verification.result, 'verified');
  });
  await test('the dispatcher hands a finished task to the verifier, and only a successful one', async () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }), b = fixedTicket(); w.list.push(b);
    w.v.sweep({ priority: 3 });
    const dev = { id: 'pc1', online: true, alias: 'PC-1', stats: { model: { windowActive: true } } };
    let status = 'running';
    const hub = { devices: () => [dev], renderBusyOf: () => false, reservedOf: () => false, aiCapable: () => true, aiReady: () => true, load: () => 0,
      submitTo: async () => ({ jobId: 'j1' }), jobOn: async () => ({ ok: true, job: { status, result: { text: 'VERDICT: VERIFIED\nREASON: Done.', tokens: 5 }, startedAt: 1, doneAt: 2, error: 'boom' } }), modelAction: async () => ({ ok: true }) };
    const d = createDispatcher({ hub, taskio: w.taskio, onDone: (t) => w.v.handleDone(t), maxAttempts: 1 });
    await d.tick(); assert.equal(w.taskio.openJobs()[0].status, 'running'); assert.equal(b.verification, null);
    status = 'failed'; await d.tick(); assert.equal(b.verification, null, 'a failed job verifies nothing');
    assert.equal(w.taskio.openJobs().length, 0);
    const w2 = mk({ website: repo({ 'archviz/app.js': FILE }) }), b2 = fixedTicket(); w2.list.push(b2); w2.v.sweep({ priority: 3 });
    status = 'running'; const d2 = createDispatcher({ hub, taskio: w2.taskio, onDone: (t) => w2.v.handleDone(t) });
    await d2.tick(); status = 'done'; await d2.tick(); assert.equal(b2.verification.result, 'verified');
    const d3 = createDispatcher({ hub, taskio: w2.taskio, onDone: () => { throw new Error('handler blew up'); } });
    await d3.tick();                                                    // an error in the handler must not break the dispatcher
  });
  await test('a web request cannot create a task that the verifier will act on', () => {
    const dir = tmp(), taskio = createTaskio({ dir, now: () => NOW });
    const r = taskio.createTask({ title: 'x', lane: 'human', handler: 'verify', ref: 'bug_aaaaaaaaaaaa@1' });
    assert.equal(r.ok, true);                                           // the store itself keeps the field (the verifier sets it), the route strips it:
    const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    assert.ok(/source: 'manual', job: undefined, proposal: undefined, handler: undefined/.test(idx), 'POST /api/taskio/task must drop "handler"');
  });

  await test('the launcher glue hands finished tasks to Vera, gives her the routines, and strips "handler" from web-made tasks', () => {
    const idx = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    assert.ok(/onDone: \(t\) => verifier\.handleDone\(t\)/.test(idx), 'the dispatcher must call verifier.handleDone');
    assert.ok(/createRoutines\(\{[^}]*verifier \}\)/.test(idx), 'the routines must be given the verifier');
    assert.ok(/verifier, stop:/.test(idx), 'the launcher reaches the verifier through bridge.verifier (the fix route sweeps with it)');
    assert.ok(/const roots = \{ launcher: dir,/.test(idx) && /path\.isAbsolute\(v\) && fs\.existsSync\(v\)/.test(idx), 'only absolute folders that exist are ever read');
  });

  console.log('routines');
  await test('Vera\'s routines are local-lane actions: verify nightly, pick a regression weekly', () => {
    const { ROUTINES } = require('./routines');
    const ids = ROUTINES.filter((r) => r.persona === 'Vera').map((r) => [r.id, r.kind, r.schedule, r.area]);
    assert.deepEqual(ids, [['vera-verify', 'action', 'nightly', 'verify'], ['vera-regression', 'action', 'weekly', 'verify']]);
    assert.equal(policy.lanes.verify, 'local'); assert.ok(!policy.confidentialAreas.includes('verify'));
  });
  await test('the routine runner reports what Vera did, skips quietly when there is nothing to do, and refuses a non-local area', () => {
    const w = mk({ website: repo({ 'archviz/app.js': FILE }) }), r = createRoutines({ taskio: w.taskio, dir: w.dir, policy, now: () => NOW, verifier: w.v });
    let res = r.run('vera-verify'); assert.equal(res.ok, true); assert.ok(res.skipped, 'nothing waiting');
    w.list.push(fixedTicket()); res = r.run('vera-verify'); assert.match(res.summary, /1 fixed ticket/);
    assert.match(r.list().find((x) => x.id === 'vera-verify').lastResult, /1 fixed ticket/);
    assert.equal(r.list().find((x) => x.id === 'vera-verify').lane, 'local');
    const noVerifier = createRoutines({ taskio: w.taskio, dir: tmp(), policy, now: () => NOW });
    assert.ok(noVerifier.run('vera-verify').skipped);
    const cloudy = createRoutines({ taskio: w.taskio, dir: tmp(), policy: { ...policy, lanes: { ...policy.lanes, verify: 'cloud' } }, now: () => NOW, verifier: w.v });
    assert.equal(cloudy.run('vera-verify').ok, false);
  });

  console.log('regression picks');
  const lib = []; for (const [comp, n] of [['C01', 12], ['C02', 8], ['C03', 6], ['C04', 3]]) for (let i = 1; i <= n; i++) lib.push({ id: comp + '-' + i, component: comp, title: 't', priority: ['Critical', 'High', 'Medium', 'Low'][i % 4], type: i % 5 === 0 ? 'Smoke' : 'Functional', status: 'Active' });
  const mkReg = (opts = {}) => { const dir = tmp(), taskio = createTaskio({ dir, now: () => NOW }), added = [], list = opts.history || [];
    const v = V.createVerifier({ tickets: store(opts.tickets || []), taskio, getCases: () => opts.cases || lib, regressions: { list: () => list, add: (r) => { added.push(r); list.unshift(r); } }, now: () => NOW, rand: opts.rand || prng(opts.seed || 3) });
    return { v, taskio, added }; };
  await test('a pick is one feature cluster with 5 to 10 of its own cases, most important first, recorded in Task-IO', () => {
    for (let s = 1; s <= 25; s++) {
      const w = mkReg({ seed: s }), r = w.v.suggestRegression({ force: true });
      assert.ok(r.suggestion, 'a suggestion'); const x = r.suggestion;
      assert.ok(x.caseIds.length >= 5 && x.caseIds.length <= 10, 'size ' + x.caseIds.length);
      assert.ok(x.caseIds.every((id) => id.startsWith(x.cluster.id + '-')), 'all from ' + x.cluster.id); assert.notEqual(x.cluster.id, 'C04', 'a cluster with 3 cases is too small');
      assert.equal(new Set(x.caseIds).size, x.caseIds.length); assert.equal(x.status, 'suggested'); assert.match(x.name, /^EG-REG-c0\d-20261025$/);
      assert.equal(w.added.length, 1); assert.ok(w.taskio.day('2026-10-25').tasks.some((t) => t.persona === 'Vera' && /Regression run suggested/.test(t.title)));
    }
    const first = mkReg({ seed: 7 }).v.suggestRegression({ force: true }).suggestion, prio = (id) => lib.find((c) => c.id === id).priority;
    assert.ok(['Critical', 'High'].includes(prio(first.caseIds[0])), 'the first case is an important one');
  });
  await test('it is sporadic: a call picks nothing about half the time, and never while one is still waiting', () => {
    assert.ok(mkReg({ rand: () => 0.9 }).v.suggestRegression({}).skipped);
    assert.ok(mkReg({ rand: () => 0.1 }).v.suggestRegression({}).suggestion);
    const waiting = [{ id: 'reg_1', status: 'suggested', at: new Date(NOW - 3 * 86400000).toISOString(), cluster: { id: 'C01' } }];
    assert.match(mkReg({ history: waiting }).v.suggestRegression({}).skipped, /already waiting/);
    const stale = [{ id: 'reg_1', status: 'suggested', at: new Date(NOW - 30 * 86400000).toISOString(), cluster: { id: 'C01' } }];
    assert.ok(mkReg({ history: stale, rand: () => 0.1 }).v.suggestRegression({}).suggestion, 'an old, ignored suggestion does not block new ones');
  });
  await test('clusters near a recent fix are favoured and the cases the fix came from are picked first', () => {
    const b = fixedTicket({}, { source: { run: 'V1.1', caseId: 'C03-3', result: 'Fail' } });
    let hits = 0; for (let s = 1; s <= 40; s++) { const x = mkReg({ tickets: [b], seed: s }).v.suggestRegression({ force: true }).suggestion; if (x.cluster.id === 'C03') { hits++; assert.equal(x.caseIds[0], 'C03-3'); assert.match(x.reason, /fix/); } }
    const base = (() => { let n = 0; for (let s = 1; s <= 40; s++) if (mkReg({ seed: s }).v.suggestRegression({ force: true }).suggestion.cluster.id === 'C03') n++; return n; })();
    assert.ok(hits > base, 'C03 picked ' + hits + ' times with a fix near it, ' + base + ' without');
  });
  await test('a cluster picked recently is less likely than one that was never picked', () => {
    const hist = [{ id: 'reg_1', status: 'started', at: new Date(NOW - 2 * 86400000).toISOString(), cluster: { id: 'C01' } }];
    let c01 = 0, plain = 0; for (let s = 1; s <= 60; s++) { if (mkReg({ history: [...hist], seed: s }).v.suggestRegression({ force: true }).suggestion.cluster.id === 'C01') c01++; if (mkReg({ seed: s }).v.suggestRegression({ force: true }).suggestion.cluster.id === 'C01') plain++; }
    assert.ok(c01 < plain, 'C01 picked ' + c01 + ' times right after a pick, ' + plain + ' otherwise');
  });
  await test('an empty library, retired cases and tiny clusters give no pick instead of an error', () => {
    assert.ok(mkReg({ cases: [] }).v.suggestRegression({ force: true }).skipped);
    assert.ok(mkReg({ cases: lib.map((c) => ({ ...c, status: 'Retired' })) }).v.suggestRegression({ force: true }).skipped);
    assert.ok(mkReg({ cases: lib.filter((c) => c.component === 'C04') }).v.suggestRegression({ force: true }).skipped);
  });

  console.log('\n' + results.filter((r) => r[0]).length + ' passed, ' + results.filter((r) => !r[0]).length + ' failed');
  process.exit(results.some((r) => !r[0]) ? 1 : 0);
})().catch((e) => { console.error('test run crashed:', e); process.exit(1); });
