'use strict';
// The coordinator: turns queued local-lane tasks into work on whichever PC is free for it.
//
// Rules (this is the whole policy, in one place):
//   1. A PC that is RENDERING a client, or is RESERVED for rendering, never gets AI work. The other PC takes all of it.
//   2. One job at a time per PC (one GPU = one inference). Two free PCs run two tasks in parallel.
//   3. If every PC is busy rendering/reserved/offline, tasks WAIT in the queue; nothing is dropped and nothing falls back
//      to the cloud. (The turn system allows one client session at a time, so a PC is normally free.)
//   4. If the chosen PC's model is not loaded, the dispatcher asks that PC to load it (the node decides whether it may)
//      and the task waits until it is up.
//   5. Routine (scheduled) tasks only run inside the nightly window; owner-requested tasks run any time.
//   6. If the PC a task is running on starts rendering, goes offline or loses its model, the task goes back in the queue
//      and runs on the other PC. A genuine error counts as an attempt; three attempts and it is marked failed.
const MAX_ATTEMPTS = 3;
const RETRYABLE = /^rendering:|llm_unavailable|offline|unloaded|ECONN|fetch failed|timed out|no such job/i;

// onDone(task) is called once a local task has finished with a result (a role such as Vera turns the answer into something: a verdict on a ticket).
function createDispatcher({ hub, taskio, pollMs = 3000, now = Date.now, log = () => {}, maxAttempts = MAX_ATTEMPTS, onDone = () => {} }) {
  let timer = null, busy = false, lastTick = 0, lastNote = '';
  const alias = (d) => d.alias || d.nodeAlias || d.id;

  async function requeue(t, why) {
    taskio.patchTask(t.id, { status: 'queued', deviceId: null, remote: null, detail: why });
    log('re-queued "' + t.title + '": ' + why);
  }
  async function fail(t, why, d) { taskio.patchTask(t.id, { status: 'failed', error: why, detail: 'Failed: ' + why, doneAt: now() }); log('failed "' + t.title + '": ' + why); }

  // Look at what is running and move it along.
  async function reconcile(t, devs) {
    const d = devs.find((x) => x.id === t.deviceId);
    if (!d || !d.online) return requeue(t, 'the PC went offline; moved to another PC');
    if (hub.renderBusyOf(d) || hub.reservedOf(d)) return requeue(t, alias(d) + ' started rendering a client; moved to the other PC');
    let r;
    try { r = await hub.jobOn(d.id, t.remote && t.remote.jobId); } catch (e) { if (RETRYABLE.test(e.message)) return requeue(t, alias(d) + ' lost the job (' + e.message + '); retrying'); return; }
    if (!r.ok) return requeue(t, r.error);
    const j = r.job;
    if (j.status === 'done') {
      taskio.patchTask(t.id, { status: 'done', result: { text: (j.result && j.result.text) || '', tokens: (j.result && j.result.tokens) || 0, deviceId: d.id, ms: (j.doneAt || now()) - (j.startedAt || now()) }, doneAt: now(), detail: 'Done on ' + alias(d) + '.', remote: null });
      log('done "' + t.title + '" on ' + alias(d));
      try { onDone(taskio.getRaw(t.id)); } catch (e) { log('on-done handler failed: ' + e.message); }
    } else if (j.status === 'failed') {
      if (/^rendering:/.test(j.error || '') || /llm_unavailable|unloaded/.test(j.error || '')) return requeue(t, alias(d) + ': ' + j.error + '; moved to another PC');
      const attempts = (t.attempts || 0) + 1;
      if (attempts >= maxAttempts) return fail(t, j.error || 'job failed');
      taskio.patchTask(t.id, { attempts, status: 'queued', deviceId: null, remote: null, detail: 'Attempt ' + attempts + ' failed on ' + alias(d) + ' (' + (j.error || 'error') + '); retrying' });
    }
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const devs = hub.devices(), jobs = taskio.openJobs(), t0 = now();
      for (const t of jobs.filter((x) => x.status === 'running')) { try { await reconcile(t, devs); } catch (e) { log('reconcile: ' + e.message); } }

      const open = taskio.openJobs();
      const usedDevices = new Set(open.filter((x) => x.status === 'running').map((x) => x.deviceId));
      const startAsked = new Set();
      const waiting = [];
      for (const t of open.filter((x) => x.status === 'queued')) {
        const routine = t.source === 'routine' && !(t.priority > 0);                   // owner-requested (priority > 0) runs any time
        const candidates = devs.filter((d) => hub.aiCapable(d) && !usedDevices.has(d.id)
          && (!routine || (d.stats && d.stats.model && d.stats.model.windowActive)));
        if (!candidates.length) { waiting.push(t); continue; }
        const ready = candidates.filter((d) => hub.aiReady(d)).sort(hub.load);
        if (ready.length) {
          const d = ready[0];
          try {
            const r = await hub.submitTo(d.id, { ...t.job, title: t.title, role: t.job.role || t.persona, area: t.job.area || t.area });
            usedDevices.add(d.id);
            taskio.patchTask(t.id, { status: 'running', deviceId: d.id, remote: { jobId: r.jobId }, startedAt: now(), detail: 'Running on ' + alias(d) + '.' });
            log('"' + t.title + '" -> ' + alias(d));
          } catch (e) { taskio.patchTask(t.id, { detail: 'Could not start on ' + alias(d) + ': ' + e.message }); }
          continue;
        }
        // Nobody has a model loaded: ask the best candidate to load it (once per tick), and wait.
        const loadable = candidates.filter((d) => d.stats && d.stats.model && d.stats.model.canStart && !startAsked.has(d.id)).sort(hub.load);
        if (loadable.length) {
          const d = loadable[0]; startAsked.add(d.id);
          const m = d.stats.model;
          if (m.phase === 'stopped' || m.phase === 'failed' || m.paused) { const r = await hub.modelAction(d.id, 'start'); taskio.patchTask(t.id, { detail: r.ok ? 'Loading the model on ' + alias(d) + '...' : 'Could not load the model on ' + alias(d) + ': ' + r.error }); }
          else taskio.patchTask(t.id, { detail: 'Loading the model on ' + alias(d) + '...' });
        }
        waiting.push(t);
      }
      lastTick = t0; lastNote = waiting.length ? waiting.length + ' task(s) waiting' : '';
    } finally { busy = false; }
  }

  function start() { timer = setInterval(() => tick().catch((e) => log('dispatcher: ' + e.message)), pollMs); if (timer.unref) timer.unref(); }
  const stop = () => { if (timer) clearInterval(timer); timer = null; };

  // What the Devices page shows: the queue, who has what, and what is waiting.
  function queueView() {
    const devs = hub.devices(), name = (id) => { const d = devs.find((x) => x.id === id); return d ? alias(d) : null; };
    const rows = taskio.openJobs().map((t) => ({ id: t.id, title: t.title, persona: t.persona, area: t.area, status: t.status, priority: t.priority || 0, source: t.source, advisory: !!t.advisory, device: name(t.deviceId), detail: t.detail || '', ts: t.ts, startedAt: t.startedAt || null, attempts: t.attempts || 0 }));
    return { ok: true, running: rows.filter((r) => r.status === 'running').length, queued: rows.filter((r) => r.status === 'queued').length, tasks: rows, lastTick, note: lastNote };
  }
  return { tick, start, stop, queueView, kick: () => { tick().catch(() => {}); } };
}

module.exports = { createDispatcher };
