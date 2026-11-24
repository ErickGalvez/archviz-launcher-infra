#!/usr/bin/env node
'use strict';
// Tests for the terminals' logs (logs.js): reading Wilbur's files and cloudflared.log like `tail -f`, the launcher's own lines, the agents through the hub,
// sorting every line into an activity type, stream sessions, and the two answers (the app's /api/logs and the QA console's /api/qa/logs).
//   node logs.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('./logs');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-logs-test-'));
const at = (h, m, s, ms = 0) => new Date(2026, 10, 16, h, m, s, ms).getTime();            // 16 Nov 2026, local time (the launcher runs on PC-1)

// What the two terminals in the owner's screenshot print, plus what a whole session looks like.
const WILBUR = [
  '[15:10:02.100] info: Http server listening on port 80',
  '[15:10:02.105] info: Listening for streamer connections on port 8888',
  '[15:10:09.000] info: Streamer DefaultStreamer connected: ::1',
  '[15:12:00.010] info: player 5 connected: 187.190.0.9',
  '[15:12:00.020] info: > Player5 :: {"type":"config","peerConnectionOptions":{}}',
  '[15:12:00.400] info: < Player5 :: {"type":"subscribe","streamerId":"DefaultStreamer"}',
  '[15:12:01.000] info: > Player5 :: {"type":"offer","sdp":"v=0 o=- 1 2 IN IP4 127.0.0.1"}',
  '[15:12:01.200] info: < Player5 :: {"type":"answer","sdp":"v=0"}',
  '[15:12:01.300] info: < Player5 :: {"type":"iceCandidate","candidate":{"candidate":"candidate:1 1 udp 2122260223 10.0.0.2 55000 typ host"}}',
  '[15:17:51.933] info: < Player5 :: {"type":"pong","time":1794863871877}',
  '[15:18:19.535] info: > DefaultStreamer :: {"type":"ping","time":1794863899}',
  '[15:18:19.536] info: < DefaultStreamer :: {"type":"pong","time":1794863899}',
  '[15:18:21.934] info: > Player5 :: {"type":"ping","time":1794863901878}',
  '\u001b[33m[15:20:00.000] warn: Player 5 disconnected: 1006 - abnormal closure\u001b[39m',
  '[15:20:30.000] error: Streamer DefaultStreamer disconnected unexpectedly',
];

(async () => {
  console.log('sorting lines into activity types');
  await test('Wilbur: keepalives, WebRTC, visitors, the UE5 streamer, startup and web requests each get their own type', () => {
    const t = (s) => L.classifyWilbur(L.parseWilburLine(s, at(16, 0, 0)).text);
    assert.deepEqual(WILBUR.map(t), ['startup', 'startup', 'streamer', 'players', 'webrtc', 'players', 'webrtc', 'webrtc', 'webrtc', 'keepalive', 'keepalive', 'keepalive', 'keepalive', 'players', 'streamer']);
    assert.equal(L.classifyWilbur('GET /player.html 200'), 'http');
    assert.equal(L.classifyWilbur('< Player5 :: {"type":"dataChannelRequest"}'), 'players');
    assert.equal(L.classifyWilbur('> DefaultStreamer :: {"type":"identify"}'), 'streamer');
  });
  await test('the node agent: model, jobs, render handover, refused requests, restarts and startup', () => {
    assert.deepEqual(['model starting (work waiting)', 'model stopping (idle)', 'job 3fa1 started: llm.chat (sales) for Nadia', 'job 3fa1 failed after 2.0 s: llm_unavailable',
      'render: this PC is serving a client (no AI work here)', 'rejected request from 192.168.1.9: bad-signature', 'restart requested by the hub: back in about 5 seconds',
      'started: "PC-1" listening on :7411 (under start-node.bat)', 'something else'].map(L.classifyAgent),
    ['model', 'model', 'jobs', 'jobs', 'render', 'security', 'updates', 'startup', 'other']);
  });
  await test('the launcher\'s own lines and cloudflared\'s', () => {
    assert.deepEqual([['ps', 'Starting launch_pixelstream.bat…'], ['cf', 'Tunnel up'], ['lobby', 'Visitor Ana joined the queue'], ['lobby', 'Admin panel: update applied, restarting the launcher.'],
      ['lobby', 'Dev Console: launcher repo updated, restarting to pick up the change.'], ['bridge', 'Unloaded the local model before the stream (900 ms)'], ['qa', 'Unauthorized QA write']].map(([s, m]) => L.classifyBackend(s, m)),
    ['stream', 'tunnel', 'lobby', 'updates', 'updates', 'bridge', 'security']);
    assert.equal(L.classifyCloudflared('Registered tunnel connection connIndex=0 connection=abc location=qro01 protocol=quic'), 'tunnel');
    assert.equal(L.classifyCloudflared('Starting tunnel tunnelID=1234'), 'startup');
  });

  console.log('reading the lines');
  await test('Wilbur console lines take the file\'s date, a level, and lose their colour codes; a time after the file was written belongs to the day before', () => {
    const p = L.parseWilburLine(WILBUR[13], at(16, 0, 0));
    assert.deepEqual([p.ts, p.level, p.text], [at(15, 20, 0), 'warn', 'Player 5 disconnected: 1006 - abnormal closure']);
    assert.equal(L.parseWilburLine('[23:59:59.000] info: late', at(0, 0, 30)).ts, at(23, 59, 59) - 86400000);
  });
  await test('a Wilbur JSON file line and an ISO-stamped line are read too; anything else keeps the file\'s time and is marked as approximate', () => {
    const j = L.parseWilburLine('{"level":"warn","message":"< Player5 :: {\\"type\\":\\"subscribe\\"}","timestamp":"2026-11-16T21:20:00.000Z"}', 0);
    assert.deepEqual([j.ts, j.level, L.classifyWilbur(j.text)], [Date.parse('2026-11-16T21:20:00.000Z'), 'warn', 'players']);
    assert.equal(L.parseWilburLine('2026-11-16T21:20:00.500Z info: Http server listening on port 80', 0).ts, Date.parse('2026-11-16T21:20:00.500Z'));
    const a = L.parseWilburLine('npm WARN config something', 1234);
    assert.deepEqual([a.ts, a.approx], [1234, true]);
    assert.equal(L.parseWilburLine('   ', 0), null);
  });
  await test('cloudflared lines: ISO time and its INF / WRN / ERR levels', () => {
    const c = L.parseCloudflaredLine('2026-11-16T21:17:51Z ERR Failed to serve quic connection error="timeout"', 0);
    assert.deepEqual([c.ts, c.level, c.text], [Date.parse('2026-11-16T21:17:51Z'), 'error', 'Failed to serve quic connection error="timeout"']);
  });

  // A launcher folder with host.config, Wilbur's log folder, cloudflared.log, and a hub with two agents.
  const dir = tmp(), sws = path.join(dir, 'SignallingWebServer'), wlogs = path.join(sws, 'logs');
  fs.mkdirSync(wlogs, { recursive: true });
  fs.writeFileSync(path.join(dir, 'host.config'), 'HOST_NAME=Test\r\nSIGNAL_DIR=' + sws + '\r\n');
  const wfile = path.join(wlogs, '2026-11-16 15.10.00.log');
  fs.writeFileSync(wfile, WILBUR.slice(0, 9).join('\n') + '\n');
  fs.utimesSync(wfile, at(15, 12, 2) / 1000, at(15, 12, 2) / 1000);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');     // cloudflared writes UTC
  fs.writeFileSync(path.join(dir, 'cloudflared.log'), iso(at(15, 9, 0)) + ' INF Starting tunnel tunnelID=1234\n' + iso(at(15, 9, 1)) + ' INF Registered tunnel connection connIndex=0 location=qro01\n');
  let clock = at(15, 12, 5), agentLines = { a1: [], a2: [] }, agentStart = { a1: 100, a2: 200 };
  const hub = { agentLogs: async (cursors) => ['a1', 'a2'].map((id) => { const c = cursors[id] || {}; const since = c.startedAt === agentStart[id] ? c.seq : 0; const all = agentLines[id]; return { id, alias: id === 'a1' ? 'PC-1' : 'Frankenstein', pc: id === 'a1' ? 1 : 2, startedAt: agentStart[id], seq: all.length, lines: all.filter((e) => e.seq > since) }; }) };
  const logs = L.createLogs({ dir, hub: () => hub, now: () => clock });
  const addAgent = (id, ts, text, level = 'info') => agentLines[id].push({ seq: agentLines[id].length + 1, ts, text, level });

  console.log('the collector');
  await test('it reads Wilbur\'s newest file from <SIGNAL_DIR>\\logs, cloudflared.log and both agents, and says where it looked', async () => {
    addAgent('a1', at(15, 11, 0), 'model stopping (a client session is starting)');
    addAgent('a2', at(15, 11, 30), 'job 7c started: llm.chat (sales) for Nadia');
    const r = (await logs.query({ session: 'all', type: 'everything' })).body;
    assert.equal(r.ok, true);
    assert.deepEqual(r.lines.map((l) => l.source).sort().filter((v, i, a) => a.indexOf(v) === i), ['agent', 'cloudflared', 'wilbur']);
    assert.equal(r.lines.filter((l) => l.source === 'wilbur').length, 9);
    assert.ok(r.sources.wilbur.ok && r.sources.wilbur.where === wlogs && r.sources.wilbur.file === '2026-11-16 15.10.00.log', JSON.stringify(r.sources.wilbur));
    assert.deepEqual(r.lines.filter((l) => l.source === 'agent').map((l) => [l.device, l.pc, l.type]), [['PC-1', 1, 'model'], ['Frankenstein', 2, 'jobs']]);
    const again = (await logs.query({ session: 'all', type: 'everything', sources: 'agent' })).body;
    assert.equal(again.lines.length, 2, 'polling again does not repeat an agent\'s lines');
  });
  await test('like tail -f: the next read gets only the new lines, and a half-written line waits for its end', async () => {
    const c0 = logs.cursor;
    fs.appendFileSync(wfile, WILBUR.slice(9, 13).join('\n') + '\n' + WILBUR[13].slice(0, 20));
    fs.utimesSync(wfile, at(15, 18, 22) / 1000, at(15, 18, 22) / 1000);           // the lines are dated by the file: pin it to the fixture's day, not today
    let r = (await logs.query({ session: 'all', type: 'everything', since: c0, sources: 'wilbur' })).body;
    assert.deepEqual(r.lines.map((l) => l.type), ['keepalive', 'keepalive', 'keepalive', 'keepalive']);
    fs.appendFileSync(wfile, WILBUR[13].slice(20) + '\n' + WILBUR[14] + '\n');
    fs.utimesSync(wfile, at(15, 20, 31) / 1000, at(15, 20, 31) / 1000);
    r = (await logs.query({ session: 'all', type: 'everything', since: r.cursor, sources: 'wilbur' })).body;
    assert.deepEqual(r.lines.map((l) => [l.level, l.type]), [['warn', 'players'], ['error', 'streamer']]);
    assert.ok(!r.lines[0].text.includes('\u001b'), 'colour codes are gone');
  });
  await test('a file that was cleared is read again from its start; an agent that restarted is read from its first line again', async () => {
    const c0 = logs.cursor;
    fs.writeFileSync(path.join(dir, 'cloudflared.log'), iso(at(15, 30, 0)) + ' WRN Connection terminated connIndex=0\n');
    agentStart.a1 = 999; agentLines.a1 = []; addAgent('a1', at(15, 31, 0), 'started: "PC-1" listening on :7411 (under start-node.bat)');
    await logs.query({ session: 'all', type: 'everything', since: c0 });          // the hub notices the restart: the new start is read on the next poll
    const r = (await logs.query({ session: 'all', type: 'everything', since: c0 })).body;
    assert.ok(r.lines.some((l) => l.source === 'cloudflared' && /Connection terminated/.test(l.text) && l.level === 'warn'));
    assert.ok(r.lines.some((l) => l.source === 'agent' && l.type === 'startup'), JSON.stringify(r.lines.map((l) => l.text)));
  });
  await test('the launcher\'s own lines are typed and kept in logs/backend.jsonl, so a restart keeps them', () => {
    logs.backend('ps', 'Starting launch_pixelstream.bat…', 'info');
    logs.backend('lobby', 'Admin panel: update applied, restarting the launcher.', 'info');
    const again = L.createLogs({ dir, hub: () => null, now: () => clock });
    const r = again.select({ sources: ['backend'], type: 'everything' });
    assert.deepEqual(r.lines.map((l) => l.type), ['stream', 'updates']);
  });

  console.log('filters');
  await test('the default view hides keepalives; "everything" keeps them; one type, several types, problems only, and words', async () => {
    const q = async (p) => (await logs.query({ session: 'all', sources: 'wilbur', ...p })).body.lines;
    assert.ok(!(await q({})).some((l) => l.type === 'keepalive'));
    assert.equal((await q({ type: 'everything' })).filter((l) => l.type === 'keepalive').length, 4);
    assert.deepEqual((await q({ type: 'webrtc' })).map((l) => (/"type":"(\w+)"/.exec(l.text) || [])[1]), ['config', 'offer', 'answer', 'iceCandidate']);
    assert.equal((await q({ type: 'webrtc,players' })).length, 7);
    assert.deepEqual((await q({ type: 'problems' })).map((l) => l.level), ['warn', 'error']);
    assert.equal((await q({ q: 'player5 SUBSCRIBE' })).length, 1);
    assert.equal((await logs.query({ type: 'nonsense' })).status, 400);
  });
  await test('every answer carries the counts per type for the dropdown, the type list, the views, and each source\'s state', async () => {
    const r = (await logs.query({ session: 'all' })).body;
    assert.equal(r.counts.keepalive, 4); assert.ok(r.counts.webrtc >= 4);
    assert.ok(r.types.some((t) => t.id === 'players' && /Visitors/.test(t.label)) && r.views.problems);
    assert.ok(r.sources.agent.ok && r.sources.backend.ok);
  });

  console.log('sessions');
  await test('a launch starts a session; a stream that stays stopped closes it after a minute; "current" is the open one, with 15 s either side', async () => {
    clock = at(16, 0, 0);
    const s = logs.sessionStart('Stream session · Ana');
    logs.sessionTick('stopped'); assert.equal(logs.sessions().find((x) => x.id === s.id).end, null, 'a launch that still reads "stopped" is not cut short');
    addAgent('a2', at(16, 0, 20), 'render: this PC is serving a client (no AI work here)');
    fs.appendFileSync(wfile, '[16:00:30.000] info: player 7 connected: 10.1.1.1\n');
    fs.utimesSync(wfile, at(16, 0, 31) / 1000, at(16, 0, 31) / 1000);            // as Wilbur writing it at that time would leave it
    let r = (await logs.query({ session: 'current', type: 'everything' })).body;
    assert.equal(r.session.id, s.id); assert.equal(r.session.open, true);
    assert.ok(r.lines.every((l) => Date.parse(l.at) >= at(16, 0, 0) - 15000), 'nothing from before the session');
    assert.deepEqual(r.lines.map((l) => l.source + ':' + l.type), ['agent:render', 'wilbur:players']);
    clock = at(16, 10, 0); logs.sessionTick('running'); assert.equal(logs.sessions().find((x) => x.id === s.id).end, null);
    clock = at(16, 20, 0); logs.sessionTick('stopped');
    const closed = logs.sessions().find((x) => x.id === s.id);
    assert.equal(closed.end, new Date(at(16, 20, 0)).toISOString());
    r = (await logs.query({ session: s.id })).body; assert.equal(r.session.open, false);
    assert.equal((await logs.query({ session: 's_nope' })).status, 404);
  });
  await test('the sessions survive a restart (logs/sessions.json), newest first in the answer', async () => {
    const again = L.createLogs({ dir, hub: () => null, now: () => clock });
    assert.equal(again.sessions().length, 1);
    const r = (await again.query({})).body;
    assert.equal(r.sessions[0].label, 'Stream session · Ana');
  });

  console.log('the QA console\'s answer');
  await test('/api/qa/logs: every line of the asked sources in the window, as { source, at, text }, an agent\'s line named by its PC', async () => {
    const r = await logs.qa({ since: new Date(at(15, 11, 0)).toISOString(), until: new Date(at(15, 13, 0)).toISOString(), sources: 'wilbur,agent,backend' });
    assert.equal(r.status, 200);
    assert.ok(r.body.lines.every((l) => typeof l.source === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(l.at) && typeof l.text === 'string'));
    assert.ok(r.body.lines.some((l) => l.source === 'agent' && l.text === 'PC-1: model stopping (a client session is starting)'));
    assert.ok(r.body.lines.some((l) => l.source === 'wilbur' && /iceCandidate/.test(l.text)), 'the patterns the QA console looks for are there');
    assert.ok(!r.body.lines.some((l) => l.source === 'cloudflared'), 'only the asked sources');
  });
  await test('/api/qa/logs refuses a window that is not a pair of ISO times, is backwards, or is over two days', async () => {
    assert.equal((await logs.qa({ since: 'yesterday' })).status, 400);
    assert.equal((await logs.qa({ since: '2026-11-16T10:00:00Z', until: '2026-11-16T09:00:00Z' })).status, 400);
    assert.equal((await logs.qa({ since: '2026-11-10T10:00:00Z', until: '2026-11-16T09:00:00Z' })).status, 400);
  });

  console.log('when a source is missing');
  await test('no SIGNAL_DIR, no Wilbur files, no cloudflared.log and no bridge are each said plainly, and the rest still answers', async () => {
    const d = tmp();
    const bare = L.createLogs({ dir: d, hub: () => null });
    let r = (await bare.query({ session: 'all' })).body;
    assert.equal(r.ok, true);
    assert.match(r.sources.wilbur.error, /SIGNAL_DIR or WILBUR_LOG_DIR/);
    assert.match(r.sources.cloudflared.error, /no cloudflared\.log/);
    assert.match(r.sources.agent.error, /bridge is not set up/);
    fs.writeFileSync(path.join(d, 'host.config'), 'WILBUR_LOG_DIR=' + path.join(d, 'nowhere') + '\n');
    r = (await bare.query({ session: 'all', sources: 'wilbur' })).body;
    assert.match(r.sources.wilbur.error, /no Wilbur log files in .*nowhere/);
  });
  await test('memory is bounded: the oldest lines go first', async () => {
    const small = L.createLogs({ dir: tmp(), hub: () => null, maxLines: 50 });
    for (let i = 0; i < 120; i++) small.backend('ps', 'line ' + i);
    const r = small.select({ sources: ['backend'], type: 'everything', limit: 5000 });
    assert.equal(r.lines.length, 50); assert.equal(r.lines[0].text, 'line 70');
  });

  console.log('the QA cases shipped with the launcher (qa-seed)');
  const S = require('./qa-seed');
  const shipped = S.readSeeds(path.join(__dirname, 'qa-seed'));
  await test('every shipped case names the filters to set, and each one is an option the Logs tab really offers', () => {
    const offered = new Set([...Object.values(L.TYPES).map((t) => t.label), ...Object.values(L.VIEWS)]);
    assert.ok(shipped.length >= 10);
    for (const c of shipped) {
      assert.match(c.steps, /Session = /, c.id); assert.match(c.steps, /What = /, c.id); assert.match(c.steps, /Sources = /, c.id);
      for (const m of c.steps.matchAll(/What = ([^;\n]+)/g)) assert.ok(offered.has(m[1].trim().replace(/\.$/, '')), c.id + ': "' + m[1].trim() + '" is not in the dropdown');
    }
  });
  await test('every shipped case is one the QA console pulls logs for, with patterns its Analyze can check, in the launcher component', () => {
    const ids = new Set();
    for (const c of shipped) {
      assert.ok(!ids.has(c.id), 'unique ' + c.id); ids.add(c.id);
      assert.match(c.id, /^LA-F\d+$/); assert.equal(c.component, 'C10'); assert.equal(c.status, 'Not Run');
      assert.ok(/\blog(s|file|ged)?\b/i.test([c.steps, c.expected, c.evidence].join(' ')), c.id + ' mentions the logs');
      assert.ok(/'[^']{4,}'|\b[a-z]+[A-Z][A-Za-z0-9]*\b/.test(c.expected), c.id + ' quotes a line or names a message to look for');
    }
  });
  await test('seeding: an empty library is left alone; otherwise each shipped case is added once, never over an edit, never again after a delete', () => {
    const d = path.join(__dirname, 'qa-seed');
    assert.deepEqual(S.seed({ cases: [], seeded: [], dir: d }).added, []);
    const mine = [{ id: 'TC-001', title: 'Wilbur starts' }, { id: 'LA-F1', title: 'my own edit' }];
    const a = S.seed({ cases: mine, seeded: [], dir: d, now: () => 'T' });
    assert.deepEqual(a.added, shipped.map((c) => c.id).filter((id) => id !== 'LA-F1'));
    assert.equal(a.cases.find((c) => c.id === 'LA-F1').title, 'my own edit');
    assert.ok(a.seeded.includes('LA-F1') && a.cases.find((c) => c.id === 'LA-F2').seededFrom === 'logs-tab.json');
    const b = S.seed({ cases: a.cases, seeded: a.seeded, dir: d });
    assert.deepEqual(b.added, []);
    const c = S.seed({ cases: a.cases.filter((x) => x.id !== 'LA-F3'), seeded: a.seeded, dir: d });
    assert.deepEqual(c.added, [], 'a deleted case does not come back');
  });
  await test('a broken seed file is skipped, a bad id is ignored, and only the case fields are taken', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'a.json'), '{ not json');
    fs.writeFileSync(path.join(d, 'b.json'), JSON.stringify({ cases: [{ id: 'bad id' }, { id: 'XX-1', title: 'ok', steps: 's'.repeat(9000), script: 'alert(1)', real: 'yes' }] }));
    const r = S.readSeeds(d);
    assert.deepEqual(r.map((c) => c.id), ['XX-1']);
    assert.equal(r[0].steps.length, 4000); assert.equal(r[0].script, undefined); assert.equal(r[0].real, false);
  });

  const failed = results.filter((x) => !x[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
