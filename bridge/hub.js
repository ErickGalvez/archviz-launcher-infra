'use strict';
// Hub side of the bridge: keeps a live table of the PCs in the pool, applies the lane policy and coordinates the two kinds
// of work the PCs share:
//
//   RENDERING a client (the live ArchViz session)  vs  AI work (the roles' tasks on a local model).
//
// A PC that is rendering - or reserved for rendering - never gets AI work, and its model is unloaded; the other PC takes
// all of it. The turn system allows ONE client session at a time, so at most one PC is ever rendering and the other is
// always free for the AI lane: the pool cannot be overloaded by design.
//
// It only ever speaks HTTP (signed, see protocol.js) to node agents it was told about (bridge.json) or that a trusted node
// discovered on the LAN. It never spawns anything.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = require('./protocol');
const defaultPolicy = require('./policy');

const PRIVATE = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/;
const isPrivateHost = (h) => PRIVATE.test(String(h || '')) || h === 'localhost';

// The router decides LAST that confidential areas stay local, so a mistake in `lanes` can't leak them.
function laneFor(policy, area, confidential) {
  const lane = (policy.lanes && policy.lanes[area]) || policy.defaultLane || 'local';
  if (confidential || (policy.confidentialAreas || []).includes(area)) return 'local';
  return lane === 'cloud' ? 'cloud' : 'local';
}
const isConfidential = (policy, area, flag) => !!flag || (policy.confidentialAreas || []).includes(area);

function createHub(opts) {
  const { dir, key, policy = defaultPolicy, pollMs = 4000, fetchImpl = fetch, log = () => {}, targets = null,
    getRenderState = () => 'stopped',   // render state of the PC that hosts the launcher: stopped | starting | running | streaming
    idleCfg = () => ({}) } = opts;      // { enabled, gpuPct }: when a PC counts as idle enough for scheduled work outside the night window
  const devices = new Map(), hubJobs = new Map();
  const aliasFile = path.join(dir, 'bridge-aliases.json'), reservedFile = path.join(dir, 'bridge-reserved.json');
  let timer = null;

  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
  const aliases = () => readJson(aliasFile, {});
  const reservedWant = () => readJson(reservedFile, {});

  function configTargets() {
    if (targets) return targets;
    const cfg = readJson(path.join(dir, 'bridge.json'), {}), out = [];
    const add = (s, source) => { const m = /^([0-9a-zA-Z._-]+):(\d{2,5})$/.exec(String(s || '')); if (m) out.push({ host: m[1], port: +m[2], source }); };
    add(cfg.local || '127.0.0.1:7411', 'local');
    (Array.isArray(cfg.peers) ? cfg.peers : []).forEach((p) => add(p, 'configured'));
    return out;
  }

  async function call(t, method, target, bodyObj) {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const headers = P.signRequest(key, method, target, body);
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetchImpl(`http://${t.host}:${t.port}${target}`, { method, headers, body: body || undefined, signal: AbortSignal.timeout(3000) });
    const j = await r.json().catch(() => null);
    if (!r.ok) throw new Error((j && j.error) || 'HTTP ' + r.status);
    return j;
  }
  const at = (d) => ({ host: d.address, port: d.port });

  // ── who is doing what ──
  // Rendering = the node says a client session is up here, or (for the PC hosting the launcher) the launcher says so.
  const renderBusyOf = (d) => !!((d.stats && d.stats.render && d.stats.render.busy) || (d.source === 'local' && getRenderState() !== 'stopped'));
  const reservedOf = (d) => !!(reservedWant()[d.id] || (d.stats && d.stats.render && d.stats.render.reserved));
  const aiCapable = (d) => !!(d.online && d.stats && !renderBusyOf(d) && !reservedOf(d));            // may be given AI work (its model may still need to load)
  const aiReady = (d) => aiCapable(d) && !!(d.stats.llm && d.stats.llm.up);                         // ... and can start right now
  // "Idle enough" lets the nightly routines run in the daytime too: the PC is online, is not rendering and is not reserved for rendering
  // (that is aiCapable), and its GPU is under the threshold right now. A PC that does not report its GPU is not assumed to be idle.
  const idleEnough = (d) => {
    const c = idleCfg() || {}, util = d.stats && d.stats.gpu && d.stats.gpu.utilPct, limit = c.gpuPct > 0 ? c.gpuPct : 20;
    return c.enabled !== false && aiCapable(d) && typeof util === 'number' && util < limit;
  };
  function assignmentOf(d) {
    if (!d.online) return 'offline';
    if (reservedOf(d)) return 'reserved';
    if (renderBusyOf(d)) return 'rendering';
    const llm = (d.stats && d.stats.llm) || {}, m = (d.stats && d.stats.model) || {};
    if (llm.busy) return 'working';
    if (llm.up) return 'ai-ready';
    if (m.phase === 'starting') return 'loading';
    return 'standby';
  }

  async function refresh() {
    const known = new Map();
    for (const t of configTargets()) known.set(t.host + ':' + t.port, t);
    // A node tells us which other PCs it has heard on the LAN, so a PC appears without any configuration.
    await Promise.allSettled([...known.values()].map(async (t) => {
      const r = await call(t, 'GET', '/v1/peers');
      for (const p of r.peers || []) if (isPrivateHost(p.address)) { const k = p.address + ':' + p.port; if (!known.has(k)) known.set(k, { host: p.address, port: p.port, source: 'discovered' }); }
    }));
    const now = Date.now();
    await Promise.allSettled([...known.values()].map(async (t) => {
      try {
        const [info, stats] = await Promise.all([call(t, 'GET', '/v1/info'), call(t, 'GET', '/v1/stats')]);
        // One address is one PC: if it now answers with a different id (re-installed, config regenerated), the old entry is a ghost - drop it,
        // or it would sit offline forever and could be mistaken for the second PC by the Devices and 3D pages.
        for (const [k, d] of devices) if (k !== info.id && d.address === t.host && d.port === t.port) devices.delete(k);
        devices.set(info.id, { id: info.id, nodeAlias: info.alias, hostname: info.hostname, address: t.host, port: t.port, source: t.source, online: true, lastSeen: now, fails: 0, hw: info.hw, stats, error: null });
        // Keep the node in step with what the owner chose, even after the node restarts.
        const want = reservedWant()[info.id];
        if (want !== undefined && stats.render && stats.render.reserved !== want) call(t, 'POST', '/v1/reserve', { reserved: want }).catch(() => {});
      } catch (e) {
        for (const d of devices.values()) if (d.address === t.host && d.port === t.port) { d.fails = (d.fails || 0) + 1; d.error = String(e.message).slice(0, 120); if (d.fails >= 2) d.online = false; }
      }
    }));
  }

  function view() {
    const al = aliases();
    return [...devices.values()].map((d) => ({ id: d.id, alias: al[d.id] || d.nodeAlias, nodeAlias: d.nodeAlias, hostname: d.hostname, address: d.address, port: d.port, source: d.source,
      online: d.online, lastSeen: d.lastSeen, hw: d.hw, stats: d.stats, error: d.error, rendering: renderBusyOf(d), reserved: reservedOf(d), assignment: assignmentOf(d), idle: idleEnough(d) }))
      .sort((a, b) => String(a.alias).localeCompare(String(b.alias)));
  }
  // The one-line answer to "who is carrying the AI work right now?" for the Devices page and the 3D map.
  function coordination() {
    const list = view(), name = (d) => d.alias;
    const rendering = list.filter((d) => d.assignment === 'rendering'), reserved = list.filter((d) => d.assignment === 'reserved');
    const carrying = list.filter((d) => d.online && d.assignment !== 'rendering' && d.assignment !== 'reserved');
    let state, message;
    if (!list.some((d) => d.online)) { state = 'none'; message = 'No PC is online.'; }
    else if (rendering.length && carrying.length) { state = 'split'; message = `${rendering.map(name).join(' and ')} ${rendering.length > 1 ? 'are' : 'is'} rendering a client — ${carrying.map(name).join(' and ')} carr${carrying.length > 1 ? 'y' : 'ies'} all the AI work.`; }
    else if (rendering.length) { state = 'blocked'; message = `${rendering.map(name).join(' and ')} ${rendering.length > 1 ? 'are' : 'is'} rendering a client and no other PC is free: AI work waits until the session ends.`; }
    else if (reserved.length && carrying.length) { state = 'reserved'; message = `${reserved.map(name).join(' and ')} reserved for client rendering — ${carrying.map(name).join(' and ')} carr${carrying.length > 1 ? 'y' : 'ies'} all the AI work.`; }
    else if (reserved.length) { state = 'blocked'; message = `${reserved.map(name).join(' and ')} reserved for rendering and no other PC is free: AI work waits.`; }
    else if (carrying.length > 1) { state = 'shared'; message = `No client is rendering: ${carrying.map(name).join(' and ')} share the AI work.`; }
    else { state = 'solo'; message = `No client is rendering: ${carrying.map(name).join(' and ')} carr${carrying.length > 1 ? 'y' : 'ies'} the AI work.`; }
    return { state, message, rendering: rendering.map((d) => d.id), carrying: carrying.map((d) => d.id) };
  }

  function setAlias(id, alias) {
    if (!devices.has(id)) return { ok: false, error: 'unknown device' };
    const a = String(alias || '').replace(/[^\p{L}\p{N} ._()+-]/gu, '').trim().slice(0, 40);
    if (!a) return { ok: false, error: 'alias must have 1-40 letters, digits or spaces' };
    const all = aliases(); all[id] = a; fs.writeFileSync(aliasFile, JSON.stringify(all, null, 2));
    return { ok: true, alias: a };
  }

  // Reserve a PC for client rendering: it gets no AI work and its model is unloaded. The owner's choice, kept on the hub.
  async function setReserved(id, reserved) {
    const d = devices.get(id);
    if (!d) return { ok: false, error: 'unknown device' };
    const all = reservedWant(); all[id] = !!reserved; fs.writeFileSync(reservedFile, JSON.stringify(all, null, 2));
    if (d.online) { try { await call(at(d), 'POST', '/v1/reserve', { reserved: !!reserved }); } catch (e) { return { ok: true, reserved: !!reserved, note: 'saved; the PC will pick it up when it is reachable (' + e.message + ')' }; } }
    return { ok: true, reserved: !!reserved };
  }
  async function modelAction(id, action) {
    const d = devices.get(id);
    if (!d || !d.online) return { ok: false, error: 'that PC is not online' };
    try { const r = await call(at(d), 'POST', '/v1/model', { action }); return { ok: true, model: r.model }; } catch (e) { return { ok: false, error: e.message }; }
  }

  const load = (d) => { const s = d.stats || {}, l = s.llm || {}; return ((l.queued || 0) + (l.busy ? 1 : 0)) * 1000 + ((s.gpu && s.gpu.utilPct) || 0) + (s.cpuPct || 0) / 10; };
  const byLoad = (a, b) => load(a) - load(b) || a.id.localeCompare(b.id);
  const pickDevice = () => [...devices.values()].filter(aiReady).sort(byLoad)[0] || null;

  // Direct submit to a chosen PC (used by the dispatcher, which does the choosing).
  async function submitTo(id, spec) {
    const d = devices.get(id);
    if (!d || !d.online) throw new Error('device offline');
    const area = String(spec.area || '').toLowerCase();
    if (spec.type === 'archive.scan') {                                        // the Archivist: a folder to catalogue, never a prompt; the PC checks it against its own allowed list
      const r = await call(at(d), 'POST', '/v1/jobs', { type: 'archive.scan', role: spec.role, area: 'archive', title: spec.title, confidential: true, params: spec.params });
      return { jobId: r.jobId };
    }
    const r = await call(at(d), 'POST', '/v1/jobs', { type: 'llm.chat', role: spec.role, area, title: spec.title, confidential: isConfidential(policy, area, spec.confidential), messages: spec.messages, maxTokens: spec.maxTokens, thinking: !!spec.thinking });
    return { jobId: r.jobId };
  }
  // The PC that runs the Archivist: the launcher's own PC (PC-1), online, with the Archivist enabled in ITS config. Nothing else may.
  const archiveDevice = () => [...devices.values()].find((d) => d.source === 'local' && d.online && d.stats && d.stats.archive && d.stats.archive.enabled) || null;
  // Reads (and the cancel/forget controls) of the Archivist's catalogs, proxied to that PC with a signed request.
  async function archiveCall(id, method, target, bodyObj) {
    const d = devices.get(id);
    if (!d || !d.online || d.source !== 'local') throw new Error('the Archivist runs only on the launcher PC, and it is not online');
    if (!/^\/v1\/archive\/[\w/.?=&%+~!*'()-]*$/.test(target) || /\.\./.test(target.split('?')[0])) throw new Error('bad archive request');     // no "..": the agent would resolve it out of /v1/archive/
    return call(at(d), method, target, bodyObj);
  }
  async function jobOn(id, jobId) {
    const d = devices.get(id);
    if (!d || !d.online) return { ok: false, error: 'device offline' };
    const r = await call(at(d), 'GET', '/v1/jobs/' + encodeURIComponent(jobId));
    return { ok: true, job: r.job };
  }

  // Older one-shot path (kept for the job-status API): pick a PC and submit now.
  async function submit(spec) {
    const area = String(spec.area || '').toLowerCase();
    const lane = laneFor(policy, area, spec.confidential);
    if (lane === 'cloud') return { ok: true, lane, area, deviceId: null, note: 'Cloud lane: dispatch this from the Dev Console (issue -> pull request). Nothing was sent anywhere.' };
    if (!Array.isArray(spec.messages) || !spec.messages.length) return { ok: false, lane, area, error: 'messages are required for a local job' };
    const d = pickDevice();
    if (!d) return { ok: false, lane, area, error: 'no_local_device_available', note: 'No PC with a running local model is free for AI work right now.' };
    const r = await submitTo(d.id, spec);
    const hubJobId = 'hj_' + crypto.randomBytes(6).toString('hex');
    hubJobs.set(hubJobId, { deviceId: d.id, remoteId: r.jobId, createdAt: Date.now() });
    if (hubJobs.size > 500) hubJobs.delete(hubJobs.keys().next().value);
    return { ok: true, lane, area, deviceId: d.id, alias: aliases()[d.id] || d.nodeAlias, hubJobId };
  }
  async function jobStatus(hubJobId) {
    const h = hubJobs.get(hubJobId);
    if (!h) return null;
    const r = await jobOn(h.deviceId, h.remoteId);
    return r.ok ? { ok: true, deviceId: h.deviceId, job: r.job } : { ok: false, error: r.error, deviceId: h.deviceId };
  }

  // Called by the launcher right BEFORE it starts a client session: tell this PC's node a render is coming and wait (bounded)
  // for its model to be unloaded, so the model never fights UE5 for VRAM. Never throws, never waits longer than timeoutMs.
  async function preRender(timeoutMs = 8000) {
    const t0 = Date.now(), local = [...devices.values()].find((d) => d.source === 'local') ? at([...devices.values()].find((d) => d.source === 'local')) : configTargets().find((x) => x.source === 'local');
    if (!local) return { unloaded: true, waitedMs: 0, note: 'no local node' };
    try { await call(local, 'POST', '/v1/hint', { render: true, ttlSec: 120 }); } catch (e) { return { unloaded: true, waitedMs: Date.now() - t0, note: 'local node unreachable' }; }
    while (Date.now() - t0 < timeoutMs) {
      try {
        const s = await call(local, 'GET', '/v1/stats');
        const phase = s.model && s.model.phase;
        if ((!s.llm || !s.llm.up) && (phase === 'stopped' || phase === 'failed' || !s.model || s.model.canStart === false)) return { unloaded: true, waitedMs: Date.now() - t0 };
      } catch (e) { return { unloaded: true, waitedMs: Date.now() - t0, note: 'lost contact with the local node' }; }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { unloaded: false, waitedMs: Date.now() - t0, note: 'model still unloading; continuing the launch' };
  }

  function start() {
    refresh().catch(() => {});
    timer = setInterval(() => refresh().catch(() => {}), pollMs);
    if (timer.unref) timer.unref();
  }
  const stop = () => { if (timer) clearInterval(timer); timer = null; };
  const devicesRaw = () => [...devices.values()].map((d) => ({ ...d, alias: aliases()[d.id] || d.nodeAlias }));

  return { start, stop, refresh, view, coordination, devices: devicesRaw, setAlias, setReserved, modelAction, submit, jobStatus, submitTo, jobOn, preRender, pickDevice,
    archiveDevice, archiveCall, renderBusyOf, reservedOf, aiCapable, aiReady, idleEnough, assignmentOf, load: byLoad, policy };
}

module.exports = { createHub, laneFor, isConfidential, isPrivateHost };
