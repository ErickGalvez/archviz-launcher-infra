'use strict';
// Where Hex's work is kept: redteam-data/ beside the launcher (gitignored; the launcher repo is public). CLASSIFIED: a run says exactly how an
// attack went against our own code, so it is read only through the launcher with the Dev Console key, answered with Cache-Control: no-store,
// and never copied to Task-IO, GitHub or a cloud model.
//
//   runs/<id>.json   one range run: the attack, the findings (with fixes), the counts and Hex's notes
//   progress.json    the course: when it started, which lessons you read and how you answered the quiz
//
// The course: a new lesson opens each day (Mexico City days), but never more than one ahead of what you have read, so they never pile up.
const fs = require('fs');
const path = require('path');
const { LESSONS } = require('./lessons');
const { ATTACKS, byId } = require('./attacks');

const RUN_ID_RE = /^rt_\d{8}_[a-z-]{2,30}_[0-9a-f]{6}$/;
const DAY = 86400000, TZ_MIN = -360;
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const mxDay = (ms) => new Date(ms + TZ_MIN * 60000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);

function createRedteamStore({ dir, now = Date.now }) {
  const root = path.join(dir, 'redteam-data'), runsDir = path.join(root, 'runs'), progressFile = path.join(root, 'progress.json');
  const ensure = () => fs.mkdirSync(runsDir, { recursive: true });
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };

  // ── runs ──
  function saveRun(run) {
    if (!RUN_ID_RE.test(run.id || '')) throw new Error('bad run id');
    ensure();
    const tmp = path.join(runsDir, run.id + '.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(run, null, 2)); fs.renameSync(tmp, path.join(runsDir, run.id + '.json'));
    return run.id;
  }
  const runFiles = () => { try { return fs.readdirSync(runsDir).filter((f) => RUN_ID_RE.test(f.replace(/\.json$/, '')) && f.endsWith('.json')).sort().reverse(); } catch (e) { return []; } };
  const summary = (r) => ({ id: r.id, attack: r.attack, title: r.title, startedAt: r.startedAt, ms: r.ms, status: r.status, counts: r.counts || {}, bySeverity: r.bySeverity || {},
    newFindings: (r.findings || []).filter((f) => f.state === 'new').length, fixedSinceLast: (r.fixed || []).length, error: r.error || null });
  function listRuns(limit = 30) { return runFiles().slice(0, Math.max(1, Math.min(100, Number(limit) || 30))).map((f) => readJson(path.join(runsDir, f), null)).filter(Boolean).map(summary); }
  function getRun(id) { if (!RUN_ID_RE.test(String(id || ''))) return null; return readJson(path.join(runsDir, id + '.json'), null); }
  function lastRunOf(attack) { for (const f of runFiles()) { const r = readJson(path.join(runsDir, f), null); if (r && r.attack === attack) return r; } return null; }
  // Findings are compared with the last run of the same attack: new, still open, or fixed since.
  function compare(attack, findings) {
    const prev = lastRunOf(attack), before = new Map(((prev && prev.findings) || []).map((f) => [f.id, f]));
    for (const f of findings) f.state = before.has(f.id) ? 'still open' : 'new';
    const nowIds = new Set(findings.map((f) => f.id));
    return { previous: prev ? prev.id : null, fixed: [...before.values()].filter((f) => !nowIds.has(f.id)).map((f) => ({ id: f.id, title: f.title, severity: f.severity })) };
  }
  // The attack for a day: one a day, a different one each day, in the library's order, counted from the course's first day.
  function attackForDay(day) { const st = progress(), i = Math.max(0, daysBetween(st.startedOn, day)); return ATTACKS[i % ATTACKS.length]; }

  // ── the course ──
  function progress() {
    const p = readJson(progressFile, null);
    if (p && /^\d{4}-\d{2}-\d{2}$/.test(p.startedOn || '')) return { startedOn: p.startedOn, read: p.read && typeof p.read === 'object' ? p.read : {} };
    const fresh = { startedOn: mxDay(now()), read: {} };
    try { ensure(); fs.writeFileSync(progressFile, JSON.stringify(fresh, null, 2)); } catch (e) { /* read-only: the course still shows */ }
    return fresh;
  }
  function unlockedCount() {
    const p = progress(), days = Math.max(0, daysBetween(p.startedOn, mxDay(now()))) + 1;
    let readInARow = 0; while (readInARow < LESSONS.length && p.read[LESSONS[readInARow].n]) readInARow++;
    return Math.min(LESSONS.length, days, readInARow + 1);
  }
  function lessonsView() {
    const p = progress(), open = unlockedCount();
    const list = LESSONS.map((l, i) => ({ n: l.n, week: l.week, title: l.title, minutes: l.minutes, attack: l.attack, open: i < open, read: !!p.read[l.n], correct: p.read[l.n] ? p.read[l.n].correct : null }));
    const today = list.find((l) => l.open && !l.read) || null;
    return { ok: true, startedOn: p.startedOn, total: LESSONS.length, open, readCount: Object.keys(p.read).length, today: today ? today.n : null,
      nextOpensOn: open < LESSONS.length ? (list[open - 1].read ? mxDay(now() + DAY) : null) : null, lessons: list };
  }
  function getLesson(n) {
    const i = LESSONS.findIndex((l) => l.n === Number(n));
    if (i < 0) return { ok: false, error: 'no such lesson' };
    if (i >= unlockedCount()) return { ok: false, error: 'this lesson is not open yet', locked: true };
    const l = LESSONS[i], p = progress(), a = byId(l.attack), last = lastRunOf(l.attack);
    const { answer, ...quiz } = l.quiz;
    const done = p.read[l.n] || null;
    return { ok: true, lesson: { ...l, quiz: done ? l.quiz : quiz }, read: done,
      attack: a ? { id: a.id, title: a.title, summary: a.summary } : null,
      lastRun: last ? { id: last.id, startedAt: last.startedAt, notes: last.notes || [], bySeverity: last.bySeverity || {}, findings: (last.findings || []).length } : null };
  }
  function markRead(n, answer) {
    const l = LESSONS.find((x) => x.n === Number(n));
    if (!l) return { ok: false, error: 'no such lesson' };
    if (LESSONS.indexOf(l) >= unlockedCount()) return { ok: false, error: 'this lesson is not open yet' };
    const a = Number(answer);
    if (!Number.isInteger(a) || a < 0 || a >= l.quiz.options.length) return { ok: false, error: 'answer must be the number of one of the options' };
    const p = progress();
    if (!p.read[l.n]) p.read[l.n] = { readAt: new Date(now()).toISOString(), answer: a, correct: a === l.quiz.answer };
    ensure(); fs.writeFileSync(progressFile, JSON.stringify(p, null, 2));
    return { ok: true, correct: p.read[l.n].correct, answer: l.quiz.answer, why: l.quiz.why, opensNext: unlockedCount() > LESSONS.indexOf(l) + 1 ? 'now' : mxDay(now() + DAY) };
  }

  function status() {
    const last = listRuns(1)[0] || null, lv = lessonsView();
    return { ok: true, classification: 'RESTRICTED · owner only', lastRun: last, today: { attack: (() => { const a = attackForDay(mxDay(now())); return { id: a.id, title: a.title, summary: a.summary }; })(), lesson: lv.today },
      course: { open: lv.open, total: lv.total, readCount: lv.readCount }, attacks: ATTACKS.map((a) => ({ id: a.id, title: a.title, summary: a.summary, lessons: a.lessons })) };
  }

  return { saveRun, listRuns, getRun, lastRunOf, compare, attackForDay, lessonsView, getLesson, markRead, status, progress, root, SEVERITIES };
}

module.exports = { createRedteamStore, RUN_ID_RE, mxDay };
