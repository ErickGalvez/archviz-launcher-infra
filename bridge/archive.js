'use strict';
// The launcher's side of the Archivist (secret department): start a scan, follow it, read its catalog, cancel it.
//
// The work happens on PC-1's node agent (archivist.js): it reads the owner's files, asks the local Qwen about them and keeps the catalog on that PC. The launcher
// only (1) creates a task pinned to PC-1, (2) proxies the read-only catalog calls over the signed bridge, and (3) cuts a long scan into slices: when one ends
// before the folder is finished, a new task continues the same run, so other work (nightly routines, Vera) gets its turn between slices.
// Nothing here opens a file or a folder: a path is only ever passed on, and PC-1 checks it against ITS OWN list of allowed folders.
const path = require('path');

const MAX_FILES = 20000;
const lastName = (p) => { const s = String(p).replace(/[\\/]+$/, ''); return path.win32.basename(s) || path.posix.basename(s) || s; };

function createArchive({ taskio, hub, log = () => {} }) {
  const need = () => { const d = hub && hub.archiveDevice(); if (!d) { const e = new Error('The Archivist runs only on PC-1 (the launcher PC). It is not online, or it is turned off in that PC\'s bridge-node.json ("archive": { "enabled": true }).'); e.code = 'no_device'; throw e; } return d; };
  const asError = (e) => ({ ok: false, error: String((e && e.message) || e).slice(0, 300), code: e && e.code });

  // The state of the department: can it work, where, on which folders, and what is it doing now.
  async function status() {
    try {
      const d = need(), r = await hub.archiveCall(d.id, 'GET', '/v1/archive/roots');
      const open = taskio.openJobs().filter((t) => t.job && t.job.type === 'archive.scan');
      return { ok: true, enabled: true, device: d.alias || d.nodeAlias || d.id, roots: r.roots || [], active: open.map((t) => ({ taskId: t.id, status: t.status, detail: t.detail || '', ref: t.ref || '', title: t.title })) };
    } catch (e) { return { ok: true, enabled: false, reason: asError(e).error, roots: [], active: [] }; }
  }

  // Start a scan of a folder. PC-1 is asked first, so a folder that is not allowed (or does not exist) is answered at once with what to do.
  async function start({ path: dir, maxFiles, fresh } = {}) {
    try {
      const d = need(), p = String(dir == null ? '' : dir).trim();
      if (!p || p.length > 500 || /[\u0000-\u001f]/.test(p)) return { ok: false, code: 'bad_path', error: 'Give a full local path, for example D:\\Old stuff' };
      try { await hub.archiveCall(d.id, 'POST', '/v1/archive/check', { path: p }); } catch (e) { return asError(e); }
      const busy = taskio.openJobs().find((t) => t.job && t.job.type === 'archive.scan' && t.job.params && t.job.params.path === p);
      if (busy) return { ok: false, code: 'busy', error: 'That folder is already being scanned.', taskId: busy.id };
      const made = taskio.createTask({ title: 'Archive scan: ' + lastName(p), persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', priority: 5, detail: 'Waiting for PC-1.',
        job: { type: 'archive.scan', role: 'Mole', params: { path: p, maxFiles: Math.min(Math.max(parseInt(maxFiles, 10) || 400, 1), MAX_FILES), fresh: fresh === true } } });
      if (!made.ok) return { ok: false, error: made.error };
      log('archive: scan of "' + p + '" queued');
      return { ok: true, taskId: made.task.id };
    } catch (e) { return asError(e); }
  }

  // The dispatcher calls this for every finished task. A scan that ended before the folder was done continues as a NEW task (the end of the queue), same run.
  function handleDone(task) {
    try {
      if (!task || !task.job || task.job.type !== 'archive.scan' || !task.result || !task.result.text) return false;
      let dg; try { dg = JSON.parse(task.result.text); } catch (e) { return false; }
      if (!dg || typeof dg !== 'object' || !/^ar_[0-9a-f]{10}(_\d{1,10})?$/.test(String(dg.runId || ''))) return false;
      const c = dg.counts || {};
      taskio.patchTask(task.id, { ref: dg.runId, detail: dg.done ? 'Done: ' + (c.files || 0) + ' files catalogued, ' + (dg.projects ? dg.projects.length : 0) + ' project group(s), ' + (((dg.duplicates || {}).exact || 0) + ((dg.duplicates || {}).near || 0)) + ' duplicate set(s).'
        : dg.status === 'cancelled' ? 'Cancelled after ' + ((c.interpretedContent || 0) + (c.interpretedFolder || 0)) + ' files (what was done is kept).' : 'Paused after a slice: ' + (dg.remaining || 0) + ' files still to read; it continues when PC-1 is free.' });
      if (dg.done || dg.status === 'cancelled' || !(dg.remaining > 0)) return true;
      if (taskio.openJobs().some((t) => t.job && t.job.type === 'archive.scan' && t.job.params && t.job.params.runId === dg.runId)) return true;
      const p = task.job.params || {};
      taskio.createTask({ title: task.title.replace(/ \(continued.*$/, '') + ' (continued)', persona: 'Mole', area: 'archive', lane: 'local', source: 'archive', priority: 5, detail: 'Waiting for PC-1 to continue.', ref: dg.runId,
        job: { type: 'archive.scan', role: 'Mole', params: { path: p.path, runId: dg.runId, maxFiles: p.maxFiles } } });
      return true;
    } catch (e) { log('archive: ' + e.message); return false; }
  }

  // Read-only views of what PC-1 holds.
  const get = async (target) => hub.archiveCall(need().id, 'GET', target);
  async function runs() { try { return { ok: true, ...(await get('/v1/archive/runs')) }; } catch (e) { return asError(e); } }
  async function run(id) { try { return await get('/v1/archive/runs/' + encodeURIComponent(String(id))); } catch (e) { return asError(e); } }
  async function files(id, q = {}) {
    try {
      const qs = ['dir', 'group', 'kind', 'q', 'offset', 'limit'].filter((k) => q[k] !== undefined && q[k] !== null && q[k] !== '').map((k) => k + '=' + encodeURIComponent(String(q[k]).slice(0, 200)));
      return await get('/v1/archive/runs/' + encodeURIComponent(String(id)) + '/files' + (qs.length ? '?' + qs.join('&') : ''));
    } catch (e) { return asError(e); }
  }
  async function forget(runId) {
    try { const open = taskio.openJobs().some((t) => t.job && t.job.type === 'archive.scan' && t.job.params && t.job.params.runId === runId); if (open) return { ok: false, error: 'That run is still being worked on: cancel it first.' };
      return await hub.archiveCall(need().id, 'POST', '/v1/archive/forget', { runId: String(runId) }); } catch (e) { return asError(e); }
  }
  // Stop a scan: a queued one is simply dismissed; a running one is told to stop at the next file (what it did is kept).
  async function cancel(taskId) {
    try {
      const t = taskio.getRaw(String(taskId || ''));
      if (!t || !t.job || t.job.type !== 'archive.scan') return { ok: false, error: 'not an archive scan' };
      const sameRun = (x) => x.job && x.job.type === 'archive.scan' && x.status === 'queued' && ((t.job.params || {}).runId ? (x.job.params || {}).runId === t.job.params.runId : x.id === t.id);
      for (const x of taskio.openJobs().filter(sameRun)) taskio.patchTask(x.id, { status: 'dismissed', detail: 'Cancelled by the owner.' });
      if (t.status === 'running' && t.remote && t.remote.jobId) { await hub.archiveCall(t.deviceId, 'POST', '/v1/archive/cancel', { jobId: t.remote.jobId }); taskio.patchTask(t.id, { detail: 'Cancelling after the current file…' }); }
      return { ok: true };
    } catch (e) { return asError(e); }
  }
  return { status, start, handleDone, runs, run, files, forget, cancel };
}

module.exports = { createArchive };
