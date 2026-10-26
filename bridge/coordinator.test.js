#!/usr/bin/env node
'use strict';
// Tests for the coordination layer: nightly window, model supervisor, render-aware unloading, the dispatcher that moves
// work between the two PCs, the routines that make roles do their tasks, and the routes that expose them.
// No GPU, no real model, no network beyond 127.0.0.1: models are faked, and "rendering" is a local TCP port being open.
//   node bridge/coordinator.test.js
const assert = require('assert');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const P = require('./protocol');
const S = require('./schedule');
const { createSupervisor, buildCommand } = require('./model-supervisor');
const { createAgent, exportBundle, defaultConfig } = require('./node-agent');
const { createHub } = require('./hub');
const { createTaskio } = require('./taskio');
const { createDispatcher } = require('./dispatcher');
const { createRoutines, ROUTINES } = require('./routines');
const policy = require('./policy');
const bridge = require('./index');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 4000, step = 40) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); } return false; };
const KEY = 'c'.repeat(64);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-coord-test-'));
const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const gpu = (util) => async () => ({ name: 'Fake RTX 3060', utilPct: util, vramUsedGB: 2, vramTotalGB: 12, tempC: 50 });
const hhmm = (iso) => Date.parse(iso);

// A model server the tests control: answers /health and chat; can be slow or failing.
function fakeLlama(opts = {}) {
  const state = { delayMs: opts.delayMs || 0, fail: !!opts.fail, calls: 0 };
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
      let b = ''; req.on('data', (d) => { b += d; });
      req.on('end', () => setTimeout(() => {
        state.calls++;
        if (state.fail) { res.writeHead(500); return res.end('{}'); }
        const m = (JSON.parse(b || '{}').messages || []).slice(-1)[0] || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'draft: ' + String(m.content).slice(0, 40) } }], usage: { completion_tokens: 9 } }));
      }, state.delayMs));
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, state, close: () => new Promise((r) => { s.close(r); s.closeAllConnections && s.closeAllConnections(); }) }));
  });
}
// A stand-in for llama-server: "starts" (healthy after a short load) and "exits" when killed, on the --port it is given.
function fakeSpawn() {
  const procs = [];
  const spawnImpl = (exe, args) => {
    const port = Number(args[args.indexOf('--port') + 1]), ee = new EventEmitter();
    let server = null; ee.exitCode = null; ee.args = args;
    setTimeout(() => { server = http.createServer((q, r) => { if (q.url === '/health') { r.writeHead(200); return r.end('{"status":"ok"}'); } let b = ''; q.on('data', (d) => { b += d; }); q.on('end', () => { r.writeHead(200, { 'Content-Type': 'application/json' }); r.end(JSON.stringify({ choices: [{ message: { content: 'draft: ok' } }], usage: { completion_tokens: 3 } })); }); }); server.listen(port, '127.0.0.1'); }, 120);
    ee.kill = () => setTimeout(() => { if (server) { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } ee.emit('exit', 0); }, 20);
    procs.push(ee); return ee;
  };
  return { spawnImpl, procs };
}
const llamaFiles = () => { const d = tmp(), exe = path.join(d, 'llama-server.exe'), model = path.join(d, 'm.gguf'); fs.writeFileSync(exe, ''); fs.writeFileSync(model, ''); return { exe, model }; };

(async () => {
  console.log('nightly window');
  await test('a window covers its hours in Mexico City time, including across midnight, and keys "this night" once', () => {
    const w = { enabled: true, start: '00:00', end: '07:00', tz: -360 };
    assert.ok(S.inWindow(hhmm('2026-10-13T06:30:00Z'), w), '00:30 local');           // 06:30Z = 00:30 CDMX
    assert.ok(S.inWindow(hhmm('2026-10-13T12:59:00Z'), w), '06:59 local');
    assert.ok(!S.inWindow(hhmm('2026-10-13T13:00:00Z'), w), '07:00 local is outside');
    assert.ok(!S.inWindow(hhmm('2026-10-13T20:00:00Z'), w));
    const late = { enabled: true, start: '22:00', end: '06:00', tz: -360 };
    assert.ok(S.inWindow(hhmm('2026-10-13T05:00:00Z'), late), '23:00 local'); assert.ok(S.inWindow(hhmm('2026-10-13T10:00:00Z'), late), '04:00 local'); assert.ok(!S.inWindow(hhmm('2026-10-13T16:00:00Z'), late));
    assert.equal(S.nightKey(hhmm('2026-10-13T05:00:00Z'), late), S.nightKey(hhmm('2026-10-13T10:00:00Z'), late), 'one night across midnight');
    assert.notEqual(S.nightKey(hhmm('2026-10-13T10:00:00Z'), late), S.nightKey(hhmm('2026-10-14T10:00:00Z'), late));
    assert.ok(!S.inWindow(hhmm('2026-10-13T06:30:00Z'), { ...w, enabled: false }) && !S.inWindow(1, null) && !S.inWindow(1, { start: 'x', end: 'y' }));
  });

  console.log('model supervisor');
  const files = llamaFiles();
  await test('the command comes only from the local config: relative paths, missing files and bad ports are refused', async () => {
    const ok = buildCommand({ exe: files.exe, model: files.model, port: 18700, alias: 'q', ctx: 8192 });
    assert.ok(!ok.error); assert.deepEqual(ok.args.slice(0, 2), ['-m', files.model]); assert.ok(ok.args.includes('127.0.0.1'), 'bound to loopback only');
    assert.match(buildCommand({ exe: 'llama-server.exe', model: files.model }).error, /absolute/);
    assert.match(buildCommand({ exe: files.exe, model: path.join(os.tmpdir(), 'nope.gguf') }).error, /not found/);
    assert.match(buildCommand({ exe: files.exe, model: files.model, port: 80 }).error, /1024/);
    assert.match(buildCommand({}).error, /not set/);
  });
  const mkSup = async (extra = {}) => {
    const port = await freePort(), fake = fakeSpawn(); let T = hhmm('2026-10-13T08:00:00Z');   // 02:00 local: inside the window
    const sup = createSupervisor({ llama: { exe: files.exe, model: files.model, port, alias: 'q' }, spawnImpl: fake.spawnImpl, now: () => T, idleMinutes: 15, ...extra });
    return { sup, fake, port, clock: { set: (v) => { T = v; }, get: () => T } };
  };
  await test('inside the nightly window the model is loaded; when the window ends it is unloaded', async () => {
    const { sup, fake, clock } = await mkSup();
    await sup.tick(); assert.equal(sup.status().phase, 'starting'); assert.equal(fake.procs.length, 1);
    assert.ok(await until(async () => (await sup.tick()).phase === 'up'));
    assert.ok(sup.status().windowActive);
    clock.set(hhmm('2026-10-13T14:00:00Z'));                         // 08:00 local: window over, nobody asked
    assert.ok(await until(async () => (await sup.tick()).phase === 'stopped'));
  });
  await test('outside the window the model loads on demand and unloads after the idle time', async () => {
    const { sup, fake, clock } = await mkSup(); clock.set(hhmm('2026-10-13T16:00:00Z'));
    await sup.tick(); assert.equal(sup.status().phase, 'stopped'); assert.equal(fake.procs.length, 0, 'nothing loads by itself in the daytime');
    sup.request('start'); await sup.tick();
    assert.ok(await until(async () => (await sup.tick()).phase === 'up'));
    clock.set(clock.get() + 10 * 60000); await sup.tick(); assert.equal(sup.status().phase, 'up', 'still within the idle time');
    sup.touch(); clock.set(clock.get() + 14 * 60000); await sup.tick(); assert.equal(sup.status().phase, 'up', 'activity extends the idle time');
    clock.set(clock.get() + 20 * 60000);
    assert.ok(await until(async () => (await sup.tick()).phase === 'stopped'));
  });
  await test('a model that dies on its own is recorded as a failure and not relaunched every tick: it waits out the retry delay', async () => {
    const { sup, fake, clock } = await mkSup();
    await sup.tick(); assert.ok(await until(async () => (await sup.tick()).phase === 'up'));
    fake.procs[0].kill();                                            // the model process dies by itself (out of memory, a crash): we did not ask for it
    assert.ok(await until(async () => (await sup.tick()).phase === 'failed', 3000), 'recorded as a failure');
    assert.match(sup.status().error, /unexpected/);
    for (let i = 0; i < 5; i++) await sup.tick();
    assert.equal(fake.procs.length, 1, 'not relaunched on the very next ticks (a crash loop would reload the model every couple of seconds all night)');
    clock.set(clock.get() + 61000); await sup.tick(); assert.equal(fake.procs.length, 2, 'tried again once the retry delay has passed');
  });
  await test('a client render always wins: the model is unloaded, and never loaded, while it lasts', async () => {
    const { sup, fake } = await mkSup();
    await sup.tick({ renderBusy: true }); assert.equal(fake.procs.length, 0, 'inside the window, but rendering: do not load');
    await sup.tick(); assert.ok(await until(async () => (await sup.tick()).phase === 'up'));
    await sup.tick({ renderBusy: true });
    assert.ok(await until(async () => (await sup.tick({ renderBusy: true })).phase === 'stopped'), 'unloaded as soon as rendering starts');
    assert.ok(await until(async () => { await sup.tick(); return sup.status().phase !== 'stopped'; }), 'and comes back after');
  });
  await test('a model started outside the bridge is never killed; the supervisor says why it cannot unload it', async () => {
    const outside = await fakeLlama(), { sup } = await mkSup({ llama: { exe: files.exe, model: files.model, port: outside.port, alias: 'q' } });
    const st = await sup.tick({ renderBusy: true });
    assert.ok(st.external && st.phase === 'up'); assert.match(st.error, /outside the bridge/);
    assert.equal((await fetch(`http://127.0.0.1:${outside.port}/health`)).status, 200, 'still running');
    await outside.close();
  });
  await test('an owner stop is honoured for an hour even inside the window', async () => {
    const { sup, fake, clock } = await mkSup();
    await sup.tick(); assert.ok(await until(async () => (await sup.tick()).phase === 'up'));
    sup.request('stop'); assert.ok(await until(async () => (await sup.tick()).phase === 'stopped'));
    const n = fake.procs.length; clock.set(clock.get() + 30 * 60000); await sup.tick(); assert.equal(fake.procs.length, n, 'not restarted within the hour');
    clock.set(clock.get() + 40 * 60000); await sup.tick(); assert.equal(fake.procs.length, n + 1, 'back after the hour (still night)');
    assert.equal(sup.request('rm -rf'), false, 'the network can only ask start or stop');
  });

  console.log('agent: render state and controls');
  await test('an agent unloads its model when a client render starts here, and says so in its stats', async () => {
    const { sup } = await mkSup(), renderPort = await freePort();
    const A = createAgent({ key: KEY, alias: 'R', port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(3), statsMs: 100, supervisor: sup, render: { ports: [renderPort] }, llamaUrl: 'http://127.0.0.1:' + (sup.command().port) });
    const pa = await A.start(), base = 'http://127.0.0.1:' + pa;
    const get = async (p) => (await (await fetch(base + p, { headers: P.signRequest(KEY, 'GET', p, '') })).json());
    const post = async (p, b) => { const body = JSON.stringify(b); const r = await fetch(base + p, { method: 'POST', headers: { ...P.signRequest(KEY, 'POST', p, body), 'Content-Type': 'application/json' }, body }); return { status: r.status, json: await r.json() }; };
    assert.ok(await until(async () => { const s = await get('/v1/stats'); return s.llm.up && s.model.phase === 'up' && !s.render.busy; }, 6000), 'model loaded in the window');
    const wilbur = net.createServer(); await new Promise((r) => wilbur.listen(renderPort, '127.0.0.1', r));        // "Wilbur's streamer port opens"
    assert.ok(await until(async () => { const s = await get('/v1/stats'); return s.render.busy && s.render.probe && !s.llm.up; }, 6000), 'render detected, model unloaded');
    const refused = await post('/v1/model', { action: 'start' }); assert.equal(refused.status, 409); assert.match(refused.json.error, /rendering/);
    const job = await post('/v1/jobs', { type: 'llm.chat', messages: [{ role: 'user', content: 'hi' }] });
    await sleep(150); const j = await get('/v1/jobs/' + job.json.jobId); assert.equal(j.job.status, 'failed'); assert.match(j.job.error, /^rendering:/);
    await new Promise((r) => { wilbur.close(r); wilbur.closeAllConnections && wilbur.closeAllConnections(); });
    assert.ok(await until(async () => { const s = await get('/v1/stats'); return !s.render.busy && s.llm.up; }, 8000), 'model back once the render ends');
    await A.stop();
  });
  await test('a launcher hint, and a reservation, make a PC "rendering" too; the reservation is remembered across restarts', async () => {
    const dir = tmp(), statePath = path.join(dir, 'state.json');
    const mk = () => createAgent({ key: KEY, alias: 'H', port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(3), statsMs: 100, statePath, render: { ports: [] } });
    let A = mk(), pa = await A.start();
    const call = async (m, p, b) => { const body = b ? JSON.stringify(b) : ''; const r = await fetch('http://127.0.0.1:' + pa + p, { method: m, headers: { ...P.signRequest(KEY, m, p, body), ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined }); return r.json(); };
    assert.equal((await call('GET', '/v1/stats')).render.busy, false);
    await call('POST', '/v1/hint', { render: true, ttlSec: 30 }); assert.equal((await call('GET', '/v1/stats')).render.busy, true, 'hint');
    await call('POST', '/v1/hint', { render: false }); assert.equal((await call('GET', '/v1/stats')).render.busy, false);
    await call('POST', '/v1/reserve', { reserved: true }); assert.equal((await call('GET', '/v1/stats')).render.reserved, true);
    await A.stop(); A = mk(); pa = await A.start();
    assert.equal((await call('GET', '/v1/stats')).render.reserved, true, 'remembered after a restart');
    await A.stop();
  });

  await test('a PC that is rendering never reaches its model: the job is refused before the model is called', async () => {
    const ll = await fakeLlama(), A = createAgent({ key: KEY, alias: 'M', port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(3), statsMs: 100, llamaUrl: 'http://127.0.0.1:' + ll.port, model: 'q', render: { ports: [] } });
    const pa = await A.start();
    const call = async (m, p, b) => { const body = b ? JSON.stringify(b) : ''; const r = await fetch('http://127.0.0.1:' + pa + p, { method: m, headers: { ...P.signRequest(KEY, m, p, body), ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined }); return r.json(); };
    const run = async () => { const j = await call('POST', '/v1/jobs', { type: 'llm.chat', messages: [{ role: 'user', content: 'hi' }] }); await sleep(250); return call('GET', '/v1/jobs/' + j.jobId); };
    assert.equal((await run()).job.status, 'done', 'control: with nothing rendering the model answers');
    const before = ll.state.calls;
    await call('POST', '/v1/hint', { render: true, ttlSec: 30 });
    const refused = await run(); assert.equal(refused.job.status, 'failed'); assert.match(refused.job.error, /^rendering:/);
    assert.equal(ll.state.calls, before, 'the running model was not called while a client was being served');
    await A.stop(); await ll.close();
  });

  console.log('dispatcher: two PCs, one pool');
  const rig = async (opts = {}) => {
    const llA = await fakeLlama(opts.llamaA), llB = await fakeLlama(opts.llamaB), dir = tmp();
    const mkNode = (alias, ll, util) => createAgent({ key: KEY, alias, port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(util), statsMs: 100, llamaUrl: 'http://127.0.0.1:' + ll.port, model: 'q', render: { ports: [] } });
    const A = mkNode('PC-A', llA, opts.utilA == null ? 5 : opts.utilA), B = mkNode('PC-B', llB, opts.utilB == null ? 20 : opts.utilB), pa = await A.start(), pb = await B.start();
    const state = { render: 'stopped' };
    const hub = createHub({ dir, key: KEY, getRenderState: () => state.render, idleCfg: opts.idleCfg, targets: [{ host: '127.0.0.1', port: pa, source: 'local' }, { host: '127.0.0.1', port: pb, source: 'configured' }] });
    const taskio = createTaskio({ dir, getProspects: () => [], getBugs: () => [] });
    const disp = createDispatcher({ hub, taskio, pollMs: 50, maxAttempts: 3 });
    await hub.refresh();
    const job = (text, extra = {}) => taskio.createTask({ title: text, persona: 'Nadia', area: 'sales', lane: 'local', source: 'ask', priority: 5, job: { messages: [{ role: 'user', content: text }], maxTokens: 50, role: 'Nadia', area: 'sales' }, ...extra });
    const step = async () => { await hub.refresh(); await disp.tick(); };
    const finish = async (ids, ms = 6000) => until(async () => { await step(); return ids.every((id) => taskio.getTask(id).status === 'done'); }, ms, 60);
    const devId = (alias) => hub.devices().find((d) => d.alias === alias).id;
    return { A, B, llA, llB, hub, taskio, disp, state, job, step, finish, devId, stop: async () => { await A.stop(); await B.stop(); await llA.close(); await llB.close(); } };
  };
  await test('with no client rendering both PCs share the work: two tasks run in parallel, one on each', async () => {
    const r = await rig(), t1 = r.job('first').task.id, t2 = r.job('second').task.id, t3 = r.job('third').task.id;
    await r.step(); const running = r.taskio.openJobs().filter((t) => t.status === 'running');
    assert.equal(running.length, 2, 'one job per PC at a time'); assert.notEqual(running[0].deviceId, running[1].deviceId);
    assert.equal(r.taskio.getTask(t3).status, 'queued', 'the third waits for a free PC');
    assert.ok(await r.finish([t1, t2, t3])); assert.match(r.taskio.getTask(t1).result.text, /^draft: first/);
    assert.equal(r.hub.coordination().state, 'shared');
    await r.stop();
  });
  await test('when one PC is rendering a client, the other takes ALL the AI work - in either direction', async () => {
    const r = await rig(), ids = [r.job('a').task.id, r.job('b').task.id, r.job('c').task.id];
    r.state.render = 'streaming';                                   // the launcher says PC-A (the local PC) is rendering
    await r.step(); assert.equal(r.hub.view().find((d) => d.alias === 'PC-A').assignment, 'rendering');
    assert.match(r.hub.coordination().message, /PC-A is rendering a client — PC-B carries all the AI work/);
    assert.ok(await r.finish(ids));
    assert.ok(ids.every((id) => r.taskio.getTask(id).result.deviceId === r.devId('PC-B')), 'everything ran on PC-B');
    assert.equal(r.llA.state.calls, 0, 'PC-A\'s model was never touched while it rendered');
    r.state.render = 'stopped';                                     // now the other way round: reserve PC-B for rendering
    await r.hub.refresh(); await r.hub.setReserved(r.devId('PC-B'), true); await r.step();
    const more = [r.job('d').task.id, r.job('e').task.id]; assert.ok(await r.finish(more));
    assert.ok(more.every((id) => r.taskio.getTask(id).result.deviceId === r.devId('PC-A')), 'now PC-A carries everything');
    assert.match(r.hub.coordination().message, /PC-B reserved for client rendering — PC-A carries all the AI work/);
    await r.stop();
  });
  await test('the dispatcher never asks a rendering or reserved PC to load its model, or hands it a task', async () => {
    const r = await rig(), real = r.hub.devices();
    const mk = (id, render) => ({ id, alias: id, online: true, source: 'configured', stats: { llm: { up: false }, gpu: { utilPct: 0 }, model: { phase: 'stopped', canStart: true, windowActive: true, paused: false }, render } });
    for (const render of [{ busy: true, reserved: false }, { busy: false, reserved: true }]) {
      const asked = [], submitted = [], devs = [mk('a-first', render), mk('b-second', { busy: false, reserved: false })];
      const spy = { ...r.hub, devices: () => devs, modelAction: async (id) => { asked.push(id); return { ok: true }; }, submitTo: async (id) => { submitted.push(id); return { jobId: 'x' }; } };
      const taskio = createTaskio({ dir: tmp(), getProspects: () => [], getBugs: () => [] });
      taskio.createTask({ title: 't', persona: 'Nadia', area: 'sales', lane: 'local', source: 'ask', priority: 5, job: { messages: [{ role: 'user', content: 't' }], maxTokens: 5 } });
      await createDispatcher({ hub: spy, taskio, pollMs: 50 }).tick();
      assert.deepEqual(asked, ['b-second'], 'only the PC that is free for AI work is asked to load (' + JSON.stringify(render) + ')');
      assert.deepEqual(submitted, []);
    }
    assert.ok(real.length === 2); await r.stop();
  });
  await test('with every PC busy rendering or reserved, tasks wait in the queue - nothing is dropped or sent to the cloud', async () => {
    const r = await rig(), id = r.job('patient').task.id;
    r.state.render = 'running'; await r.hub.refresh(); await r.hub.setReserved(r.devId('PC-B'), true);
    for (let i = 0; i < 4; i++) { await r.step(); await sleep(60); }
    assert.equal(r.taskio.getTask(id).status, 'queued'); assert.equal(r.hub.coordination().state, 'blocked');
    assert.equal(r.llA.state.calls + r.llB.state.calls, 0);
    r.state.render = 'stopped'; await r.hub.setReserved(r.devId('PC-B'), false);
    assert.ok(await r.finish([id]), 'runs as soon as a PC is free');
    await r.stop();
  });
  await test('a task running on a PC that starts rendering moves to the other PC and still completes', async () => {
    const r = await rig({ llamaA: { delayMs: 1500 }, llamaB: { delayMs: 0 } });
    // make PC-A the least loaded so the first task lands there
    const id = r.job('long one').task.id; await r.step();
    const t = r.taskio.getTask(id); assert.equal(t.status, 'running'); assert.equal(t.deviceId, r.devId('PC-A'));
    r.state.render = 'starting';                                    // a visitor's session starts on PC-A
    await r.step(); assert.equal(r.taskio.getTask(id).status === 'queued' || r.taskio.getTask(id).status === 'running', true);
    assert.ok(await r.finish([id])); assert.equal(r.taskio.getTask(id).result.deviceId, r.devId('PC-B'));
    assert.match(r.taskio.getTask(id).detail, /Done on PC-B/);
    await r.stop();
  });
  await test('owner requests run any time; scheduled (routine) tasks wait for the nightly window while every GPU is busy', async () => {
    const r = await rig({ utilA: 60, utilB: 45 }), routine = r.job('nightly thing', { source: 'routine', priority: 0 }).task.id, owner = r.job('asked now').task.id;
    assert.ok(await r.finish([owner]));
    for (let i = 0; i < 3; i++) { await r.step(); await sleep(60); }
    assert.equal(r.taskio.getTask(routine).status, 'queued', 'no PC is in its nightly window and no GPU is under 20%, so the routine waits');
    await r.stop();
  });
  await test('outside the nightly window a scheduled task runs on a PC that is idle: GPU under 20%, not rendering, not reserved', async () => {
    const r = await rig({ utilA: 90, utilB: 4 }), id = r.job('daytime nightly', { source: 'routine', priority: 0 }).task.id;
    assert.ok(await r.finish([id]), 'PC-B is at 4%, so the routine runs now');
    assert.equal(r.taskio.getTask(id).result.deviceId, r.devId('PC-B'), 'on the idle PC, never the busy one'); assert.equal(r.llA.state.calls, 0);
    assert.equal(r.hub.view().find((d) => d.alias === 'PC-B').idle, true); assert.equal(r.hub.view().find((d) => d.alias === 'PC-A').idle, false);
    await r.stop();
  });
  await test('20% is the line: a PC at exactly the threshold is not idle, and the limit can be changed or the rule switched off', async () => {
    const at20 = await rig({ utilA: 20, utilB: 20 }), a = at20.job('edge', { source: 'routine', priority: 0 }).task.id;
    for (let i = 0; i < 3; i++) { await at20.step(); await sleep(60); }
    assert.equal(at20.taskio.getTask(a).status, 'queued', 'exactly 20% is not under 20%'); await at20.stop();
    const looser = await rig({ utilA: 20, utilB: 20, idleCfg: () => ({ enabled: true, gpuPct: 30 }) }), b = looser.job('looser', { source: 'routine', priority: 0 }).task.id;
    assert.ok(await looser.finish([b]), 'with the limit at 30% a PC at 20% is idle'); await looser.stop();
    const off = await rig({ utilA: 1, utilB: 1, idleCfg: () => ({ enabled: false }) }), c = off.job('rule off', { source: 'routine', priority: 0 }).task.id;
    for (let i = 0; i < 3; i++) { await off.step(); await sleep(60); }
    assert.equal(off.taskio.getTask(c).status, 'queued', 'switched off: only the night window lets a routine run'); await off.stop();
  });
  await test('idleness never beats rendering: a rendering, reserved, offline or GPU-less PC is not idle even at 0%', async () => {
    const r = await rig({ utilA: 0, utilB: 0 }), id = r.job('should wait', { source: 'routine', priority: 0 }).task.id;
    r.state.render = 'streaming'; await r.hub.refresh(); await r.hub.setReserved(r.devId('PC-B'), true);
    for (let i = 0; i < 4; i++) { await r.step(); await sleep(60); }
    assert.equal(r.taskio.getTask(id).status, 'queued', 'PC-A renders, PC-B is reserved: a quiet GPU changes nothing'); assert.ok(r.hub.devices().every((d) => !r.hub.idleEnough(d)));
    assert.equal(r.llA.state.calls + r.llB.state.calls, 0);
    const noGpu = { id: 'n', online: true, source: 'configured', stats: { llm: { up: true }, render: { busy: false, reserved: false } } };
    assert.equal(r.hub.idleEnough(noGpu), false, 'a PC that does not report its GPU is not assumed idle');
    assert.equal(r.hub.idleEnough({ ...noGpu, online: false, stats: { ...noGpu.stats, gpu: { utilPct: 0 } } }), false);
    assert.equal(r.hub.idleEnough({ ...noGpu, stats: { ...noGpu.stats, gpu: { utilPct: 0 } } }), true, 'control: with a GPU reading at 0% it is');
    await r.stop();
  });
  await test('a real failure is retried, then reported; it does not loop forever', async () => {
    const r = await rig({ llamaA: { fail: true }, llamaB: { fail: true } }), id = r.job('doomed').task.id;
    assert.ok(await until(async () => { await r.step(); return r.taskio.getTask(id).status === 'failed'; }, 8000, 60));
    assert.equal(r.taskio.getRaw(id).attempts, 2, 'two retries recorded, third attempt marks it failed'); assert.match(r.taskio.getTask(id).error, /HTTP 500/);
    await r.stop();
  });
  await test('the dispatcher asks a PC to load its model when work is waiting, then runs the task once it is up', async () => {
    const { sup, fake } = await mkSup(), dir = tmp(); let T = hhmm('2026-10-13T16:00:00Z');   // daytime: nothing loads by itself
    const sup2 = createSupervisor({ llama: { exe: files.exe, model: files.model, port: await freePort(), alias: 'q' }, spawnImpl: fake.spawnImpl, now: () => T, idleMinutes: 15 });
    const A = createAgent({ key: KEY, alias: 'PC-L', port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(3), statsMs: 80, supervisor: sup2, render: { ports: [] }, model: 'q', llamaUrl: 'http://127.0.0.1:' + sup2.command().port });
    const pa = await A.start();
    const hub = createHub({ dir, key: KEY, targets: [{ host: '127.0.0.1', port: pa, source: 'local' }] });
    const taskio = createTaskio({ dir, getProspects: () => [], getBugs: () => [] }), disp = createDispatcher({ hub, taskio, pollMs: 50 });
    await hub.refresh(); assert.equal(hub.view()[0].stats.llm.up, false);
    const id = taskio.createTask({ title: 'needs a model', persona: 'Nadia', area: 'sales', lane: 'local', priority: 5, job: { messages: [{ role: 'user', content: 'x' }], role: 'Nadia', area: 'sales' } }).task.id;
    assert.ok(await until(async () => { await hub.refresh(); await disp.tick(); return taskio.getTask(id).status === 'done'; }, 9000, 80));
    assert.equal(fake.procs.length >= 1, true); assert.match(taskio.getTask(id).detail, /Done on PC-L/);
    await A.stop(); sup.stop();
  });
  await test('before a client render starts the launcher can have the local model unloaded first, within a bound', async () => {
    const { sup, fake } = await mkSup(), dir = tmp();
    const A = createAgent({ key: KEY, alias: 'PC-P', port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(3), statsMs: 80, supervisor: sup, render: { ports: [] }, model: 'q', llamaUrl: 'http://127.0.0.1:' + sup.command().port });
    const pa = await A.start(), hub = createHub({ dir, key: KEY, targets: [{ host: '127.0.0.1', port: pa, source: 'local' }] });
    await hub.refresh();
    assert.ok(await until(async () => { await hub.refresh(); return hub.view()[0].stats.llm.up; }, 6000), 'model up in the window');
    const t0 = Date.now(), r = await hub.preRender(5000);
    assert.ok(r.unloaded && Date.now() - t0 < 4500, 'unloaded before returning'); await hub.refresh(); assert.equal(hub.view()[0].stats.llm.up, false);
    const dead = createHub({ dir: tmp(), key: KEY, targets: [{ host: '127.0.0.1', port: await freePort(), source: 'local' }] });
    const t1 = Date.now(), r2 = await dead.preRender(5000); assert.ok(r2.unloaded && Date.now() - t1 < 4000, 'an unreachable node never delays or fails the launch');
    await A.stop();
  });

  console.log('routines: the roles do their tasks');
  const rdir = tmp(), w = (f, rows) => fs.writeFileSync(path.join(rdir, f), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  let NOW = hhmm('2026-10-13T08:00:00Z');                       // 02:00 local, inside the window
  const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
  w('autotest-runs.jsonl', [{ ts: iso(1), job: 'weekly', summary: { ok: 104, warn: 1, down: 1, total: 106 }, results: [{ id: 'gate-launch-ps', state: 'down', note: 'NOT GATED' }, { id: 'api-status', state: 'ok' }] }]);
  w('devconsole-log.jsonl', [{ ts: iso(0.5), type: 'dispatch', repo: 'website', issueNumber: 7, title: 'Add the privacy link to the footer form' }, { ts: iso(0.4), type: 'commit', repo: 'website', pr: 8, merged: true, category: 'functional' }]);
  w('leads-log.jsonl', [{ ts: iso(2), name: 'Someone Private', email: 'private@example.com', company: 'X', message: 'hola', emailVerified: false, device: {} }]);
  const prospects = [{ id: 'p1', name: 'Alfa Desarrollos', location: 'Roma Norte', status: 'contacted', createdAt: iso(20), updatedAt: iso(9), fitScore: null }, { id: 'p2', name: 'Beta Inmobiliaria', location: 'Polanco', status: 'new', createdAt: iso(2), updatedAt: iso(2), fitScore: null }];
  const bugs = [{ id: 'b1', title: 'Wilbur never reconnects', priority: 'critical', status: 'open', component: 'Pixel Streaming', createdAt: iso(1), updatedAt: iso(1) }, { id: 'b2', title: 'Hub page shows a blank tile', priority: 'medium', status: 'open', component: 'Dashboard', description: 'tile is empty', createdAt: iso(1), updatedAt: iso(1) }];
  const tio = createTaskio({ dir: rdir, getProspects: () => prospects, getBugs: () => bugs, now: () => NOW });
  tio.createTask({ title: 'Reviewed the cookie banner', persona: 'Ximena', area: 'compliance', lane: 'local', status: 'done' });
  const mkR = (pol = policy, win) => createRoutines({ taskio: tio, dir: rdir, policy: pol, window: win || S.DEFAULT_WINDOW, now: () => NOW, kick: () => {} });
  fs.rmSync(path.join(rdir, 'routines-state.json'), { force: true });
  const R = mkR();
  await test('nothing runs outside the nightly window; inside it each routine runs once per night, weekly ones once a week', () => {
    NOW = hhmm('2026-10-13T20:00:00Z'); assert.deepEqual(R.tick(), []);
    NOW = hhmm('2026-10-13T08:00:00Z');
    const first = R.tick().map((x) => x.id); assert.ok(first.includes('nadia-pipeline') && first.includes('ward-digest') && first.includes('priya-bug-tests') && first.includes('ximena-checklist') && first.includes('talia-ideas'), first.join(','));
    assert.deepEqual(R.tick(), [], 'not again the same night');
    NOW = hhmm('2026-10-14T08:00:00Z');
    const next = R.tick().map((x) => x.id); assert.ok(next.includes('nadia-pipeline') && next.includes('ward-digest'), 'nightly ones run again');
    assert.ok(!next.includes('ximena-checklist') && !next.includes('talia-ideas'), 'weekly ones do not');
    NOW = hhmm('2026-10-21T08:00:00Z'); assert.ok(R.tick().map((x) => x.id).includes('ximena-checklist'), 'weekly ones are back after a week');
    NOW = hhmm('2026-10-13T08:00:00Z');
  });
  await test('outside the window the routines still start - once per night - but only while some PC is idle', () => {
    let free = false;
    const d3 = tmp(), tio3 = createTaskio({ dir: d3, getProspects: () => prospects, getBugs: () => bugs, now: () => NOW });
    const R5 = createRoutines({ taskio: tio3, dir: d3, policy, window: S.DEFAULT_WINDOW, now: () => NOW, idle: () => free });
    NOW = hhmm('2026-10-13T20:00:00Z');                                  // 14:00 local: outside the night window
    assert.deepEqual(R5.tick(), [], 'no PC is idle: nothing starts');
    free = true; const day = R5.tick().map((x) => x.id);
    assert.ok(day.includes('nadia-pipeline') && day.includes('ward-digest') && day.includes('priya-bug-tests'), 'an idle PC lets tonight\'s routines run in the daytime: ' + day.join(','));
    assert.deepEqual(R5.tick(), [], 'and only once for that night');
    NOW = hhmm('2026-10-14T08:00:00Z'); assert.ok(R5.tick().map((x) => x.id).includes('nadia-pipeline'), 'the next night\'s window starts them again');
    NOW = hhmm('2026-10-13T08:00:00Z');
  });
  await test('a fresher scheduled draft replaces an old unrun one, but a draft the owner asked for with "run now" is never replaced', () => {
    const d4 = tmp(), tio4 = createTaskio({ dir: d4, getProspects: () => prospects, getBugs: () => bugs, now: () => NOW });
    const R6 = createRoutines({ taskio: tio4, dir: d4, policy, window: S.DEFAULT_WINDOW, now: () => NOW });
    const queued = () => tio4.openJobs().filter((t) => t.routineId === 'nadia-pipeline');
    const mine = R6.run('nadia-pipeline', { manual: true }).taskId; R6.run('nadia-pipeline'); R6.run('nadia-pipeline');
    assert.ok(queued().some((t) => t.id === mine), 'the owner\'s own request is still waiting its turn');
    assert.equal(queued().filter((t) => t.priority === 0).length, 1, 'scheduled drafts still do not pile up');
  });
  await test('an AI routine queues a local job built from real data, flagged advisory/confidential where it must be', () => {
    const all = tio.openJobs(), nadia = all.find((t) => t.routineId === 'nadia-pipeline'), ximena = all.find((t) => t.routineId === 'ximena-checklist');
    assert.ok(nadia && nadia.lane === 'local' && nadia.source === 'routine' && nadia.priority === 0);
    const text = nadia.job.messages.map((m) => m.content).join(' ');
    assert.match(text, /Alfa Desarrollos/); assert.match(text, /Spanish/); assert.match(text, /Drafts only/);
    assert.ok(nadia.job.confidential, 'sales data is confidential'); assert.ok(ximena.advisory && ximena.job.confidential);
    assert.match(ximena.job.messages.map((m) => m.content).join(' '), /not legal advice/);
    const ward = tio.getRaw(R.run('ward-digest', { manual: true }).taskId).job.messages.map((m) => m.content).join(' ');      // a fresh run: older unrun drafts are replaced, so look at the newest
    assert.match(ward, /gate-launch-ps \[down\]/); assert.match(ward, /privacy link/);
  });
  await test('no personal data reaches any prompt: leads are reduced to field names', () => {
    const prompts = tio.openJobs().map((t) => t.job.messages.map((m) => m.content).join(' ')).join(' ');
    assert.ok(!prompts.includes('private@example.com') && !prompts.includes('Someone Private'));
    assert.match(prompts, /fields stored per request: [^.]*email/);
  });
  await test('cloud-lane roles get proposals prepared for approval - never queued to a model, never sent', () => {
    const props = tio.proposals(), priya = props.find((t) => t.routineId === 'priya-bug-tests'), dex = props.find((t) => t.routineId === 'dex-site-backlog');
    assert.ok(priya && priya.lane === 'cloud' && priya.status === 'proposed' && /Wilbur never reconnects/.test(priya.proposal.transcript) && priya.proposal.repo === 'website');
    assert.match(priya.proposal.transcript, /\n- \[critical\]/, 'the brief keeps its line breaks: the bug list stays a list when it reaches GitHub');
    assert.ok(dex && /blank tile/.test(dex.proposal.transcript) && !/Wilbur/.test(dex.proposal.transcript), 'only website-repo bugs go to the website repo');
    assert.ok(!tio.openJobs().some((t) => t.lane === 'cloud'), 'cloud work never enters the local queue');
  });
  await test('routines do not pile up: an unanswered or dismissed proposal is not proposed again, and a fresh AI draft replaces last night\'s unrun one', () => {
    const d2 = tmp(), tio2 = createTaskio({ dir: d2, getProspects: () => prospects, getBugs: () => bugs, now: () => NOW });
    const R4 = createRoutines({ taskio: tio2, dir: d2, policy, window: S.DEFAULT_WINDOW, now: () => NOW });
    const priya = () => tio2.proposals().filter((t) => t.routineId === 'priya-bug-tests');
    NOW = hhmm('2026-10-13T08:00:00Z'); R4.tick(); assert.equal(priya().length, 1);
    NOW = hhmm('2026-10-14T08:00:00Z'); const second = R4.tick().find((x) => x.id === 'priya-bug-tests');
    assert.ok(second && second.skipped, 'the same brief is not proposed a second night'); assert.equal(priya().length, 1);
    const first = priya()[0]; tio2.updateTask(first.id, { status: 'dismissed' });                      // the owner said no
    NOW = hhmm('2026-10-15T08:00:00Z'); assert.ok(R4.tick().find((x) => x.id === 'priya-bug-tests').skipped, 'a dismissed proposal does not come back the next night');
    NOW = hhmm('2026-10-29T08:00:00Z'); assert.ok(R4.tick().find((x) => x.id === 'priya-bug-tests').taskId, 'but after two weeks it is asked again');
    assert.equal(tio2.openJobs().filter((t) => t.routineId === 'nadia-pipeline').length, 1, 'only the newest unrun AI draft is kept');
    NOW = hhmm('2026-10-13T08:00:00Z');
  });
  await test('routines that have nothing to work on say so instead of producing noise; owners can disable or run one now', () => {
    const empty = createTaskio({ dir: tmp(), getProspects: () => [], getBugs: () => [], now: () => NOW });
    const R2 = createRoutines({ taskio: empty, dir: tmp(), policy, window: S.DEFAULT_WINDOW, now: () => NOW });
    const res = R2.tick(); assert.ok(res.filter((x) => x.skipped).length >= 5); assert.equal(empty.openJobs().filter((t) => t.routineId === 'nadia-pipeline').length, 0);
    assert.equal(R2.setEnabled('ward-digest', false).enabled, false); NOW = hhmm('2026-10-15T08:00:00Z'); assert.ok(!R2.tick().some((x) => x.id === 'ward-digest'));
    NOW = hhmm('2026-10-13T20:00:00Z'); const manual = R.run('nadia-pipeline', { manual: true }); assert.ok(manual.ok && manual.taskId);
    assert.equal(tio.getRaw(manual.taskId).priority, 3, 'a manual run is owner-priority and runs any time');
    assert.equal(R.run('nope').ok, false); NOW = hhmm('2026-10-13T08:00:00Z');
  });
  await test('a policy change can never quietly send a confidential routine to the other lane', () => {
    const tampered = { ...policy, lanes: { ...policy.lanes, sales: 'cloud', dev: 'local' }, confidentialAreas: [] };   // even the confidential list gets emptied
    const R3 = createRoutines({ taskio: createTaskio({ dir: tmp(), getProspects: () => prospects, getBugs: () => bugs, now: () => NOW }), dir: tmp(), policy: tampered, window: S.DEFAULT_WINDOW, now: () => NOW });
    const n = R3.run('nadia-pipeline'); assert.equal(n.ok, false); assert.match(n.error, /policy/);
    const d = R3.run('dex-site-backlog'); assert.equal(d.ok, false); assert.match(d.error, /policy/);
  });

  console.log('routes');
  const rd = tmp(); fs.mkdirSync(path.join(rd, 'bridge')); fs.writeFileSync(path.join(rd, 'bridge', 'bridge.key'), KEY);
  const llR = await fakeLlama(), nodeR = createAgent({ key: KEY, alias: 'PC-R', port: 0, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(2), statsMs: 80, llamaUrl: 'http://127.0.0.1:' + llR.port, model: 'q', render: { ports: [] } });
  const pr = await nodeR.start();
  process.env.G741_BRIDGE_KEY_FILE = path.join(rd, 'bridge', 'bridge.key');
  const API = bridge.init({ dir: rd, isAuthed: (req) => req.headers['x-devconsole-key'] === 'k', cors: {}, getProspects: () => prospects, getBugs: () => bugs, getRenderState: () => 'stopped',
    hubOptions: { targets: [{ host: '127.0.0.1', port: pr, source: 'local' }], pollMs: 100, dispatchMs: 60 } });
  const srv = http.createServer((req, res) => { if (!API.handle(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end('{}'); } });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const base = 'http://127.0.0.1:' + srv.address().port;
  const api = async (m, p, b, key = 'k') => { const r = await fetch(base + p, { method: m, headers: { 'x-devconsole-key': key, ...(b ? { 'Content-Type': 'application/json' } : {}) }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, json: await r.json().catch(() => null) }; };
  await until(async () => (await api('GET', '/api/bridge/devices')).json.devices.some((d) => d.online), 5000);
  await test('every new route is closed without the Dev Console key', async () => {
    for (const [m, p] of [['GET', '/api/bridge/queue'], ['GET', '/api/bridge/routines'], ['POST', '/api/bridge/reserve'], ['POST', '/api/bridge/model'], ['POST', '/api/bridge/routines/run'], ['POST', '/api/bridge/routines/toggle'], ['POST', '/api/taskio/ask'], ['GET', '/api/taskio/task?id=x'], ['GET', '/api/taskio/proposals']]) assert.equal((await api(m, p, m === 'POST' ? {} : undefined, 'wrong')).status, 401, p);
  });
  await test('the idle-run settings come from bridge.json: the Devices route says which PCs are idle, and a switch turns the rule off', async () => {
    const cfgFile = path.join(rd, 'bridge.json');
    let d = (await api('GET', '/api/bridge/devices')).json;
    assert.deepEqual(d.idleRun, { enabled: true, gpuPct: 20 }, 'defaults: on, under 20%'); assert.equal(d.devices[0].idle, true, 'the test PC sits at 2% GPU');
    fs.writeFileSync(cfgFile, JSON.stringify({ idleRun: { enabled: true, gpuPct: 1 } }));
    d = (await api('GET', '/api/bridge/devices')).json; assert.equal(d.idleRun.gpuPct, 1); assert.equal(d.devices[0].idle, false, '2% is over a 1% limit');
    fs.writeFileSync(cfgFile, JSON.stringify({ idleRun: { enabled: false, gpuPct: 'lots' } }));
    d = (await api('GET', '/api/bridge/devices')).json; assert.equal(d.idleRun.enabled, false); assert.equal(d.idleRun.gpuPct, 20, 'a nonsense limit falls back to 20'); assert.equal(d.devices[0].idle, false);
    fs.rmSync(cfgFile, { force: true });
  });
  await test('hostile input never crashes a route or leaves a request hanging; an oversized body is answered with 413', async () => {
    const posts = ['/api/bridge/alias', '/api/bridge/reserve', '/api/bridge/model', '/api/bridge/jobs', '/api/bridge/routines/run', '/api/bridge/routines/toggle', '/api/taskio/task', '/api/taskio/ask', '/api/taskio/task/update', '/api/taskio/eod/submit'];
    const bodies = ['{', 'null', '[]', '123', '{"__proto__":{"polluted":true}}', '{"id":["a"],"alias":{"x":1},"action":{"a":1},"date":{"d":1},"tz":"abc","prompt":[1],"title":{"t":1},"patch":"x"}', '{"date":"2026-13-45","tz":1e300}', '{"date":"2026-10-14","tz":99999999999999}', '{"id":"tk_000000000000","patch":{"status":"hacked"}}'];
    for (const p of posts) for (const b of bodies) {
      const r = await fetch(base + p, { method: 'POST', headers: { 'x-devconsole-key': 'k', 'Content-Type': 'application/json' }, body: b, signal: AbortSignal.timeout(5000) });
      assert.ok(r.status < 500 || r.status === 502 || r.status === 503, p + ' ' + b.slice(0, 30) + ' -> ' + r.status); await r.text();
    }
    for (const q of ['/api/taskio/day?date=2026-13-45', '/api/taskio/day?date=2026-10-14&tz=1e999', '/api/taskio/day?tz=abc', '/api/taskio/task?id=../../etc/passwd', '/api/taskio/eod?limit=-5', '/api/taskio/eod?date=' + 'd'.repeat(3000)]) {
      const r = await fetch(base + q, { headers: { 'x-devconsole-key': 'k' }, signal: AbortSignal.timeout(5000) }); assert.ok(r.status < 500, q.slice(0, 50) + ' -> ' + r.status); await r.text();
    }
    assert.equal(({}).polluted, undefined, 'no prototype pollution');
    assert.equal((await api('POST', '/api/taskio/task', { title: 'x'.repeat(70 * 1024) })).status, 413);
    assert.equal((await api('GET', '/api/bridge/devices')).status, 200, 'still serving afterwards');
  });
  await test('"ask a role": the server picks the lane from the policy - local roles run on the pool, cloud roles become proposals', async () => {
    const local = await api('POST', '/api/taskio/ask', { persona: 'Nadia', area: 'sales', prompt: 'Which prospect first?', system: 'You are Nadia.' });
    assert.equal(local.status, 200); assert.equal(local.json.lane, 'local');
    assert.ok(await until(async () => (await api('GET', '/api/taskio/task?id=' + local.json.task.id)).json.task.status === 'done', 6000), 'ran on the pool');
    const done = (await api('GET', '/api/taskio/task?id=' + local.json.task.id)).json.task; assert.match(done.result.text, /^draft: Which prospect/); assert.ok(done.deviceId);
    for (const t of [local.json.task, done]) { assert.equal(t.job, undefined, 'the prompt stays on the host'); assert.equal(t.remote, undefined); }
    const day = (await api('GET', '/api/taskio/day')).json; assert.ok(!JSON.stringify(day).includes('Which prospect first?') || day.tasks.every((x) => x.job === undefined), 'the day view never carries a prompt');
    const cloud = await api('POST', '/api/taskio/ask', { persona: 'Dex', area: 'dev', prompt: 'Fix the footer link' });
    assert.equal(cloud.json.lane, 'cloud'); assert.equal(cloud.json.task.status, 'proposed'); assert.ok(!cloud.json.task.hasJob);
    const forged = await api('POST', '/api/taskio/ask', { persona: 'Lucia', area: 'legal', prompt: 'confidential', lane: 'cloud', confidential: false });
    assert.equal(forged.json.lane, 'local', 'a request cannot choose its own lane');
    assert.ok((await api('GET', '/api/taskio/proposals')).json.proposals.some((p) => p.id === cloud.json.task.id));
  });
  await test('devices report who is rendering and who carries the AI work; reserve and model controls work; the queue is visible', async () => {
    const d = (await api('GET', '/api/bridge/devices')).json; assert.equal(d.configured, true); assert.ok(d.coordination.message); assert.equal(d.nightly.start, '00:00');
    const id = d.devices[0].id;
    assert.equal((await api('POST', '/api/bridge/reserve', { id, reserved: true })).status, 200);
    assert.ok(await until(async () => (await api('GET', '/api/bridge/devices')).json.devices[0].assignment === 'reserved', 4000));
    assert.equal((await api('POST', '/api/bridge/model', { id, action: 'start' })).status, 409, 'no model is configured on this test PC, so the node says so');
    assert.equal((await api('POST', '/api/bridge/reserve', { id, reserved: false })).status, 200);
    const q = (await api('GET', '/api/bridge/queue')).json; assert.ok(q.ok && Array.isArray(q.tasks));
    const rt = (await api('GET', '/api/bridge/routines')).json; assert.ok(rt.routines.length >= 9 && rt.routines.find((r) => r.id === 'ward-digest').lane === 'local' && rt.routines.find((r) => r.id === 'dex-site-backlog').lane === 'cloud');
    assert.equal((await api('POST', '/api/bridge/routines/toggle', { id: 'ward-digest', enabled: false })).status, 200);
    assert.equal((await api('POST', '/api/bridge/routines/run', { id: 'nope' })).status, 400);
  });
  await test('without a bridge key the local lane fails cleanly (503) while the cloud lane still records proposals', async () => {
    delete process.env.G741_BRIDGE_KEY_FILE;
    const bare = bridge.init({ dir: tmp(), isAuthed: () => true, cors: {}, getProspects: () => [], getBugs: () => [], autoStart: false });
    const s2 = http.createServer((req, res) => { if (!bare.handle(req, res, new URL(req.url, 'http://x'))) { res.writeHead(404); res.end('{}'); } });
    await new Promise((r) => s2.listen(0, '127.0.0.1', r)); const b2 = 'http://127.0.0.1:' + s2.address().port;
    const post = async (b) => { const r = await fetch(b2 + '/api/taskio/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, json: await r.json() }; };
    assert.equal((await post({ persona: 'Ward', area: 'security', prompt: 'x' })).status, 503);
    assert.equal((await post({ persona: 'Dex', area: 'dev', prompt: 'x' })).json.lane, 'cloud');
    const pre = await bare.beforeRender(); assert.ok(pre.unloaded, 'beforeRender is a no-op without a bridge');
    await new Promise((r) => s2.close(r));
  });
  API.stop(); await new Promise((r) => { srv.close(r); srv.closeAllConnections && srv.closeAllConnections(); }); await nodeR.stop(); await llR.close();

  console.log('joining another PC');
  await test('the bundle for a second PC has everything it needs, the shared key, a fresh identity, and refuses a non-empty folder', () => {
    const src = tmp(), key = path.join(src, 'bridge.key');
    P.createKeyFile(key);
    for (const f of ['node-agent.js', 'protocol.js', 'model-supervisor.js', 'schedule.js', 'archivist.js', 'start-node.bat', 'join.bat', 'join.ps1']) fs.copyFileSync(path.join(__dirname, f), path.join(src, f));
    const out = path.join(tmp(), 'bundle'), r = exportBundle(src, key, out);
    for (const f of ['node-agent.js', 'protocol.js', 'model-supervisor.js', 'schedule.js', 'archivist.js', 'join.bat', 'join.ps1', 'bridge.key', 'bridge-node.json', 'README-PC2.txt']) assert.ok(fs.existsSync(path.join(out, f)), f);
    assert.equal(P.loadKey(path.join(out, 'bridge.key')), P.loadKey(key)); assert.equal(r.fingerprint, P.fingerprint(P.loadKey(key)));
    const cfg = JSON.parse(fs.readFileSync(path.join(out, 'bridge-node.json'), 'utf8')); assert.equal(cfg.alias, 'Frankenstein'); assert.equal(cfg.nightly.start, '00:00'); assert.ok(cfg.id && cfg.id !== defaultConfig('x').id);
    assert.ok(!fs.readFileSync(path.join(out, 'README-PC2.txt'), 'utf8').includes(P.loadKey(key)), 'the readme never contains the key');
    assert.throws(() => exportBundle(src, key, out), /not empty/);
    const lone = path.join(tmp(), 'b2'); fs.mkdirSync(lone); fs.copyFileSync(path.join(src, 'node-agent.js'), path.join(src, 'node-agent.copy.js'));
    assert.throws(() => exportBundle(tmp(), key, lone), /missing/);
  });

  console.log('\n' + results.filter((r) => r[0]).length + ' passed, ' + results.filter((r) => !r[0]).length + ' failed');
  process.exit(results.some((r) => !r[0]) ? 1 : 0);
})().catch((e) => { console.error('test run crashed:', e); process.exit(1); });
