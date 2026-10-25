'use strict';
// Mutations for the ticket model, Vera (the verifier) and the fix-note reader: bridge.mutation.js breaks ONE protection at a time in a copy of
// bridge/ and requires tickets.test.js, verifier.test.js, fixnote.test.js (or the older tests) to go red.
// [name, file, exact text to find, replacement]
const raw = String.raw;
module.exports = [
  // ── the ticket model: what a fix note must contain, and what a verdict may do ──
  ['a fix note without a root cause is accepted', 'tickets.js', "if (!rootCause) throw new Error('rootCause is required: say why it happened');", ''],
  ['a fix note without a solution is accepted', 'tickets.js', "if (!solution) throw new Error('solution is required: say how it was solved');", ''],
  ['a commit that is not a git sha is accepted', 'tickets.js', "if (commit && !SHA.test(commit)) throw new Error('commit must be a git sha (7-40 hex characters)');", ''],
  ['a website change needs no commit', 'tickets.js', "if (!commit && (repo === 'website' || repo === 'launcher')) throw new Error('commit is required for a change in the ' + repo + ' repo');", ''],
  ['the commit link can be supplied by the request', 'tickets.js', 'commitUrl: commitUrl(repo, commit),', 'commitUrl: i.commitUrl || commitUrl(repo, commit),'],
  ['a verdict for an old fix revision is accepted', 'tickets.js', "if (Number(i.fixRev) !== bug.fixRev) throw new Error('stale: the ticket is at fix revision ' + bug.fixRev);", ''],
  ['"unsure" reopens the ticket', 'tickets.js', "if (v.result === 'failed') bug.status = 'open';", "if (v.result !== 'verified') bug.status = 'open';"],
  ['"failed" does not reopen the ticket', 'tickets.js', "if (v.result === 'failed') bug.status = 'open';", ''],
  ['the public list shows the whole fix note', 'tickets.js', 'fix: fix ? { rev: fix.rev, repo: fix.repo, commit: fix.commit, commitUrl: fix.commitUrl, by: fix.by, at: fix.at } : null,', 'fix: fix,'],
  ['a verifier is asked about a fix it already judged', 'tickets.js', "return !(b.comments || []).some((c) => c.kind === 'verification' && c.verification && c.verification.by === by && c.verification.fixRev === b.fixRev);", 'return true;'],
  ['a reopened ticket is not shown as reopened', 'tickets.js', "if (b.status === 'open' && current && v.result === 'failed') return 'reopened';", ''],
  ['a won\'t-fix ticket is still in the queue', 'tickets.js', "if (b.status === 'wontfix') return 'closed';", ''],
  ['an edit accepts any status', 'tickets.js', "if (has('status') && STATUSES.includes(src.status))", "if (has('status'))"],
  ['an unknown priority is stored as it is', 'tickets.js', "priority: PRIORITIES.includes(i.priority) ? i.priority : 'medium',", 'priority: i.priority,'],
  ['a new ticket takes the status the request names', 'tickets.js', "status: 'open',", "status: i.status || 'open',"],
  ['a thread grows without limit', 'tickets.js', 'const MAX_COMMENTS = 300;', 'const MAX_COMMENTS = 30000;'],
  ['a code snippet may be huge', 'tickets.js', 'const after = clipCode(s.after, 4000), before = clipCode(s.before, 4000);', 'const after = clipCode(s.after, 400000), before = clipCode(s.before, 400000);'],
  ['a fix note may list any number of files', 'tickets.js', '.map((f) => clip(f, 200)).filter(Boolean).slice(0, 20);', '.map((f) => clip(f, 200)).filter(Boolean).slice(0, 2000);'],
  ['a snippet loses its indentation', 'tickets.js', raw`.replace(/^\n+/, '').replace(/\s+$/, '').slice(0, n);`, '.trim().slice(0, n);'],

  // ── Vera: what she may read, what fails a fix, what the model can and cannot change ──
  ['keys, vaults and logs can be read', 'verifier.js', '|| FORBIDDEN.test(r) || !READABLE.test(r)) return null;', '|| !READABLE.test(r)) return null;'],
  ['any kind of file can be read', 'verifier.js', '|| FORBIDDEN.test(r) || !READABLE.test(r)) return null;', '|| FORBIDDEN.test(r)) return null;'],
  ['a symbolic link out of the checkout is followed', 'verifier.js', "if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return { error: 'path not allowed' };", ''],
  ['a missing file never fails a fix', 'verifier.js', 'out.hardFail = checks.some((c) => c.hard && c.ok === false);', 'out.hardFail = false;'],
  ['new code that is not in the file passes', 'verifier.js', 'ok: parts.length > 0 && !missing.length, hard: true,', 'ok: true, hard: true,'],
  ['an old line that is still there fails the fix outright', 'verifier.js', 'hard: !snippet.after,', 'hard: true,'],
  ['a fix that is not in the code is only "unsure"', 'verifier.js', "result: 'failed', method: 'static'", "result: 'unsure', method: 'static'"],
  ['the model\'s doubt reopens a ticket', 'verifier.js', "if (model.verdict === 'not_verified') return { result: 'unsure',", "if (model.verdict === 'not_verified') return { result: 'failed',"],
  ['the model verifies a fix with an old line still in the file', 'verifier.js', "if (model.verdict === 'verified' && !st.softFail)", "if (model.verdict === 'verified')"],
  ['every answer reads as verified', 'verifier.js', "(/^NOT/i.test(m[1]) ? 'not_verified' : m[1].toLowerCase())", "'verified'"],
  ['a self-contradicting answer is believed', 'verifier.js', 'if (new Set(found).size > 1)', 'if (false)'],
  ['a failing static check still goes to the model', 'verifier.js', 'if (st.skipped || st.hardFail || st.weak) {', 'if (st.skipped) {'],
  ['the same revision is queued again and again', 'verifier.js', 'if (active.length || failedLately.length) { out.skipped++; continue; }', 'if (false) { out.skipped++; continue; }'],
  ['a failed attempt is retried at once', 'verifier.js', 'taskio.recent(now() - 12 * 3600000,', 'taskio.recent(now() - 0,'],
  ['a fix she already verified is checked again', 'verifier.js', '.filter((b) => (!only || b.id === only) && T.needsVerification(b, NAME));', ".filter((b) => (!only || b.id === only) && b.status === 'fixed');"],
  ['an answer for an old fix revision is recorded', 'verifier.js', 'bug.fixRev !== Number(m[2]) ||', 'false ||'],
  ['the files are not checked again when the answer arrives', 'verifier.js', 'combine(st, parseVerdict(task.result && task.result.text))', 'combine({ checks: [], hardFail: false, softFail: false, weak: false }, parseVerdict(task.result && task.result.text))'],
  ['she acts on anyone\'s finished task', 'verifier.js', 'if (!task || task.handler !== HANDLER) return false;', 'if (!task) return false;'],
  ['a fix-time check waits for the night window', 'verifier.js', "source: priority > 0 ? 'bridge' : 'routine'", "source: 'routine'"],
  ['a regression run can be any size', 'verifier.js', 'const n = Math.min(10, Math.max(5, Math.round(pick.list.length * 0.3)));', 'const n = Math.min(20, Math.max(1, Math.round(pick.list.length * 0.3)));'],
  ['a new suggestion is made while one is waiting', 'verifier.js', "history.some((r) => r.status === 'suggested' && now() - Date.parse(r.at) < 21 * DAY)", 'false'],
  ['she picks a regression every time she is asked', 'verifier.js', 'if (!force && rand() >= chance)', 'if (false)'],
  ['a feature with two cases is picked for a "regression run"', 'verifier.js', '.filter(([, l]) => l.length >= 5);', '.filter(([, l]) => l.length >= 1);'],
  ['retired cases are put in regression runs', 'verifier.js', "!/retired|deprecated/i.test(String(c.status || ''))", 'true'],
  ['cases behind a recent fix are not picked first', 'verifier.js', '[linked.has(c.id) ? 0 : 1, prioOf(c),', '[1, prioOf(c),'],
  ['a recent fix does not make its feature likelier', 'verifier.js', 'if (hit) { w += hit; fixes++; }', 'if (hit) { fixes++; }'],
  ['a feature picked yesterday is as likely as one never picked', 'verifier.js', 'const quiet = lastPicked(id) ? Math.min(2, (now() - lastPicked(id)) / (28 * DAY)) : 2;', 'const quiet = 2;'],

  // ── the glue: who may trigger her, which routines she has, which lane she is on ──
  ['a routine for a cloud-lane area runs as an action', 'routines.js', "if (r.kind === 'action' && lane !== 'local') {", 'if (false) {'],
  ['an action routine with no verifier crashes instead of skipping', 'routines.js', "if (!verifier) { done({ lastResult: 'skipped: no verifier' }); return { ok: true, skipped: 'no verifier' }; }", ''],
  ['tasks lose the handler that ties them to Vera', 'taskio.js', 'handler: clip(input.handler, 20) || undefined, ', ''],
  ['a finished task is never handed to the verifier', 'dispatcher.js', "try { onDone(taskio.getRaw(t.id)); } catch (e) { log('on-done handler failed: ' + e.message); }", ''],
  ['a web request can set a task\'s handler', 'index.js', ', proposal: undefined, handler: undefined })', ', proposal: undefined })'],
  ['the dispatcher is not wired to Vera', 'index.js', 'onDone: (t) => verifier.handleDone(t)', 'onDone: () => {}'],
  ['the routines are not given Vera', 'index.js', 'kick: () => dispatcher.kick(), log, verifier });', 'kick: () => dispatcher.kick(), log });'],
  ['a folder that does not exist or is relative is read', 'index.js', 'path.isAbsolute(v) && fs.existsSync(v)', 'true'],
  ['Vera is not on the local lane', 'policy.js', "verify: 'local',", ''],

  // ── the fix-note reader ──
  ['the old and new code are swapped in a snippet', 'fixnote.js', "before: fitLines(h.oldLines).join('\\n'), after: fitLines(h.newLines).join('\\n')", "before: fitLines(h.newLines).join('\\n'), after: fitLines(h.oldLines).join('\\n')"],
  ['a note with no root cause or solution is recorded', 'fixnote.js', 'if (!s.rootCause || !s.solution) {', 'if (false) {'],
  ['a note is recorded on a won\'t-fix ticket', 'fixnote.js', "if (t.status === 'wontfix') {", 'if (false) {'],
  ['the snippet shows a test file instead of the fix', 'fixnote.js', raw`const TEST_OR_DOC = /(^|\/)(tests?|__tests__|docs?)\/|\.(test|spec)\.[a-z]+$|\.md$/i;`, 'const TEST_OR_DOC = /^$/;'],
  ['a snippet may be as long as it likes', 'fixnote.js', 'const MAX_SNIPPET = 3600;', 'const MAX_SNIPPET = 36000;'],
  ['added lines are not read from a diff', 'fixnote.js', "if (c === '+') { hunk.newLines.push(text); hunk.added++; }", "if (c === '+') { hunk.added++; }"],
];
module.exports.TESTS = ['tickets.test.js', 'verifier.test.js', 'fixnote.test.js'];
