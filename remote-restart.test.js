#!/usr/bin/env node
'use strict';
// Tests for the Dev Console's Launchers card on the launcher side (remote-restart.js), with a fake updater, hub and clock.
//   node remote-restart.test.js
const assert = require('assert');
const { createRemote } = require('./remote-restart');

const results = [];
const test = async (name, fn) => { try { await fn(); results.push([true, name]); console.log('  ok   ' + name); } catch (e) { results.push([false, name]); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };

// Everything the module may touch, recording the order of the calls.
function rig({ busy = null, apply = { ok: true, from: 'aaaaaaa', to: 'bbbbbbb', pulled: 2, restarting: true }, agents = {}, models = { starting: ['PC-1 · GPU Rig'], ready: [], skipped: [] }, hub = true, updater = true } = {}) {
  const calls = [], clock = { t: 1000000 };
  const fakeUpdater = { apply: async (o) => { calls.push(['apply', o]); return typeof apply === 'function' ? apply() : apply; } };
  const fakeHub = {
    restartAgents: async (pc) => { calls.push(['agents', pc]); return agents[pc] || [{ ok: true, alias: pc === 1 ? 'PC-1 · GPU Rig' : 'Frankenstein' }]; },
    startModels: async () => { calls.push(['models']); return models; },
  };
  const r = createRemote({ updater: updater ? fakeUpdater : null, hub: () => (hub ? fakeHub : null), busy: () => busy, now: () => clock.t });
  return { r, calls, clock };
}

(async () => {
  console.log('which PC');
  await test('pc is 1, 2 or left out (all); anything else is refused before anything happens', async () => {
    for (const pc of [3, 0, -1, 'x', '1; shutdown', { a: 1 }, [1], true, 1.5]) {
      const { r, calls } = rig();
      const out = await r.restart({ pc });
      assert.equal(out.status, 400, JSON.stringify(pc)); assert.equal(calls.length, 0);
    }
    for (const [body, want] of [[{}, 'all'], [null, 'all'], [{ pc: null }, 'all'], [{ pc: 'all' }, 'all'], [{ pc: 1 }, 1], [{ pc: '2' }, 2]]) {
      const { r } = rig();
      assert.equal((await r.restart(body)).body.pc, want, JSON.stringify(body));
    }
  });

  console.log('restart');
  await test('PC 1 restarts this launcher only through the updater (never forced), then PC 1\'s agent, after the pull', async () => {
    const { r, calls } = rig();
    const out = await r.restart({ pc: 1, force: true, restart: false, cmd: 'calc.exe' });
    assert.deepEqual(calls, [['apply', { restart: true }], ['agents', 1]], 'nothing from the body reaches the updater');
    assert.equal(out.status, 200); assert.equal(out.body.ok, true);
    assert.match(out.body.message, /^PC 1: the launcher is restarting with 2 new changes \(back in about 10 s\); PC-1 · GPU Rig: node agent restarting\.$/);
  });
  await test('PC 2 restarts only PC 2\'s agent: the launcher is left alone', async () => {
    const { r, calls } = rig();
    const out = await r.restart({ pc: 2 });
    assert.deepEqual(calls, [['agents', 2]]);
    assert.equal(out.status, 200); assert.equal(out.body.message, 'Frankenstein: node agent restarting (back in about 5 s).');
  });
  await test('all restarts PC 2 first, then this launcher and PC 1\'s agent', async () => {
    const { r, calls } = rig();
    const out = await r.restart({});
    assert.deepEqual(calls, [['agents', 2], ['apply', { restart: true }], ['agents', 1]]);
    assert.equal(out.status, 200); assert.ok(out.body.pc1.ok && out.body.pc2.ok);
  });
  await test('a live session refuses PC 1 and all (409, nothing restarted); PC 2 alone does not touch the session and goes ahead', async () => {
    for (const pc of [1, undefined]) {
      const { r, calls } = rig({ busy: 'a client session is running' });
      const out = await r.restart({ pc });
      assert.equal(out.status, 409); assert.equal(out.body.busy, 'a client session is running'); assert.match(out.body.error, /^Not now: a client session is running\./);
      assert.equal(calls.length, 0, 'not even PC 2');
    }
    const { r, calls } = rig({ busy: 'a client session is running' });
    assert.equal((await r.restart({ pc: 2 })).status, 200); assert.deepEqual(calls, [['agents', 2]]);
  });
  await test('when the updater refuses (busy by the time it checks, or new code that fails its checks) it is said plainly and PC 1\'s agent is left alone', async () => {
    const a = rig({ apply: { ok: false, busy: 'visitors are in the queue or in a turn', error: 'Not now: visitors are in the queue or in a turn.' } });
    const out = await a.r.restart({ pc: 1 });
    assert.equal(out.status, 409); assert.equal(out.body.error, 'PC 1: Not now: visitors are in the queue or in a turn.');
    assert.deepEqual(a.calls, [['apply', { restart: true }]]);
    const b = rig({ apply: { ok: false, step: 'preflight', rolledBack: true, error: 'The update failed its checks and was rolled back: launcher-server.js does not parse' } });
    const out2 = await b.r.restart({ pc: 1 });
    assert.equal(out2.status, 502); assert.match(out2.body.error, /rolled back: launcher-server\.js does not parse\.$/);
  });
  await test('an agent that cannot restart is reported by name; the rest of the request still happens', async () => {
    const { r } = rig({ agents: { 2: [{ ok: false, alias: 'Frankenstein', error: 'this agent was started by hand, so it would not come back: start it with start-node.bat' }] } });
    const out = await r.restart({});
    assert.equal(out.status, 502); assert.equal(out.body.pc1.ok, true); assert.equal(out.body.pc2.ok, false);
    assert.match(out.body.error, /^Frankenstein: this agent was started by hand.*\. PC 1: the launcher is restarting/);
  });
  await test('without the bridge PC 2 says so; without the updater PC 1 is refused before anything happens', async () => {
    const a = rig({ hub: false });
    const out = await a.r.restart({ pc: 2 });
    assert.equal(out.status, 502); assert.match(out.body.error, /bridge is not set up/);
    const b = rig({ updater: false });
    const out2 = await b.r.restart({});
    assert.equal(out2.status, 503); assert.equal(b.calls.length, 0);
  });
  await test('one restart every 20 seconds, whatever is sent; a refused request does not use up the turn', async () => {
    const { r, calls, clock } = rig();
    assert.equal((await r.restart({ pc: 3 })).status, 400);
    assert.equal((await r.restart({ pc: 2 })).status, 200);
    clock.t += 19000;
    const again = await r.restart({ pc: 1 });
    assert.equal(again.status, 429); assert.match(again.body.error, /wait 1 s/);
    clock.t += 1000;
    assert.equal((await r.restart({ pc: 1 })).status, 200);
    assert.equal(calls.filter((c) => c[0] === 'apply').length, 1);
  });

  console.log('start agents');
  await test('starts the model on the free PCs and says where it did not, by name and why', async () => {
    const { r, calls } = rig({ models: { starting: ['PC-1 · GPU Rig'], ready: ['Frankenstein'], skipped: [{ alias: 'PC-3', why: 'reserved for rendering' }] } });
    const out = await r.startAgents();
    assert.deepEqual(calls, [['models']]);
    assert.equal(out.status, 200);
    assert.equal(out.body.message, 'Starting the local model on PC-1 · GPU Rig (about a minute). Frankenstein already has it running. Not on PC-3 (reserved for rendering).');
  });
  await test('no PC free is a 409 with the reasons; no bridge is a 503; one start every 10 seconds', async () => {
    const a = rig({ models: { starting: [], ready: [], skipped: [{ alias: 'PC-1', why: 'rendering a client' }, { alias: 'Frankenstein', why: 'offline' }] } });
    const out = await a.r.startAgents();
    assert.equal(out.status, 409); assert.equal(out.body.error, 'Not on PC-1 (rendering a client), Frankenstein (offline).');
    const b = rig({ hub: false });
    assert.equal((await b.r.startAgents()).status, 503);
    const c = rig();
    assert.equal((await c.r.startAgents()).status, 200);
    c.clock.t += 9000; assert.equal((await c.r.startAgents()).status, 429);
    c.clock.t += 1000; assert.equal((await c.r.startAgents()).status, 200);
  });

  const failed = results.filter((x) => !x[0]).length;
  console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})();
