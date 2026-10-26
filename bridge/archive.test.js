#!/usr/bin/env node
'use strict';
// Tests for the Archivist across the bridge: the node agent (job type, endpoints, who may run it), the hub proxy, the dispatcher's pin to PC-1, the launcher's
// archive.js and its routes. Real agents and a real hub over loopback; the model is a fake llama-server that answers in JSON.
//   node bridge/archive.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./protocol');
const { createAgent } = require('./node-agent');
const { createHub } = require('./hub');
const { createTaskio } = require('./taskio');
const { createDispatcher } = require('./dispatcher');
const { createArchive } = require('./archive.js');
const policy = require('./policy');
const bridge = require('./index');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 6000, step = 40) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; };
const KEY = 'd'.repeat(64);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-archive-test-'));
const gpu = (util) => async () => ({ name: 'Fake RTX 3060', utilPct: util, vramUsedGB: 2, vramTotalGB: 12, tempC: 50 });
const put = (root, rel, data) => { const f = path.join(root, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); };
const LOREM = (t, n = 40) => Array.from({ length: n }, (_, i) => t + ' word' + (i % 13) + ' detail' + (i % 5)).join(' ');

// a model server that answers the Archivist's questions in JSON (optionally slowly), and keeps what it was asked
function fakeLlama(opts = {}) {
  const state = { calls: 0, prompts: [], delayMs: opts.delayMs || 0 };
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => setTimeout(() => {
        state.calls++; const msgs = (JSON.parse(b || '{}').messages || []), sys = (msgs[0] || {}).content || '', user = (msgs[msgs.length - 1] || {}).content || ''; state.prompts.push(sys + '\n' + user);
        const topic = /cancun/i.test(user) ? 'Cancun trip' : /essay/i.test(user) ? 'School essay' : 'Notes';
        const content = /group labels/.test(sys) ? JSON.stringify({ projects: [{ name: 'All', description: '', labels: [] }] }) : /ONE folder/.test(sys) ? JSON.stringify({ summary: 'Pictures of the ' + topic, topic: 'pictures', project: topic }) : JSON.stringify({ summary: 'About ' + topic, topic, project: topic, tags: ['a'] });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { completion_tokens: 9 } }));
      }, state.delayMs));
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, state, close: () => new Promise((r) => { s.close(r); s.closeAllConnections && s.closeAllConnections(); }) }));
  });
}

(async () => {
  // PC-A: the launcher PC (source "local") with the Archivist ON for one root. PC-B: another PC, Archivist off. Both could run an ordinary prompt.
  const root = tmp(), outside = tmp();
  put(root, 'Trip Cancun/notes.txt', LOREM('cancun hotel beach')); put(root, 'Trip Cancun/plan.md', LOREM('cancun tours flights')); put(root, 'Trip Cancun/photos/IMG_1.jpg', Buffer.from('jpgjpgjpg'.repeat(50))); put(root, 'School/essay.txt', LOREM('essay on currents')); put(root, 'dup/a.txt', LOREM('same text', 30)); put(root, 'dup/b.txt', LOREM('same text', 30));
  put(outside, 'private/diary.txt', LOREM('not for you'));
  const llA = await fakeLlama({ delayMs: 25 }), llB = await fakeLlama(), llC = await fakeLlama({ delayMs: 200 }), archiveCfgA = { enabled: true, roots: [root] }, archiveCfgB = { enabled: false, roots: [root] };
  const rootC = tmp(); for (let i = 0; i < 10; i++) put(rootC, 'c' + i + '.txt', LOREM('slice doc ' + i, 30));
  const mkNode = (alias, ll, util, extra = {}) => createAgent({ key: KEY, alias, port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(util), statsMs: 100, llamaUrl: 'http://127.0.0.1:' + ll.port, model: 'q', render: { ports: [] }, archiveDir: path.join(tmp(), 'archive'), ...extra });
  const A = mkNode('PC-1', llA, 40, { archive: archiveCfgA }), B = mkNode('PC-2', llB, 1, { archive: archiveCfgB });     // B is the less loaded PC and even lists the folder: it still must not run it
  const C = mkNode('PC-3', llC, 40, { archive: { enabled: true, roots: [rootC] }, archiveSliceMs: 500 });                 // a PC with a very short slice, to see a slice end
  const pa = await A.start(), pb = await B.start(), pc = await C.start();
  const dir = tmp(), hubState = { render: 'stopped' };
  const hub = createHub({ dir, key: KEY, getRenderState: () => hubState.render, targets: [{ host: '127.0.0.1', port: pa, source: 'local' }, { host: '127.0.0.1', port: pb, source: 'configured' }] });
  const taskio = createTaskio({ dir, getProspects: () => [], getBugs: () => [] });
  const arch = createArchive({ taskio, hub });
  const disp = createDispatcher({ hub, taskio, pollMs: 50, onDone: (t) => arch.handleDone(t) });
  await hub.refresh();
  const call = async (port, method, p, b) => { const body = b ? JSON.stringify(b) : ''; const r = await fetch('http://127.0.0.1:' + port + p, { method, headers: { ...P.signRequest(KEY, method, p, body), ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  const step = async () => { await hub.refresh(); await disp.tick(); };
  const finish = async (id, ms = 15000) => until(async () => { await step(); const t = taskio.getTask(id); return t && (t.status === 'done' || t.status === 'failed'); }, ms, 60);

  console.log('the node agent');
  await test('only a PC whose own config turns the Archivist on will run a scan; the others refuse the job and hide the endpoints', async () => {
    const job = { type: 'archive.scan', params: { path: root } };
    const off = await call(pb, 'POST', '/v1/jobs', job); assert.equal(off.status, 400); assert.match(off.json.error, /does not run the Archivist/);
    for (const p of ['/v1/archive/roots', '/v1/archive/runs']) assert.equal((await call(pb, 'GET', p)).status, 404, p);
    assert.equal((await call(pb, 'GET', '/v1/stats')).json.archive.enabled, false); assert.equal((await call(pa, 'GET', '/v1/stats')).json.archive.enabled, true);
    const on = await call(pa, 'POST', '/v1/jobs', job); assert.equal(on.status, 202); assert.ok(await until(async () => (await call(pa, 'GET', '/v1/jobs/' + on.json.jobId)).json.job.status === 'done', 15000));
    assert.equal((await call(pa, 'GET', '/v1/jobs/' + on.json.jobId)).json.job.confidential, true, 'a scan is confidential on the PC even when the request does not say so');
    const bare = await fetch('http://127.0.0.1:' + pa + '/v1/archive/runs'); assert.equal(bare.status, 401, 'an unsigned request is refused like every other');
  });
  await test('the folder in a request is checked against the PC\'s own list: outside it, relative, a file, or a link out are refused before any job exists', async () => {
    for (const [p, re] of [[outside, /allowed list/], ['relative/dir', /full local path/], [path.join(root, 'nope'), /does not exist/], [path.join(root, 'School', 'essay.txt'), /file, not a folder/], [path.join(root, '..'), /allowed list/]]) {
      const r = await call(pa, 'POST', '/v1/jobs', { type: 'archive.scan', params: { path: p } }); assert.equal(r.status, 400, p); assert.match(r.json.error, re, p);
      const c = await call(pa, 'POST', '/v1/archive/check', { path: p }); assert.equal(c.status, 400); assert.ok(c.json.code);
    }
    assert.match((await call(pa, 'POST', '/v1/archive/check', { path: outside })).json.error, /archive-allow\.js/, 'it says how to allow a folder');
    assert.equal((await call(pa, 'POST', '/v1/archive/check', { path: root })).status, 200);
    for (const bad of [{ type: 'archive.scan' }, { type: 'archive.scan', params: { path: 5 } }, { type: 'archive.scan', params: { path: root, runId: '../x' } }, { type: 'archive.scan', params: [] }]) assert.equal((await call(pa, 'POST', '/v1/jobs', bad)).status, 400, JSON.stringify(bad));
  });
  await test('editing the allowed list takes effect at once, without a restart, and removing a folder stops further reads of it', async () => {
    const extra = tmp(); put(extra, 'x.txt', LOREM('extra folder')); assert.equal((await call(pa, 'POST', '/v1/archive/check', { path: extra })).status, 400);
    archiveCfgA.roots = [...archiveCfgA.roots, extra];                            // a NEW list, like the config file read again: a list kept from the start would not see this
    assert.equal((await call(pa, 'POST', '/v1/archive/check', { path: extra })).status, 200); assert.deepEqual((await call(pa, 'GET', '/v1/archive/roots')).json.roots, [root, extra]);
    archiveCfgA.roots = archiveCfgA.roots.filter((r) => r !== extra); assert.equal((await call(pa, 'POST', '/v1/archive/check', { path: extra })).status, 400);
  });

  console.log('a scan through the launcher');
  await test('a scan is pinned to PC-1 even when PC-2 is idle, runs there with progress, and leaves a readable catalog', async () => {
    llA.state.delayMs = 250;                                                     // slow enough for the page's 3-second-style polling to see a file being read
    const started = await arch.start({ path: root, fresh: true }); assert.equal(started.ok, true, JSON.stringify(started)); const id = started.taskId;       // fresh: the folder was already scanned above, and a plain scan would just resume that finished run
    const t0 = taskio.getTask(id); assert.equal(t0.area, 'archive'); assert.equal(t0.persona, 'Mole'); assert.equal(t0.lane, 'local'); assert.equal(t0.source, 'archive'); assert.ok(!('job' in t0), 'the path stays server-side');
    assert.ok(t0.title.endsWith(path.basename(root)) && !t0.title.includes(path.dirname(root)), 'the title carries the last folder name only');
    let sawProgress = false; const seen = new Set(); assert.ok(await until(async () => { await step(); const t = taskio.getTask(id); seen.add(t.status + ': ' + (t.detail || '').slice(0, 50)); if (/Reading files \d+\/\d+/.test(t.detail || '')) sawProgress = true; return t.status === 'done'; }, 20000, 40));
    llA.state.delayMs = 25;
    const done = taskio.getTask(id); assert.equal(done.result.deviceId, hub.devices().find((d) => d.alias === 'PC-1').id, 'ran on PC-1'); assert.equal(llB.state.calls, 0, 'PC-2\'s model was never touched');
    assert.ok(sawProgress, 'Task-IO showed which file it was reading; saw: ' + [...seen].join(' | ')); assert.match(done.detail, /^Done: \d+ files catalogued/); assert.match(done.ref, /^ar_[0-9a-f]{10}(_\d+)?$/);
    const runs = await arch.runs(); assert.equal(runs.ok, true); assert.equal(runs.runs[0].runId, done.ref); assert.equal(runs.runs[0].status, 'done');
    const sm = (await arch.run(done.ref)).summary; assert.ok(sm.counts.files >= 6 && sm.projects.some((p) => p.name === 'Cancun trip') && sm.duplicates.exact.some((g) => g.files.length === 2));
    const f = await arch.files(done.ref, { dir: 'Trip Cancun', limit: 10 }); assert.ok(f.ok && f.files.length === 2 && f.files.every((x) => x.dir === 'Trip Cancun'));
    assert.equal((await arch.run('../../etc')).ok, false); assert.equal((await arch.files('nope', {})).ok, false);
  });
  await test('a folder that is not allowed is answered at once with what to do, and no task is made', async () => {
    const before = taskio.openJobs().length, r = await arch.start({ path: outside });
    assert.equal(r.ok, false); assert.match(r.error, /allowed list/); assert.match(r.error, /archive-allow\.js/); assert.equal(taskio.openJobs().length, before);
    for (const bad of ['', '   ', 'relative', 'x'.repeat(600), 'D:\\a\u0000b']) assert.equal((await arch.start({ path: bad })).ok, false, JSON.stringify(bad).slice(0, 30));
  });
  await test('the same folder cannot be queued twice; a scan nobody can run (PC-1 off or not enabled) waits instead of going to another PC', async () => {
    const first = await arch.start({ path: path.join(root, 'School'), fresh: true }); assert.equal(first.ok, true); const dup = await arch.start({ path: path.join(root, 'School') }); assert.equal(dup.ok, false); assert.equal(dup.code, 'busy');
    assert.ok(await finish(first.taskId));
    archiveCfgA.enabled = false; await hub.refresh(); await sleep(150); await hub.refresh();
    const r = await arch.start({ path: root }); assert.equal(r.ok, false); assert.match(r.error, /only on PC-1/);
    const st = await arch.status(); assert.equal(st.enabled, false);
    const queued = taskio.createTask({ title: 'pinned', persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', priority: 5, job: { type: 'archive.scan', params: { path: root, fresh: true } } }).task.id;
    for (let i = 0; i < 5; i++) { await step(); await sleep(60); } assert.equal(taskio.getTask(queued).status, 'queued', 'PC-2 is free and idle but does not take it'); assert.equal(llB.state.calls, 0);
    archiveCfgA.enabled = true; assert.ok(await finish(queued, 20000)); assert.equal(taskio.getTask(queued).result.deviceId, hub.devices().find((d) => d.alias === 'PC-1').id);
  });
  await test('the launcher talks to the Archivist only on PC-1 and only on archive paths, whatever another PC says about itself', async () => {
    const d1 = hub.devices().find((d) => d.alias === 'PC-1'), d2 = hub.devices().find((d) => d.alias === 'PC-2');
    await assert.rejects(() => hub.archiveCall(d2.id, 'GET', '/v1/archive/runs'), /only on the launcher PC/);
    for (const bad of ['/v1/jobs', '/v1/archive/../jobs', '/v1/archive/runs/..', '/v1/archive/x\r\nHost: y', 'v1/archive/runs', '/v1/archive']) await assert.rejects(() => hub.archiveCall(d1.id, 'GET', bad), /bad archive request/, JSON.stringify(bad));
    archiveCfgA.enabled = false; archiveCfgB.enabled = true; await hub.refresh(); await sleep(150); await hub.refresh();
    assert.equal(hub.archiveDevice(), null, 'PC-2 says it runs the Archivist, but it is not the launcher PC: nobody does');
    archiveCfgA.enabled = true; archiveCfgB.enabled = false; await hub.refresh(); await sleep(150); await hub.refresh();
    assert.equal(hub.archiveDevice().id, d1.id, 'PC-1 again');
  });
  await test('a slice ends when its time is up: the PC says the scan is not finished, and a job with the run id carries on', async () => {
    const wait = async (id) => { await until(async () => ['done', 'failed'].includes((await call(pc, 'GET', '/v1/jobs/' + id)).json.job.status), 20000, 80); return (await call(pc, 'GET', '/v1/jobs/' + id)).json.job; };
    const first = await call(pc, 'POST', '/v1/jobs', { type: 'archive.scan', params: { path: rootC, maxFiles: 50 } }); assert.equal(first.status, 202);
    const j1 = await wait(first.json.jobId); assert.equal(j1.status, 'done', j1.error); let dg = JSON.parse(j1.result.text);
    assert.equal(dg.done, false, 'the 0.5 s slice ended before ten files at 0.2 s each'); assert.ok(dg.remaining > 0 && dg.remaining < 10, 'some were read: ' + dg.remaining);
    for (let i = 0; i < 12 && !dg.done; i++) { const next = await call(pc, 'POST', '/v1/jobs', { type: 'archive.scan', params: { path: rootC, maxFiles: 50, runId: dg.runId } }); const j = await wait(next.json.jobId); assert.equal(j.status, 'done', j.error); dg = JSON.parse(j.result.text); }
    assert.equal(dg.done, true); assert.equal(dg.counts.interpretedContent, 10);
  });
  await test('a folder that stopped being allowed after the scan was queued fails the task with the reason, instead of retrying forever', async () => {
    const tmpRoot = tmp(); put(tmpRoot, 'a.txt', LOREM('temp')); archiveCfgA.roots.push(tmpRoot);
    const id = taskio.createTask({ title: 'soon not allowed', persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', priority: 5, job: { type: 'archive.scan', params: { path: tmpRoot } } }).task.id;
    archiveCfgA.roots.pop(); assert.ok(await finish(id, 10000)); const t = taskio.getTask(id); assert.equal(t.status, 'failed'); assert.match(t.error, /allowed list/);
  });
  await test('a client starting to render pauses the scan (the model goes), nothing is lost, and it finishes when the PC is free again', async () => {
    const big = tmp(); archiveCfgA.roots.push(big); for (let i = 0; i < 14; i++) put(big, 'n' + i + '.txt', LOREM('doc ' + i, 30));
    const r = await arch.start({ path: big }); assert.equal(r.ok, true); const id = r.taskId;
    assert.ok(await until(async () => { await step(); return /Reading files [3-9]/.test(taskio.getTask(id).detail || ''); }, 20000, 40), 'it is reading');
    await call(pa, 'POST', '/v1/hint', { render: true, ttlSec: 60 });
    assert.ok(await until(async () => { await step(); const t = taskio.getTask(id); return t.status === 'queued' && /rendering|started rendering|moved/i.test(t.detail || ''); }, 15000, 50), 'back in the queue, not failed');
    const kept = (await arch.runs()).runs[0]; assert.ok(kept && kept.runId, 'the run and its progress are on PC-1');
    await call(pa, 'POST', '/v1/hint', { render: false });
    assert.ok(await finish(id, 30000)); assert.equal(taskio.getTask(id).status, 'done'); const files = (await arch.files(taskio.getTask(id).ref, { limit: 50 })).files; assert.equal(files.length, 14); assert.ok(files.every((f) => f.interpreted === 'content'));
    archiveCfgA.roots.pop();
  });
  await test('cancelling a queued scan dismisses it; cancelling a running one stops it at the next file and keeps what it did, with no continuation', async () => {
    const big = tmp(); archiveCfgA.roots.push(big); for (let i = 0; i < 30; i++) put(big, 'm' + i + '.txt', LOREM('cancel doc ' + i, 30));
    const q = taskio.createTask({ title: 'queued one', persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', priority: 1, job: { type: 'archive.scan', params: { path: big, fresh: true } } }).task.id;
    assert.equal((await arch.cancel(q)).ok, true); assert.equal(taskio.getTask(q).status, 'dismissed');
    const r = await arch.start({ path: big, fresh: true }), id = r.taskId;
    assert.ok(await until(async () => { await step(); return /Reading files [2-9]/.test(taskio.getTask(id).detail || ''); }, 20000, 40));
    assert.equal((await arch.cancel(id)).ok, true);
    assert.ok(await finish(id, 15000)); const t = taskio.getTask(id); assert.equal(t.status, 'done'); assert.match(t.detail, /^Cancelled after \d+ files/);
    assert.ok(!taskio.openJobs().some((x) => x.job && x.job.type === 'archive.scan' && (x.job.params || {}).runId === t.ref), 'a cancelled scan does not continue');
    const f = (await arch.files(t.ref, { limit: 50 })).files; assert.ok(f.filter((x) => x.interpreted === 'content').length >= 2 && f.filter((x) => !x.interpreted).length > 0, 'some done, the rest left alone');
    assert.equal((await arch.cancel('tk_000000000000')).ok, false); assert.equal((await arch.cancel(taskio.createTask({ title: 'not a scan', lane: 'human' }).task.id)).ok, false);
    archiveCfgA.roots.pop();
  });
  await test('a run that is being read cannot be forgotten, from the launcher or straight on the PC; once it is stopped it can', async () => {
    const big = tmp(); archiveCfgA.roots.push(big); for (let i = 0; i < 30; i++) put(big, 'q' + i + '.txt', LOREM('forget doc ' + i, 30)); llA.state.delayMs = 150;
    const r = await arch.start({ path: big, fresh: true }), id = r.taskId; let runId = null;
    assert.ok(await until(async () => { await step(); const t = taskio.getRaw(id); if (t.remote && t.remote.jobId) { const jv = (await call(pa, 'GET', '/v1/jobs/' + t.remote.jobId)).json.job; runId = jv.progress && jv.progress.runId; } return !!runId; }, 20000, 40), 'the PC says which run it is reading');
    assert.equal((await call(pa, 'POST', '/v1/archive/forget', { runId })).status, 409, 'the PC itself refuses'); const viaLauncher = await arch.forget(runId); assert.equal(viaLauncher.ok, false); assert.match(viaLauncher.error, /still being worked on/);
    assert.equal((await arch.cancel(id)).ok, true); assert.ok(await finish(id, 20000)); llA.state.delayMs = 25;
    assert.equal((await arch.forget(runId)).ok, true, 'once nothing is reading it'); assert.equal((await arch.run(runId)).ok, false); archiveCfgA.roots.pop();
  });
  await test('a scan that ended before the folder was finished continues as a NEW task of the same run (once), so other work gets its turn between slices', () => {
    const t1 = taskio.createTask({ title: 'Archive scan: x', persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', priority: 5, job: { type: 'archive.scan', params: { path: root, maxFiles: 77 } } }).task.id;
    const digest = { done: false, status: 'partial', runId: 'ar_0123456789', remaining: 12, counts: { files: 20, interpretedContent: 8, interpretedFolder: 0 }, projects: [], duplicates: { exact: 0, near: 0 } };
    taskio.patchTask(t1, { status: 'done', result: { text: JSON.stringify(digest), tokens: 0, deviceId: 'x', ms: 1 } });
    assert.equal(arch.handleDone(taskio.getRaw(t1)), true); const next = taskio.openJobs().filter((t) => t.job.type === 'archive.scan' && t.job.params.runId === 'ar_0123456789'); assert.equal(next.length, 1);
    assert.equal(next[0].job.params.path, root); assert.equal(next[0].job.params.maxFiles, 77); assert.ok(next[0].ts >= taskio.getRaw(t1).ts, 'at the end of the queue'); assert.match(taskio.getTask(t1).detail, /^Paused after a slice: 12 files/);
    arch.handleDone(taskio.getRaw(t1)); assert.equal(taskio.openJobs().filter((t) => t.job.params.runId === 'ar_0123456789').length, 1, 'not twice');
    for (const t of next) taskio.patchTask(t.id, { status: 'dismissed' });
    for (const stop of [{ ...digest, done: true, status: 'done', remaining: 0 }, { ...digest, status: 'cancelled' }, { ...digest, remaining: 0 }]) { const t2 = taskio.createTask({ title: 'Archive scan: y', persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', job: { type: 'archive.scan', params: { path: root } } }).task.id; taskio.patchTask(t2, { status: 'done', result: { text: JSON.stringify(stop), tokens: 0 } }); arch.handleDone(taskio.getRaw(t2)); }
    assert.equal(taskio.openJobs().filter((t) => t.job.params && t.job.params.runId === 'ar_0123456789').length, 0, 'a finished, cancelled or empty run never continues');
    assert.equal(arch.handleDone(null), false); assert.equal(arch.handleDone(taskio.getRaw(taskio.createTask({ title: 'plain', lane: 'human' }).task.id)), false);
    const junk = taskio.createTask({ title: 'junk result', lane: 'local', job: { type: 'archive.scan', params: { path: root } } }).task.id; taskio.patchTask(junk, { status: 'done', result: { text: '{"runId":"../../x","done":false,"remaining":4}', tokens: 0 } }); assert.equal(arch.handleDone(taskio.getRaw(junk)), false, 'a run id that is not ours is ignored');
  });
  await test('a scan task can only be made for a real folder path, is always local and confidential, and the area cannot be changed', () => {
    assert.equal(taskio.createTask({ title: 'x', lane: 'local', job: { type: 'archive.scan', params: { path: '' } } }).ok, false); assert.equal(taskio.createTask({ title: 'x', lane: 'local', job: { type: 'archive.scan', params: { path: 'a\u0000b' } } }).ok, false);
    const t = taskio.createTask({ title: 'x', lane: 'local', area: 'sales', job: { type: 'archive.scan', params: { path: 'D:\\x', maxFiles: 9e9, sliceMinutes: 999 } } }), raw = taskio.getRaw(t.task.id);
    assert.equal(raw.job.area, 'archive'); assert.equal(raw.job.confidential, true); assert.equal(raw.job.pin, 'local'); assert.equal(raw.job.params.maxFiles, 20000); assert.equal(raw.job.params.sliceMinutes, 30);
    assert.equal(taskio.createTask({ title: 'cloud', lane: 'cloud', job: { type: 'archive.scan', params: { path: 'D:\\x' } } }).task.lane, 'cloud'); assert.equal(taskio.getRaw(taskio.createTask({ title: 'cloud', lane: 'cloud', job: { type: 'archive.scan', params: { path: 'D:\\x' } } }).task.id).job, undefined, 'a cloud-lane task carries no job at all');
    const { laneFor } = require('./hub'); assert.equal(laneFor(policy, 'archive', false), 'local'); assert.equal(laneFor({ ...policy, lanes: { ...policy.lanes, archive: 'cloud' } }, 'archive', false), 'local', 'even a tampered table cannot send it to the cloud'); assert.ok(policy.confidentialAreas.includes('archive')); assert.equal(policy.lanes.archive, 'local');
  });

  console.log('the routes');
  const rd = tmp(); fs.mkdirSync(path.join(rd, 'bridge')); fs.writeFileSync(path.join(rd, 'bridge', 'bridge.key'), KEY); process.env.G741_BRIDGE_KEY_FILE = path.join(rd, 'bridge', 'bridge.key');
  const API = bridge.init({ dir: rd, isAuthed: (req) => req.headers['x-devconsole-key'] === 'k', cors: {}, getProspects: () => [], getBugs: () => [], getRenderState: () => 'stopped', hubOptions: { targets: [{ host: '127.0.0.1', port: pa, source: 'local' }], pollMs: 100, dispatchMs: 60 } });
  const srv = http.createServer((req, res) => { if (!API.handle(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const api = async (m, p, b, key = 'k') => { const r = await fetch(base + p, { method: m, headers: { 'x-devconsole-key': key, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  await until(async () => (await api('GET', '/api/archive/status')).json.enabled === true, 6000);
  await test('every archive route is closed without the Dev Console key (and to the wrong key)', async () => {
    for (const [m, p] of [['GET', '/api/archive/status'], ['GET', '/api/archive/runs'], ['GET', '/api/archive/run?id=x'], ['GET', '/api/archive/files?id=x'], ['POST', '/api/archive/start'], ['POST', '/api/archive/cancel'], ['POST', '/api/archive/forget']]) for (const key of ['wrong', '']) assert.equal((await api(m, p, m === 'POST' ? {} : undefined, key)).status, 401, m + ' ' + p);
  });
  await test('through the routes: status, start, runs, a run, its files, and forgetting it; the API returns catalogs, never the job or a prompt', async () => {
    const st = (await api('GET', '/api/archive/status')).json; assert.equal(st.enabled, true); assert.deepEqual(st.roots, [root]);
    const s = await api('POST', '/api/archive/start', { path: root, fresh: true, maxFiles: 50 }); assert.equal(s.status, 200); assert.ok(s.json.taskId);
    assert.ok(await until(async () => { const t = (await api('GET', '/api/taskio/task?id=' + s.json.taskId)).json.task; return t && t.status === 'done'; }, 25000, 100), 'the launcher\'s own dispatcher ran it');
    const task = (await api('GET', '/api/taskio/task?id=' + s.json.taskId)).json.task, runs = (await api('GET', '/api/archive/runs')).json.runs; assert.ok(runs.some((r) => r.runId === task.ref));
    const run = (await api('GET', '/api/archive/run?id=' + task.ref)).json; assert.ok(run.ok && run.summary.folders.length >= 3 && run.summary.counts.files >= 6);
    const files = (await api('GET', '/api/archive/files?id=' + task.ref + '&dir=' + encodeURIComponent('Trip Cancun') + '&limit=5')).json; assert.ok(files.ok && files.total === 2);
    assert.ok(!JSON.stringify([run, files, task]).includes('messages'), 'no prompt anywhere');
    assert.equal((await api('GET', '/api/archive/run?id=nope')).status, 404); assert.equal((await api('GET', '/api/archive/files?id=..%2f..%2fx')).status, 400, 'an id with ".." is turned away before it reaches the PC');
    assert.equal((await api('POST', '/api/archive/start', { path: outside })).status, 400); assert.equal((await api('POST', '/api/archive/start', {})).status, 400);
    assert.equal((await api('POST', '/api/archive/forget', { runId: task.ref })).json.ok, true); assert.equal((await api('GET', '/api/archive/run?id=' + task.ref)).status, 404);
  });
  await test('hostile input never crashes a route, leaves it hanging or reaches a file', async () => {
    const bodies = ['{', 'null', '[]', '{"path":["a"],"maxFiles":"lots","fresh":{}}', '{"path":"..\\\\..\\\\Windows\\\\System32"}', '{"taskId":{"x":1}}', '{"runId":"../../x"}', '{"__proto__":{"polluted":true}}'];
    for (const p of ['/api/archive/start', '/api/archive/cancel', '/api/archive/forget']) for (const b of bodies) { const r = await fetch(base + p, { method: 'POST', headers: { 'x-devconsole-key': 'k', 'Content-Type': 'application/json' }, body: b, signal: AbortSignal.timeout(5000) }); assert.ok(r.status < 500, p + ' ' + b + ' -> ' + r.status); await r.text(); }
    for (const q of ['/api/archive/run?id=' + 'x'.repeat(3000), '/api/archive/files?id=ar_0123456789&q=' + 'y'.repeat(3000), '/api/archive/files?id=ar_0123456789&offset=-5&limit=1e9', '/api/archive/nope']) { const r = await fetch(base + q, { headers: { 'x-devconsole-key': 'k' }, signal: AbortSignal.timeout(5000) }); assert.ok(r.status < 500, q.slice(0, 40) + ' -> ' + r.status); await r.text(); }
    assert.equal(({}).polluted, undefined);
  });

  API.stop(); await new Promise((r) => srv.close(r)); await A.stop(); await B.stop(); await C.stop(); await llA.close(); await llB.close(); await llC.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
