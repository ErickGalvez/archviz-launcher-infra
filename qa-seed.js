'use strict';
// QA cases shipped with the launcher (qa-seed/*.json, each { "cases": [...] }). On start the launcher adds every shipped case its QA library has never had,
// once: an id the library has had before is left alone, even if it was deleted since (the ids offered are kept in qa-data.json as `seeded`), so a case
// the owner removed does not come back, and a case the owner edited is never overwritten. An empty library is left alone too: the QA console offers to
// import its own starting cases into it, and that import only runs on an empty library.
const fs = require('fs');
const path = require('path');

const ID = /^[A-Z]{2,4}-[A-Z0-9]{1,6}$/;
const TEXT = ['component', 'title', 'priority', 'type', 'platform', 'preconditions', 'steps', 'expected', 'evidence', 'status'];

function readSeeds(dir) {
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort(); } catch (e) { return out; }
  for (const f of files) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (e) { continue; }      // a broken file is skipped, never half-read
    for (const c of (j && Array.isArray(j.cases) ? j.cases : [])) {
      if (!c || !ID.test(String(c.id || ''))) continue;
      const clean = { id: c.id };
      for (const k of TEXT) if (typeof c[k] === 'string') clean[k] = c[k].slice(0, k === 'steps' || k === 'expected' ? 4000 : 400);
      clean.real = c.real === true;
      clean.seededFrom = f;
      out.push(clean);
    }
  }
  return out;
}

// cases: the library now; seeded: ids offered before. Returns the new library, the new `seeded` list, and the ids added this time.
function seed({ cases, seeded = [], dir, now = () => new Date().toISOString() }) {
  const shipped = readSeeds(dir), have = new Set(cases.map((c) => c && c.id)), offered = new Set(seeded);
  if (!cases.length) return { cases, seeded, added: [] };
  const added = [], next = cases.slice();
  for (const c of shipped) {
    if (offered.has(c.id)) continue;
    offered.add(c.id);
    if (have.has(c.id)) continue;
    next.push({ ...c, addedAt: now() }); have.add(c.id); added.push(c.id);
  }
  return { cases: next, seeded: [...offered], added };
}

module.exports = { seed, readSeeds };
