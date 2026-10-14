'use strict';
// A ONE-OFF nightly for a single date, through the Claude / GitHub lane only (QA + Dev), logged for the 3D replay.
//
//   node bridge/nightly-once.js --date 2026-10-14
//
// What it does, using only what the studio already has:
//   00:05  Otto   runs the full automated checks (devconsole/smoke-test.js --record) -> autotest-runs.jsonl
//          Priya  sends a QA brief through the Dev Console (issue -> pull request): a regression test case for the open critical bug
//          Dex    sends a Dev brief through the Dev Console: the three CSS images that 404 in production
//   then   follows both issues until a pull request appears (every 10 min until 06:30) and records the links
//   06:35  Otto   runs the automated checks again
//   07:00  Morgan closes the night: an EOD snapshot is written to taskio-eod.jsonl
//
// Nothing here merges, sends or deploys anything: the pull requests wait for the owner. Everything is logged three ways: nightly-<date>.log,
// Task-IO (taskio-tasks.jsonl + the derived Dev Console / autotest entries) and the EOD snapshot, so the Virtual Team replay for <date> shows the night.
// Safe to re-run: dispatches are remembered in nightly-<date>.state.json and never repeated.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { createTaskio } = require('./taskio');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const DIR = path.resolve(arg('dir', path.join(__dirname, '..')));                        // the launcher folder (data files, key)
const SITE = path.resolve(arg('site', 'Y:\\ArchVizChallenge\\Local_Archviz_GITHUB\\ARCHVIZ'));   // the website checkout (devconsole/smoke-test.js)
const API = String(arg('api', 'http://127.0.0.1:3000')).replace(/\/$/, '');
const RECORD = arg('record', '');                                                          // test runs write to this file instead of the real history
const DATE = arg('date', '');
const FAST = !!process.env.NIGHTLY_FAST;                                                    // tests: no waiting
const TZ = -360;                                                                            // Mexico City
const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(DATE);
if (!m) { console.error('usage: node bridge/nightly-once.js --date YYYY-MM-DD'); process.exit(2); }
const dayStart = Date.UTC(+m[1], +m[2] - 1, +m[3]) - TZ * 60000;
const at = (h, mi = 0) => dayStart + (h * 60 + mi) * 60000;
const T = { open: at(0, 5), pollEnd: at(6, 30), closing: at(6, 35), eod: at(7, 0) };
const LOG = path.join(DIR, `nightly-${DATE}.log`), STATE = path.join(DIR, `nightly-${DATE}.state.json`);

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
const local = (ms) => new Date(ms + TZ * 60000).toISOString().replace('T', ' ').slice(0, 19);
const log = (s) => { const line = `[${local(Date.now())}] ${s}`; console.log(line); try { fs.appendFileSync(LOG, line + '\n'); } catch (e) { /* the console copy is enough */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = async (t) => { while (!FAST && Date.now() < t) await sleep(Math.min(30000, t - Date.now())); };
const state = readJson(STATE, { date: DATE, startedAt: null, checks: {}, qa: null, dev: null, tasks: {}, done: false });
const save = () => fs.writeFileSync(STATE, JSON.stringify(state, null, 2));

let KEY = '';
try { KEY = fs.readFileSync(path.join(DIR, 'devconsole.key'), 'utf8').trim(); } catch (e) { /* reported below */ }
const taskio = createTaskio({ dir: DIR, getProspects: () => (readJson(path.join(DIR, 'sales-data.json'), {}).prospects || []), getBugs: () => (readJson(path.join(DIR, 'qa-data.json'), {}).bugs || []) });

// ── the two briefs (same shape as the Priya / Dex routines in bridge/routines.js) ──
const BUG = (readJson(path.join(DIR, 'qa-data.json'), {}).bugs || []).find((b) => b.status === 'open' && /wilbur rtc never reconnects/i.test(b.title)) || null;
const QA_BRIEF = {
  repo: 'website', category: 'functional', summary: 'QA: regression test case for the Wilbur reconnect bug (nightly ' + DATE + ')',
  transcript: `QA request from Priya (the nightly run of ${DATE}). This bug is open in the QA console's bug tracker:\n\n- [critical] Wilbur RTC never reconnects after manual close (Pixel Streaming / Wilbur RTC)\n  Repro: start a session and let the stream connect, then close the Wilbur/UE5 process window by hand (not through the launcher UI), then open a new session. Before the fix the viewer stayed stuck with no stream and nothing self-healed. The launcher's periodic health check was fixed to also check the Cloudflare tunnel and fully reset the session state when it is unreachable, so the next visitor gets a clean launch within about one 8-second health tick. The fix needs the launcher restarted, then this manual repro to confirm it.\n\nAdd ONE regression test case for this bug to the QA test library (qa/testdata.js), in the existing format and in the style of the neighbouring cases: preconditions (a session running; the launcher restarted after the fix), numbered steps for the manual-close repro, and the expected result that would have caught the bug (the stream or lobby recovers within about one health tick instead of hanging, and a new session gets a clean launch). Do not change any application code and do not modify any other test case. Open the change as a pull request; do not merge it.`,
};
const DEV_BRIEF = {
  repo: 'website', category: 'cosmetic', summary: 'Fix 404s: three CSS images that do not exist (nightly ' + DATE + ')',
  transcript: `Dev request from Dex (the nightly run of ${DATE}). g741-styles.css references three background images that exist neither in the repository nor on the live site (all three return HTTP 404 from https://g-741studio.com today):\n\n- assets/hero-bg.jpg (the hero background, around line 109)\n- assets/coil-spheres.jpg (a card background, around line 183)\n- assets/coil-spheres-full.png (a section background, around line 201)\n\nEvery page that loads g741-styles.css makes three failing requests and logs 404 errors. Fix it with minimal changes: keep the gradient layers that are already part of those background declarations and drop only the url(...) layers that point at the missing files, so the pages look exactly as they do today (the images are not rendering anyway). Do not add, generate or invent image files. Check whether any other file (HTML, JS, other CSS) references these three paths and handle those the same way. In the pull request description list exactly which declarations changed and say that the original images can be restored later if they exist somewhere. Open the change as a pull request; do not merge it. Do not touch qa/testdata.js or anything under devconsole/.`,
};

// ── helpers ──
async function api(method, pathAndQuery, body) {
  const res = await fetch(API + pathAndQuery, { method, headers: { 'x-devconsole-key': KEY, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.ok === false) throw new Error((json && json.error) || 'HTTP ' + res.status);
  return json;
}
// The launcher logs every dispatch it makes; if a reply was lost after the issue was created, find it there instead of sending twice.
const loggedDispatch = (title, since) => { try { return fs.readFileSync(path.join(DIR, 'devconsole-log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).reverse().find((e) => e.type === 'dispatch' && e.title === title.slice(0, 120) && Date.parse(e.ts) >= since); } catch (e) { return null; } };
async function dispatch(brief) {
  // Already sent during this night (a restart or a reboot between the send and the state file being saved)? Reuse it, never send twice.
  const already = loggedDispatch(brief.summary, (Date.parse(state.startedAt) || Date.now()) - 1000);
  if (already) { log('found the dispatch already made for "' + brief.summary.slice(0, 50) + '": issue #' + already.issueNumber); return { issue: already.issueNumber, url: 'https://github.com/ErickGalvez/ARCHVIZ/issues/' + already.issueNumber }; }
  const since = Date.now() - 1000;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { const r = await api('POST', '/api/devconsole/dispatch', brief); return { issue: r.issueNumber, url: r.issueUrl }; }
    catch (e) {
      const found = loggedDispatch(brief.summary, since); if (found) return { issue: found.issueNumber, url: `https://github.com/${'ErickGalvez/ARCHVIZ'}/issues/${found.issueNumber}` };
      log(`dispatch attempt ${attempt} failed: ${e.message}`); if (attempt === 5) throw e; await sleep(FAST ? 50 : 60000);
    }
  }
}
function runChecks(job) {
  return new Promise((resolve) => {
    const recordFile = RECORD || path.join(DIR, 'autotest-runs.jsonl'), count = () => { try { return fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean).length; } catch (e) { return 0; } }, before = count();
    log(`Otto: running the automated checks (${job})...`);
    const child = cp.spawn(process.execPath, ['devconsole/smoke-test.js', '--record', ...(RECORD ? [RECORD] : []), '--job', job], { cwd: SITE, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { try { child.kill(); } catch (e) { /* already gone */ } }, 15 * 60000);
    child.on('close', () => {
      clearTimeout(timer);
      let rec = null; try { const lines = fs.readFileSync(recordFile, 'utf8').split('\n').filter(Boolean); if (lines.length > before) rec = JSON.parse(lines[lines.length - 1]); } catch (e) { /* no record */ }
      const s = rec && rec.summary; log(s ? `Otto: ${s.ok} ok / ${s.warn} degraded / ${s.down} down (${s.total} checks)` : 'Otto: the checks did not record a result');
      resolve(s ? { ok: s.ok, warn: s.warn, down: s.down, total: s.total } : null);
    });
    child.on('error', (e) => { clearTimeout(timer); log('Otto: could not start the checks: ' + e.message); resolve(null); });
  });
}
const note = (id, patch) => { try { taskio.patchTask(id, patch); } catch (e) { log('could not update a task: ' + e.message); } };
function makeTask(key, input) { if (state.tasks[key]) return state.tasks[key]; const r = taskio.createTask(input); if (r.ok) { state.tasks[key] = r.task.id; save(); return r.task.id; } log('could not record a task: ' + r.error); return null; }

async function follow(who, brief, rec, taskKey, label) {
  // one look at the issue: has a pull request appeared? did the agent ask something?
  try {
    const s = await api('GET', `/api/devconsole/status?repo=website&issue=${rec.issue}`);
    if (s.pr && !rec.pr) {
      rec.pr = { number: s.pr.number, url: s.pr.url, draft: !!s.pr.draft }; save();
      log(`${who}: pull request #${s.pr.number} opened for issue #${rec.issue}: ${s.pr.url}`);
      note(state.tasks[taskKey], { status: 'done', detail: `${label}: pull request #${s.pr.number} is open${s.pr.draft ? ' (draft)' : ''} and waits for your review. Nothing is merged. ${s.pr.url}`, ref: `website#${rec.issue} -> PR ${s.pr.number}` });
    } else if (s.question && !rec.question) { rec.question = String(s.question).slice(0, 300); save(); log(`${who}: the agent asked: ${rec.question}`); note(state.tasks[taskKey], { detail: `${label}: the agent asked a question on issue #${rec.issue}: ${rec.question}` }); }
  } catch (e) { log(`${who}: could not read issue #${rec.issue}: ${e.message}`); }
}

async function main() {
  if (!KEY) { log('No Dev Console key found next to the launcher (devconsole.key): nothing was sent.'); process.exit(3); }
  if (!FAST && Date.now() > T.eod + 15 * 60000) { log('The nightly window for ' + DATE + ' has already closed; nothing was run.'); return; }
  if (state.done) { log('This night was already closed (' + DATE + '). Nothing to do.'); return; }
  state.startedAt = state.startedAt || new Date().toISOString(); save();
  log(`NIGHTLY ${DATE} - QA + Dev through the Claude / GitHub lane. Launcher ${API}, data ${DIR}`);
  await sleepUntil(T.open);

  if (!state.checks.start) { state.checks.start = await runChecks('nightly-start'); save(); }

  if (!state.qa && !BUG) { state.qa = { skipped: true }; save(); log('Priya: the Wilbur bug is no longer open in the QA tracker, so there is nothing to brief.'); }
  if (!state.qa) {
    log('Priya: sending the QA brief through the Dev Console...');
    state.qa = await dispatch(QA_BRIEF); save();
    makeTask('qa', { title: 'QA brief: regression test case for the Wilbur reconnect bug', persona: 'Priya', area: 'qa', lane: 'cloud', status: 'running', source: 'routine', priority: 5, ref: 'website#' + state.qa.issue,
      detail: `Issue #${state.qa.issue} sent through the Dev Console (cloud lane): add one regression test case to qa/testdata.js for the open critical bug. No application code. ${state.qa.url}` });
    log(`Priya: issue #${state.qa.issue} ${state.qa.url}`);
  }
  if (!state.dev) {
    log('Dex: sending the Dev brief through the Dev Console...');
    state.dev = await dispatch(DEV_BRIEF); save();
    makeTask('dev', { title: 'Fix: three CSS images that 404 in production', persona: 'Dex', area: 'dev', lane: 'cloud', status: 'running', source: 'routine', priority: 5, ref: 'website#' + state.dev.issue,
      detail: `Issue #${state.dev.issue} sent through the Dev Console (cloud lane): remove the dead url() layers for assets/hero-bg.jpg, coil-spheres.jpg and coil-spheres-full.png from g741-styles.css. ${state.dev.url}` });
    log(`Dex: issue #${state.dev.issue} ${state.dev.url}`);
  }

  // follow the two issues until both have a pull request, or until 06:30
  let looks = 0;
  while (((!state.qa.skipped && !state.qa.pr) || !state.dev.pr) && (FAST ? looks < 4 : Date.now() < T.pollEnd)) {
    await sleep(FAST ? 100 : 10 * 60000); looks++;
    if (!state.qa.skipped && !state.qa.pr) await follow('Priya', QA_BRIEF, state.qa, 'qa', 'QA brief');
    if (!state.dev.pr) await follow('Dex', DEV_BRIEF, state.dev, 'dev', 'Dev brief');
  }

  await sleepUntil(T.closing);
  if (!state.checks.end) { state.checks.end = await runChecks('nightly-end'); save(); }

  await sleepUntil(T.eod);
  const c = (x) => (x ? `${x.ok} ok / ${x.warn} degraded / ${x.down} down` : 'no result');
  const line = (who, rec, what) => (rec.skipped ? `${who}: ${what} - not needed (the bug is no longer open)` : rec.pr ? `${who}: ${what} - issue #${rec.issue} -> PR #${rec.pr.number}${rec.pr.draft ? ' (draft)' : ''}` : `${who}: ${what} - issue #${rec.issue}, no pull request yet${rec.question ? ' (the agent asked a question)' : ''}`);
  const eodNote = [`Nightly ${DATE}: QA + Dev through the Claude / GitHub lane only. No local model ran and nothing was merged.`,
    `Otto: checks at the start ${c(state.checks.start)}; at the close ${c(state.checks.end)}.`,
    line('Priya', state.qa, 'regression test case for the Wilbur reconnect bug'), line('Dex', state.dev, 'dead CSS image references'),
    'Waiting on you: review and merge (or close) the pull requests; restart the launcher, then run the manual-close repro for the Wilbur bug.'].join(' ');
  makeTask('eod', { title: `EOD ${DATE}: nightly closed`, persona: 'Morgan', area: 'management', lane: 'script', status: 'done', source: 'routine', priority: 1,
    detail: 'Compiled by the nightly script from the night\'s log (no model involved). ' + eodNote.slice(0, 600) });
  const r = taskio.submitEod({ date: DATE, tz: TZ, note: eodNote });
  log(r.ok ? `EOD snapshot written for ${DATE} (${r.report.taskCount} tasks).` : 'EOD could not be written: ' + r.error);
  state.done = true; state.finishedAt = new Date().toISOString(); save();
  log('NIGHTLY CLOSED. Replay it in the Virtual Team page: "Replay a day" -> ' + DATE);
}

main().catch((e) => { log('NIGHTLY STOPPED: ' + (e && e.stack || e)); process.exit(1); });
