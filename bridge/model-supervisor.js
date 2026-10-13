'use strict';
// Keeps ONE local model server (llama-server) running on this PC when it should be, and unloads it when it must not be.
//
//   - NIGHTLY WINDOW: inside it (default 00:00-07:00 Mexico City) the model is kept loaded so queued work can run.
//   - ON DEMAND: outside it the model starts when work arrives and unloads again after `idleMinutes` of silence.
//   - RENDERING WINS: while this PC is rendering a client session the model is unloaded (and never started) - the same
//     GPU draws the stream, and the product comes first.
//
// Security: this is the ONLY place in the bridge that starts a long-running process, and it starts exactly the one
// command named in THIS PC's own config file (bridge-node.json). Nothing that arrives over the network can change the
// executable, the model path or the arguments: the network can only ask for "start" or "stop" of that configured model.
// It only ever kills the child it started itself, by handle - never by image name.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { parseHHMM, inWindow, nightKey, DEFAULT_WINDOW } = require('./schedule');

// The command line is built ONLY from this PC's own config.
function buildCommand(llama) {
  if (!llama || !llama.exe || !llama.model) return { error: 'llama.exe and llama.model are not set in bridge-node.json' };
  if (!path.isAbsolute(llama.exe) || !path.isAbsolute(llama.model)) return { error: 'llama.exe and llama.model must be absolute paths' };
  if (!fs.existsSync(llama.exe)) return { error: 'llama-server not found at ' + llama.exe };
  if (!fs.existsSync(llama.model)) return { error: 'model file not found at ' + llama.model };
  const port = Number(llama.port || 8097);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { error: 'llama.port must be 1024-65535' };
  const extra = Array.isArray(llama.extraArgs) ? llama.extraArgs.map(String) : [];
  const args = ['-m', llama.model, '--host', '127.0.0.1', '--port', String(port), '-c', String(Number(llama.ctx) || 16384), '-ngl', String(llama.ngl == null ? 99 : Number(llama.ngl)),
    '-np', '1', '--jinja', '-a', String(llama.alias || 'local'), '-fa', 'on', ...extra];
  return { exe: llama.exe, args, port };
}

function createSupervisor(opts) {
  const { llama, window: win = DEFAULT_WINDOW, idleMinutes = 15, log = () => {}, now = Date.now,
    spawnImpl = spawn, startTimeoutMs = 120000, stopTimeoutMs = 6000, retryMs = 60000 } = opts;
  const cmd = buildCommand(llama);
  const s = { phase: 'stopped', child: null, external: false, demandUntil: 0, pausedUntil: 0, error: cmd.error || null, startedAt: 0, failedAt: 0, reason: '' };
  const idleMs = idleMinutes * 60000;

  const healthy = async () => { try { return (await fetch(`http://127.0.0.1:${cmd.port || 8097}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch (e) { return false; } };

  function start(reason) {
    if (cmd.error || s.child) return false;
    s.phase = 'starting'; s.startedAt = now(); s.error = null; s.reason = reason || '';
    let child;
    try { child = spawnImpl(cmd.exe, cmd.args, { stdio: 'ignore', windowsHide: true }); }
    catch (e) { s.phase = 'failed'; s.error = 'could not start: ' + e.message; s.failedAt = now(); return false; }
    s.child = child;
    child.on('error', (e) => { s.error = 'model server error: ' + e.message; });
    child.on('exit', (code) => {
      if (s.child === child) { s.child = null; if (s.phase !== 'stopping') { s.phase = s.phase === 'starting' ? 'failed' : 'stopped'; if (s.phase === 'failed') { s.error = 'model server exited (code ' + code + ')'; s.failedAt = now(); } } else s.phase = 'stopped'; }
    });
    log('model starting (' + (reason || 'requested') + ')');
    return true;
  }
  function stop(reason) {
    const child = s.child;
    if (!child) { if (s.phase !== 'failed') s.phase = 'stopped'; return Promise.resolve(); }
    s.phase = 'stopping'; s.reason = reason || '';
    log('model stopping (' + (reason || 'requested') + ')');
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); resolve(); };
      child.once('exit', done);
      try { child.kill(); } catch (e) { /* already gone */ }
      const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) { /* gone */ } setTimeout(resolve, 500); }, stopTimeoutMs);
    });
  }

  // One decision step. renderBusy = this PC is (about to be) rendering a client session, or is reserved for rendering.
  async function tick({ renderBusy = false } = {}) {
    const t = now(), up = await healthy();
    if (!s.child && up) { s.external = true; if (s.phase !== 'up') s.phase = 'up'; }
    else if (s.child || !up) { s.external = false; }
    if (s.child && s.phase === 'starting' && up) s.phase = 'up';
    if (s.child && s.phase === 'starting' && t - s.startedAt > startTimeoutMs) { s.error = 'model did not come up in time'; s.failedAt = t; await stop('start timed out'); s.phase = 'failed'; return status(); }
    if (!s.child && s.phase === 'up' && !up) s.phase = 'stopped';

    const wantWindow = inWindow(t, win), wantDemand = s.demandUntil > t, paused = s.pausedUntil > t;
    const desired = !renderBusy && !paused && !cmd.error && (wantWindow || wantDemand);

    if (renderBusy && up && s.external) s.error = 'a model is running outside the bridge, so it cannot be unloaded for rendering';
    else if (s.error && /outside the bridge/.test(s.error)) s.error = cmd.error || null;

    if (desired && !s.child && !s.external && (s.phase === 'stopped' || (s.phase === 'failed' && t - s.failedAt > retryMs))) start(wantWindow ? 'nightly window' : 'work waiting');
    else if (!desired && s.child && (s.phase === 'up' || s.phase === 'starting')) await stop(renderBusy ? 'rendering a client' : paused ? 'stopped by the owner' : 'idle');
    return status();
  }

  // The network may only ask for these two things.
  const request = (action) => {
    if (action === 'start') { s.pausedUntil = 0; s.demandUntil = now() + idleMs; return true; }
    if (action === 'stop') { s.demandUntil = 0; s.pausedUntil = now() + 60 * 60000; return true; }   // honoured for an hour, even inside the window
    return false;
  };
  const demand = () => { if (!s.pausedUntil || s.pausedUntil <= now()) s.demandUntil = Math.max(s.demandUntil, now() + idleMs); };
  const touch = () => { if (s.demandUntil > now()) s.demandUntil = now() + idleMs; };

  function status() {
    const t = now();
    return { phase: s.phase, external: s.external, windowActive: inWindow(t, win), demandActive: s.demandUntil > t, paused: s.pausedUntil > t, canStart: !cmd.error, error: s.error,
      window: win && win.enabled !== false ? { start: win.start, end: win.end, tz: win.tz == null ? -360 : win.tz } : null, reason: s.reason };
  }
  return { tick, request, demand, touch, status, stop, start, command: () => cmd };
}

module.exports = { createSupervisor, inWindow, nightKey, parseHHMM, buildCommand };
