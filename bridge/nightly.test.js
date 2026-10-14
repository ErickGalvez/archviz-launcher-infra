#!/usr/bin/env node
'use strict';
// Self-test for bridge/nightly-once.js against a MOCK launcher in a temp folder: no GitHub issue is created, no real data file is touched, the
// automated checks are replaced by a tiny stub, and the waiting is switched off (NIGHTLY_FAST).
//   node bridge/nightly.test.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');
const { createTaskio } = require('./taskio');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e && e.message).split('\n')[0]); } };
const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'g741-nightly-test-'));
const today = new Date(Date.now() - 360 * 60000).toISOString().slice(0, 10);          // Mexico City date

(async () => {
  console.log('nightly (one-off, cloud lane)');
  const dir = mk(), site = mk(), record = path.join(dir, 'autotest-runs.jsonl');
  fs.writeFileSync(path.join(dir, 'qa-data.json'), JSON.stringify({ bugs: [{ id: 'bug_1', status: 'open', priority: 'critical', component: 'Pixel Streaming / Wilbur RTC', title: 'Wilbur RTC never reconnects after manual close' }] }));   // a fixture: the real tracker is never read
  fs.writeFileSync(path.join(dir, 'sales-data.json'), '{"prospects":[]}');                                      // never copy the real CRM into a test
  fs.writeFileSync(path.join(dir, 'devconsole.key'), 'test-key-not-real\n');
  fs.mkdirSync(path.join(site, 'devconsole'));
  fs.writeFileSync(path.join(site, 'devconsole', 'smoke-test.js'), `const a = process.argv.slice(2), i = a.indexOf('--record'); require('fs').appendFileSync(a[i + 1], JSON.stringify({ ts: new Date().toISOString(), job: a[a.indexOf('--job') + 1], summary: { ok: 100, warn: 1, down: 0, total: 101 } }) + '\\n');`);
  const dispatches = [], polls = {};
  const server = http.createServer((req, res) => {
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.headers['x-devconsole-key'] !== 'test-key-not-real') return json(401, { ok: false, error: 'Unauthorized' });
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/devconsole/dispatch' && req.method === 'POST') {
      let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => {
        const body = JSON.parse(b), issueNumber = 900 + dispatches.length + 1; dispatches.push(body);
        fs.appendFileSync(path.join(dir, 'devconsole-log.jsonl'), JSON.stringify({ ts: new Date().toISOString(), type: 'dispatch', repo: 'website', issueNumber, title: String(body.summary).slice(0, 120), transcript: body.transcript, category: body.category }) + '\n');
        json(200, { ok: true, issueNumber, issueUrl: 'https://github.com/example/example/issues/' + issueNumber });
      });
    } else if (u.pathname === '/api/devconsole/status') {
      const n = +u.searchParams.get('issue'); polls[n] = (polls[n] || 0) + 1;
      json(200, { ok: true, pr: polls[n] >= 2 ? { number: n + 50, url: 'https://github.com/example/example/pull/' + (n + 50), state: 'open', draft: true } : null, question: null });
    } else json(404, { ok: false });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const run = (extra = []) => new Promise((resolve) => {
    const c = cp.spawn(process.execPath, [path.join(__dirname, 'nightly-once.js'), '--date', today, '--dir', dir, '--site', site, '--api', 'http://127.0.0.1:' + server.address().port, '--record', record, ...extra], { env: { ...process.env, NIGHTLY_FAST: '1' } });
    let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; }); c.on('close', (code) => resolve({ code, out }));
  });

  let first;
  await test('a night sends exactly the QA and Dev briefs to the website repo, follows both pull requests, and closes with the checks and an EOD', async () => {
    first = await run();
    assert.equal(first.code, 0, first.out.slice(-300)); assert.equal(dispatches.length, 2, 'exactly two briefs');
    assert.ok(dispatches.every((d) => d.repo === 'website'), 'the website repo is the only dispatch target');
    assert.match(dispatches[0].transcript, /Wilbur RTC never reconnects/); assert.match(dispatches[0].transcript, /Do not change any application code/); assert.match(dispatches[1].transcript, /do not merge it/i);
    const state = JSON.parse(fs.readFileSync(path.join(dir, `nightly-${today}.state.json`), 'utf8'));
    assert.ok(state.done && state.qa.pr && state.dev.pr, 'both pull requests followed, night closed'); assert.ok(state.checks.start && state.checks.end, 'checks at both ends');
  });
  await test('everything is logged for the replay: one entry per step, each under the right person, no duplicates, plus the EOD snapshot', () => {
    const t = createTaskio({ dir }), d = t.day(today), by = (p) => d.tasks.filter((x) => x.persona === p);
    assert.equal(d.tasks.length, 5, d.tasks.map((x) => x.persona + ':' + x.title).join(' | '));
    assert.equal(by('Otto').length, 2); assert.ok(by('Priya').some((x) => x.status === 'done' && /PR/.test(x.ref))); assert.ok(by('Dex').some((x) => x.status === 'done' && x.lane === 'cloud'));
    assert.equal(d.tasks.filter((x) => x.source === 'devconsole').length, 0, 'the dispatches are not shown a second time as derived Dex entries');
    const eod = t.getEod(today); assert.ok(eod && eod.tasks.length === 5); assert.match(eod.note, /nothing was merged/i);
  });
  await test('the key never reaches the log or the state file', () => {
    const log = fs.readFileSync(path.join(dir, `nightly-${today}.log`), 'utf8'), state = fs.readFileSync(path.join(dir, `nightly-${today}.state.json`), 'utf8');
    assert.ok(!log.includes('test-key-not-real') && !state.includes('test-key-not-real'));
  });
  await test('a second run sends nothing again', async () => {
    const second = await run(); assert.equal(dispatches.length, 2); assert.match(second.out, /already closed/);
  });
  await test('after a crash between sending and saving, a restart finds the dispatch in the Dev Console log instead of sending it twice', async () => {
    const stateFile = path.join(dir, `nightly-${today}.state.json`), st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    st.done = false; st.qa = null; st.tasks = {}; fs.writeFileSync(stateFile, JSON.stringify(st));                  // the state file lost the QA dispatch (the log still has it)
    const r = await run(); assert.equal(dispatches.length, 2, 'no third issue'); assert.match(r.out, /found the dispatch already made/);
  });
  await test('if the bug has been resolved by the time the night runs, QA is not briefed about it', async () => {
    const d3 = mk(); fs.writeFileSync(path.join(d3, 'qa-data.json'), JSON.stringify({ bugs: [{ id: 'bug_1', status: 'resolved', title: 'Wilbur RTC never reconnects after manual close' }] }));
    fs.writeFileSync(path.join(d3, 'sales-data.json'), '{"prospects":[]}'); fs.writeFileSync(path.join(d3, 'devconsole.key'), 'test-key-not-real\n');
    const before = dispatches.length, c = await new Promise((resolve) => { const p = cp.spawn(process.execPath, [path.join(__dirname, 'nightly-once.js'), '--date', today, '--dir', d3, '--site', site, '--api', 'http://127.0.0.1:' + server.address().port, '--record', path.join(d3, 'r.jsonl')], { env: { ...process.env, NIGHTLY_FAST: '1' } }); let o = ''; p.stdout.on('data', (x) => { o += x; }); p.on('close', (code) => resolve({ code, out: o })); });
    assert.equal(c.code, 0, c.out.slice(-200)); assert.equal(dispatches.length - before, 1, 'only the Dev brief was sent'); assert.match(c.out, /no longer open/);
    assert.match(c.out, /EOD snapshot written/);
  });
  await test('without a Dev Console key nothing is sent and the run says so', async () => {
    const d2 = mk(); fs.writeFileSync(path.join(d2, 'qa-data.json'), '{"bugs":[]}'); const before = dispatches.length;
    const c = cp.spawnSync(process.execPath, [path.join(__dirname, 'nightly-once.js'), '--date', today, '--dir', d2, '--api', 'http://127.0.0.1:' + server.address().port], { env: { ...process.env, NIGHTLY_FAST: '1' }, encoding: 'utf8' });
    assert.equal(c.status, 3); assert.equal(dispatches.length, before); assert.match(c.stdout, /No Dev Console key/);
  });

  server.close(); for (const d of [dir, site]) fs.rmSync(d, { recursive: true, force: true });
  const failed = results.filter((r) => !r[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('test run crashed:', e); process.exit(1); });
