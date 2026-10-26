'use strict';
// Mutations for the Archivist (the secret department): bridge.mutation.js breaks ONE protection at a time in a copy of bridge/ and requires
// archivist.test.js or archive.test.js to go red. A protection nobody tests is a protection nobody notices losing, and this one guards a person's private files.
// [name, file, exact text to find, replacement]
module.exports = [
  // ── which folders may be read ──
  ['a folder outside the allowed list is scanned', 'archivist.js', "if (isInside(real, rr)) { allowed = true; break; }", '{ allowed = true; break; }'],
  ['a relative path is accepted', 'archivist.js', "|| !path.isAbsolute(s)) return { ok: false, code: 'bad_path'", ") return { ok: false, code: 'bad_path'"],
  ['a folder next to an allowed one counts as inside it', 'archivist.js', 'a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep)', 'a === b || a.startsWith(b)'],
  ['the allowed list is read once, when the agent starts', 'node-agent.js', 'roots: () => ((archiveCfg() || {}).roots || [])', 'roots: ((archiveCfg() || {}).roots || [])'],
  ['a PC that has not turned the Archivist on runs scans', 'node-agent.js', 'return c.enabled === true; };', 'return true; };'],
  ['the archive routes answer on a PC that has it off', 'node-agent.js', "if (!archiveOn()) return send(404, { ok: false, error: 'the Archivist is not enabled on this PC' });", ''],
  ['a job for a folder that is not allowed is accepted', 'node-agent.js', 'const chk = archive.check(p.path); if (!chk.ok) return chk.error;', ''],
  ['the launcher queues a scan without asking PC-1 first', 'archive.js', "try { await hub.archiveCall(d.id, 'POST', '/v1/archive/check', { path: p }); } catch (e) { return asError(e); }", ''],

  // ── what is never followed, never read, never sent to the model ──
  // two layers guard the same thing (a link is skipped by its type, and a folder that resolves outside the root is skipped by its real path), so breaking ONE of them changes nothing a test can see: both are broken together
  ['a link is followed out of the folder', 'archivist.js', ['if (e.isSymbolicLink()) continue;', 'if (e.isDirectory()) {', 'if (!isInside(real, realRoot)) { errors.unreadable++; continue; }'], ['', 'if (e.isDirectory() || e.isSymbolicLink()) {', '']],
  ['secret files are not set aside', 'archivist.js', 'if (secretFile(f.name)) entry.flags.sensitive = true;', 'if (false) entry.flags.sensitive = true;'],
  ['files with a private name are not set aside', 'archivist.js', 'else if (privateName(f.rel)) entry.flags.private = true;', ''],
  ['secret folders (.ssh, .aws, wallets) are walked', 'archivist.js', "if (SECRET_DIR.has(n)) { secrets.push({ rel, kind: 'folder' }); continue; }", ''],
  ['program folders (node_modules, .git) are walked', 'archivist.js', 'if (dep) { if (deps.length < 300) deps.push({ rel, label: dep }); continue; }', ''],
  ['secret and private files go to the model', 'archivist.js', 'const readable = catalog.filter((f) => !f.interpreted && !f.flags.sensitive && !f.flags.private && (', 'const readable = catalog.filter((f) => !f.interpreted && ('],
  ['private files are named in the folder question', 'archivist.js', 'for (const f of catalog) if (!f.interpreted && !f.flags.sensitive && !f.flags.private) { const a = todo.get(f.dir)', 'for (const f of catalog) if (!f.interpreted) { const a = todo.get(f.dir)'],
  ['the model gets the whole file, not a clipped sample', 'archivist.js', '.slice(0, PROMPT_CHARS);', '.slice(0, 1e9);'],
  ['G741 files are sorted into the owner\'s other projects', 'archivist.js', "if (f.flags.g741) f.group = 'g741'; else if (f.flags.sensitive)", "if (false) f.group = 'g741'; else if (f.flags.sensitive)"],
  ['every file is hashed, not only the files that share a size', 'archivist.js', '.filter((a) => a.length > 1).flat()', '.filter((a) => a.length > 0).flat()'],

  // ── limits, runs, and the way a scan stops ──
  ['the file limit is ignored', 'archivist.js', 'if (catalog.length >= maxFiles) continue;', ''],
  ['a request can lift the hard file limit', 'archivist.js', 'Math.min(Math.max(parseInt(params.maxFiles, 10) || limits.maxFiles, 1), limits.maxFilesHard)', 'Math.max(parseInt(params.maxFiles, 10) || limits.maxFiles, 1)'],
  ['a run id from the request is used as a folder name', 'archivist.js', 'const id = validRun(params.runId) ? params.runId : runIdFor(root, !!params.fresh)', 'const id = params.runId || runIdFor(root, !!params.fresh)'],
  ['a run of another folder is resumed', 'archivist.js', 'if (meta.root !== root) {', 'if (false) {'],
  ['the catalog of any id can be read', 'archivist.js', "if (!validRun(id)) return null;\n    const f = path.join(runDir(id), 'files.json');", "const f = path.join(runDir(id), 'files.json');"],
  ['forgetting a scan accepts any id', 'archivist.js', 'function deleteRun(id) { if (!validRun(id)) return false; try {', 'function deleteRun(id) { try {'],
  ['a cancelled scan keeps reading', 'archivist.js', "if (cancelled()) { stopped = 'cancelled'; break; }\n      if (now() > deadline) { stopped = 'slice'; break; }\n      progress({ phase: 'reading'", "if (now() > deadline) { stopped = 'slice'; break; }\n      progress({ phase: 'reading'"],
  ['a slice never ends', 'archivist.js', "if (cancelled()) { stopped = 'cancelled'; break; }\n      if (now() > deadline) { stopped = 'slice'; break; }\n      progress({ phase: 'reading'", "if (cancelled()) { stopped = 'cancelled'; break; }\n      progress({ phase: 'reading'"],
  ['the hashing step ignores the slice time', 'archivist.js', 'if (now() > deadline) { hashStopped = true; break; }', ''],
  ['a model that is gone is treated as one odd answer', 'archivist.js', 'catch (e) { if (/^(rendering:|llm_unavailable)/.test(e.message) || ++modelErrors >= 5) { persist(); throw e; } r = null; }', 'catch (e) { r = null; }'],
  ['one odd answer ends the whole scan', 'archivist.js', '|| ++modelErrors >= 5) { persist(); throw e; } r = null; }', '|| ++modelErrors >= 1) { persist(); throw e; } r = null; }'],
  // (not listed: "cancelled: () => job.cancel || renderBusy()" - the model call itself also refuses while a client is rendering, so the render pause is guarded twice)
  ['a slice may run for ever', 'node-agent.js', 'deadline: Date.now() + (archiveSliceMs > 0 ? archiveSliceMs : job.params.sliceMinutes * 60000)', 'deadline: Date.now() + 1e12'],
  ['the PC forgets a run that is being read', 'node-agent.js', "if (busy) return send(409, { ok: false, error: 'That run is still being worked on: cancel it first.' });", ''],
  ['a scan is no longer treated as confidential on the PC', 'node-agent.js', "confidential: b.type === 'archive.scan' ? true : !!b.confidential", 'confidential: !!b.confidential'],

  // ── duplicates: what is called a copy ──
  ['files of the same size are called exact copies', 'archivist.js', "const k = f.size + ':' + f.hash;", "const k = f.size + ':';"],
  ['text that merely resembles another is called a near copy', 'archivist.js', 'if (d <= 3 &&', 'if (d <= 40 &&'],

  // ── only PC-1, only the local lane, only with the key ──
  ['a scan may run on any PC', 'dispatcher.js', "&& (!pinned || (d.source === 'local' && d.stats && d.stats.archive && d.stats.archive.enabled))", ''],
  ['a folder that is not allowed keeps being retried', 'dispatcher.js', 'const PERMANENT = /^archive:|allowed list|', 'const PERMANENT = /^never-matches|'],
  ['the launcher\'s proxy reaches any PC', 'hub.js', "if (!d || !d.online || d.source !== 'local') throw new Error('the Archivist runs only on the launcher PC, and it is not online');", ''],
  ['the proxy forwards any path to the agent', 'hub.js', "if (!/^\\/v1\\/archive\\/[\\w/.?=&%+~!*'()-]*$/.test(target) || /\\.\\./.test(target.split('?')[0])) throw new Error('bad archive request');", ''],
  ['any PC with the Archivist on may be chosen', 'hub.js', "d.source === 'local' && d.online && d.stats && d.stats.archive && d.stats.archive.enabled", 'd.online && d.stats && d.stats.archive && d.stats.archive.enabled'],
  ['the archive routes need no key', 'index.js', "if (!p.startsWith('/api/bridge/') && !p.startsWith('/api/taskio/') && !p.startsWith('/api/archive/')) return false;\n    if (!isAuthed(req)) {", "if (!p.startsWith('/api/bridge/') && !p.startsWith('/api/taskio/') && !p.startsWith('/api/archive/')) return false;\n    if (false) {"],
  ['a scan task is not pinned to PC-1', 'taskio.js', "return { type: 'archive.scan', pin: 'local',", "return { type: 'archive.scan',"],
  ['a path with control characters is accepted into the queue', 'taskio.js', "|| p.path.length > 500 || /[\\u0000-\\u001f]/.test(p.path)) return null;", ') return null;'],
  ['the archive area can go to the cloud', 'policy.js', "archive: 'local',", "archive: 'cloud',"],
  ['the archive area is not confidential', 'policy.js', "'management', 'archive'],", "'management'],"],
  ['a long scan does not continue after a slice', 'archive.js', "if (dg.done || dg.status === 'cancelled' || !(dg.remaining > 0)) return true;", 'return true;'],
  ['a folder can be scanned twice at once', 'archive.js', "if (busy) return { ok: false, code: 'busy', error: 'That folder is already being scanned.', taskId: busy.id };", ''],
  ['the proxy lets ".." climb out of the archive paths', 'hub.js', "|| /\\.\\./.test(target.split('?')[0])) throw new Error('bad archive request');", ") throw new Error('bad archive request');"],
  // (not listed: the launcher's own "still being worked on" check in archive.js forget() - the PC refuses the same thing, which is what the test relies on)
];
module.exports.TESTS = ['archivist.test.js', 'archive.test.js'];
