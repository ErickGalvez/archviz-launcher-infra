'use strict';
// The Dev Console's Launchers card, on the launcher side (POST /api/devconsole/restart-launchers and /api/devconsole/start-agents):
//   restart PC 1   this launcher, through the updater, then PC 1's node agent
//   restart PC 2   PC 2's node agent (PC 2 has no launcher: it is the AI worker)
//   restart all    both
//   start agents   start the local model on every PC that is free, so the roles answer at once
//
// Who may: the Dev Console key holder (launcher-server.js checks the key before calling this). What it may do is narrow on purpose:
//   - This launcher restarts ONLY through the updater's apply(): a fast-forward pull, the new code checked before the exit, rolled back if it fails,
//     and refused while a client session, a turn or a queue is live. Never forced from here.
//   - A node agent restarts only when it runs under start-node.bat's loop and has no job running (the agent itself refuses otherwise).
//   - One restart every 20 seconds and one model start every 10 seconds, whatever the caller sends.
// Nothing in a request reaches a command: the only thing read from the body is which PC (1, 2 or all). This module never starts a process.

function createRemote({ updater, hub, busy = () => null, now = Date.now, log = () => {}, restartGapMs = 20000, startGapMs = 10000 }) {
  let lastRestart = -Infinity, lastStart = -Infinity;
  const hubNow = () => (typeof hub === 'function' ? hub() : hub);
  const wait = (gap, last, t) => Math.ceil((gap - (t - last)) / 1000);
  const and = (xs) => (xs.length > 1 ? xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1] : xs[0] || '');

  function parsePc(body) {
    const v = body && typeof body === 'object' ? body.pc : undefined;
    if (v === undefined || v === null || v === '' || v === 'all') return { pc: 'all' };
    return v === 1 || v === 2 || v === '1' || v === '2' ? { pc: Number(v) } : { error: 'pc must be 1, 2 or left out (all)' };
  }
  const agentsLine = (rs) => rs.map((r) => (r.ok ? r.alias + ': node agent restarting' : r.alias + ': ' + r.error)).join('; ');

  async function restart(body) {
    const { pc, error } = parsePc(body);
    if (error) return { status: 400, body: { ok: false, error } };
    const t = now();
    if (t - lastRestart < restartGapMs) return { status: 429, body: { ok: false, error: 'A restart was just requested: wait ' + wait(restartGapMs, lastRestart, t) + ' s.' } };
    const wantPc1 = pc === 1 || pc === 'all', wantPc2 = pc === 2 || pc === 'all';
    if (wantPc1) {
      const reason = busy();
      if (reason) return { status: 409, body: { ok: false, busy: reason, error: 'Not now: ' + reason + '. The launcher restarts when the session is over.' } };
      if (!updater) return { status: 503, body: { ok: false, error: 'The updater is not loaded on this launcher (updater.js), so it cannot restart itself.' } };
    }
    lastRestart = t;
    const h = hubNow(), parts = {}, lines = [];
    if (wantPc2) {                                     // first: this process may exit right after the PC 1 part
      const rs = h ? await h.restartAgents(2) : [{ ok: false, alias: 'PC 2', error: 'the bridge is not set up on this launcher' }];
      parts.pc2 = { ok: rs.every((r) => r.ok), agents: rs };
      lines.push(agentsLine(rs) + (parts.pc2.ok ? ' (back in about 5 s).' : '.'));
    }
    if (wantPc1) {
      const u = await updater.apply({ restart: true });
      if (!u.ok) {
        parts.pc1 = { ok: false, busy: u.busy, error: u.error };
        lines.push('PC 1: ' + String(u.error || 'the launcher did not restart').replace(/\.$/, '') + '.');
      } else {
        parts.pc1 = { ok: true, from: u.from, to: u.to, pulled: u.pulled || 0 };
        // After the pull, so PC 1's agent comes back on the new code too. The launcher waits a moment before it exits (restartDelayMs) for this call.
        const rs = h ? await h.restartAgents(1) : [{ ok: false, alias: 'PC 1', error: 'the bridge is not set up on this launcher' }];
        parts.pc1.agents = rs;
        lines.push('PC 1: the launcher is restarting' + (u.pulled ? ' with ' + u.pulled + ' new change' + (u.pulled === 1 ? '' : 's') : '') + ' (back in about 10 s); ' + agentsLine(rs) + '.');
      }
    }
    const ok = Object.values(parts).every((x) => x.ok), message = lines.join(' ');
    log('restart ' + (pc === 'all' ? 'all' : 'PC ' + pc) + ': ' + message);
    return { status: ok ? 200 : parts.pc1 && parts.pc1.busy ? 409 : 502, body: ok ? { ok: true, pc, ...parts, message } : { ok: false, pc, ...parts, error: message } };
  }

  async function startAgents() {
    const t = now();
    if (t - lastStart < startGapMs) return { status: 429, body: { ok: false, error: 'The agents were just started: wait ' + wait(startGapMs, lastStart, t) + ' s.' } };
    const h = hubNow();
    if (!h) return { status: 503, body: { ok: false, error: 'The bridge is not set up on this launcher, so there are no agents to start.' } };
    lastStart = t;
    const r = await h.startModels();
    const lines = [];
    if (r.starting.length) lines.push('Starting the local model on ' + and(r.starting) + ' (about a minute).');
    if (r.ready.length) lines.push(and(r.ready) + ' already ' + (r.ready.length > 1 ? 'have' : 'has') + ' it running.');
    if (r.skipped.length) lines.push('Not on ' + r.skipped.map((s) => s.alias + ' (' + s.why + ')').join(', ') + '.');
    const ok = r.starting.length + r.ready.length > 0, message = lines.join(' ') || 'No PC is online.';
    log('start agents: ' + message);
    return { status: ok ? 200 : 409, body: ok ? { ok: true, ...r, message } : { ok: false, ...r, error: message } };
  }

  return { restart, startAgents };
}

module.exports = { createRemote };
