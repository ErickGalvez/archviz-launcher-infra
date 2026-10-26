'use strict';
// Reports: a named set of tickets filed together (a test run's findings, a triage, an audit), plus a STAMP the owner puts on it.
// The Files room in the 3D office and the QA console both show them. A report holds ticket ids, not copies: what it displays is
// always the tickets as they are now, so "what changes were made" is just the tickets' fix notes, read live.
//
// The stamp is the one thing a report DOES to its tickets:
//   new      nobody has started on it - nothing moves
//   working  the work has begun - every ticket still "open" goes to "in progress"
//   closed   the work is done - tickets still open or in progress are marked fixed (by hand, which the board shows as "fixed, no fix note"),
//            unless a verifier has failed one of them: closing then needs force, so a failed verdict is never overruled by accident.
// Going back to "working" from "closed" re-opens only the tickets that were closed by hand (fixed without a fix note); a fix with a note is
// real work and stays fixed. The module is plain functions with no HTTP and no files, like tickets.js.
const crypto = require('crypto');

const STAMPS = ['new', 'working', 'closed'];
const KINDS = ['test-run', 'triage', 'audit', 'other'];
const MAX_TICKETS = 300, MAX_HISTORY = 50;
const STAMP_LABEL = { new: 'New', working: 'Working', closed: 'Closed' };

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
const clipText = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n);
const isoNow = (now) => new Date(now == null ? Date.now() : now).toISOString();
const newId = (prefix) => prefix + crypto.randomBytes(6).toString('hex');

function cleanIds(list) {
  const seen = new Set(), out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const id = clip(x, 40);
    if (id && !seen.has(id)) { seen.add(id); out.push(id); }
    if (out.length >= MAX_TICKETS) break;
  }
  return out;
}

function normalize(r) {
  const o = { ...(r || {}) };
  o.title = clip(o.title, 160) || 'Untitled report';
  o.kind = KINDS.includes(o.kind) ? o.kind : 'other';
  o.run = clip(o.run, 80);
  o.summary = clipText(o.summary, 8000);
  o.ticketIds = cleanIds(o.ticketIds);
  o.stamp = STAMPS.includes(o.stamp) ? o.stamp : 'new';
  o.stampedAt = o.stampedAt || null; o.stampedBy = clip(o.stampedBy, 40); o.stampNote = clipText(o.stampNote, 500);
  o.history = Array.isArray(o.history) ? o.history.slice(-MAX_HISTORY) : [];
  o.createdBy = clip(o.createdBy, 40);
  return o;
}

function create(input, { now, id } = {}) {
  const i = input || {};
  if (!clip(i.title, 160)) throw new Error('title is required');
  const t = isoNow(now);
  return normalize({ id: id || newId('rep_'), title: i.title, kind: i.kind, run: i.run, summary: i.summary, ticketIds: i.ticketIds, stamp: 'new', createdBy: i.createdBy || i.by, createdAt: t, updatedAt: t });
}

// Edit the text, add or remove tickets. Returns the names of the fields that changed.
function patch(report, p, { now } = {}) {
  const src = p || {}, has = (k) => Object.prototype.hasOwnProperty.call(src, k), changed = [];
  const set = (k, v) => { if (report[k] !== v) { report[k] = v; changed.push(k); } };
  if (has('title') && clip(src.title, 160)) set('title', clip(src.title, 160));
  if (has('run')) set('run', clip(src.run, 80));
  if (has('summary')) set('summary', clipText(src.summary, 8000));
  if (has('kind') && KINDS.includes(src.kind)) set('kind', src.kind);
  if (has('add') || has('remove')) {
    const drop = new Set(cleanIds(src.remove)), next = cleanIds([...report.ticketIds.filter((x) => !drop.has(x)), ...cleanIds(src.add)]);
    if (next.join() !== report.ticketIds.join()) { report.ticketIds = next; changed.push('ticketIds'); }
  }
  if (changed.length) report.updatedAt = isoNow(now);
  return changed;
}

const RESOLVED = (b) => b.status === 'fixed' || b.status === 'wontfix';
const UNRESOLVED_STATUS = (b) => b.status === 'open' || b.status === 'in_progress';

// How far along the report is, from the tickets as they are now. `ids` that no longer exist (a ticket deleted) are counted as `missing`.
function progress(report, byId, Tk) {
  const rows = report.ticketIds.map((id) => byId.get(id)).filter(Boolean);
  const byQueue = {}, byArea = {};
  for (const b of rows) {
    const q = Tk.queueState(b); byQueue[q] = (byQueue[q] || 0) + 1;
    const a = b.area || 'none'; byArea[a] = byArea[a] || { total: 0, resolved: 0 }; byArea[a].total++; if (RESOLVED(b)) byArea[a].resolved++;
  }
  const resolved = rows.filter(RESOLVED).length, verified = byQueue.verified || 0;
  return { total: rows.length, missing: report.ticketIds.length - rows.length, resolved, verified, unresolved: rows.length - resolved, reopened: byQueue.reopened || 0,
    handFixed: byQueue.fixed_unnoted || 0, byQueue, byArea, readyToClose: rows.length > 0 && resolved === rows.length };
}

// The one-line row of a ticket inside a report. `withNotes` (the keyed views) adds the fix note itself: how it was fixed, the commit, the files, the snippet.
function ticketRow(b, Tk, withNotes) {
  const row = { id: b.id, title: b.title, type: b.type, area: b.area, assignee: b.assignee, priority: b.priority, status: b.status, queue: Tk.queueState(b), component: b.component, source: b.source,
    fixRev: b.fixRev, commentCount: (b.comments || []).length, updatedAt: b.updatedAt,
    fix: b.fix ? { rev: b.fix.rev, repo: b.fix.repo, commit: b.fix.commit, commitUrl: b.fix.commitUrl, by: b.fix.by, at: b.fix.at, files: b.fix.files, viaMerge: !!b.fix.viaMerge } : null,
    verification: b.verification ? { fixRev: b.verification.fixRev, result: b.verification.result, by: b.verification.by, at: b.verification.at } : null };
  if (withNotes) {
    if (b.fix) row.fix = { ...row.fix, rootCause: b.fix.rootCause, solution: b.fix.solution, context: b.fix.context, notes: b.fix.notes, snippet: b.fix.snippet, branch: b.fix.branch };
    if (b.verification) row.verification = { ...row.verification, summary: b.verification.summary, method: b.verification.method, checks: b.verification.checks };
    row.description = b.description;
  }
  return row;
}

// The list entry (no tickets) and the full report with its tickets.
function summary(report, byId, Tk) {
  const { ticketIds, history, ...rest } = report;
  return { ...rest, ticketCount: ticketIds.length, progress: progress(report, byId, Tk), lastMove: history.length ? history[history.length - 1] : null };
}
function detail(report, byId, Tk) {
  return { ...summary(report, byId, Tk), history: report.history, tickets: report.ticketIds.map((id) => byId.get(id)).filter(Boolean).map((b) => ticketRow(b, Tk, true)) };
}

// Put a stamp on the report and move its tickets with it. `tickets` are the live ticket objects (they are changed in place; the caller saves).
// Returns { ok, moved:{ inProgress, fixed, reopened }, handFixed } or { ok:false, error, blocking } when closing would overrule a failed verification.
function stamp(report, to, { tickets = [], Tk, by, note, force = false, now } = {}) {
  if (!STAMPS.includes(to)) return { ok: false, error: 'stamp must be new, working or closed' };
  const who = clip(by, 40) || 'Owner', mine = report.ticketIds.map((id) => tickets.find((b) => b.id === id)).filter(Boolean);
  const moved = { inProgress: [], fixed: [], reopened: [] }, why = 'Report "' + clip(report.title, 60) + '" stamped ' + STAMP_LABEL[to];
  if (to === 'closed') {
    const blocking = mine.filter((b) => Tk.queueState(b) === 'reopened').map((b) => b.id);
    if (blocking.length && !force) return { ok: false, error: blocking.length + ' ticket(s) failed verification and are open again; closing the report would overrule that', blocking };
    for (const b of mine) if (UNRESOLVED_STATUS(b) && (!blocking.includes(b.id) || force)) { Tk.patch(b, { status: 'fixed' }, { by: who, now, note: why }); moved.fixed.push(b.id); }
  } else if (to === 'working') {
    for (const b of mine) {
      if (b.status === 'open') { Tk.patch(b, { status: 'in_progress' }, { by: who, now, note: why }); moved.inProgress.push(b.id); }
      else if (report.stamp === 'closed' && b.status === 'fixed' && !(b.fixRev > 0)) { Tk.patch(b, { status: 'in_progress' }, { by: who, now, note: why + ' (closed by hand before)' }); moved.reopened.push(b.id); }
    }
  }
  const at = isoNow(now);
  report.history.push({ at, by: who, from: report.stamp, to, note: clipText(note, 500), moved: { inProgress: moved.inProgress.length, fixed: moved.fixed.length, reopened: moved.reopened.length } });
  if (report.history.length > MAX_HISTORY) report.history.splice(0, report.history.length - MAX_HISTORY);
  report.stamp = to; report.stampedAt = at; report.stampedBy = who; report.stampNote = clipText(note, 500); report.updatedAt = at;
  return { ok: true, moved, handFixed: moved.fixed.filter((id) => { const b = mine.find((x) => x.id === id); return b && !(b.fixRev > 0); }) };
}

module.exports = { STAMPS, KINDS, MAX_TICKETS, normalize, create, patch, progress, summary, detail, ticketRow, stamp };
