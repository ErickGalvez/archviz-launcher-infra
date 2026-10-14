'use strict';
// Glue between the launcher and the bridge: mounts /api/bridge/* and /api/taskio/* behind the Dev Console key, and runs
// the coordinator (dispatcher + routines) that makes the roles actually do their tasks.
//
//   const bridge = require('./bridge').init({ dir, isAuthed, cors, log, getProspects, getBugs, getRenderState });
//   ...inside the request handler:   if (bridge.handle(req, res, parsedUrl)) return;
//   ...at the top of launchPS():     await bridge.beforeRender();          // unload the local model before UE5 starts
//
// Every route here needs the Dev Console credential (the caller passes in the launcher's own check). Nothing in this
// module spawns processes - the launcher keeps its single, sandbox-stubbed child_process.
const fs = require('fs');
const path = require('path');
const P = require('./protocol');
const { createHub, laneFor, isConfidential } = require('./hub');
const { createTaskio, DEFAULT_TZ } = require('./taskio');
const { createDispatcher } = require('./dispatcher');
const { createRoutines } = require('./routines');
const { DEFAULT_WINDOW } = require('./schedule');
const defaultPolicy = require('./policy');

const MAX_BODY = 64 * 1024;

function init({ dir, isAuthed, cors, log = () => {}, getProspects, getBugs, getRenderState, hubOptions = {}, autoStart = true }) {
  const taskio = createTaskio({ dir, getProspects, getBugs });
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
  const windowCfg = () => ({ ...DEFAULT_WINDOW, ...(readJson(path.join(dir, 'bridge.json'), {}).nightly || {}) });

  // The hub needs the shared key. No key yet = the bridge is simply "not set up": device routes report that, Task-IO still works.
  const keyFile = process.env.G741_BRIDGE_KEY_FILE || path.join(dir, 'bridge', 'bridge.key');
  let hub = null, hubError = null, dispatcher = null, routines = null, routineTimer = null;
  try {
    hub = createHub({ dir, key: P.loadKey(keyFile), log, getRenderState, ...hubOptions });
    dispatcher = createDispatcher({ hub, taskio, log, pollMs: hubOptions.dispatchMs || 3000 });
    routines = createRoutines({ taskio, dir, policy: hub.policy, window: windowCfg(), kick: () => dispatcher.kick(), log });
    if (autoStart && !process.env.G741_BRIDGE_DISABLED) {
      hub.start(); dispatcher.start();
      routineTimer = setInterval(() => { try { routines.tick(); } catch (e) { log('routines: ' + e.message); } }, 60000);
      if (routineTimer.unref) routineTimer.unref();
    }
  } catch (e) { hubError = fs.existsSync(keyFile) ? e.message : 'no bridge key yet - run: node bridge/node-agent.js --init'; hub = dispatcher = routines = null; }

  const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify(obj)); };
  const readBody = (req, res, cb) => {
    let body = '', big = false;
    req.setEncoding('utf8');            // same reason as the node agent: never split a multi-byte character between chunks
    req.on('data', (d) => {
      if (big) return; body += d;
      if (body.length > MAX_BODY) { big = true; body = ''; res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', ...cors }); res.end(JSON.stringify({ ok: false, error: 'Body too large' }), () => req.destroy()); }   // answer first, then drop the connection
    });
    req.on('end', () => { if (big) return; try { cb(JSON.parse(body || '{}')); } catch (e) { cb(null); } });
  };
  const tzOf = (u) => { const t = parseInt(u.searchParams.get('tz'), 10); return Number.isFinite(t) && Math.abs(t) <= 14 * 60 ? t : DEFAULT_TZ; };

  // Called by the launcher right before a client session starts. Bounded, and it can never fail the launch.
  async function beforeRender() {
    if (!hub) return { unloaded: true, note: 'no bridge' };
    try { return await hub.preRender(8000); } catch (e) { return { unloaded: false, note: 'pre-render check failed: ' + e.message }; }
  }

  const COLD = 'Cloud lane: this is prepared for you to approve in Task-IO or dispatch from the Dev Console. Nothing was sent anywhere.';

  function handle(req, res, u) {
    const p = u.pathname;
    if (!p.startsWith('/api/bridge/') && !p.startsWith('/api/taskio/')) return false;
    if (!isAuthed(req)) { json(res, 401, { ok: false, error: 'Unauthorized' }); return true; }
    const post = (fn) => { readBody(req, res, (b) => (b ? fn(b) : json(res, 400, { ok: false, error: 'Invalid body' }))); return true; };
    const needHub = () => { if (!hub) { json(res, 503, { ok: false, error: hubError }); return false; } return true; };

    // ── devices + coordination ──
    if (p === '/api/bridge/devices' && req.method === 'GET') {
      const q = dispatcher ? dispatcher.queueView() : null;
      json(res, 200, { ok: true, configured: !!hub, setup: hubError, devices: hub ? hub.view() : [], coordination: hub ? hub.coordination() : null, nightly: windowCfg(),
        queue: q ? { running: q.running, queued: q.queued } : null, policy: hub ? hub.policy : defaultPolicy, generatedAt: Date.now() });
      return true;
    }
    if (p === '/api/bridge/policy' && req.method === 'GET') { json(res, 200, { ok: true, policy: defaultPolicy }); return true; }
    if (p === '/api/bridge/alias' && req.method === 'POST') return post((b) => { if (!needHub()) return; const r = hub.setAlias(String(b.id || ''), b.alias); json(res, r.ok ? 200 : 400, r); });
    const failed = (e) => json(res, 502, { ok: false, error: 'bridge error: ' + String((e && e.message) || e).slice(0, 120) });   // an async failure must answer the request, not leave it hanging
    if (p === '/api/bridge/reserve' && req.method === 'POST') return post((b) => { if (!needHub()) return; hub.setReserved(String(b.id || ''), !!b.reserved).then((r) => json(res, r.ok ? 200 : 400, r)).catch(failed); });
    if (p === '/api/bridge/model' && req.method === 'POST') return post((b) => { if (!needHub()) return; hub.modelAction(String(b.id || ''), String(b.action || '')).then((r) => json(res, r.ok ? 200 : 409, r)).catch(failed); });
    if (p === '/api/bridge/queue' && req.method === 'GET') { if (!needHub()) return true; json(res, 200, dispatcher.queueView()); return true; }
    if (p === '/api/bridge/routines' && req.method === 'GET') { if (!needHub()) return true; json(res, 200, { ok: true, window: windowCfg(), routines: routines.list() }); return true; }
    if (p === '/api/bridge/routines/run' && req.method === 'POST') return post((b) => { if (!needHub()) return; const r = routines.run(String(b.id || ''), { manual: true }); json(res, r.ok ? 200 : 400, r); });
    if (p === '/api/bridge/routines/toggle' && req.method === 'POST') return post((b) => { if (!needHub()) return; const r = routines.setEnabled(String(b.id || ''), !!b.enabled); json(res, r.ok ? 200 : 400, r); });

    // One-shot job API (kept): picks a free PC right now, or records a cloud-lane request.
    if (p === '/api/bridge/jobs' && req.method === 'POST') return post((b) => {
      const record = (r) => { const t = taskio.createTask({ title: b.title || 'Task for ' + (b.role || b.area || 'a role'), persona: b.role, area: b.area, lane: r.lane, status: r.ok ? (r.lane === 'cloud' ? 'queued' : 'running') : 'failed', deviceId: r.deviceId, detail: r.note || r.error || '' }); return t.ok ? t.task.id : null; };
      if (!hub) {
        const area = String(b.area || '').toLowerCase(), lane = laneFor(defaultPolicy, area, b.confidential);
        if (lane === 'cloud') { const r = { ok: true, lane, area, deviceId: null, note: COLD }; return json(res, 200, { ...r, taskId: record(r) }); }
        return json(res, 503, { ok: false, lane, area, error: hubError });
      }
      hub.submit(b).then((r) => json(res, r.ok ? 200 : 503, { ...r, taskId: record(r) })).catch((e) => json(res, 502, { ok: false, error: 'bridge error: ' + String(e.message).slice(0, 120) }));
    });
    if (p === '/api/bridge/jobs' && req.method === 'GET') {
      if (!needHub()) return true;
      hub.jobStatus(u.searchParams.get('id') || '').then((r) => json(res, r ? 200 : 404, r || { ok: false, error: 'unknown job' })).catch((e) => json(res, 502, { ok: false, error: String(e.message).slice(0, 120) }));
      return true;
    }

    // ── task-io ──
    if (p === '/api/taskio/day' && req.method === 'GET') {
      const tz = tzOf(u), date = u.searchParams.get('date') || taskio.today(tz), d = taskio.day(date, tz);
      if (!d) { json(res, 400, { ok: false, error: 'date must be YYYY-MM-DD' }); return true; }
      const eod = taskio.getEod(date);
      json(res, 200, { ok: true, ...d, eod: eod ? { id: eod.id, submittedAt: eod.submittedAt, note: eod.note } : null });
      return true;
    }
    if (p === '/api/taskio/task' && req.method === 'GET') { const t = taskio.getTask(u.searchParams.get('id') || ''); json(res, t ? 200 : 404, t ? { ok: true, task: t } : { ok: false, error: 'not found' }); return true; }
    if (p === '/api/taskio/proposals' && req.method === 'GET') { json(res, 200, { ok: true, proposals: taskio.proposals() }); return true; }
    if (p === '/api/taskio/task' && req.method === 'POST') return post((b) => { const r = taskio.createTask({ ...b, source: 'manual', job: undefined, proposal: undefined }); json(res, r.ok ? 200 : 400, r); });
    // "Ask a role": the SERVER picks the lane from the policy. Local -> queued for the pool; cloud -> a proposal waiting for approval.
    if (p === '/api/taskio/ask' && req.method === 'POST') return post((b) => {
      const area = String(b.area || '').toLowerCase().slice(0, 40), prompt = String(b.prompt || '').trim().slice(0, 4000), persona = String(b.persona || 'Owner').slice(0, 40);
      if (!prompt) return json(res, 400, { ok: false, error: 'prompt is required' });
      const lane = laneFor(defaultPolicy, area, false), title = String(b.title || prompt).slice(0, 80);
      if (lane === 'cloud') {
        const t = taskio.createTask({ title, persona, area, lane: 'cloud', source: 'ask', priority: 5, status: 'proposed', detail: COLD, proposal: { repo: 'website', category: 'functional', summary: title, transcript: `Request from ${persona}:\n${prompt}` } });
        return json(res, t.ok ? 200 : 400, { ...t, lane, note: COLD });
      }
      if (!hub) return json(res, 503, { ok: false, lane, error: hubError });
      const system = String(b.system || '').slice(0, 2000) || `You are ${persona} at G741 Studio. Keep answers short and concrete.`;
      const t = taskio.createTask({ title, persona, area, lane: 'local', source: 'ask', priority: 5, advisory: !!b.advisory, detail: 'Waiting for a PC.',
        job: { messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], maxTokens: 500, role: persona, area, confidential: isConfidential(defaultPolicy, area, false) } });
      if (t.ok) dispatcher.kick();
      return json(res, t.ok ? 200 : 400, { ...t, lane });
    });
    if (p === '/api/taskio/task/update' && req.method === 'POST') return post((b) => { const r = taskio.updateTask(b.id, b.patch); json(res, r.ok ? 200 : 400, r); });
    if (p === '/api/taskio/eod/submit' && req.method === 'POST') return post((b) => { const tz = Number.isFinite(+b.tz) ? +b.tz : DEFAULT_TZ; const r = taskio.submitEod({ date: b.date || taskio.today(tz), tz, note: b.note }); json(res, r.ok ? 200 : 400, r); });
    if (p === '/api/taskio/eod' && req.method === 'GET') {
      const date = u.searchParams.get('date');
      if (date) { const r = taskio.getEod(date); json(res, r ? 200 : 404, r ? { ok: true, report: r } : { ok: false, error: 'no EOD submitted for that date' }); return true; }
      json(res, 200, { ok: true, reports: taskio.listEod(u.searchParams.get('limit')) });
      return true;
    }
    json(res, 404, { ok: false, error: 'Not found' });
    return true;
  }
  return { handle, beforeRender, taskio, hub, dispatcher, routines, stop: () => { if (hub) hub.stop(); if (dispatcher) dispatcher.stop(); if (routineTimer) clearInterval(routineTimer); } };
}

module.exports = { init };
