#!/usr/bin/env node
'use strict';
// Self-test for the bridge: protocol, two real agents + a hub over loopback with a fake model server, routing policy,
// and Task-IO. No dependencies, no GPU, no network beyond 127.0.0.1 (plus one optional LAN-broadcast discovery check).
//   node bridge/bridge.test.js
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./protocol');
const { createAgent } = require('./node-agent');
const { createHub, laneFor, isConfidential, isPrivateHost } = require('./hub');
const { createTaskio } = require('./taskio');
const policy = require('./policy');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEY = 'a'.repeat(64), OTHER = 'b'.repeat(64);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-bridge-test-'));

async function signedFetch(base, key, method, p, bodyObj, mutate) {
  const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
  const headers = P.signRequest(key, method, p, body);
  if (mutate) mutate(headers);
  const r = await fetch(base + p, { method, headers: { ...headers, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body || undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}

function fakeLlama() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200); return res.end('{"status":"ok"}'); }
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        const j = JSON.parse(b || '{}'), last = (j.messages || []).slice(-1)[0] || {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'echo: ' + last.content } }], usage: { completion_tokens: 7 } }));
      });
    });
    s.listen(0, '127.0.0.1', () => resolve({ port: s.address().port, close: () => new Promise((r) => { s.close(r); s.closeAllConnections && s.closeAllConnections(); }) }));
  });
}
const gpu = (util) => async () => ({ name: 'Fake RTX 3060', utilPct: util, vramUsedGB: 2, vramTotalGB: 12, tempC: 50 });

(async () => {
  console.log('protocol');
  await test('a signed request verifies; a tampered body, wrong key, stale clock and replay do not', () => {
    const g = new P.ReplayGuard(), now = Date.now(), h = P.signRequest(KEY, 'POST', '/v1/jobs', '{"a":1}', now);
    assert.ok(P.verifyRequest(KEY, 'POST', '/v1/jobs', h, '{"a":1}', g, now).ok);
    assert.equal(P.verifyRequest(KEY, 'POST', '/v1/jobs', h, '{"a":1}', g, now).reason, 'replay');
    const h2 = P.signRequest(KEY, 'POST', '/v1/jobs', '{"a":1}', now);
    assert.equal(P.verifyRequest(KEY, 'POST', '/v1/jobs', h2, '{"a":2}', new P.ReplayGuard(), now).reason, 'bad-signature');
    assert.equal(P.verifyRequest(OTHER, 'POST', '/v1/jobs', h2, '{"a":1}', new P.ReplayGuard(), now).reason, 'bad-signature');
    assert.equal(P.verifyRequest(KEY, 'GET', '/v1/jobs', h2, '{"a":1}', new P.ReplayGuard(), now).reason, 'bad-signature');
    assert.equal(P.verifyRequest(KEY, 'POST', '/v1/jobs', h2, '{"a":1}', new P.ReplayGuard(), now + 5 * 60 * 1000).reason, 'stale-or-future');
    assert.equal(P.verifyRequest(KEY, 'POST', '/v1/jobs', {}, '', new P.ReplayGuard(), now).reason, 'missing-auth');
  });
  await test('a forged signature never fills the replay cache', () => {
    const g = new P.ReplayGuard(), now = Date.now();
    for (let i = 0; i < 50; i++) P.verifyRequest(KEY, 'GET', '/v1/info', { 'x-bridge-ts': String(now), 'x-bridge-nonce': ('0'.repeat(23) + (i % 10)), 'x-bridge-sig': 'f'.repeat(64) }, '', g, now);
    assert.equal(g.seen.size, 0);
  });
  await test('beacons: valid round-trips; forged, tampered, stale and malformed are dropped', () => {
    const now = Date.now(), b = P.makeBeacon(KEY, { id: 'abc', alias: 'PC-2', port: 7411 }, now);
    assert.deepEqual(P.parseBeacon(KEY, b, now), { id: 'abc', alias: 'PC-2', port: 7411, ts: now });
    assert.equal(P.parseBeacon(OTHER, b, now), null);
    assert.equal(P.parseBeacon(KEY, Buffer.from(b.toString().replace('PC-2', 'EVIL')), now), null);
    assert.equal(P.parseBeacon(KEY, b, now + 3 * 60 * 1000), null);
    assert.equal(P.parseBeacon(KEY, Buffer.from('not json'), now), null);
  });
  await test('broadcast addresses skip virtual adapters and compute the subnet broadcast', () => {
    const ifs = { 'Wi-Fi': [{ family: 'IPv4', internal: false, address: '192.168.100.23', netmask: '255.255.255.0' }], 'VMware Network Adapter VMnet8': [{ family: 'IPv4', internal: false, address: '192.168.88.1', netmask: '255.255.255.0' }],
      'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.17.80.1', netmask: '255.255.240.0' }], Loopback: [{ family: 'IPv4', internal: true, address: '127.0.0.1', netmask: '255.0.0.0' }] };
    assert.deepEqual(P.broadcastAddresses(ifs), ['192.168.100.255']);
  });
  await test('key files: only 64 hex characters are accepted, and creating one never overwrites', () => {
    const d = tmp(), f = path.join(d, 'k.key');
    const a = P.createKeyFile(f), b = P.createKeyFile(f);
    assert.ok(a.created && !b.created && a.fingerprint === b.fingerprint && /^[0-9a-f]{8}$/.test(a.fingerprint));
    fs.writeFileSync(f, 'short'); assert.throws(() => P.loadKey(f));
  });

  console.log('routing policy');
  await test('dev and qa go to the cloud lane; everything else stays local', () => {
    for (const a of ['dev', 'qa']) assert.equal(laneFor(policy, a, false), 'cloud');
    for (const a of ['legal', 'compliance', 'marketing', 'strategy', 'sales', 'design', 'copy', 'security', 'management', 'unknown-area']) assert.equal(laneFor(policy, a, false), 'local', a);
  });
  await test('confidential work can never reach the cloud, even if the policy table is edited to say so', () => {
    const tampered = { defaultLane: 'cloud', lanes: { legal: 'cloud', compliance: 'cloud', sales: 'cloud', dev: 'cloud' }, confidentialAreas: policy.confidentialAreas };
    for (const a of policy.confidentialAreas) assert.equal(laneFor(tampered, a, false), 'local', a);
    assert.equal(laneFor(policy, 'dev', true), 'local');
    assert.ok(isConfidential(policy, 'legal', false) && !isConfidential(policy, 'dev', false) && isConfidential(policy, 'dev', true));
  });
  await test('only private LAN addresses are ever followed from discovery', () => {
    for (const h of ['10.0.0.5', '192.168.1.9', '172.20.1.1', '127.0.0.1']) assert.ok(isPrivateHost(h), h);
    for (const h of ['8.8.8.8', '172.32.0.1', '203.0.113.9', 'evil.example.com']) assert.ok(!isPrivateHost(h), h);
  });

  console.log('agents + hub (loopback)');
  const llama = await fakeLlama(), dir = tmp();
  const A = createAgent({ key: KEY, alias: 'PC-A', port: 0, bindHost: '127.0.0.1', llamaUrl: 'http://127.0.0.1:' + llama.port, model: 'fake', discovery: false, gpuProvider: gpu(5) });
  const B = createAgent({ key: KEY, alias: 'PC-B', port: 0, bindHost: '127.0.0.1', llamaUrl: 'http://127.0.0.1:' + llama.port, model: 'fake', discovery: false, gpuProvider: gpu(90), pendingRamGB: 16 });
  const pa = await A.start(), pb = await B.start();
  const hub = createHub({ dir, key: KEY, targets: [{ host: '127.0.0.1', port: pa, source: 'configured' }, { host: '127.0.0.1', port: pb, source: 'configured' }] });
  await hub.refresh();

  await test('the hub lists both PCs with hardware, live stats and model state', () => {
    const v = hub.view();
    assert.equal(v.length, 2); assert.ok(v.every((d) => d.online));
    const b = v.find((d) => d.alias === 'PC-B');
    assert.equal(b.hw.pendingRamGB, 16); assert.equal(b.hw.gpu.name, 'Fake RTX 3060');
    assert.ok(b.stats.llm.up && b.stats.gpu.utilPct === 90 && b.stats.ramTotalGB > 0);
  });
  await test('the hub never contacts a public address a node reports as a peer, but does follow private LAN ones', async () => {
    const calls = [];
    const spy = async (url, init) => {
      calls.push(url);
      if (/\/v1\/peers$/.test(url)) return { ok: true, status: 200, json: async () => ({ ok: true, peers: [{ id: 'evil', alias: 'evil', address: '203.0.113.9', port: 7411 }, { id: 'lan', alias: 'lan', address: '192.168.1.50', port: 7411 }] }) };
      if (url.includes('192.168.1.50')) throw new Error('unreachable (test)');
      return fetch(url, init);
    };
    const h2 = createHub({ dir: tmp(), key: KEY, fetchImpl: spy, targets: [{ host: '127.0.0.1', port: pa, source: 'configured' }] });
    await h2.refresh();
    assert.ok(!calls.some((u) => u.includes('203.0.113.9')), 'contacted a public address');
    assert.ok(calls.some((u) => u.includes('192.168.1.50')), 'did not follow the private LAN peer');
  });
  await test('an alias set in the hub is stored and shown instead of the PC name', () => {
    const id = hub.view().find((d) => d.alias === 'PC-B').id;
    assert.ok(hub.setAlias(id, 'Studio tower').ok);
    assert.equal(hub.view().find((d) => d.id === id).alias, 'Studio tower');
    assert.equal(hub.setAlias(id, '<<<>>>').ok, false);
    assert.equal(hub.setAlias('nope', 'x').ok, false);
    hub.setAlias(id, 'PC-B');
  });
  await test('a local job goes to the less-loaded PC, runs on its model, and the result comes back', async () => {
    const r = await hub.submit({ area: 'legal', role: 'Lucia', title: 'Draft NDA outline', messages: [{ role: 'user', content: 'outline an NDA' }] });
    assert.ok(r.ok && r.lane === 'local'); assert.equal(r.alias, 'PC-A');
    let s; for (let i = 0; i < 40; i++) { s = await hub.jobStatus(r.hubJobId); if (s.job.status === 'done') break; await sleep(50); }
    assert.equal(s.job.status, 'done'); assert.equal(s.job.result.text, 'echo: outline an NDA'); assert.ok(s.job.confidential, 'legal is confidential');
  });
  await test('cloud-lane work is not sent to any PC; confidential work is forced local', async () => {
    const c = await hub.submit({ area: 'dev', title: 'Fix cooldown' });
    assert.ok(c.ok && c.lane === 'cloud' && c.deviceId === null && /Dev Console/.test(c.note));
    const f = await hub.submit({ area: 'dev', confidential: true, title: 'x', messages: [{ role: 'user', content: 'secret' }] });
    assert.equal(f.lane, 'local'); assert.ok(f.deviceId);
  });
  await test('a PC that comes back with a new identity at the same address replaces its old entry instead of leaving an offline ghost', async () => {
    const mk = (id, port = 0) => createAgent({ key: KEY, alias: 'Frankenstein', id, port, bindHost: '127.0.0.1', discovery: false, gpuProvider: gpu(1), render: { ports: [] } });
    const a1 = mk('111111111111'), p = await a1.start();
    const hubG = createHub({ dir: tmp(), key: KEY, targets: [{ host: '127.0.0.1', port: p, source: 'configured' }] });
    await hubG.refresh(); assert.equal(hubG.view().length, 1);
    await a1.stop();
    const a2 = mk('222222222222', p); await a2.start();                       // re-installed: same PC, same port, a fresh id
    await hubG.refresh();
    const v = hubG.view(); assert.equal(v.length, 1, 'one PC, one entry'); assert.equal(v[0].id, '222222222222'); assert.ok(v[0].online);
    await a2.stop();
  });
  await test('work spreads: with one PC busy the other takes the next job', async () => {
    await A.stop();                 // A goes away
    await hub.refresh(); await hub.refresh();
    assert.equal(hub.view().find((d) => d.alias === 'PC-A').online, false);
    const r = await hub.submit({ area: 'marketing', role: 'Talia', title: 'Taglines', messages: [{ role: 'user', content: 'three taglines' }] });
    assert.ok(r.ok); assert.equal(r.alias, 'PC-B');
  });
  await test('with no PC online a local job fails cleanly instead of falling back to the cloud', async () => {
    await B.stop(); await hub.refresh(); await hub.refresh();
    const r = await hub.submit({ area: 'legal', title: 'x', messages: [{ role: 'user', content: 'y' }] });
    assert.equal(r.ok, false); assert.equal(r.error, 'no_local_device_available'); assert.equal(r.lane, 'local');
  });

  console.log('agent security');
  const S = createAgent({ key: KEY, alias: 'PC-S', port: 0, bindHost: '127.0.0.1', llamaUrl: 'http://127.0.0.1:1', discovery: false, gpuProvider: gpu(1) });
  const ps = await S.start(), base = 'http://127.0.0.1:' + ps;
  await test('no signature, a wrong key, a tampered body and a replayed request are all refused with a bare 401', async () => {
    assert.equal((await fetch(base + '/v1/info')).status, 401);
    assert.equal((await signedFetch(base, OTHER, 'GET', '/v1/info')).status, 401);
    const body = { type: 'echo', messages: [{ role: 'user', content: 'hi' }] }, hdr = P.signRequest(KEY, 'POST', '/v1/jobs', JSON.stringify(body));
    assert.equal((await fetch(base + '/v1/jobs', { method: 'POST', headers: hdr, body: JSON.stringify({ ...body, messages: [{ role: 'user', content: 'tampered' }] }) })).status, 401);
    const h2 = P.signRequest(KEY, 'GET', '/v1/stats', '');
    assert.equal((await fetch(base + '/v1/stats', { headers: h2 })).status, 200);
    const again = await fetch(base + '/v1/stats', { headers: h2 });
    assert.equal(again.status, 401); assert.deepEqual(await again.json(), { ok: false, error: 'unauthorized' });
  });
  await test('jobs are data only: other types, commands, bad messages and oversize bodies are rejected', async () => {
    const bad = [{ type: 'shell', messages: [{ role: 'user', content: 'dir' }] }, { type: 'exec', cmd: 'calc.exe' }, { type: 'echo', messages: [] }, { type: 'echo', messages: [{ role: 'root', content: 'x' }] },
      { type: 'echo', messages: [{ role: 'user', content: 'x'.repeat(16001) }] }, { type: 'echo', messages: [{ role: 'user', content: 1 }] }];
    for (const b of bad) assert.equal((await signedFetch(base, KEY, 'POST', '/v1/jobs', b)).status, 400, JSON.stringify(b).slice(0, 60));
    const ok = await signedFetch(base, KEY, 'POST', '/v1/jobs', { type: 'echo', title: 'ping', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(ok.status, 202);
    await sleep(80);
    const j = await signedFetch(base, KEY, 'GET', '/v1/jobs/' + ok.json.jobId);
    assert.equal(j.json.job.result.text, 'hi');
  });
  await test('a signed request with accents survives a multi-byte character split across network chunks (it must not fail the signature)', async () => {
    const text = 'Pregunta sobre diseño y cotización: ¿cuánto cuesta? ' + 'ñ'.repeat(5000), body = JSON.stringify({ type: 'echo', messages: [{ role: 'user', content: text }] }), buf = Buffer.from(body, 'utf8');
    const cut = buf.indexOf(Buffer.from('ñ')) + 1;                       // the middle of a 2-byte character
    const u = new URL(base), status = await new Promise((resolve) => {
      const headers = { ...P.signRequest(KEY, 'POST', '/v1/jobs', body), 'Content-Type': 'application/json', 'Content-Length': buf.length };
      const req = http.request({ host: u.hostname, port: u.port, method: 'POST', path: '/v1/jobs', headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', () => resolve(0)); req.write(buf.subarray(0, cut)); setTimeout(() => { req.write(buf.subarray(cut)); req.end(); }, 50);
    });
    assert.equal(status, 202, 'accepted, not 401');
  });
  await test('an llm job on a PC with no model running fails fast with a clear reason', async () => {
    const r = await signedFetch(base, KEY, 'POST', '/v1/jobs', { type: 'llm.chat', messages: [{ role: 'user', content: 'hi' }] });
    await sleep(120);
    const j = await signedFetch(base, KEY, 'GET', '/v1/jobs/' + r.json.jobId);
    assert.equal(j.json.job.status, 'failed'); assert.match(j.json.job.error, /llm_unavailable/);
  });
  await S.stop(); await llama.close();

  console.log('discovery (real UDP broadcast, optional)');
  await test('two agents on one LAN find each other from signed beacons (skipped if this host cannot broadcast)', async () => {
    if (!P.broadcastAddresses().length) { console.log('       (no real network interface - skipped)'); return; }
    const dp = 17000 + Math.floor(Math.random() * 1000);
    const X = createAgent({ key: KEY, alias: 'X', port: 0, bindHost: '127.0.0.1', discoveryPort: dp, discovery: true, gpuProvider: gpu(1) });
    const Y = createAgent({ key: KEY, alias: 'Y', port: 0, bindHost: '127.0.0.1', discoveryPort: dp, discovery: true, gpuProvider: gpu(1) });
    await X.start(); await Y.start();
    let found = false;
    for (let i = 0; i < 30 && !found; i++) { await sleep(500); found = X.peers().some((p) => p.alias === 'Y') && Y.peers().some((p) => p.alias === 'X'); }
    await X.stop(); await Y.stop();
    if (!found) console.log('       (no broadcast delivery on this host - discovery not verified here; static peers still work)');
  });

  console.log('task-io');
  const tdir = tmp(), D = '2026-10-12';
  const w = (f, rows) => fs.writeFileSync(path.join(tdir, f), rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  w('devconsole-log.jsonl', [{ ts: '2026-10-12T15:00:00Z', type: 'dispatch', repo: 'website', issueNumber: 80, title: 'Follow-up: Follow-up: add star' }, { ts: '2026-10-12T16:00:00Z', type: 'commit', repo: 'website', pr: 81, merged: true, category: 'functional' },
    { ts: '2026-10-12T05:30:00Z', type: 'dispatch', repo: 'website', issueNumber: 79, title: 'late last night (Oct 11 in Mexico City)' }, 'garbage line']);
  w('autotest-runs.jsonl', [{ ts: '2026-10-12T14:00:00Z', job: 'weekly', summary: { ok: 104, warn: 1, down: 1, total: 106 } }]);
  w('leads-log.jsonl', [{ ts: '2026-10-12T17:00:00Z', name: 'Private Person', email: 'private@example.com' }, { ts: '2026-10-12T18:00:00Z', name: 'Other Person', email: 'other@example.com' }]);
  const prospects = Array.from({ length: 8 }, (_, i) => ({ id: 'p' + i, name: 'Dev ' + i, status: 'new', createdAt: '2026-10-12T19:00:00Z', updatedAt: '2026-10-12T19:00:00Z' })).concat([{ id: 'pX', name: 'Maxica', status: 'contacted', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-10-12T20:00:00Z' }]);
  const bugs = [{ id: 'bug_1', title: 'Wilbur never reconnects', priority: 'critical', status: 'open', createdAt: '2026-10-12T21:00:00Z', updatedAt: '2026-10-12T21:00:00Z' }];
  const T = createTaskio({ dir: tdir, getProspects: () => prospects, getBugs: () => bugs, now: () => Date.parse('2026-10-12T22:00:00Z') });
  const d = T.day(D);
  await test('a day is built from real activity, in order, attributed to the right area and lane', () => {
    const by = (src) => d.tasks.filter((t) => t.source === src);
    assert.equal(by('devconsole').length, 2); assert.equal(by('devconsole')[0].title, 'Follow-up: add star'); assert.equal(by('devconsole')[1].status, 'done');
    assert.ok(d.tasks.every((t, i, a) => !i || a[i - 1].ts <= t.ts)); assert.equal(by('autotest')[0].status, 'failed'); assert.equal(by('autotest')[0].lane, 'script');
    assert.equal(by('qa')[0].persona, 'Priya'); assert.ok(d.tasks.filter((t) => t.persona === 'Dex').every((t) => t.lane === 'cloud'));
  });
  await test('a role that records its own Dev Console dispatch is shown once, under the right person; others keep the derived entry', () => {
    const d2 = tmp(); fs.writeFileSync(path.join(d2, 'devconsole-log.jsonl'), [{ ts: '2026-10-14T06:10:00Z', type: 'dispatch', repo: 'website', issueNumber: 901, title: 'QA: regression test case' }, { ts: '2026-10-14T06:11:00Z', type: 'dispatch', repo: 'website', issueNumber: 90, title: 'older unrelated issue' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const T2 = createTaskio({ dir: d2, now: () => Date.parse('2026-10-14T06:10:30Z') });
    const mine = T2.createTask({ title: 'QA brief: regression test', persona: 'Priya', area: 'qa', lane: 'cloud', status: 'running', source: 'routine', ref: 'website#901' });
    T2.patchTask(mine.task.id, { status: 'done', ref: 'website#901 -> PR 951' });             // the PR link is appended later; the issue is still recognised
    const day2 = T2.day('2026-10-14'), dispatches = day2.tasks.filter((t) => /website#9/.test(t.ref));
    assert.equal(dispatches.filter((t) => /website#901/.test(t.ref)).length, 1, 'issue 901 appears once'); assert.equal(dispatches.find((t) => /website#901/.test(t.ref)).persona, 'Priya');
    assert.ok(day2.tasks.some((t) => t.source === 'devconsole' && t.ref === 'website#90'), 'issue 90 is not mistaken for 901 and keeps its derived entry');
  });
  await test('days follow Mexico City time: a 05:30 UTC event belongs to the previous local day', () => {
    assert.ok(!d.tasks.some((t) => /late last night/.test(t.title)));
    assert.ok(T.day('2026-10-11').tasks.some((t) => /late last night/.test(t.title)));
    assert.equal(T.today(), '2026-10-12');
  });
  await test('bulk CRM changes collapse into one task; inbound leads are counted, never copied', () => {
    assert.equal(d.tasks.filter((t) => t.source === 'sales' && /prospects added/.test(t.title)).length, 1);
    assert.equal(d.tasks.filter((t) => /Maxica -> contacted/.test(t.title)).length, 1);
    const l = d.tasks.find((t) => t.source === 'leads'); assert.equal(l.title, '2 session requests received');
    assert.ok(!JSON.stringify(d).includes('private@example.com') && !JSON.stringify(d).includes('Private Person'));
  });
  await test('the Task-IO log is cached only while the file is unchanged: a write by another process (the nightly script) is seen straight away', () => {
    const d3 = tmp(), T3 = createTaskio({ dir: d3 }), c = T3.createTask({ title: 'mine', persona: 'Priya', lane: 'script', status: 'queued' });
    assert.equal(T3.getTask(c.task.id).status, 'queued'); assert.equal(T3.getTask(c.task.id).status, 'queued');          // second read is the cached one
    fs.appendFileSync(path.join(d3, 'taskio-tasks.jsonl'), JSON.stringify({ type: 'update', id: c.task.id, patch: { status: 'done' } }) + '\n');   // another process writes
    assert.equal(T3.getTask(c.task.id).status, 'done');
    createTaskio({ dir: d3 }).patchTask(c.task.id, { detail: 'a second writer' }); assert.equal(T3.getTask(c.task.id).detail, 'a second writer');
  });
  await test('manual tasks: validated, editable only if created here, folded into the day', () => {
    assert.equal(T.createTask({ title: '   ' }).ok, false);
    const c = T.createTask({ title: 'Review privacy notice', persona: 'Ximena', area: 'Compliance', lane: 'bogus', status: 'nonsense' });
    assert.ok(c.ok && c.task.lane === 'human' && c.task.status === 'queued' && c.task.area === 'compliance');
    assert.ok(T.updateTask(c.task.id, { status: 'done', detail: 'ok' }).ok);
    assert.equal(T.updateTask('dc:123', { status: 'done' }).ok, false); assert.equal(T.updateTask('tk_000000000000', {}).ok, false);
    const t = T.day(D).tasks.find((x) => x.id === c.task.id); assert.equal(t.status, 'done'); assert.equal(t.detail, 'ok');
  });
  await test('EOD: snapshot is frozen, latest submission per date wins, history lists newest first', () => {
    const r1 = T.submitEod({ date: D, note: 'first' });
    assert.ok(r1.ok && r1.report.taskCount === T.day(D).tasks.length);
    T.createTask({ title: 'after the first EOD' });
    const frozen = T.getEod(D); assert.ok(!frozen.tasks.some((t) => t.title === 'after the first EOD'));
    const r2 = T.submitEod({ date: D, note: 'second' }); assert.equal(T.getEod(D).note, 'second'); assert.ok(T.getEod(D).tasks.some((t) => t.title === 'after the first EOD'));
    T.submitEod({ date: '2026-10-11', note: 'older' });
    assert.deepEqual(T.listEod().map((r) => r.date), [D, '2026-10-11']); assert.equal(T.submitEod({ date: 'nope' }).ok, false); assert.ok(r2.ok);
  });

  console.log('\n' + results.filter((r) => r[0]).length + ' passed, ' + results.filter((r) => !r[0]).length + ' failed');
  process.exit(results.some((r) => !r[0]) ? 1 : 0);
})().catch((e) => { console.error('test run crashed:', e); process.exit(1); });
