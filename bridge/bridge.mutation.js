#!/usr/bin/env node
'use strict';
// Mutation check for the bridge's own tests: copy bridge/ to a temp dir, deliberately break ONE protection at a time,
// and require the tests to go red. A test that can't fail is worse than no test.
//   node bridge/bridge.mutation.js            (about 10 minutes: both test files run for each of ~35 mutations)
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// [name, file, exact text to find, replacement]
const MUTATIONS = [
  // ── security: signing, jobs, discovery, the policy ──
  ['confidential work may go to the cloud', 'hub.js', "if (confidential || (policy.confidentialAreas || []).includes(area)) return 'local';", ''],
  ['the cloud lane is ignored (everything runs locally)', 'hub.js', "return lane === 'cloud' ? 'cloud' : 'local';", "return 'local';"],
  ['signatures are not checked', 'protocol.js', "if (!safeEqualHex(sig, hmacHex(key, canonical(method, target, ts, nonce, body)))) return { ok: false, reason: 'bad-signature' };", ''],
  ['replayed requests are accepted', 'protocol.js', 'if (this.seen.has(nonce)) return false;', ''],
  ['stale requests are accepted', 'protocol.js', 'Math.abs(now - t) > MAX_SKEW_MS', 'false'],
  ['the agent accepts any job type', 'node-agent.js', "if (!JOB_TYPES.has(b.type)) return 'unsupported job type';", ''],
  ['discovered peers are followed to any address', 'hub.js', 'if (isPrivateHost(p.address))', 'if (true)'],
  ['a PC that is down is never marked offline', 'hub.js', 'if (d.fails >= 2) d.online = false;', ''],
  ['a role\'s own Dev Console dispatch is also shown as a derived Dex entry', 'taskio.js', '!(t.ref && claimed.has(t.ref))', 'true'],
  ['a task is not recognised once its ref has the pull request appended', 'taskio.js', ".split(' ')[0]", ""],
  ["the agent decodes each network chunk on its own (a split accent breaks the signature)","node-agent.js","req.setEncoding('utf8');",""],
  ["a model that dies by itself is relaunched on the next tick","model-supervisor.js","s.phase = 'failed'; s.failedAt = now();","s.phase = 'stopped';"],
  ["an unanswered proposal is proposed again every night","routines.js","if (dup) {","if (false) {"],
  ["an AI draft that never ran piles up behind the next one","routines.js","x.status === 'queued')) taskio.patchTask","x.status === 'never')) taskio.patchTask"],
  ["a PC that returns with a new id leaves an offline ghost","hub.js","devices.delete(k);",""],
  ["the Task-IO cache never notices a change to the file","taskio.js","folded.map && folded.sig === sig","folded.map"],
  ['task days ignore the Mexico City offset', 'taskio.js', 'const start = Date.UTC(+m[1], +m[2] - 1, +m[3]) - tz * 60000;', 'const start = Date.UTC(+m[1], +m[2] - 1, +m[3]);'],
  ['inbound leads are copied into tasks verbatim', 'taskio.js', "title: leads.length + ' session request' + (leads.length > 1 ? 's' : '') + ' received' }", "title: leads.length + ' session request' + (leads.length > 1 ? 's' : '') + ' received', detail: leads.map((l) => l.email).join(',') }"],
  // ── coordination: rendering vs AI work ──
  ['a PC that is rendering a client is given AI work', 'hub.js', 'const aiCapable = (d) => !!(d.online && d.stats && !renderBusyOf(d) && !reservedOf(d));', 'const aiCapable = (d) => !!(d.online && d.stats && !reservedOf(d));'],
  ['a PC reserved for rendering is given AI work', 'hub.js', 'const aiCapable = (d) => !!(d.online && d.stats && !renderBusyOf(d) && !reservedOf(d));', 'const aiCapable = (d) => !!(d.online && d.stats && !renderBusyOf(d));'],
  ['the reservation the owner set is forgotten', 'hub.js', 'const reservedOf = (d) => !!(reservedWant()[d.id] || (d.stats && d.stats.render && d.stats.render.reserved));', 'const reservedOf = (d) => false;'],
  ['the dispatcher ignores the render state when choosing a PC', 'dispatcher.js', 'hub.aiCapable(d) && !usedDevices.has(d.id)', 'd.online && !usedDevices.has(d.id)'],
  ['a task on a PC that starts rendering is left there', 'dispatcher.js', "if (hub.renderBusyOf(d) || hub.reservedOf(d)) return requeue(t, alias(d) + ' started rendering a client; moved to the other PC');", ''],
  ['a failing task is retried forever', 'dispatcher.js', 'if (attempts >= maxAttempts) return fail(', 'if (false) return fail('],
  ['scheduled tasks run outside the nightly window', 'dispatcher.js', "const routine = t.source === 'routine' && !(t.priority > 0);", 'const routine = false;'],
  ['an idle PC does not get scheduled tasks in the daytime', 'dispatcher.js', "|| hub.idleEnough(d)));", "));"],
  ['a PC that is rendering counts as idle', 'hub.js', "return c.enabled !== false && aiCapable(d) && typeof util === 'number' && util < limit;", "return c.enabled !== false && typeof util === 'number' && util < limit;"],
  ['a PC exactly at the GPU limit counts as idle', 'hub.js', "typeof util === 'number' && util < limit;", "typeof util === 'number' && util <= limit;"],
  ['a PC that does not report its GPU is assumed idle', 'hub.js', "typeof util === 'number' && util < limit;", "!(util >= limit);"],
  ['the idle rule cannot be switched off', 'hub.js', "return c.enabled !== false && aiCapable(d)", "return aiCapable(d)"],
  ['the GPU limit from bridge.json is ignored', 'hub.js', "limit = c.gpuPct > 0 ? c.gpuPct : 20;", "limit = 20;"],
  ['routines start in the daytime even when no PC is idle', 'routines.js', "if (!inWindow(t, window) && !idle()) return [];", "if (!inWindow(t, window) && false) return [];"],
  ['routines never start outside the night window, idle or not', 'routines.js', "if (!inWindow(t, window) && !idle()) return [];", "if (!inWindow(t, window)) return [];"],
  ['a draft the owner asked for with run now is replaced by the next scheduled one', 'routines.js', "x.status === 'queued' && !(x.priority > 0))) taskio.patchTask", "x.status === 'queued')) taskio.patchTask"],
  ['the routines are not told whether a PC is idle', 'index.js', "idle: () => hub.devices().some(hub.idleEnough) });", "});"],
  ['the hub is not given the idle settings from bridge.json', 'index.js', "getRenderState, idleCfg, ...hubOptions", "getRenderState, ...hubOptions"],
  ['the agent runs the model while this PC is rendering', 'node-agent.js', "if (renderBusy()) throw new Error('rendering: this PC is serving a client, so it does not run the model');", ''],
  ['the agent will start the model while rendering', 'node-agent.js', "if (b.action === 'start' && renderBusy())", 'if (false)'],
  ['a launcher render hint is ignored', 'node-agent.js', 'state.hintUntil = b.render ? Date.now() + ttl * 1000 : 0;', 'state.hintUntil = 0;'],
  ['a reservation is not remembered across restarts', 'node-agent.js', 'fs.writeFileSync(statePath, JSON.stringify({ reserved: state.reserved }));', ''],
  ['the launcher does not wait for the model to unload', 'hub.js', 'while (Date.now() - t0 < timeoutMs) {', 'while (false) {'],
  // ── the model supervisor ──
  ['the model is loaded while rendering', 'model-supervisor.js', 'const desired = !renderBusy && !paused && !cmd.error && (wantWindow || wantDemand);', 'const desired = !paused && !cmd.error && (wantWindow || wantDemand);'],
  ['the model is never unloaded', 'model-supervisor.js', 'else if (!desired && s.child && (s.phase', 'else if (false && s.child && (s.phase'],
  ['an owner stop is not honoured', 'model-supervisor.js', 's.pausedUntil = now() + 60 * 60000;', 's.pausedUntil = 0;'],
  ['relative paths are accepted for the model command', 'model-supervisor.js', 'if (!path.isAbsolute(llama.exe) || !path.isAbsolute(llama.model)) return', 'if (false) return'],
  // ── routines and Task-IO ──
  ['routines run outside the nightly window', 'routines.js', 'if (!inWindow(t, window) && !idle()) return [];', ''],
  ['a routine runs again the same night', 'routines.js', 'if (s.enabled === false || s.lastNightKey === nightKey(t, window)) continue;', 'if (s.enabled === false) continue;'],
  ['weekly routines run every night', 'routines.js', "if (r.schedule === 'weekly' && s.lastRunAt && t - s.lastRunAt < 6.5 * DAY) continue;", ''],
  ['a local routine runs for a cloud-lane area', 'routines.js', "if (r.kind === 'ai' && lane !== 'local') {", 'if (false) {'],
  ['a lead\'s e-mail reaches a prompt', 'routines.js', "Object.keys(l).filter((k) => k !== 'ts')", "Object.keys(l).filter((k) => k !== 'ts').concat([l.email])"],
  ['a request can choose its own lane', 'index.js', 'const lane = laneFor(defaultPolicy, area, false), title = String(b.title || prompt).slice(0, 80);', "const lane = (b.lane === 'cloud' ? 'cloud' : laneFor(defaultPolicy, area, false)), title = String(b.title || prompt).slice(0, 80);"],
  ['the prompt of a task is exposed through the API', 'taskio.js', 'const view = (t) => { const { job, remote, ...rest } = t;', 'const view = (t) => { const { remote, ...rest } = t;'],
].concat(require('./tickets.mutations.js'), require('./archive.mutations.js'));          // the ticket model, Vera and the fix-note reader; the Archivist

const TESTS = ['bridge.test.js', 'coordinator.test.js', 'nightly.test.js', 'tickets.test.js', 'verifier.test.js', 'fixnote.test.js', 'reports.test.js'];
const runOne = (dir, f) => new Promise((resolve) => {
  const c = cp.spawn(process.execPath, [path.join(dir, f)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { try { c.kill(); } catch (e) { /* gone */ } }, 150000);
  c.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});
const GROUPS = [require('./tickets.mutations.js'), require('./archive.mutations.js')], TESTS_FOR = new Map();   // each group is caught by its own fast test files, so only those run for its mutations
for (const g of GROUPS) for (const m of g) TESTS_FOR.set(m[0], g.TESTS);
const GROUP_OF = new Map(); [['tickets', GROUPS[0]], ['archive', GROUPS[1]]].forEach(([n, g]) => g.forEach((m) => GROUP_OF.set(m[0], n)));      // GROUP=archive re-checks one list
const runAll = async (dir, files = TESTS) => { const rs = await Promise.all(files.map((f) => runOne(dir, f))); return { red: rs.some((r) => r.code !== 0), out: rs.map((r) => r.out).join('\n') }; };
const copy = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'g741-bridge-mut-')); for (const f of fs.readdirSync(__dirname)) if (/\.(js|ps1|bat)$/.test(f) && f !== 'bridge.mutation.js') fs.copyFileSync(path.join(__dirname, f), path.join(d, f)); return d; };

(async () => {
  let failures = 0;
  const base = copy(), b = await runAll(base, [...new Set([...TESTS, ...GROUPS.flatMap((g) => g.TESTS)])]);
  console.log((b.red ? '  FAIL ' : '  pass ') + 'baseline (unmodified copy) passes everything');
  if (b.red) { failures++; console.log(b.out.split('\n').filter((l) => /FAIL/.test(l)).join('\n')); }
  fs.rmSync(base, { recursive: true, force: true });

  for (const [name, file, from, to] of MUTATIONS) {
    if (process.env.ONLY && !name.includes(process.env.ONLY)) continue;           // e.g. ONLY="rendering" re-checks a subset
    if (process.env.GROUP && GROUP_OF.get(name) !== process.env.GROUP) continue;  // e.g. GROUP=archive
    const d = copy(), f = path.join(d, file), src = fs.readFileSync(f, 'utf8');
    const pairs = Array.isArray(from) ? from.map((x, i) => [x, to[i]]) : [[from, to]];            // a mutation may change several places at once (two guards for one thing)
    if (pairs.some(([x]) => !src.includes(x))) { failures++; console.log('  FAIL "' + name + '" - MUTATION DID NOT APPLY (source changed; update this list)'); fs.rmSync(d, { recursive: true, force: true }); continue; }
    fs.writeFileSync(f, pairs.reduce((s, [x, y]) => s.replace(x, () => y), src));
    const r = await runAll(d, TESTS_FOR.get(name) || TESTS), which = (r.out.match(/FAIL (.+)/g) || []).slice(0, 2).map((s) => s.slice(5, 72)).join(' | ');
    if (!r.red) failures++;
    console.log((r.red ? '  pass ' : '  FAIL ') + 'breaking "' + name + '" is ' + (r.red ? 'caught by: ' + (which || 'a crash') : 'NOT CAUGHT'));
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\n' + (failures ? failures + ' problem(s) - some regressions would slip through' : 'every mutation was caught (' + MUTATIONS.length + ')'));
  process.exit(failures ? 1 : 0);
})();
