'use strict';
// "Update & restart" for the launcher's admin panel: how far the running launcher is behind what has been pushed, and one action that pulls it and restarts.
//
// What "ahead" means here: the commits between the code this process STARTED with and the newest code there is (GitHub's branch, or this checkout's own HEAD when
// it has commits that are not pushed yet). That is the number of changes a restart would pick up, whether they came from a push made elsewhere or from this very
// checkout (this PC is both the machine that runs the launcher and one that edits it).
//
// Applying an update: refuse while a client session, a turn or a queue is live (unless forced), `git pull --ff-only` (never a merge, never a reset of the
// owner's work), then check that the new code at least loads (`node --check`, and that bridge/index.js still exposes init), roll the pull back if it does not,
// and only then exit. listener_service.bat relaunches the process about 5 seconds later with the new code, the same self-healing loop the Dev Console merge uses.
//
// This module never starts a process itself: launcher-server.js hands it `run(cmd, args, opts)`, so the tests can drive it with a fake and the sandbox
// launcher (whose child_process is stubbed) can only answer "git is not available". The commands are fixed argument lists, never built from a request.
const path = require('path');

// The files the running launcher has loaded: a change to any of them needs a restart. Tests, mutation lists, the node agent and the installers do not.
const RESTART_FILES = ['launcher-server.js', 'updater.js', ...['index', 'hub', 'taskio', 'protocol', 'policy', 'routines', 'dispatcher', 'schedule', 'tickets', 'reports', 'verifier', 'fixnote'].map((n) => 'bridge/' + n + '.js')];

const short = (s) => String(s || '').trim().slice(0, 7);
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const redact = (s) => String(s || '').replace(/:\/\/[^/@\s]+@/g, '://***@');       // a remote URL may carry a token: never show it
const lines = (s) => String(s || '').split('\n').map((l) => l.trim()).filter(Boolean);

// The sentence under the button. Pure: everything it says is in `info`.
function describe(info) {
  if (!info || !info.ok) return { level: 'warn', headline: (info && info.error) || 'Could not check for updates.', lines: [] };
  const out = { level: 'ok', headline: '', lines: [] };
  const n = info.ahead || 0, plural = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
  if (info.diverged) { out.level = 'warn'; out.headline = 'This checkout and GitHub have diverged: it cannot update by itself.'; out.lines.push('Fix the branches by hand, then check again.'); return out; }
  if (n === 0) out.headline = 'Up to date · running ' + info.running;
  else {
    out.level = 'ahead';
    out.headline = plural(n, 'change') + ' ahead · ' + plural(info.files || 0, 'file') + ' changed' + (info.insertions || info.deletions ? ' (+' + (info.insertions || 0) + ' −' + (info.deletions || 0) + ')' : '');
    for (const c of info.commits || []) out.lines.push(c.sha + ' ' + c.subject);
    if (n > (info.commits || []).length) out.lines.push('… and ' + (n - info.commits.length) + ' more');
    out.lines.push(info.needsRestart ? 'The launcher itself changed: it needs a restart (about 10 seconds; nothing running is affected when no session is live).' : 'Only tests, docs or tools changed: the running launcher does not need a restart.');
    if (info.canPull) out.lines.push('These are on GitHub: the update pulls them first.');
    else if (info.unpushed) out.lines.push('These commits are in this checkout and not pushed to GitHub yet.');
  }
  if (info.dirty && info.dirty.length) { out.level = out.level === 'ok' ? 'ahead' : out.level; out.lines.push(plural(info.dirty.length, 'uncommitted file') + ' in this checkout (' + info.dirty.slice(0, 4).join(', ') + (info.dirty.length > 4 ? ', …' : '') + '): a restart loads them too.'); }
  if (info.fetchError) out.lines.push('Could not reach GitHub just now; this is based on the last time it could.');
  return out;
}

function createUpdater({ run, dir, node = process.execPath, now = Date.now, busy = () => null, restart = () => {}, log = () => {}, cacheMs = 60000, minFreshMs = 5000, restartDelayMs = 700 }) {
  const git = (args, opt) => run('git', args, { cwd: dir, timeout: 25000, ...opt });
  const state = { running: null };
  let ready = Promise.resolve(), cache = null, inflight = null, applying = false;

  // Call once at startup: remembers which commit THIS process was started from.
  function start() {
    ready = git(['rev-parse', 'HEAD'], { timeout: 8000 }).then((r) => { state.running = r.code === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim()) ? r.stdout.trim() : null; }).catch(() => { state.running = null; });
    return ready;
  }

  async function compute() {
    const info = { ok: false, at: now(), running: short(state.running) };
    if (!state.running) { info.error = 'Git is not available on this host, or this folder is not a git checkout.'; return info; }
    const f = await git(['fetch', '--quiet', 'origin'], { timeout: 30000 });
    if (f.code !== 0) info.fetchError = clip(redact(f.stderr || f.stdout), 160) || 'fetch failed';
    const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (up.code !== 0) { info.error = 'This checkout has no upstream branch to compare with.'; return info; }
    info.upstream = clip(up.stdout, 60);
    const head = (await git(['rev-parse', 'HEAD'])).stdout.trim(), tip = (await git(['rev-parse', info.upstream])).stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(head) || !/^[0-9a-f]{40}$/.test(tip)) { info.error = 'Could not read the branch heads.'; return info; }
    const headInTip = (await git(['merge-base', '--is-ancestor', head, tip])).code === 0, tipInHead = (await git(['merge-base', '--is-ancestor', tip, head])).code === 0;
    info.head = short(head); info.upstreamSha = short(tip);
    info.diverged = !headInTip && !tipInHead;
    info.canPull = headInTip && head !== tip;                            // GitHub has commits this checkout does not
    info.unpushed = !headInTip;                                          // this checkout has commits GitHub does not
    const target = headInTip ? tip : head;                               // what a restart after the update would run
    info.target = target;
    const run0 = state.running;
    const count = await git(['rev-list', '--count', run0 + '..' + target]);
    info.ahead = count.code === 0 ? parseInt(count.stdout, 10) || 0 : 0;
    info.commits = [];
    if (info.ahead > 0) {
      const lg = await git(['log', '--format=%h%x09%s', '--max-count=12', run0 + '..' + target]);
      info.commits = lines(lg.stdout).map((l) => { const [sha, ...rest] = l.split('\t'); return { sha: short(sha), subject: clip(rest.join(' '), 140) }; });
      const names = lines((await git(['diff', '--name-only', run0, target])).stdout);
      info.changed = names.slice(0, 15); info.files = names.length;
      info.needsRestart = names.some((nm) => RESTART_FILES.includes(nm));
      const st = (await git(['diff', '--shortstat', run0, target])).stdout;
      info.insertions = parseInt((/(\d+) insertion/.exec(st) || [])[1], 10) || 0; info.deletions = parseInt((/(\d+) deletion/.exec(st) || [])[1], 10) || 0;
    } else { info.files = 0; info.needsRestart = false; }
    info.dirty = lines((await git(['status', '--porcelain', '--untracked-files=no'])).stdout).map((l) => clip(l.slice(2), 80)).slice(0, 12);
    info.ok = true;
    info.legend = describe(info);
    return info;
  }

  async function check({ fresh = false } = {}) {
    await ready;
    const t = now();
    if (cache && (t - cache.at < (fresh ? minFreshMs : cacheMs))) return cache;
    if (inflight) return inflight;
    inflight = compute().then((i) => { cache = i; return i; }).finally(() => { inflight = null; });
    return inflight;
  }

  // The checks the new code must pass before the process exits: every launcher file it changed parses, and the bridge still loads (the exact failure that once
  // left the launcher with no bridge: `require('./bridge')` found bridge.json first).
  async function preflight(changed) {
    const files = [...new Set(['launcher-server.js', 'updater.js', ...(changed || []).filter((f) => RESTART_FILES.includes(f))])].slice(0, 20);
    for (const f of files) {
      const r = await run(node, ['--check', path.join(dir, f)], { cwd: dir, timeout: 20000 });
      if (r.code !== 0) return f + ' does not parse: ' + clip(redact(r.stderr), 140);
    }
    const load = "process.env.G741_BRIDGE_DISABLED = '1'; const b = require('./bridge/index.js'); if (typeof b.init !== 'function') process.exit(3); const u = require('./updater.js'); if (typeof u.createUpdater !== 'function') process.exit(4);";
    const l = await run(node, ['-e', load], { cwd: dir, timeout: 20000 });
    if (l.code !== 0) return 'the bridge or the updater no longer loads (exit ' + l.code + ')' + (l.stderr ? ': ' + clip(redact(l.stderr), 120) : '');
    return null;
  }

  // restart: true restarts even when nothing the launcher uses changed (the "Restart" button); false only pulls when that is all that changed.
  async function apply({ force = false, restart: wantRestart = true } = {}) {
    if (applying) return { ok: false, error: 'An update is already running.' };
    applying = true;
    let willExit = false;
    try {
      const info = await check({ fresh: true });
      if (!info.ok) return { ok: false, error: info.error };
      if (info.diverged) return { ok: false, error: 'This checkout and GitHub have diverged: fix the branches by hand.' };
      const reason = busy();
      if (reason && !force && (wantRestart || info.needsRestart)) return { ok: false, busy: reason, error: 'Not now: ' + reason + '.' };
      const before = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      let pulled = 0;
      if (info.canPull) {
        const p = await git(['pull', '--ff-only', '--quiet'], { timeout: 60000 });
        if (p.code !== 0) return { ok: false, step: 'pull', error: 'git pull failed: ' + (clip(redact(p.stderr || p.stdout), 200) || 'unknown error') };
        pulled = info.ahead;
      }
      const bad = await preflight(info.changed);
      if (bad) {
        let rolled = false;
        if (info.canPull && /^[0-9a-f]{40}$/.test(before)) rolled = (await git(['reset', '--hard', before])).code === 0;    // only ever back to the commit it was on a moment ago
        cache = null;
        return { ok: false, step: 'preflight', rolledBack: rolled, error: 'The update failed its checks' + (rolled ? ' and was rolled back' : ' (the pull had not run)') + ': ' + bad };
      }
      const after = (await git(['rev-parse', 'HEAD'])).stdout.trim();
      cache = null;
      const exits = wantRestart || info.needsRestart, was = state.running;
      if (exits) { willExit = true; log('update: ' + short(before) + ' -> ' + short(after) + ', ' + (info.ahead || 0) + ' change(s); restarting'); setTimeout(restart, restartDelayMs); }
      else { state.running = after; log('update: ' + short(before) + ' -> ' + short(after) + ', no restart needed'); }
      return { ok: true, from: short(was), to: short(after), pulled, changes: info.ahead || 0, restarting: exits, needsRestart: !!info.needsRestart };
    } finally { if (!willExit) applying = false; }
  }

  return { start, check, apply, describe, state };
}

module.exports = { createUpdater, describe, RESTART_FILES };
