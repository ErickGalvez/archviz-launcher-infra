'use strict';
// Task-IO: "what did each area do today?" - the data behind the Task-IO hub app, the EOD report and the 3D replay.
//
// A day's task list is the union of:
//   - tasks recorded explicitly (taskio-tasks.jsonl: created by the bridge, an agent, or by hand), and
//   - tasks DERIVED from activity the launcher already records: Dev Console dispatches/merges, automated test runs,
//     QA bugs, CRM prospect changes, inbound session requests/inquiries.
// Derived tasks are computed on read and never stored, so there is no second copy to drift. Personal data (leads'
// names and e-mails) is never copied into a task: inbound requests are only counted.
//
// An EOD report is an immutable snapshot of one day, appended to taskio-eod.jsonl; the latest per date wins.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_TZ = -360;                       // minutes east of UTC; Mexico City has been UTC-6 all year since 2022
const LANES = ['local', 'cloud', 'human', 'script'];
// proposed = a cloud-lane piece of work prepared for the owner to approve (it is never sent anywhere by itself); dismissed = the owner said no.
const STATUSES = ['queued', 'running', 'done', 'failed', 'proposed', 'dismissed'];
const SOURCES = ['manual', 'ask', 'routine', 'bridge'];
const BULK = 5;                                // more than this many of the same CRM change collapse into one task

const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean); } catch (e) { return []; } };
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
// Multi-line text (a proposal's brief): keep newlines and tabs, drop the other control characters.
const clipText = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n);
const stamp = (t) => Date.parse(t) || 0;

function dayRange(date, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  if (!m) return null;
  const start = Date.UTC(+m[1], +m[2] - 1, +m[3]) - tz * 60000;
  return { start, end: start + 86400000 };
}
const todayFor = (tz, now = Date.now()) => new Date(now + tz * 60000).toISOString().slice(0, 10);

function createTaskio(opts) {
  const { dir, getProspects = () => [], getBugs = () => [], now = () => Date.now() } = opts;
  const tasksFile = path.join(dir, 'taskio-tasks.jsonl'), eodFile = path.join(dir, 'taskio-eod.jsonl');
  const within = (t, r) => t >= r.start && t < r.end;
  const mk = (o) => ({ deviceId: null, detail: '', ref: '', status: 'done', ...o, at: new Date(o.ts).toISOString() });

  // ── explicit tasks ──
  // Everything recorded here, folded from the event log. A task may carry a `job` (the prompt, kept server-side and never
  // sent to the pages) and a `result` (what the pool produced).
  // The log is re-folded only when the file has actually changed (size + modification time), so the dispatcher's every-3-seconds reads stay cheap
  // however long the log grows - and a write by ANOTHER process (the nightly script, a second launcher) is still seen straight away.
  // Callers treat the tasks as read-only; views are copies.
  let folded = { sig: '', map: null };
  function foldAll() {
    let sig = 'none'; try { const st = fs.statSync(tasksFile); sig = st.size + ':' + st.mtimeMs; } catch (e) { /* no file yet */ }
    if (folded.map && folded.sig === sig) return folded.map;
    const byId = new Map();
    for (const ev of readJsonl(tasksFile)) {
      if (ev.type === 'create' && ev.task) byId.set(ev.task.id, { ...ev.task });
      else if (ev.type === 'update' && byId.has(ev.id)) Object.assign(byId.get(ev.id), ev.patch || {});
    }
    folded = { sig, map: byId };
    return byId;
  }
  const view = (t) => { const { job, remote, ...rest } = t; return mk({ ...rest, source: t.source || 'manual', hasJob: !!job }); };
  function explicit(r) { return [...foldAll().values()].filter((t) => within(t.ts, r)).map(view); }

  // ── derived tasks ──
  function fromDevconsole(r) {
    return readJsonl(path.join(dir, 'devconsole-log.jsonl')).filter((e) => within(stamp(e.ts), r)).map((e) => {
      const ts = stamp(e.ts), ref = e.repo ? e.repo + '#' + (e.issueNumber || e.pr || '') : '';
      if (e.type === 'dispatch') return mk({ id: 'dc:' + ts + ':' + (e.issueNumber || ''), ts, persona: 'Dex', area: 'dev', lane: 'cloud', source: 'devconsole', title: clip(String(e.title || 'Dev Console dispatch').replace(/^(Follow-up:\s*)+/i, 'Follow-up: '), 140), status: 'running', ref });
      if (e.type === 'commit') return mk({ id: 'dc:' + ts + ':pr' + (e.pr || ''), ts, persona: 'Dex', area: 'dev', lane: 'cloud', source: 'devconsole', title: 'Merged PR #' + (e.pr || '?') + (e.category ? ' (' + clip(e.category, 20) + ')' : ''), status: e.merged === false ? 'failed' : 'done', ref });
      return mk({ id: 'dc:' + ts + ':' + clip(e.type, 12), ts, persona: 'Dex', area: 'dev', lane: 'cloud', source: 'devconsole', title: 'Dev Console: ' + clip(e.type || 'event', 30), ref });
    });
  }
  function fromAutotests(r) {
    return readJsonl(path.join(dir, 'autotest-runs.jsonl')).filter((e) => within(stamp(e.ts), r)).map((e) => {
      const s = e.summary || {}, ts = stamp(e.ts);
      return mk({ id: 'at:' + ts, ts, persona: 'Otto', area: 'qa', lane: 'script', source: 'autotest', title: 'Automated checks (' + clip(e.job || 'run', 20) + '): ' + (s.ok || 0) + ' ok / ' + (s.warn || 0) + ' degraded / ' + (s.down || 0) + ' down', status: (s.down || 0) > 0 ? 'failed' : 'done' });
    });
  }
  function fromBugs(r) {
    const out = [];
    for (const b of getBugs() || []) {
      const c = stamp(b.createdAt), u = stamp(b.updatedAt);
      if (within(c, r)) out.push(mk({ id: 'bug:' + b.id + ':c', ts: c, persona: 'Priya', area: 'qa', lane: 'human', source: 'qa', title: 'Bug filed: ' + clip(b.title, 100) + (b.priority ? ' (' + clip(b.priority, 12) + ')' : ''), ref: b.id }));
      else if (within(u, r)) out.push(mk({ id: 'bug:' + b.id + ':u', ts: u, persona: 'Priya', area: 'qa', lane: 'human', source: 'qa', title: 'Bug ' + clip(b.status || 'updated', 20) + ': ' + clip(b.title, 100), ref: b.id }));
    }
    return out;
  }
  function fromProspects(r) {
    const created = [], updated = [];
    for (const p of getProspects() || []) {
      const c = stamp(p.createdAt), u = stamp(p.updatedAt);
      if (within(c, r)) created.push({ ts: c, p }); else if (within(u, r)) updated.push({ ts: u, p });
    }
    const out = [], base = { persona: 'Nadia', area: 'sales', lane: 'human', source: 'sales' };
    const emit = (list, verb, fmt) => {
      if (!list.length) return;
      if (list.length > BULK) out.push(mk({ ...base, id: 'sales:' + verb + ':' + list[0].ts, ts: Math.max(...list.map((x) => x.ts)), title: list.length + ' prospects ' + verb, detail: list.slice(0, 5).map((x) => clip(x.p.name, 40)).join(', ') + ', ...' }));
      else for (const x of list) out.push(mk({ ...base, id: 'sales:' + x.p.id + ':' + verb, ts: x.ts, title: fmt(x.p), ref: x.p.id }));
    };
    emit(created, 'added', (p) => 'Prospect added: ' + clip(p.name, 80));
    emit(updated, 'updated', (p) => clip(p.name, 80) + ' -> ' + clip(p.status, 20));
    return out;
  }
  function fromInbound(r) {
    const out = [], count = (f) => readJsonl(path.join(dir, f)).filter((e) => within(stamp(e.ts), r));
    const leads = count('leads-log.jsonl'), inq = count('inquiries-log.jsonl');
    if (leads.length) out.push(mk({ id: 'in:leads:' + leads[0].ts, ts: stamp(leads[leads.length - 1].ts), persona: 'Nadia', area: 'sales', lane: 'human', source: 'leads', title: leads.length + ' session request' + (leads.length > 1 ? 's' : '') + ' received' }));
    if (inq.length) out.push(mk({ id: 'in:inq:' + inq[0].ts, ts: stamp(inq[inq.length - 1].ts), persona: 'Talia', area: 'marketing', lane: 'human', source: 'inquiries', title: inq.length + ' hero inquir' + (inq.length > 1 ? 'ies' : 'y') + ' received' }));
    return out;
  }

  function day(date, tz = DEFAULT_TZ) {
    const r = dayRange(date, tz);
    if (!r) return null;
    // A role that records its own Dev Console dispatch (an explicit task whose ref starts with "repo#issue") replaces the entry derived from the
    // Dev Console log: shown once, under the right person (derived dispatches are always attributed to Dex, even a QA brief from Priya).
    const own = explicit(r), claimed = new Set(own.map((t) => String(t.ref || '').split(' ')[0]).filter(Boolean));
    const tasks = [...own, ...fromDevconsole(r).filter((t) => !(t.ref && claimed.has(t.ref))), ...fromAutotests(r), ...fromBugs(r), ...fromProspects(r), ...fromInbound(r)].sort((a, b) => a.ts - b.ts);
    return { date, tz, tasks, counts: counts(tasks) };
  }
  function counts(tasks) {
    const c = { total: tasks.length, byArea: {}, byPersona: {}, byLane: {}, byStatus: {} };
    for (const t of tasks) for (const [k, v] of [['byArea', t.area], ['byPersona', t.persona], ['byLane', t.lane], ['byStatus', t.status]]) c[k][v] = (c[k][v] || 0) + 1;
    return c;
  }

  // ── explicit task writes ──
  function cleanJob(j) {
    if (!j || !Array.isArray(j.messages) || j.messages.length < 1 || j.messages.length > 20) return null;
    const messages = [];
    for (const m of j.messages) {
      if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') return null;
      messages.push({ role: m.role, content: m.content.slice(0, 16000) });
    }
    return { messages, maxTokens: Math.min(Math.max(parseInt(j.maxTokens, 10) || 600, 1), 2048), thinking: !!j.thinking, role: clip(j.role, 40), area: clip(j.area, 40).toLowerCase(), confidential: !!j.confidential };
  }
  function cleanProposal(p) {
    if (!p || !clipText(p.transcript, 8000)) return null;
    return { repo: clip(p.repo, 20) || 'website', summary: clip(p.summary, 140), transcript: clipText(p.transcript, 8000), category: ['functional', 'cosmetic'].includes(p.category) ? p.category : 'functional' };
  }
  function createTask(input) {
    const title = clip(input && input.title, 160);
    if (!title) return { ok: false, error: 'title is required' };
    const lane = LANES.includes(input.lane) ? input.lane : 'human';
    const job = lane === 'local' ? cleanJob(input.job) : null;
    if (input.job && lane === 'local' && !job) return { ok: false, error: 'job must have 1-20 messages with a role and text' };
    const proposal = lane === 'cloud' ? cleanProposal(input.proposal) : null;
    const status = STATUSES.includes(input.status) ? input.status : (job ? 'queued' : proposal ? 'proposed' : 'queued');
    const t = { id: 'tk_' + crypto.randomBytes(6).toString('hex'), ts: now(), persona: clip(input.persona, 40) || 'Owner', area: clip(input.area, 40).toLowerCase() || 'general',
      lane, status, title, detail: clip(input.detail, 800), ref: clip(input.ref, 120), deviceId: input.deviceId ? clip(input.deviceId, 40) : null, source: SOURCES.includes(input.source) ? input.source : 'manual',
      priority: Math.min(Math.max(parseInt(input.priority, 10) || 0, 0), 9), advisory: !!input.advisory, routineId: clip(input.routineId, 40) || undefined, handler: clip(input.handler, 20) || undefined, attempts: 0, ...(job ? { job } : {}), ...(proposal ? { proposal } : {}) };
    fs.appendFileSync(tasksFile, JSON.stringify({ type: 'create', task: t }) + '\n');
    return { ok: true, task: view(t) };
  }
  function updateTask(id, patch) {
    if (!/^tk_[0-9a-f]{12}$/.test(String(id || ''))) return { ok: false, error: 'only tasks created here (tk_...) can be edited' };
    const exists = foldAll().has(id);
    if (!exists) return { ok: false, error: 'not found' };
    const p = {};
    if (patch && STATUSES.includes(patch.status)) p.status = patch.status;
    if (patch && typeof patch.detail === 'string') p.detail = clip(patch.detail, 800);
    if (patch && typeof patch.title === 'string' && clip(patch.title, 160)) p.title = clip(patch.title, 160);
    if (patch && typeof patch.ref === 'string') p.ref = clip(patch.ref, 120);
    if (patch && 'deviceId' in patch) p.deviceId = patch.deviceId ? clip(patch.deviceId, 40) : null;
    fs.appendFileSync(tasksFile, JSON.stringify({ type: 'update', id, patch: p }) + '\n');
    return { ok: true };
  }
  // The dispatcher's own writes (assignment, results, retries) - not reachable from the web routes.
  function patchTask(id, patch) {
    if (!foldAll().has(id)) return false;
    const p = { ...patch };
    if (p.result && typeof p.result === 'object') p.result = { text: clip(p.result.text, 6000), tokens: Number(p.result.tokens) || 0, deviceId: clip(p.result.deviceId, 40), ms: Number(p.result.ms) || 0 };
    if (typeof p.detail === 'string') p.detail = clip(p.detail, 800);
    if (typeof p.error === 'string') p.error = clip(p.error, 300);
    fs.appendFileSync(tasksFile, JSON.stringify({ type: 'update', id, patch: p }) + '\n');
    return true;
  }
  const getTask = (id) => { const t = foldAll().get(id); return t ? view(t) : null; };
  // Explicit tasks created at or after sinceMs that match pred (routines use it to avoid repeating themselves). Views keep the proposal, never the job.
  const recent = (sinceMs, pred) => [...foldAll().values()].filter((t) => t.ts >= sinceMs && (!pred || pred(t))).map(view);
  const getRaw = (id) => foldAll().get(id) || null;
  // Local-lane tasks that still need to run (any day), oldest first within priority.
  const openJobs = () => [...foldAll().values()].filter((t) => t.job && (t.status === 'queued' || t.status === 'running')).sort((a, b) => (b.priority || 0) - (a.priority || 0) || a.ts - b.ts);
  const proposals = () => [...foldAll().values()].filter((t) => t.status === 'proposed').sort((a, b) => b.ts - a.ts).map(view);

  // ── EOD ──
  function submitEod({ date, tz = DEFAULT_TZ, note }) {
    const d = day(date, tz);
    if (!d) return { ok: false, error: 'date must be YYYY-MM-DD' };
    const report = { id: 'eod_' + crypto.randomBytes(6).toString('hex'), date, tz, submittedAt: new Date(now()).toISOString(), note: clip(note, 1000), counts: d.counts, tasks: d.tasks };
    fs.appendFileSync(eodFile, JSON.stringify(report) + '\n');
    return { ok: true, report: { ...report, tasks: undefined, taskCount: report.tasks.length } };
  }
  function eodByDate() { const m = new Map(); for (const r of readJsonl(eodFile)) m.set(r.date, r); return m; }
  const listEod = (limit = 14) => [...eodByDate().values()].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, Math.min(Math.max(+limit || 14, 1), 60)).map((r) => ({ id: r.id, date: r.date, submittedAt: r.submittedAt, note: r.note, counts: r.counts }));
  const getEod = (date) => eodByDate().get(date) || null;

  // Read-only access to the launcher's own logs, for the routines that summarise them.
  const readLog = (name) => (/^[\w.-]+\.jsonl$/.test(name) ? readJsonl(path.join(dir, name)) : []);
  return { day, createTask, updateTask, patchTask, getTask, recent, getRaw, openJobs, proposals, submitEod, listEod, getEod, readLog, getProspects, getBugs, today: (tz = DEFAULT_TZ) => todayFor(tz, now()) };
}

module.exports = { createTaskio, dayRange, todayFor, DEFAULT_TZ, LANES, STATUSES };
