'use strict';
// The ticket model behind the QA console's Bugs tab (the "JIRA-lite" error database), as plain functions with no HTTP and no files, so
// qa-tickets.test.js can pin every rule and launcher-server.js only wires the routes.
//
// A ticket is the original bug record (title, description, component, priority, status, reportedBy) plus what a tracker needs to be
// worked from a list: a TYPE (bug | request | observation | regression), the team AREA that should fix it, an assignee, the SOURCE it came
// from (a test run + case), and a THREAD of comments. Three kinds of entry in the thread matter:
//   - a FIX NOTE: what the fixer wrote down when the work was done (root cause, how it was solved, the commit, a snippet of the change, the
//     context around it, dev notes). Recording one moves the ticket to "fixed" and bumps `fixRev`.
//   - a VERIFICATION: the verifier's verdict on one fix revision (verified | failed | unsure) with the checks behind it. A failed
//     verification reopens the ticket; the same verifier is never asked to verify the same revision twice.
//   - plain comments and system "activity" lines (status / priority / assignee changes).
//
// Old tickets (created before any of this) are normalised on load: every new field has a harmless default, so nothing has to be migrated.
const crypto = require('crypto');

const STATUSES = ['open', 'in_progress', 'fixed', 'wontfix'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const TYPES = ['bug', 'request', 'observation', 'regression'];
// The team areas a ticket can be routed to (the owner decides anything outside the product: pricing, legal wording, strategy).
const AREAS = ['dev', 'qa', 'design', 'copy', 'marketing', 'sales', 'security', 'management', 'legal', 'compliance', 'owner'];
const VERDICTS = ['verified', 'failed', 'unsure'];
// Where a fix lives. Only repos with a remote get a commit link; the link is built here from the sha and never taken from the request,
// so a fix note cannot point a reader at an arbitrary address.
const REPOS = { website: 'ErickGalvez/ARCHVIZ', launcher: 'ErickGalvez/archviz-launcher-infra', app: null, other: null };
const MAX_COMMENTS = 300;
const STATUS_LABEL = { open: 'Open', in_progress: 'In Progress', fixed: 'Fixed', wontfix: "Won't Fix" };

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
// Multi-line prose: keep newlines and tabs, drop the other control characters.
const clipText = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').trim().slice(0, n);
// Code: keep the indentation of the first line, drop leading blank lines and trailing space.
const clipCode = (s, n) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/^\n+/, '').replace(/\s+$/, '').slice(0, n);
const isoNow = (now) => new Date(now == null ? Date.now() : now).toISOString();
const newId = (prefix) => prefix + crypto.randomBytes(6).toString('hex');

function cleanSource(s) {
  if (!s || typeof s !== 'object') return null;
  const out = { run: clip(s.run, 80), caseId: clip(s.caseId, 24), result: clip(s.result, 20), kind: clip(s.kind, 30) };
  return out.run || out.caseId ? out : null;
}

// Old tickets get the new fields' defaults. Pure: returns a new object.
function normalize(b) {
  const o = { ...(b || {}) };
  o.type = TYPES.includes(o.type) ? o.type : 'bug';
  o.area = AREAS.includes(o.area) ? o.area : '';
  o.assignee = clip(o.assignee, 40);
  o.source = cleanSource(o.source);
  o.comments = Array.isArray(o.comments) ? o.comments : [];
  o.fixRev = Number.isInteger(o.fixRev) && o.fixRev > 0 ? o.fixRev : 0;
  o.fix = o.fix && typeof o.fix === 'object' ? o.fix : null;
  o.verification = o.verification && typeof o.verification === 'object' ? o.verification : null;
  return o;
}

function create(input, { now, id } = {}) {
  const i = input || {};
  const title = clip(i.title, 200);
  if (!title) throw new Error('title is required');
  const t = isoNow(now);
  return normalize({
    id: id || newId('bug_'),
    title,
    description: clipText(i.description, 6000),
    component: clip(i.component, 80),
    priority: PRIORITIES.includes(i.priority) ? i.priority : 'medium',
    status: 'open',                               // a new ticket always opens "open", whatever the request says
    reportedBy: clip(i.reportedBy, 80),
    type: i.type, area: i.area, assignee: i.assignee, source: i.source,
    createdAt: t, updatedAt: t,
  });
}

function activity(bug, by, text, now) {
  bug.comments.push({ id: newId('c_'), at: isoNow(now), by: clip(by, 40) || 'QA console', role: '', kind: 'activity', text: clip(text, 300) });
  if (bug.comments.length > MAX_COMMENTS) bug.comments.splice(0, bug.comments.length - MAX_COMMENTS);
}

// The edit route. Only these fields change; a value outside its list is ignored rather than stored. Changes to status, priority,
// assignee, area and type leave a line in the thread. Returns the changed field names.
function patch(bug, p, { now, by } = {}) {
  const changed = [], src = p || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(src, k);
  const set = (k, v) => { if (bug[k] !== v) { const before = bug[k]; bug[k] = v; changed.push(k); return before; } return undefined; };
  if (has('title') && clip(src.title, 200)) set('title', clip(src.title, 200));
  if (has('description')) set('description', clipText(src.description, 6000));
  if (has('component')) set('component', clip(src.component, 80));
  if (has('reportedBy')) set('reportedBy', clip(src.reportedBy, 80));
  const line = [];
  if (has('priority') && PRIORITIES.includes(src.priority)) { const b = set('priority', src.priority); if (b !== undefined) line.push('Priority: ' + b + ' -> ' + src.priority); }
  if (has('status') && STATUSES.includes(src.status)) { const b = set('status', src.status); if (b !== undefined) line.push('Status: ' + (STATUS_LABEL[b] || b) + ' -> ' + STATUS_LABEL[src.status]); }
  if (has('type') && TYPES.includes(src.type)) { const b = set('type', src.type); if (b !== undefined) line.push('Type: ' + b + ' -> ' + src.type); }
  if (has('area') && (AREAS.includes(src.area) || src.area === '')) { const b = set('area', src.area); if (b !== undefined) line.push('Area: ' + (b || 'none') + ' -> ' + (src.area || 'none')); }
  if (has('assignee')) { const a = clip(src.assignee, 40), b = set('assignee', a); if (b !== undefined) line.push('Assignee: ' + (b || 'nobody') + ' -> ' + (a || 'nobody')); }
  if (line.length) activity(bug, by, line.join('; '), now);
  bug.updatedAt = isoNow(now);
  return changed;
}

function addComment(bug, input, { now } = {}) {
  const text = clipText(input && input.text, 4000);
  if (!text) throw new Error('text is required');
  const c = { id: newId('c_'), at: isoNow(now), by: clip(input.by, 40) || 'QA console', role: clip(input.role, 40), kind: 'comment', text };
  bug.comments.push(c);
  if (bug.comments.length > MAX_COMMENTS) bug.comments.splice(0, bug.comments.length - MAX_COMMENTS);
  bug.updatedAt = c.at;
  return c;
}

const SHA = /^[0-9a-f]{7,40}$/i;
function commitUrl(repo, sha) { return REPOS[repo] && SHA.test(sha || '') ? 'https://github.com/' + REPOS[repo] + '/commit/' + sha.toLowerCase() : null; }

function cleanSnippet(s) {
  if (!s || typeof s !== 'object') return null;
  const after = clipCode(s.after, 4000), before = clipCode(s.before, 4000);
  if (!after && !before) return null;
  return { file: clip(s.file, 200), lang: clip(s.lang, 20).toLowerCase(), before, after };
}

// The fix note. The fixer must say what the root cause was and how it was solved; a code change must name its commit. Everything is
// clipped, and the commit link is derived (see REPOS). Moves the ticket to fixed (or keeps it in progress for a partial fix).
function addFix(bug, input, { now } = {}) {
  const i = input || {};
  const repo = Object.prototype.hasOwnProperty.call(REPOS, i.repo) ? i.repo : 'other';
  const rootCause = clipText(i.rootCause, 2000), solution = clipText(i.solution, 2000);
  if (!rootCause) throw new Error('rootCause is required: say why it happened');
  if (!solution) throw new Error('solution is required: say how it was solved');
  const commit = clip(i.commit, 40);
  if (commit && !SHA.test(commit)) throw new Error('commit must be a git sha (7-40 hex characters)');
  if (!commit && (repo === 'website' || repo === 'launcher')) throw new Error('commit is required for a change in the ' + repo + ' repo');
  const files = (Array.isArray(i.files) ? i.files : []).map((f) => clip(f, 200)).filter(Boolean).slice(0, 20);
  const snippet = cleanSnippet(i.snippet);
  const rev = bug.fixRev + 1, at = isoNow(now);
  const fix = { rev, repo, commit: commit.toLowerCase(), commitUrl: commitUrl(repo, commit), branch: clip(i.branch, 80), files, rootCause, solution, context: clipText(i.context, 1500), notes: clipText(i.notes, 2000), snippet, viaMerge: i.viaMerge === true, by: clip(i.by, 40) || 'Dev', role: clip(i.role, 40), at };
  const c = { id: newId('c_'), at, by: fix.by, role: fix.role, kind: 'fix', text: solution.slice(0, 300), fix };
  bug.comments.push(c);
  if (bug.comments.length > MAX_COMMENTS) bug.comments.splice(0, bug.comments.length - MAX_COMMENTS);
  bug.fix = fix; bug.fixRev = rev;
  if (i.partial) { if (bug.status === 'open') { bug.status = 'in_progress'; } } else bug.status = 'fixed';
  bug.updatedAt = at;
  return c;
}

function cleanChecks(list) {
  return (Array.isArray(list) ? list : []).slice(0, 20).map((c) => ({ name: clip(c && c.name, 80), ok: c && c.ok === true ? true : c && c.ok === null ? null : false, detail: clip(c && c.detail, 300) })).filter((c) => c.name);
}

// A verifier's verdict on ONE fix revision. A verdict for an older revision is refused (the ticket was fixed again meanwhile). "failed"
// reopens the ticket so it lands back in the fix queue; "verified" and "unsure" leave it fixed.
function addVerification(bug, input, { now } = {}) {
  const i = input || {};
  if (!VERDICTS.includes(i.result)) throw new Error('result must be verified, failed or unsure');
  if (!bug.fixRev) throw new Error('this ticket has no fix note to verify');
  if (Number(i.fixRev) !== bug.fixRev) throw new Error('stale: the ticket is at fix revision ' + bug.fixRev);
  const at = isoNow(now), by = clip(i.by, 40) || 'Verifier';
  const v = { fixRev: bug.fixRev, result: i.result, by, role: clip(i.role, 40), method: clip(i.method, 40), summary: clipText(i.summary, 1500), checks: cleanChecks(i.checks), at };
  const c = { id: newId('c_'), at, by, role: v.role, kind: 'verification', text: v.summary.slice(0, 300), verification: v };
  bug.comments.push(c);
  if (bug.comments.length > MAX_COMMENTS) bug.comments.splice(0, bug.comments.length - MAX_COMMENTS);
  bug.verification = v;
  if (v.result === 'failed') bug.status = 'open';
  else if (v.result === 'verified' && bug.status === 'open') bug.status = 'fixed';      // a reopened ticket whose fix is now confirmed is fixed again
  bug.updatedAt = at;
  return c;
}

// Where the ticket stands in the fix queue (the QA console draws its filter chips from this, and so does the verifier):
//   open | in_progress   still to be fixed          awaiting   fixed, nobody has verified this revision yet
//   verified | unsure    a verdict on this revision  reopened   a verification of this revision failed
//   fixed_unnoted        moved to fixed by hand, no fix note to check          closed   won't fix
function queueState(b) {
  if (!b) return 'open';
  if (b.status === 'wontfix') return 'closed';
  const v = b.verification, current = v && v.fixRev === b.fixRev && b.fixRev > 0;
  if (b.status === 'fixed') {
    if (!b.fixRev) return 'fixed_unnoted';
    if (!current) return 'awaiting';
    return v.result === 'verified' ? 'verified' : v.result === 'unsure' ? 'unsure' : 'reopened';
  }
  if (b.status === 'open' && current && v.result === 'failed') return 'reopened';
  return b.status === 'in_progress' ? 'in_progress' : 'open';
}

// Does this verifier still owe this ticket a verification? Fixed with a fix note, and nothing recorded by THIS verifier for THIS revision
// (whatever the verdict was: a verified fix is never re-verified, and an "unsure" one waits for a human instead of looping every night).
// Someone can ask for a fresh look at the SAME revision (requestRecheck): that is the one way a verdict is given twice, and it is a person's decision.
// A reopened ticket is only looked at again when that happens.
function needsVerification(b, by) {
  if (!b || !(b.fixRev > 0) || (b.status !== 'fixed' && b.status !== 'open')) return false;
  let lastVerdict = -1, lastAsk = -1;
  (b.comments || []).forEach((c, i) => {
    if (c.kind === 'verification' && c.verification && c.verification.by === by && c.verification.fixRev === b.fixRev) lastVerdict = i;
    if (c.kind === 'recheck' && c.fixRev === b.fixRev) lastAsk = i;
  });
  const asked = lastAsk > lastVerdict;
  return b.status === 'open' ? asked : (lastVerdict < 0 || asked);
}

// "Check again": for when the code has changed since the verdict (the checkout was behind, the fix was completed by hand). It asks the verifier, it does not
// decide anything itself.
function requestRecheck(bug, input, { now } = {}) {
  if (!(bug.fixRev > 0)) throw new Error('this ticket has no fix note to check');
  if (bug.status === 'wontfix') throw new Error("this ticket is marked won't fix");
  const by = clip(input && input.by, 40) || 'QA console', at = isoNow(now);
  const c = { id: newId('c_'), at, by, role: '', kind: 'recheck', fixRev: bug.fixRev, text: 'Asked for a new check of fix #' + bug.fixRev };
  bug.comments.push(c);
  if (bug.comments.length > MAX_COMMENTS) bug.comments.splice(0, bug.comments.length - MAX_COMMENTS);
  bug.updatedAt = at;
  return c;
}

// What leaves the building without the QA key: the ticket as before plus the new routing fields and counts. No thread, and no code
// snippet or root cause (a fix note describes how the system works inside).
function publicView(b) {
  const n = normalize(b), { comments, fix, verification, ...rest } = n;
  return { ...rest, queue: queueState(n), commentCount: comments.length,
    fix: fix ? { rev: fix.rev, repo: fix.repo, commit: fix.commit, commitUrl: fix.commitUrl, by: fix.by, at: fix.at } : null,
    verification: verification ? { fixRev: verification.fixRev, result: verification.result, by: verification.by, at: verification.at } : null };
}
// With the QA key: everything, thread included.
function fullView(b) { const n = normalize(b); return { ...n, queue: queueState(n), commentCount: n.comments.length }; }

module.exports = { STATUSES, PRIORITIES, TYPES, AREAS, VERDICTS, REPOS, MAX_COMMENTS, normalize, create, patch, addComment, addFix, addVerification, requestRecheck, queueState, needsVerification, publicView, fullView, commitUrl, clip, clipText };
