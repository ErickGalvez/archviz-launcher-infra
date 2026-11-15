'use strict';
// Passes: what a website page on PC-1 gets from the G741 Launcher app instead of a typed key.
//
// The page asks the app (on this PC); the app asks the owner (Windows Hello in the app, or Google through the browser), then asks THIS module, through
// POST /api/pass/issue, for a pass of one scope. The app sends the real key of that scope, which never leaves the app. The page then sends the pass
// wherever it used to send the key (x-devconsole-key, x-qa-key): isDevConsoleAuthed / isQaAuthed accept a live pass of their own scope and nothing else.
//
//   - A pass opens one scope: 'devconsole' (the Dev Console key's routes), 'qa' (the QA key's) or 'owner' (only proves to Cortex that the owner signed in).
//   - It lasts 12 hours, never longer, and cannot be renewed with itself: issuing needs the real key (launcher-server.js checks that, and that the
//     request was made on this PC, not through Cloudflare).
//   - Only a SHA-256 of each pass is kept (in memory and in passes.json, so a restart does not sign every page out). The pass itself is shown once.
//   - At most 20 live passes per scope; the oldest goes first.
//
// This module starts no process and makes no request.
const crypto = require('crypto');
const fs = require('fs');

const SCOPES = ['devconsole', 'qa', 'owner'];
const PASS_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_PER_SCOPE = 20;
const PASS_RE = /^g741p_[A-Za-z0-9_-]{43}$/;           // 'g741p_' + 32 random bytes, base64url

const hashOf = (pass) => crypto.createHash('sha256').update(pass).digest('hex');

function createPasses({ file = null, now = () => Date.now(), fsImpl = fs, randomBytes = crypto.randomBytes } = {}) {
  const live = new Map();                               // sha256(pass) -> { scope, issuedAt, expiresAt }

  function prune() { const t = now(); for (const [h, p] of live) if (p.expiresAt <= t) live.delete(h); }

  function save() {
    if (!file) return;
    prune();
    const passes = [...live].map(([h, p]) => ({ h, scope: p.scope, issuedAt: p.issuedAt, expiresAt: p.expiresAt }));
    try { fsImpl.writeFileSync(file, JSON.stringify({ v: 1, passes })); } catch (e) { /* not saved: those passes last only until the next restart */ }
  }

  function load() {
    if (!file) return;
    let j = null;
    try { j = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch (e) { return; }        // no file yet, or unreadable: start empty
    const t = now();
    for (const p of (j && Array.isArray(j.passes) ? j.passes : [])) {
      // Only what this module could have written: a hash, a known scope, and an expiry that is in the future but no further than one lifetime away.
      if (!p || !/^[0-9a-f]{64}$/.test(p.h) || !SCOPES.includes(p.scope) || !Number.isFinite(p.expiresAt) || p.expiresAt <= t || p.expiresAt > t + PASS_TTL_MS) continue;
      live.set(p.h, { scope: p.scope, issuedAt: Number(p.issuedAt) || 0, expiresAt: p.expiresAt });
    }
  }

  function lookup(pass) {
    if (typeof pass !== 'string' || !PASS_RE.test(pass)) return null;
    const h = hashOf(pass), p = live.get(h);
    if (!p) return null;
    if (p.expiresAt <= now()) { live.delete(h); return null; }
    return p;
  }

  // A new pass for one scope, or null for an unknown scope. The caller has already checked the real key.
  function issue(scope) {
    if (!SCOPES.includes(scope)) return null;
    prune();
    const mine = [...live].filter(([, p]) => p.scope === scope);                      // Map order is issue order: the first is the oldest
    while (mine.length >= MAX_PER_SCOPE) live.delete(mine.shift()[0]);
    const pass = 'g741p_' + randomBytes(32).toString('base64url');
    const t = now(), expiresAt = t + PASS_TTL_MS;
    live.set(hashOf(pass), { scope, issuedAt: t, expiresAt });
    save();
    return { pass, scope, expiresAt };
  }

  const valid = (pass, scope) => { const p = lookup(pass); return !!p && p.scope === scope; };
  const check = (pass) => { const p = lookup(pass); return p ? { scope: p.scope, expiresAt: p.expiresAt } : null; };
  function revoke(pass) {
    if (typeof pass !== 'string' || !PASS_RE.test(pass)) return false;
    const had = live.delete(hashOf(pass));
    if (had) save();
    return had;
  }
  function revokeAll() { prune(); const n = live.size; live.clear(); save(); return n; }

  load();
  return { issue, valid, check, revoke, revokeAll, size: () => { prune(); return live.size; } };
}

module.exports = { createPasses, SCOPES, PASS_TTL_MS, MAX_PER_SCOPE, PASS_RE };
