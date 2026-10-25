'use strict';
// Turns what a fixer already wrote (a unified diff, and a pull request's description) into the structured fix note a ticket takes
// (bridge/tickets.js addFix). Pure text in, plain objects out: no files, no git, no network. The same code serves the fix-note command line
// tool (devconsole/fix-note.js, which runs `git show`) and the Dev Console merge hook (which reads the pull request from GitHub).
//
// A pull request that fixes tickets carries one section per ticket in its description, in this shape (the fix brief Task-IO prepares asks for it):
//
//   ### Fix note: bug_0123456789ab
//   Root cause: why it happened
//   How it was solved: what was changed
//   Context: what this code does and where it runs
//   Dev notes: anything worth knowing later
//   Files: archviz/app.js, archviz/styles.css      (optional: otherwise the files the diff touches)

const MAX_SNIPPET = 3600;                       // tickets.js keeps 4000 characters of code; staying under it means a line is never cut in half
const MAX_LINES = 60;
const TEST_OR_DOC = /(^|\/)(tests?|__tests__|docs?)\/|\.(test|spec)\.[a-z]+$|\.md$/i;

// A unified diff -> [{ file, hunks: [{ oldLines, newLines, added, removed }], deleted }]. Binary files are left out.
function parseDiff(diff) {
  const files = []; let cur = null, hunk = null;
  for (const line of String(diff || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (line.startsWith('diff --git ')) { const m = / b\/(.+)$/.exec(line); cur = { file: m ? m[1] : '', hunks: [], deleted: false, binary: false }; files.push(cur); hunk = null; continue; }
    if (!cur) continue;
    if (!hunk && line.startsWith('deleted file mode')) { cur.deleted = true; continue; }
    if (!hunk && (line.startsWith('Binary files') || line.startsWith('GIT binary patch'))) { cur.binary = true; continue; }
    if (line.startsWith('@@')) { hunk = { oldLines: [], newLines: [], added: 0, removed: 0 }; cur.hunks.push(hunk); continue; }
    if (!hunk || line.startsWith('\\')) continue;          // the file header lines before the first hunk, and "\ No newline at end of file"
    const c = line[0], text = line.slice(1);
    if (c === '+') { hunk.newLines.push(text); hunk.added++; }
    else if (c === '-') { hunk.oldLines.push(text); hunk.removed++; }
    else if (c === ' ') { hunk.oldLines.push(text); hunk.newLines.push(text); }
  }
  return files.filter((f) => f.file && !f.binary);
}
const changed = (f) => f.hunks.reduce((n, h) => n + h.added + h.removed, 0);

// Keeps a long run of lines within a character budget: the start and the end, with a line holding only "..." where the middle was left out
// (the verifier reads that as "skipped lines" and looks for each part on its own).
function fitLines(lines, maxLines = MAX_LINES, maxChars = MAX_SNIPPET) {
  const size = (l) => l.reduce((n, x) => n + x.length + 1, 0);
  if (lines.length <= maxLines && size(lines) <= maxChars) return lines;
  const budget = maxChars - 8, head = [], tail = [];
  let used = 0, i = 0, j = lines.length - 1;
  while (i <= j && head.length < maxLines / 2 && used + lines[i].length + 1 <= budget / 2) { head.push(lines[i]); used += lines[i].length + 1; i++; }   // the start gets up to half
  while (j >= i && head.length + tail.length < maxLines - 1 && used + lines[j].length + 1 <= budget) { tail.unshift(lines[j]); used += lines[j].length + 1; j--; }   // the end gets the rest
  return head.concat(['...'], tail);
}

// The file a snippet should show: the one named, else the biggest change outside tests and docs, else the biggest change.
function primaryFile(files, prefer) {
  const live = files.filter((f) => !f.deleted && f.hunks.length);
  const named = (prefer || []).map((p) => live.find((f) => f.file === p)).filter(Boolean);
  const pool = named.length ? named : live.filter((f) => !TEST_OR_DOC.test(f.file)).length ? live.filter((f) => !TEST_OR_DOC.test(f.file)) : live;
  return pool.slice().sort((a, b) => changed(b) - changed(a))[0] || null;
}

// before = the old side of the biggest hunk, after = the new side (context included, so the new lines are contiguous in the file).
function snippetFromDiff(files, prefer) {
  const f = primaryFile(files, prefer);
  if (!f) return null;
  const h = f.hunks.slice().sort((a, b) => (b.added + b.removed) - (a.added + a.removed))[0];
  const lang = (/\.([a-z0-9]+)$/i.exec(f.file) || [])[1] || '';
  return { file: f.file, lang: lang.toLowerCase(), before: fitLines(h.oldLines).join('\n'), after: fitLines(h.newLines).join('\n') };
}

const LABELS = [
  ['rootCause', /^(?:root cause|cause)\s*:\s*/i], ['solution', /^(?:how it was solved|solution|fix)\s*:\s*/i], ['context', /^context\s*:\s*/i],
  ['notes', /^(?:dev notes|notes)\s*:\s*/i], ['files', /^files?\s*:\s*/i],
];
// A pull request description -> [{ ticket, rootCause, solution, context, notes, files }], one per "### Fix note: bug_..." section.
function parsePrBody(body) {
  const out = [], text = String(body || '').replace(/\r\n?/g, '\n');
  const parts = text.split(/^#{2,4}[ \t]*fix note[ \t]*:[ \t]*(bug_[0-9a-f]{12})[ \t]*$/im);
  for (let i = 1; i < parts.length; i += 2) {
    const note = { ticket: parts[i].toLowerCase(), rootCause: '', solution: '', context: '', notes: '', files: [] };
    let key = null;
    for (const raw of parts[i + 1].split('\n')) {
      if (/^#{1,4}\s/.test(raw)) break;                      // another heading ends the section
      const hit = LABELS.find(([, re]) => re.test(raw.trim()));
      if (hit) { key = hit[0]; const rest = raw.trim().replace(hit[1], ''); if (key === 'files') note.files = rest.split(/[,\s]+/).map((s) => s.replace(/^`|`$/g, '')).filter(Boolean); else note[key] = rest; }
      else if (key && key !== 'files') note[key] += (note[key] ? '\n' : '') + raw;
    }
    for (const k of ['rootCause', 'solution', 'context', 'notes']) note[k] = note[k].trim();
    out.push(note);
  }
  return out;
}

// The notes a merged pull request should leave on the tickets it names. `tickets` is the store's list; a section that names a ticket that is
// not there, is closed as won't fix, or lacks a root cause or a solution is reported in `skipped` instead of being recorded.
function buildFixNotes({ body, diff, sha, repoKey, tickets, by = 'Dex', role = 'Developer' }) {
  const files = parseDiff(diff), notes = [], skipped = [];
  for (const s of parsePrBody(body)) {
    const t = (tickets || []).find((b) => b.id === s.ticket);
    if (!t) { skipped.push({ ticket: s.ticket, reason: 'no such ticket' }); continue; }
    if (t.status === 'wontfix') { skipped.push({ ticket: s.ticket, reason: "marked won't fix" }); continue; }
    if (!s.rootCause || !s.solution) { skipped.push({ ticket: s.ticket, reason: 'the section needs a root cause and how it was solved' }); continue; }
    const listed = s.files.filter((f) => files.some((d) => d.file === f));
    notes.push({ ticketId: s.ticket, input: { repo: repoKey, commit: sha, files: (listed.length ? listed : s.files.length ? s.files : files.filter((f) => !f.deleted).map((f) => f.file)).slice(0, 20),
      rootCause: s.rootCause, solution: s.solution, context: s.context, notes: s.notes, snippet: snippetFromDiff(files, listed.length ? listed : s.files), by, role } });
  }
  return { notes, skipped };
}

module.exports = { parseDiff, snippetFromDiff, fitLines, primaryFile, parsePrBody, buildFixNotes, MAX_SNIPPET };
