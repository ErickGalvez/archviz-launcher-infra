'use strict';
// What each role actually DOES on its own: recurring routines that run in the nightly window.
//
// Two kinds:
//   AI routine       - gathers real data the launcher already holds, writes a prompt, and queues it for the local pool.
//                      The output is a DRAFT stored in Task-IO for the owner to read; nothing is sent, posted or contacted.
//   Proposal routine - for the cloud-lane roles (Dev, QA). Prepares a ready-to-send Dev Console brief and waits as
//                      "proposed" until the owner approves it in Task-IO. Nothing reaches GitHub without that click.
//
// Local routines only run for areas the policy keeps local, so a policy change can never quietly move a confidential
// role's data to the cloud. Inputs are clipped hard: the model is small and the context short.
const fs = require('fs');
const path = require('path');
const { inWindow, nightKey, DEFAULT_WINDOW } = require('./schedule');
const { laneFor, isConfidential } = require('./hub');

const DAY = 86400000;
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const iso = (ms) => new Date(ms).toISOString();

const RULES = 'Use only the data given below; if it is not enough, say so instead of guessing. Be concrete and brief. Plain text with short bullet lists. Never claim to have done anything: you only draft.';
const sys = (name, role, charge, extra) => ({ role: 'system', content: `You are ${name}, ${role} at G741 Studio, a small studio selling live, pixel-streamed real-estate walkthroughs to Mexico City pre-sale developers. ${charge} ${RULES}${extra ? ' ' + extra : ''}` });
const ADVISORY = 'This is advisory only: say plainly that it is not legal advice, give each point a confidence level (high/medium/low), and leave every decision to the owner and a licensed Mexican attorney.';

// ── data the routines read (all of it is already on the launcher host) ──
function gather(taskio, now, tz) {
  const prospects = () => taskio.getProspects() || [];
  return {
    prospects,
    pipeline() {
      const ps = prospects(), by = {};
      for (const p of ps) by[p.status || 'new'] = (by[p.status || 'new'] || 0) + 1;
      const stale = ps.filter((p) => p.status === 'contacted' && now() - Date.parse(p.updatedAt || 0) > 5 * DAY).slice(0, 8);
      const unscored = ps.filter((p) => p.fitScore == null && p.status !== 'lost').slice(0, 8);
      const line = (p) => `${clip(p.name, 40)}${p.location ? ' (' + clip(p.location, 30) + ')' : ''} [${p.status}${p.fitScore != null ? ', fit ' + p.fitScore : ''}]`;
      return { total: ps.length, by, stale: stale.map(line), unscored: unscored.map(line) };
    },
    bugs: () => (taskio.getBugs() || []).filter((b) => b.status !== 'resolved' && b.status !== 'closed'),
    lastAutotest() {
      const runs = taskio.readLog('autotest-runs.jsonl').sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
      const r = runs[0]; if (!r) return null;
      return { ts: r.ts, summary: r.summary || {}, notOk: (r.results || []).filter((x) => x.state && x.state !== 'ok').slice(0, 14).map((x) => `${clip(x.id, 40)} [${x.state}] ${clip(x.note, 90)}`) };
    },
    devLog: (sinceMs) => taskio.readLog('devconsole-log.jsonl').filter((e) => Date.parse(e.ts) >= sinceMs && (e.type === 'dispatch' || e.type === 'commit')).slice(-20)
      .map((e) => (e.type === 'dispatch' ? 'asked: ' + clip(e.title, 90) : 'merged PR #' + e.pr + (e.category ? ' (' + e.category + ')' : ''))),
    count: (file, sinceMs) => taskio.readLog(file).filter((e) => Date.parse(e.ts) >= sinceMs).length,
    leadFields() { const l = taskio.readLog('leads-log.jsonl').slice(-1)[0]; return l ? Object.keys(l).filter((k) => k !== 'ts') : []; },
    yesterday() { const d = new Date(now() + tz * 60000 - DAY).toISOString().slice(0, 10); return { date: d, day: taskio.day(d, tz) }; },
  };
}

// ── the roster of routines ──
const ROUTINES = [
  { id: 'nadia-pipeline', persona: 'Nadia', area: 'sales', role: 'Sales', title: 'Pipeline review', schedule: 'nightly', kind: 'ai',
    build(g) {
      const p = g.pipeline(); if (!p.total) return { skip: 'the sales database is empty' };
      return { maxTokens: 700, messages: [sys('Nadia', 'Sales', 'You keep the outreach pipeline moving from cold to booked call.'),
        { role: 'user', content: `Pipeline snapshot. Total ${p.total}. By status: ${Object.entries(p.by).map(([k, n]) => n + ' ' + k).join(', ')}.\nStale (contacted, no update for 5+ days): ${p.stale.join('; ') || 'none'}.\nNot scored yet: ${p.unscored.join('; ') || 'none'}.\n\nPick the 5 prospects most worth following up tomorrow. For each: one line on why, and a first message in Spanish (Mexico), two sentences, no promises about price or dates. Drafts only - nobody is contacted automatically.` }] };
    } },
  { id: 'talia-ideas', persona: 'Talia', area: 'marketing', role: 'Marketing', title: 'Campaign ideas', schedule: 'weekly', kind: 'ai',
    build(g, now) {
      const p = g.pipeline(), wk = now() - 7 * DAY;
      return { maxTokens: 650, messages: [sys('Talia', 'Marketing', 'You run positioning and the "before it\'s built" story.'),
        { role: 'user', content: `Goal: land the first paying ArchViz pilot with a CDMX pre-sale developer. This week: ${g.count('leads-log.jsonl', wk)} session requests and ${g.count('inquiries-log.jsonl', wk)} hero inquiries came in. Pipeline: ${p.total} prospects (${Object.entries(p.by).map(([k, n]) => n + ' ' + k).join(', ') || 'empty'}).\n\nGive 3 ideas for reaching developers this week. For each: the hook (one sentence), the channel, and the call to action. Drafts for the owner to pick from.` }] };
    } },
  { id: 'ward-digest', persona: 'Ward', area: 'security', role: 'Cybersecurity', title: 'Security digest', schedule: 'nightly', kind: 'ai',
    build(g, now) {
      const a = g.lastAutotest(), log = g.devLog(now() - DAY);
      if (!a && !log.length) return { skip: 'no test run and no changes to look at' };
      return { maxTokens: 650, messages: [sys('Ward', 'Cybersecurity', 'You audit auth gates, key handling, CORS and anything exposed through the Cloudflare tunnel.', 'Never ask for or repeat any key or secret.'),
        { role: 'user', content: `Last automated run (${a ? a.ts : 'none'}): ${a ? JSON.stringify(a.summary) : 'n/a'}.\nChecks not OK: ${a && a.notOk.length ? a.notOk.join(' | ') : 'none'}.\nChanges in the last 24 h: ${log.join('; ') || 'none'}.\n\nRank what deserves a closer security look tomorrow and say why, in 5 bullets at most. Flag anything touching auth gates, keys, CORS or tunnel exposure. If nothing looks suspicious, say that.` }] };
    } },
  { id: 'morgan-brief', persona: 'Morgan', area: 'management', role: 'General Manager', title: 'Daily brief', schedule: 'nightly', kind: 'ai',
    build(g) {
      const y = g.yesterday(), tasks = (y.day && y.day.tasks) || [];
      if (!tasks.length) return { skip: 'nothing was recorded yesterday' };
      const lines = tasks.slice(0, 40).map((t) => `${t.persona}: ${clip(t.title, 90)} [${t.status}]`).join('\n');
      return { maxTokens: 450, messages: [sys('Morgan', 'General Manager', 'You keep the roadmap honest: sequencing, scope cuts, what actually ships.'),
        { role: 'user', content: `Tasks recorded on ${y.date}:\n${lines}\n\nWrite the end-of-day brief in under 120 words: what got done, what is stuck or failed, and the 3 priorities for today. This is a draft for the owner's EOD.` }] };
    } },
  { id: 'orion-questions', persona: 'Orion', area: 'strategy', role: 'Entrepreneur / Vision', title: 'Strategy questions', schedule: 'weekly', kind: 'ai',
    build(g, now) {
      const p = g.pipeline(), wk = now() - 7 * DAY;
      return { maxTokens: 500, messages: [sys('Orion', 'Entrepreneur / Vision', 'You hold the bigger bet and keep asking whether this makes money.'),
        { role: 'user', content: `Goal: first paying ArchViz pilot. Funnel: ${p.total} prospects (${Object.entries(p.by).map(([k, n]) => n + ' ' + k).join(', ') || 'empty'}). Last 7 days: ${g.count('leads-log.jsonl', wk)} session requests, ${g.count('inquiries-log.jsonl', wk)} inquiries, ${g.count('session-log.jsonl', wk)} sessions streamed.\n\nAsk the 3 hardest questions the owner should answer this week about whether this is heading to a paying pilot, and name the one metric to watch. Short.` }] };
    } },
  { id: 'ximena-checklist', persona: 'Ximena', area: 'compliance', role: 'Mexico Compliance', title: 'Compliance checklist', schedule: 'weekly', kind: 'ai', advisory: true,
    build(g) {
      const f = g.leadFields();
      return { maxTokens: 800, messages: [sys('Ximena', 'Mexico Compliance', 'You watch the Mexican business-law side of the product.', ADVISORY),
        { role: 'user', content: `Facts: the public site collects visitor details through a session-request form (fields stored per request: ${f.length ? f.join(', ') : 'name, email, company, message, device'}), optionally via Google sign-in; it runs a Meta (Facebook) Pixel; a live 3D walkthrough is streamed from a host in Mexico City; the offer is pre-sale (preventa) real-estate marketing; payments do not exist yet.\n\nList up to 6 questions to confirm with a Mexican attorney, covering the aviso de privacidad vs. the fields above, consent for the Pixel, how ARCO rights requests would be handled, retention, and the wording of preventa claims. For each: why it matters and a confidence level.` }] };
    } },
  { id: 'justine-policy-watch', persona: 'Justine', area: 'legal', role: 'Legal (Policies)', title: 'Policy watch', schedule: 'weekly', kind: 'ai', advisory: true,
    build(g, now) {
      const log = g.devLog(now() - 7 * DAY);
      if (!log.length) return { skip: 'no site changes this week' };
      return { maxTokens: 600, messages: [sys('Justine', 'Legal (Policies)', 'You keep the privacy policy, cookie consent and pricing disclaimers honest and current.', ADVISORY),
        { role: 'user', content: `Site changes this week (titles only): ${log.join('; ')}.\n\nWhich of these could plausibly touch forms or data collection, consent or cookies, pricing text, or terms - and so deserve a policy review? List only those, with a one-line reason each. If none, say none.` }] };
    } },
  // ── cloud lane: prepared for approval, never sent by itself ──
  { id: 'priya-bug-tests', persona: 'Priya', area: 'qa', role: 'Testing (QA)', title: 'Regression tests for open bugs', schedule: 'nightly', kind: 'proposal',
    build(g) {
      const bugs = g.bugs(); if (!bugs.length) return { skip: 'no open bugs' };
      const list = bugs.slice(0, 8).map((b) => `- [${b.priority || 'medium'}] ${clip(b.title, 100)}${b.component ? ' (' + clip(b.component, 30) + ')' : ''}`).join('\n');
      return { proposal: { repo: 'website', category: 'functional', summary: 'Add QA test cases for the open bugs',
        transcript: `QA request from Priya: these bugs are open in the QA console's bug tracker:\n${list}\n\nFor each one, add a regression test case to the QA test library (qa/testdata.js) in the existing format: preconditions, steps and the expected result that would have caught it. Do not change any application code in this change.` } };
    } },
  { id: 'dex-site-backlog', persona: 'Dex', area: 'dev', role: 'Developer', title: 'Website backlog', schedule: 'weekly', kind: 'proposal',
    build(g) {
      const bugs = g.bugs().filter((b) => /site|web|ui|dashboard|console|hub|page/i.test((b.component || '') + ' ' + (b.title || '')));
      if (!bugs.length) return { skip: 'no open bug that belongs to the website repo' };
      const list = bugs.slice(0, 6).map((b) => `- [${b.priority || 'medium'}] ${clip(b.title, 100)}${b.description ? ': ' + clip(b.description, 160) : ''}`).join('\n');
      return { proposal: { repo: 'website', category: 'functional', summary: 'Fix the open website bugs',
        transcript: `Dev request from Dex: these open bugs look like they live in the website repo:\n${list}\n\nInvestigate each, fix the ones you can with minimal changes, and say clearly which you could not reproduce. Open the change as a pull request; do not merge.` } };
    } },
  // ── Vera (verification): she does the work herself, with the local model, and records it on the tickets ──
  { id: 'vera-verify', persona: 'Vera', area: 'verify', role: 'Verification', title: 'Verify the fixed tickets', schedule: 'nightly', kind: 'action',
    act({ verifier }) {
      const r = verifier.sweep({ limit: 8 });
      return r.considered ? { summary: `${r.considered} fixed ticket(s) waiting: ${r.recorded} settled by the static checks, ${r.queued} sent to the model, ${r.skipped} already in progress` } : { skipped: 'no fixed ticket is waiting for a verdict' };
    } },
  { id: 'vera-regression', persona: 'Vera', area: 'verify', role: 'Verification', title: 'Pick a small regression run', schedule: 'weekly', kind: 'action',
    act({ verifier, manual }) {
      const r = verifier.suggestRegression({ force: !!manual });         // sporadic on purpose: the owner pressing "run now" always gets one
      return r.suggestion ? { summary: `suggested ${r.suggestion.cluster.id}: ${r.suggestion.caseIds.length} cases (${r.suggestion.name})` } : { skipped: r.skipped };
    } },
];

// idle() says whether a PC could take scheduled work right now outside the night window (the hub's idleEnough on any device).
function createRoutines({ taskio, dir, policy, window = DEFAULT_WINDOW, now = Date.now, kick = () => {}, log = () => {}, tz = -360, verifier = null, idle = () => false }) {
  const stateFile = path.join(dir, 'routines-state.json');
  const load = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (e) { return {}; } };
  const save = (st) => { try { fs.writeFileSync(stateFile, JSON.stringify(st, null, 2)); } catch (e) { log('could not save routine state: ' + e.message); } };
  const g = gather(taskio, now, tz);
  const laneOf = (r) => laneFor(policy, r.area, false);

  function list() {
    const st = load();
    return ROUTINES.map((r) => ({ id: r.id, persona: r.persona, area: r.area, title: r.title, schedule: r.schedule, kind: r.kind, lane: laneOf(r), advisory: !!r.advisory, confidential: isConfidential(policy, r.area, false),
      enabled: !(st[r.id] && st[r.id].enabled === false), lastRunAt: (st[r.id] || {}).lastRunAt || null, lastResult: (st[r.id] || {}).lastResult || null, lastTaskId: (st[r.id] || {}).lastTaskId || null }));
  }

  // Runs one routine now (scheduled or by the owner). Returns { ok, taskId } or { ok:false, skipped | error }.
  function run(id, { manual = false } = {}) {
    const r = ROUTINES.find((x) => x.id === id);
    if (!r) return { ok: false, error: 'unknown routine' };
    const st = load(); st[id] = st[id] || {};
    const t = now(), label = new Date(t + tz * 60000).toISOString().slice(0, 10);
    const done = (patch) => { Object.assign(st[id], { lastRunAt: t, lastNightKey: nightKey(t, window) }, patch); save(st); };
    const lane = laneOf(r);
    if (r.kind === 'ai' && lane !== 'local') { done({ lastResult: 'blocked: policy keeps ' + r.area + ' off the local pool' }); return { ok: false, error: 'policy: ' + r.area + ' is not a local-lane area' }; }
    if (r.kind === 'action' && lane !== 'local') { done({ lastResult: 'blocked: policy keeps ' + r.area + ' off the local pool' }); return { ok: false, error: 'policy: ' + r.area + ' is not a local-lane area' }; }
    // An action routine does its work itself (Vera checking tickets or picking a regression run) and reports a one-line result.
    if (r.kind === 'action') {
      if (!verifier) { done({ lastResult: 'skipped: no verifier' }); return { ok: true, skipped: 'no verifier' }; }
      let res; try { res = r.act({ verifier, manual }); } catch (e) { done({ lastResult: 'error: ' + e.message }); return { ok: false, error: e.message }; }
      if (res.skipped) { done({ lastResult: 'skipped: ' + res.skipped }); return { ok: true, skipped: res.skipped }; }
      done({ lastResult: res.summary || 'done' });
      return { ok: true, summary: res.summary };
    }
    if (r.kind === 'proposal' && lane !== 'cloud') { done({ lastResult: 'blocked: policy keeps ' + r.area + ' local' }); return { ok: false, error: 'policy: ' + r.area + ' is not a cloud-lane area' }; }
    let out; try { out = r.build(g, now); } catch (e) { done({ lastResult: 'error: ' + e.message }); return { ok: false, error: e.message }; }
    if (out.skip) { done({ lastResult: 'skipped: ' + out.skip }); return { ok: true, skipped: out.skip }; }
    // Don't repeat yourself. A brief the owner has not answered, or dismissed, is not proposed again for two weeks; an AI draft that never got
    // to run (no PC was free) is replaced by tonight's fresher one instead of piling up behind it.
    if (out.proposal) {
      const dup = taskio.recent(t - 14 * DAY, (x) => x.routineId === r.id && x.proposal && x.proposal.transcript === out.proposal.transcript)[0];
      if (dup) { done({ lastResult: 'skipped: the same brief is already ' + dup.status, lastTaskId: dup.id }); return { ok: true, skipped: 'the same brief is already ' + dup.status }; }
    } else {
      // Only scheduled drafts are replaced: one the owner asked for with "run now" (priority > 0) stays in the queue until it has run.
      for (const old of taskio.recent(0, (x) => x.routineId === r.id && x.status === 'queued' && !(x.priority > 0))) taskio.patchTask(old.id, { status: 'dismissed', detail: 'Replaced by a fresher run of the same routine.' });
    }
    const base = { title: r.title + ' - ' + label, persona: r.persona, area: r.area, source: 'routine', routineId: r.id, advisory: !!r.advisory, priority: manual ? 3 : 0 };
    const created = out.proposal
      ? taskio.createTask({ ...base, lane: 'cloud', status: 'proposed', detail: 'Prepared for your approval - nothing is sent until you approve it.', proposal: out.proposal })
      : taskio.createTask({ ...base, lane: 'local', job: { messages: out.messages, maxTokens: out.maxTokens, role: r.persona, area: r.area, confidential: isConfidential(policy, r.area, false) }, detail: 'Waiting for a PC.' });
    if (!created.ok) { done({ lastResult: 'error: ' + created.error }); return { ok: false, error: created.error }; }
    done({ lastResult: out.proposal ? 'proposed' : 'queued', lastTaskId: created.task.id });
    kick();
    return { ok: true, taskId: created.task.id };
  }

  function setEnabled(id, enabled) {
    if (!ROUTINES.some((x) => x.id === id)) return { ok: false, error: 'unknown routine' };
    const st = load(); st[id] = st[id] || {}; st[id].enabled = !!enabled; save(st);
    return { ok: true, enabled: !!enabled };
  }

  // Called every minute: starts whatever is due, at most once per night (weekly ones at most once in ~a week).
  // Inside the night window it always does; outside it, only while some PC is idle, so the nightlies catch up in the daytime without ever competing with a render.
  function tick() {
    const t = now();
    if (!inWindow(t, window) && !idle()) return [];
    const st = load(), started = [];
    for (const r of ROUTINES) {
      const s = st[r.id] || {};
      if (s.enabled === false || s.lastNightKey === nightKey(t, window)) continue;
      if (r.schedule === 'weekly' && s.lastRunAt && t - s.lastRunAt < 6.5 * DAY) continue;
      const res = run(r.id);
      started.push({ id: r.id, ...res });
    }
    return started;
  }
  return { list, run, tick, setEnabled, definitions: ROUTINES };
}

module.exports = { createRoutines, ROUTINES };
