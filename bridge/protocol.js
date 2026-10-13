'use strict';
// Shared wire protocol for the G741 bridge: request signing, replay protection and LAN discovery beacons.
//
// Threat model: anything on the local network can reach a node's port, so EVERY request must prove it was made by
// someone holding the shared key (bridge/bridge.key, copied between the PCs by hand, never sent over the network).
//   - Requests carry an HMAC-SHA256 over method + path + timestamp + nonce + body hash.
//   - A request is rejected if its clock is >60s off, or if its nonce was already seen (replay).
//   - The signature is checked BEFORE the nonce is recorded, so a stranger can't fill the replay cache.
//   - Beacons (discovery) are signed too, so a stranger can't make the hub talk to an address of their choosing.
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');

const MAX_SKEW_MS = 60 * 1000;
const VIRTUAL_IFACE = /vmware|virtualbox|vethernet|hyper-v|docker|wsl|loopback|bluetooth|tailscale|zerotier/i;

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length || a.length % 2) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch (e) { return false; }
}

function canonical(method, target, ts, nonce, body) {
  return [String(method).toUpperCase(), target, ts, nonce, sha256hex(body || '')].join('\n');
}

function signRequest(key, method, target, body, now = Date.now()) {
  const ts = String(now), nonce = crypto.randomBytes(12).toString('hex');
  return { 'x-bridge-ts': ts, 'x-bridge-nonce': nonce, 'x-bridge-sig': hmacHex(key, canonical(method, target, ts, nonce, body)) };
}

class ReplayGuard {
  constructor(max = 4096) { this.seen = new Map(); this.max = max; }
  fresh(nonce, ts, now = Date.now()) {
    for (const [n, t] of this.seen) { if (now - t > MAX_SKEW_MS * 2) this.seen.delete(n); else break; }   // insertion-ordered: oldest first
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value);
    this.seen.set(nonce, ts);
    return true;
  }
}

// Returns { ok: true } or { ok: false, reason }. `reason` is for the node's own log, never sent back verbatim.
function verifyRequest(key, method, target, headers, body, guard, now = Date.now()) {
  const ts = headers['x-bridge-ts'], nonce = headers['x-bridge-nonce'], sig = headers['x-bridge-sig'];
  if (!ts || !nonce || !sig) return { ok: false, reason: 'missing-auth' };
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(now - t) > MAX_SKEW_MS) return { ok: false, reason: 'stale-or-future' };
  if (!/^[0-9a-f]{24}$/.test(nonce)) return { ok: false, reason: 'bad-nonce' };
  if (!safeEqualHex(sig, hmacHex(key, canonical(method, target, ts, nonce, body)))) return { ok: false, reason: 'bad-signature' };
  if (!guard.fresh(nonce, t, now)) return { ok: false, reason: 'replay' };
  return { ok: true };
}

// ── discovery beacons ──
function makeBeacon(key, { id, alias, port }, now = Date.now()) {
  const b = { v: 1, id: String(id), alias: String(alias).slice(0, 40), port: Number(port), ts: now };
  return Buffer.from(JSON.stringify({ ...b, sig: hmacHex(key, ['beacon', b.v, b.id, b.alias, b.port, b.ts].join('\n')) }));
}
function parseBeacon(key, buf, now = Date.now()) {
  try {
    const b = JSON.parse(Buffer.from(buf).toString('utf8'));
    if (!b || b.v !== 1 || typeof b.id !== 'string' || typeof b.alias !== 'string' || !Number.isInteger(b.port) || b.port < 1 || b.port > 65535 || !Number.isFinite(b.ts)) return null;
    if (Math.abs(now - b.ts) > MAX_SKEW_MS) return null;
    if (!safeEqualHex(b.sig, hmacHex(key, ['beacon', b.v, b.id, b.alias, b.port, b.ts].join('\n')))) return null;
    return { id: b.id, alias: b.alias, port: b.port, ts: b.ts };
  } catch (e) { return null; }
}

// One broadcast address per real network interface (a single 255.255.255.255 send only leaves through one adapter,
// and this machine also has VMware / Hyper-V adapters that must not be used).
function broadcastAddresses(interfaces = os.networkInterfaces()) {
  const out = new Set();
  for (const [name, list] of Object.entries(interfaces)) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal || !i.netmask) continue;
      const ip = i.address.split('.').map(Number), mask = i.netmask.split('.').map(Number);
      out.add(ip.map((o, k) => (o & mask[k]) | (~mask[k] & 255)).join('.'));
    }
  }
  return [...out];
}

// ── key file ──
const KEY_RE = /^[0-9a-f]{64}$/;
function loadKey(file) {
  const k = fs.readFileSync(file, 'utf8').trim();
  if (!KEY_RE.test(k)) throw new Error('bridge key file is not 64 hex characters: ' + file);
  return k;
}
function createKeyFile(file) {
  if (fs.existsSync(file)) return { created: false, fingerprint: fingerprint(loadKey(file)) };
  const k = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, k + '\n', { mode: 0o600 });
  return { created: true, fingerprint: fingerprint(k) };
}
// Safe to show: lets you confirm two PCs hold the same key without revealing it.
const fingerprint = (key) => sha256hex('fingerprint:' + key).slice(0, 8);

module.exports = { MAX_SKEW_MS, signRequest, verifyRequest, ReplayGuard, makeBeacon, parseBeacon, broadcastAddresses, loadKey, createKeyFile, fingerprint, sha256hex };
