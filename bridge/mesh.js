'use strict';
// Zed's 3D models, the launcher's half: it stores the reference images you upload and serves the models the worker makes. It starts no process:
// the GPU work is done by the mesh worker on PC-1 (mcp/mesh-maker/worker.mjs in the website repo), which watches the same folder.
//
//   <root>/inbox/<id>.<png|jpg|webp>   the reference image          <root>/jobs/<id>.json   the job (queued -> working -> done | failed)
//   <root>/out/<id>.glb                the model                    <root>/jobs/worker.json what the worker last said (heartbeat)
//
// root: bridge.json { "mesh": { "root": "<absolute path>" } }, else <launcher>/mesh (gitignored). Every id is checked against MESH_ID_RE before it
// becomes part of a path; images are checked by their first bytes, not their name; the page gets files back only by id and kind.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MESH_ID_RE = /^mj_[0-9a-f]{12}$/;
const MAX_IMAGE = 10 * 1024 * 1024;
const KINDS = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const MAGIC = { png: (b) => b.length > 8 && b.readUInt32BE(0) === 0x89504e47, jpg: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  webp: (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' };
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

function createMesh({ dir, log = () => {}, rootFrom = () => null, now = Date.now }) {
  const root = () => { const r = rootFrom(); return typeof r === 'string' && path.isAbsolute(r) ? r : path.join(dir, 'mesh'); };
  const sub = (s) => { const d = path.join(root(), s); fs.mkdirSync(d, { recursive: true }); return d; };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
  const jobFile = (id) => path.join(sub('jobs'), id + '.json');

  function list() {
    let names = []; try { names = fs.readdirSync(sub('jobs')).filter((f) => MESH_ID_RE.test(f.replace(/\.json$/, ''))); } catch (e) { /* none */ }
    const jobs = names.map((f) => readJson(path.join(sub('jobs'), f))).filter(Boolean).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 40);
    const w = readJson(path.join(sub('jobs'), 'worker.json'));
    const fresh = w && now() - (w.at || 0) < 2 * 60000;
    return { ok: true, jobs: jobs.map((j) => ({ id: j.id, name: j.name, faces: j.faces, status: j.status, createdAt: j.createdAt, startedAt: j.startedAt || null, doneAt: j.doneAt || null,
      seconds: j.seconds || null, vertices: j.vertices || null, triangles: j.triangles || null, error: j.error ? clip(j.error, 300) : null, note: j.note ? clip(j.note, 300) : null, hasModel: j.status === 'done' })),
      worker: w ? { online: !!fresh, at: w.at, status: clip(w.status, 120), model: clip(w.model, 80), gpu: clip(w.gpu, 120) } : { online: false } };
  }

  function upload(req, res, u, { json, cors }) {
    const ext = String(u.searchParams.get('ext') || '').toLowerCase().replace('jpeg', 'jpg');
    if (!KINDS[ext]) { req.resume(); json(400, { ok: false, error: 'The image must be a PNG, JPG or WEBP.' }); return true; }
    const name = clip(u.searchParams.get('name') || 'model', 60) || 'model';
    const faces = Math.max(2000, Math.min(200000, parseInt(u.searchParams.get('faces'), 10) || 40000));
    const chunks = []; let size = 0, big = false;
    req.on('data', (d) => { if (big) return; size += d.length; if (size > MAX_IMAGE) { big = true; res.writeHead(413, { 'Content-Type': 'application/json', Connection: 'close', ...cors }); res.end(JSON.stringify({ ok: false, error: 'The image is over 10 MB.' }), () => req.destroy()); return; } chunks.push(d); });
    req.on('end', () => {
      if (big) return;
      const buf = Buffer.concat(chunks);
      if (!MAGIC[ext](buf)) return json(400, { ok: false, error: 'That file is not a ' + ext.toUpperCase() + ' image.' });
      const id = 'mj_' + crypto.randomBytes(6).toString('hex');
      try {
        fs.writeFileSync(path.join(sub('inbox'), id + '.' + ext), buf);
        fs.writeFileSync(jobFile(id), JSON.stringify({ id, name, faces, ext, status: 'queued', createdAt: now() }, null, 2));
      } catch (e) { log('mesh: could not store an upload: ' + e.message); return json(500, { ok: false, error: 'The image could not be stored.' }); }
      log('mesh: queued ' + id + ' (' + name + ', ' + Math.round(buf.length / 1024) + ' KB)');
      json(200, { ok: true, id, status: 'queued' });
    });
    return true;
  }

  function file(res, u, { cors }) {
    const id = u.searchParams.get('id') || '', kind = u.searchParams.get('kind') || '';
    const no = (code, msg) => { res.writeHead(code, { 'Content-Type': 'application/json', ...cors }); res.end(JSON.stringify({ ok: false, error: msg })); return true; };
    if (!MESH_ID_RE.test(id)) return no(400, 'bad id');
    const job = readJson(jobFile(id)); if (!job) return no(404, 'no such model');
    let f, type;
    if (kind === 'image' && KINDS[job.ext]) { f = path.join(sub('inbox'), id + '.' + job.ext); type = KINDS[job.ext]; }
    else if (kind === 'glb') { f = path.join(sub('out'), id + '.glb'); type = 'model/gltf-binary'; }
    else return no(400, 'kind must be image or glb');
    let st; try { st = fs.statSync(f); } catch (e) { return no(404, kind === 'glb' ? 'the model is not ready' : 'no image'); }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="' + id + (kind === 'glb' ? '.glb' : '.' + job.ext) + '"', ...cors });
    const s = fs.createReadStream(f); s.on('error', () => res.destroy()); res.on('close', () => s.destroy()); s.pipe(res);
    return true;
  }

  function remove(id) {
    if (!MESH_ID_RE.test(String(id || ''))) return { ok: false, error: 'bad id' };
    const job = readJson(jobFile(id)); if (!job) return { ok: false, error: 'no such model' };
    if (job.status === 'working') return { ok: false, error: 'The worker is making this model right now; delete it when it is done.' };
    for (const f of [jobFile(id), path.join(sub('out'), id + '.glb'), KINDS[job.ext] ? path.join(sub('inbox'), id + '.' + job.ext) : null]) if (f) try { fs.unlinkSync(f); } catch (e) { /* already gone */ }
    return { ok: true };
  }

  function handle(req, res, u, { json, cors }) {
    const p = u.pathname, reply = (code, obj) => json(code, obj);
    if (req.method === 'GET' && p === '/api/mesh/jobs') { reply(200, list()); return true; }
    if (req.method === 'POST' && p === '/api/mesh/upload') return upload(req, res, u, { json: reply, cors });
    if (req.method === 'GET' && p === '/api/mesh/file') return file(res, u, { cors });
    if (req.method === 'POST' && p === '/api/mesh/delete') {
      let body = ''; req.setEncoding('utf8');
      req.on('data', (d) => { if (body.length < 1024) body += d; });
      req.on('end', () => { let b = {}; try { b = JSON.parse(body || '{}'); } catch (e) { /* bad body */ } const r = remove(b.id); reply(r.ok ? 200 : /no such/.test(r.error) ? 404 : 400, r); });
      return true;
    }
    req.resume(); reply(404, { ok: false, error: 'Not found' }); return true;
  }

  return { handle, list, remove, root, MESH_ID_RE };
}

module.exports = { createMesh, MESH_ID_RE, MAGIC };
