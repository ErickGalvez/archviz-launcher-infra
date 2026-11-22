'use strict';
// The range guard. Preloaded into the throwaway copy of the launcher that Hex attacks (node --require <guard> launcher-server.js), before any of
// the launcher's own code runs. Whatever an attack makes the copy do, the copy:
//   - reads and writes files only inside its own folder (G741_RANGE_DIR), so a path-traversal bug can never touch the real launcher, a key or
//     anything else on the PC;
//   - reaches nothing but loopback (no internet, no LAN, no DNS), so a server-side request forgery bug cannot leave this machine;
//   - starts no process and no worker thread.
// Every refusal is printed as one line, "RANGE-GUARD <what> <where>", which the range reads back as evidence: a copy that TRIED to reach out
// is a finding even though the guard stopped it.
const path = require('path');
const fs = require('fs');
const net = require('net');
const dns = require('dns');

const ROOT = path.resolve(process.env.G741_RANGE_DIR || '');
if (!process.env.G741_RANGE_DIR || !fs.existsSync(ROOT)) { console.error('RANGE-GUARD no G741_RANGE_DIR: refusing to start'); process.exit(97); }

const say = (what, where) => { try { process.stderr.write('RANGE-GUARD ' + what + ' ' + String(where).replace(/\s+/g, ' ').slice(0, 200) + '\n'); } catch (e) { /* nothing to report to */ } };
const refusal = (what, where) => { say(what, where); const e = new Error('blocked by the range guard: ' + what); e.code = 'ERANGEGUARD'; return e; };

// ── files: only inside ROOT ──
const inside = (p) => {
  if (p == null) return true;
  if (typeof p === 'number') return true;                              // a file descriptor: it was opened through a checked path
  const s = Buffer.isBuffer(p) ? p.toString() : p instanceof URL ? p.pathname : String(p);
  const abs = path.resolve(ROOT, s);
  return abs === ROOT || abs.startsWith(ROOT + path.sep);
};
const WRITE_FLAGS = /[wa+]/;
const guardPaths = (obj, names, argIdx, kind) => {
  for (const n of names) {
    const orig = obj[n]; if (typeof orig !== 'function') continue;
    obj[n] = function guarded(...args) {
      for (const i of argIdx) if (!inside(args[i])) {
        if (n === 'existsSync') return false;
        const err = refusal(kind, args[i]);
        if (typeof args[args.length - 1] === 'function' && !n.endsWith('Sync')) { process.nextTick(args[args.length - 1], err); return undefined; }
        if (obj === fs.promises) return Promise.reject(err);
        throw err;
      }
      return orig.apply(this, args);
    };
  }
};
const READS = ['readFile', 'readFileSync', 'createReadStream', 'readdir', 'readdirSync', 'opendir', 'opendirSync', 'existsSync', 'watch', 'watchFile'];
const WRITES1 = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'createWriteStream', 'mkdir', 'mkdirSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync',
  'unlink', 'unlinkSync', 'truncate', 'truncateSync', 'chmod', 'chmodSync', 'utimes', 'utimesSync', 'mkdtemp', 'mkdtempSync'];
const WRITES2 = ['rename', 'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'link', 'linkSync'];
guardPaths(fs, READS, [0], 'file read outside the range');
guardPaths(fs, WRITES1, [0], 'file write outside the range');
guardPaths(fs, WRITES2, [0, 1], 'file write outside the range');
guardPaths(fs.promises, ['readFile', 'readdir', 'opendir'], [0], 'file read outside the range');
guardPaths(fs.promises, ['writeFile', 'appendFile', 'mkdir', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'utimes', 'mkdtemp'], [0], 'file write outside the range');
guardPaths(fs.promises, ['rename', 'copyFile', 'cp', 'symlink', 'link'], [0, 1], 'file write outside the range');
for (const [obj, n] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
  const orig = obj[n];
  obj[n] = function guardedOpen(p, flags, ...rest) {
    if (!inside(p)) {
      const err = refusal(WRITE_FLAGS.test(String(flags || 'r')) ? 'file write outside the range' : 'file read outside the range', p);
      const cb = [flags, ...rest].find((x) => typeof x === 'function');
      if (cb) { process.nextTick(cb, err); return undefined; }
      if (obj === fs.promises) return Promise.reject(err);
      throw err;
    }
    return orig.call(this, p, flags, ...rest);
  };
}
process.chdir = () => { throw refusal('chdir', ''); };

// ── network: loopback only, and no name lookups ──
const LOOP = new Set(['127.0.0.1', '::1', 'localhost', '::ffff:127.0.0.1']);
const origConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const a = Array.isArray(args[0]) ? args[0][0] : args[0];
  const opts = a && typeof a === 'object' ? a : { port: a, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
  if (opts.path) { const err = refusal('pipe connection', opts.path); process.nextTick(() => this.destroy(err)); return this; }
  const host = String(opts.host || 'localhost').replace(/^\[|\]$/g, '');
  if (!LOOP.has(host)) { const err = refusal('network connection', host + ':' + opts.port); process.nextTick(() => this.destroy(err)); return this; }
  return origConnect.apply(this, args);
};
const origLookup = dns.lookup;
dns.lookup = function guardedLookup(host, ...rest) {
  if (LOOP.has(String(host))) return origLookup.call(this, host, ...rest);
  const cb = rest.find((x) => typeof x === 'function'), err = refusal('name lookup', host);
  if (cb) process.nextTick(cb, err);
  return undefined;
};
for (const n of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt', 'resolveSrv', 'resolveNs', 'reverse']) {
  dns[n] = (...args) => { const cb = args.find((x) => typeof x === 'function'), err = refusal('name lookup', args[0]); if (cb) process.nextTick(cb, err); };
  if (dns.promises && dns.promises[n]) dns.promises[n] = (h) => Promise.reject(refusal('name lookup', h));
}
if (dns.promises) { const origP = dns.promises.lookup; dns.promises.lookup = (h, ...r) => (LOOP.has(String(h)) ? origP.call(dns.promises, h, ...r) : Promise.reject(refusal('name lookup', h))); }
try { const dgram = require('dgram'); dgram.createSocket = () => { throw refusal('udp socket', ''); }; } catch (e) { /* no dgram */ }

// ── processes and threads: none ──
const cp = require('child_process');
for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  cp[n] = (cmd) => {
    const err = refusal('process start', Array.isArray(cmd) ? cmd.join(' ') : cmd);
    if (/Sync$/.test(n)) throw err;
    const { EventEmitter } = require('events'), e = new EventEmitter();
    e.stdout = new EventEmitter(); e.stderr = new EventEmitter(); e.kill = () => {}; e.unref = () => {}; e.pid = undefined;
    process.nextTick(() => e.emit('error', err));
    return e;
  };
}
try { const wt = require('worker_threads'); wt.Worker = function Worker() { throw refusal('worker thread', ''); }; } catch (e) { /* no worker_threads */ }

module.exports = { ROOT, inside, LOOP };
