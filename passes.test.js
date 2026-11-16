#!/usr/bin/env node
'use strict';
// Tests for passes.js (what the G741 app gets for a website page instead of a typed key), with a fake clock and a fake file.
//   node passes.test.js
const assert = require('assert');
const { createPasses, SCOPES, PASS_TTL_MS, MAX_PER_SCOPE, PASS_RE } = require('./passes');

const results = [];
const test = (name, fn) => { try { fn(); results.push(true); console.log('  ok   ' + name); } catch (e) { results.push(false); console.log('  FAIL ' + name + '\n       ' + String(e.stack || e).split('\n').slice(0, 3).join('\n       ')); } };

function rig({ start = 1000000, files = {} } = {}) {
  const clock = { t: start };
  const fsImpl = {
    readFileSync: (f) => { if (!(f in files)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files[f]; },
    writeFileSync: (f, s) => { files[f] = String(s); },
  };
  const make = () => createPasses({ file: 'passes.json', now: () => clock.t, fsImpl });
  return { p: make(), make, clock, files };
}

console.log('issuing');
test('the scopes are exactly devconsole, qa and owner', () => assert.deepEqual(SCOPES, ['devconsole', 'qa', 'owner']));
test('a pass is g741p_ plus 32 random bytes, different every time, and lasts exactly 12 hours', () => {
  const { p, clock } = rig();
  const a = p.issue('devconsole'), b = p.issue('devconsole');
  assert.ok(PASS_RE.test(a.pass) && PASS_RE.test(b.pass)); assert.notEqual(a.pass, b.pass);
  assert.equal(a.scope, 'devconsole'); assert.equal(a.expiresAt, clock.t + 12 * 60 * 60 * 1000); assert.equal(PASS_TTL_MS, 43200000);
});
test('an unknown scope gets nothing', () => {
  const { p } = rig();
  for (const s of ['admin', 'DEVCONSOLE', '', null, undefined, 'qa ', ['qa'], { scope: 'qa' }, '__proto__', 'constructor']) assert.equal(p.issue(s), null, String(s));
  assert.equal(p.size(), 0);
});

console.log('using');
test('a pass opens its own scope and no other', () => {
  const { p } = rig();
  const d = p.issue('devconsole').pass, q = p.issue('qa').pass, o = p.issue('owner').pass;
  assert.ok(p.valid(d, 'devconsole') && p.valid(q, 'qa') && p.valid(o, 'owner'));
  assert.ok(!p.valid(d, 'qa') && !p.valid(d, 'owner') && !p.valid(q, 'devconsole') && !p.valid(o, 'devconsole') && !p.valid(o, 'qa'));
});
test('anything that is not a live pass is refused: a made-up pass, a near miss, a key, junk', () => {
  const { p } = rig();
  const d = p.issue('devconsole').pass;
  const fake = 'g741p_' + 'A'.repeat(43), near = d.slice(0, -1) + (d.slice(-1) === 'A' ? 'B' : 'A');
  for (const t of [fake, near, d + 'x', d.toUpperCase(), 'a'.repeat(48), '', null, undefined, 42, [d], { d }]) assert.equal(p.valid(t, 'devconsole'), false, String(t));
  assert.equal(p.check(fake), null);
});
test('check says the scope and the expiry of a live pass, and nothing for anything else', () => {
  const { p } = rig();
  const o = p.issue('owner');
  assert.deepEqual(p.check(o.pass), { scope: 'owner', expiresAt: o.expiresAt });
  assert.equal(p.check('nope'), null);
});
test('a pass stops working at its expiry, to the millisecond', () => {
  const { p, clock } = rig();
  const d = p.issue('devconsole');
  clock.t = d.expiresAt - 1; assert.ok(p.valid(d.pass, 'devconsole'));
  clock.t = d.expiresAt; assert.ok(!p.valid(d.pass, 'devconsole')); assert.equal(p.check(d.pass), null); assert.equal(p.size(), 0);
});

console.log('signing out');
test('revoke ends one pass and leaves the others', () => {
  const { p } = rig();
  const a = p.issue('devconsole').pass, b = p.issue('devconsole').pass;
  assert.equal(p.revoke(a), true); assert.equal(p.revoke(a), false);
  assert.ok(!p.valid(a, 'devconsole') && p.valid(b, 'devconsole'));
  assert.equal(p.revoke('junk'), false); assert.equal(p.revoke(null), false);
});
test('revokeAll ends every pass of every scope and says how many', () => {
  const { p } = rig();
  const keep = SCOPES.map((s) => p.issue(s).pass);
  assert.equal(p.revokeAll(), 3); assert.equal(p.size(), 0);
  assert.ok(keep.every((t, i) => !p.valid(t, SCOPES[i])));
});
test('at most 20 live passes per scope: the oldest goes first, other scopes are untouched', () => {
  const { p, clock } = rig();
  const q = p.issue('qa').pass;
  const all = [];
  for (let i = 0; i < MAX_PER_SCOPE + 3; i++) { clock.t += 1; all.push(p.issue('devconsole').pass); }
  assert.equal(MAX_PER_SCOPE, 20);
  assert.ok(all.slice(0, 3).every((t) => !p.valid(t, 'devconsole')), 'the three oldest are gone');
  assert.ok(all.slice(3).every((t) => p.valid(t, 'devconsole')), 'the newest 20 work');
  assert.ok(p.valid(q, 'qa'));
});

console.log('the file');
test('only hashes are written: the pass itself never reaches the file', () => {
  const { p, files } = rig();
  const d = p.issue('devconsole').pass;
  const saved = files['passes.json'];
  assert.ok(saved && !saved.includes(d) && !saved.includes(d.slice(6)), 'the pass is not in the file');
  const j = JSON.parse(saved);
  assert.equal(j.passes.length, 1); assert.ok(/^[0-9a-f]{64}$/.test(j.passes[0].h));
});
test('a restart keeps live passes and drops expired ones', () => {
  const r = rig();
  const d = r.p.issue('devconsole'); r.clock.t += 1000; const q = r.p.issue('qa');
  const again = r.make();
  assert.ok(again.valid(d.pass, 'devconsole') && again.valid(q.pass, 'qa'));
  r.clock.t = d.expiresAt;
  const later = r.make();
  assert.ok(!later.valid(d.pass, 'devconsole') && later.valid(q.pass, 'qa'));
});
test('a restart keeps revocations', () => {
  const r = rig();
  const d = r.p.issue('devconsole').pass; r.p.revoke(d);
  assert.ok(!r.make().valid(d, 'devconsole'));
  const o = r.p.issue('owner').pass; r.p.revokeAll();
  assert.ok(!r.make().valid(o, 'owner'));
});
test('a tampered file cannot add a scope, stretch a lifetime or plant a raw pass', () => {
  const r = rig();
  const d = r.p.issue('devconsole');
  const j = JSON.parse(r.files['passes.json']);
  const hashOf = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
  const planted = 'g741p_' + 'B'.repeat(43);
  j.passes.push({ h: hashOf(planted), scope: 'admin', expiresAt: r.clock.t + 1000 });                        // a scope that does not exist
  j.passes.push({ h: hashOf('g741p_' + 'C'.repeat(43)), scope: 'qa', expiresAt: r.clock.t + PASS_TTL_MS * 10 }); // a lifetime too long
  j.passes.push({ h: 'g741p_' + 'D'.repeat(43), scope: 'qa', expiresAt: r.clock.t + 1000 });                  // a raw pass, not a hash
  r.files['passes.json'] = JSON.stringify(j);
  const again = r.make();
  assert.ok(again.valid(d.pass, 'devconsole'));
  assert.ok(!again.valid(planted, 'admin') && !again.valid(planted, 'qa') && !again.valid('g741p_' + 'C'.repeat(43), 'qa') && !again.valid('g741p_' + 'D'.repeat(43), 'qa'));
  assert.equal(again.size(), 1);
});
test('a missing or broken file starts empty and does not throw', () => {
  const r = rig({ files: { 'passes.json': '{ not json' } });
  assert.equal(r.p.size(), 0);
  assert.equal(createPasses({}).size(), 0);                    // no file at all: memory only
});

const failed = results.filter((x) => !x).length;
console.log('\n' + (results.length - failed) + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
