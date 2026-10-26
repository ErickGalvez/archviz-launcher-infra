'use strict';
// The Archivist: the engine of the secret department. It walks a folder the owner names, reads or interprets the files one by one with the local model (Qwen),
// and returns a catalog: what each file is, suggested projects, and possible duplicates. It never leaves PC-1 and it never changes a file.
//
// This is a port of the FileArchive prototype (PyQt6 + Ollama + SQLite, see devconsole/archive.html for the new 3D map) to the bridge:
//   scanner + dependency detector -> walk(), classifyDependency()     AI analysis (llava) -> interpret() with Qwen; media by folder
//   duplicate finder (sha256 + pHash) -> exact (sha256), near (simhash of the text), versions (name stems)
//   K-Means over tags -> Qwen groups the labels into projects        vault (private photos) -> name-based privacy flags, never read
//   transactions that move files -> deliberately NOT here: this engine is READ-ONLY.
//
// Safety model (the node agent is the only caller):
//   - A folder is only scanned if it is inside one of `roots`, which come from THIS PC's own config file (bridge-node.json "archive"), never from the network.
//     The request names a folder; it cannot widen the list. Links (symlinks, junctions) are never followed, so a link cannot lead out of a root.
//   - Secrets are never read: key files, .env, password stores, browser profiles, ssh/aws folders are listed by name only. Files whose NAME looks private
//     (intimate, banking, medical, passwords...) are not read either; the page masks their names until asked.
//   - Everything is clipped: bytes read per file, files per run, entries per list, time per slice. A run is resumable: its state is saved as it goes.
//   - It starts no process and opens no network connection of its own: the model call is handed in as llm().
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const WIN = process.platform === 'win32';
const SAMPLE_BYTES = 8192, PROMPT_CHARS = 1800, NEAR_BYTES = 32768, ZIP_TEXT_BYTES = 200000;
const DEFAULTS = { maxFiles: 400, maxFilesHard: 20000, walkCap: 250000, maxFolders: 3000, hashFullBytes: 256 * 1024 * 1024, hashPartBytes: 1024 * 1024, sliceMs: 10 * 60 * 1000, saveEvery: 15, saveMs: 20000, maxProjects: 14 };

// ── what a file is ──
const EXT = {
  image: '.jpg .jpeg .png .gif .bmp .tif .tiff .webp .heic .heif .raw .cr2 .nef .arw .dng .orf .rw2 .pef .sr2 .svg .ico',
  video: '.mp4 .mov .avi .mkv .wmv .flv .webm .m4v .3gp .mts .m2ts .mxf .mpg .mpeg',
  audio: '.mp3 .wav .flac .aac .ogg .m4a .wma .opus .aiff .aif .mid .midi',
  creative: '.psd .psb .ai .eps .blend .blend1 .fbx .obj .3ds .max .c4d .skp .dae .stl .ma .mb .uasset .umap .unitypackage .kra .xcf .sai .clip .aep .prproj .drp .gltf .glb .abc .usd .usdz',
  document: '.pdf .docx .doc .xlsx .xls .pptx .ppt .rtf .odt .ods .odp .epub .pages .key .numbers',
  text: '.txt .md .markdown .rst .log .csv .tsv .ini .cfg .conf .toml .yaml .yml .tex .srt .vtt .json .xml .html .htm .url .nfo',
  code: '.js .mjs .cjs .ts .tsx .jsx .py .rb .go .rs .java .kt .c .h .cpp .hpp .cc .cs .php .lua .sh .bat .cmd .ps1 .sql .swift .gd .gdshader .glsl .hlsl .usf .ush .uproject .uplugin .sln .vcxproj .gradle .css .scss .less .vue .svelte .r .m .pl',
  archive: '.zip .7z .rar .tar .gz .tgz .bz2 .xz .iso .cab',
  binary: '.exe .dll .msi .bin .dat .so .dylib .sys .drv .ocx .pak .bundle .cache',
  font: '.ttf .otf .woff .woff2 .fon',
};
const KIND_OF = {};
for (const [k, list] of Object.entries(EXT)) for (const e of list.split(' ')) KIND_OF[e] = k;
const ZIP_DOCS = new Set(['.docx', '.xlsx', '.pptx', '.odt', '.ods', '.odp']);
const kindOf = (ext) => KIND_OF[String(ext || '').toLowerCase()] || 'other';

// ── what must never be read (by name) ──
const SECRET_FILE = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|known_hosts|authorized_keys|credentials(\.[a-z]+)?|secrets?(\.[a-z]+)?|wallet\.dat|login data|cookies|web data|logins\.json|key[34]\.db|cert9\.db|\.htpasswd|master\.key|service[-_]?account.*\.json)$/i;
const SECRET_EXT = new Set(['.pem', '.key', '.pfx', '.p12', '.kdbx', '.kdb', '.keystore', '.jks', '.gpg', '.pgp', '.asc', '.ppk', '.ovpn', '.1pux', '.opvault']);
const SECRET_DIR = new Set(['.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'ssh-key', 'ssh-keys', '.password-store', 'keepass', 'bitwarden', 'wallets']);
const PRIVATE_NAME = /(nude|nsfw|intim|xxx|porn|onlyfans|erotic|sexy|private|privad[oa]|diary|diario|passwords?|contrase[ñn]as?|bank[-_ ]?statement|estado[-_ ]?de[-_ ]?cuenta|n[oó]mina|passport|pasaporte|curp\b|medical|m[eé]dic[oa]|receta|diagn[oó]stic|lab[-_ ]?results?|resultados?[-_ ]?de[-_ ]?lab|tax[-_ ]?return|declaraci[oó]n[-_ ]?anual)/i;
// the owner's company: its files are set aside, not sorted into the owner's other projects
const G741 = /(g741|archviz|arkwiz|arch[-_ ]?viz[-_ ]?challenge|pixel[-_ ]?stream|wilbur)/i;

// ── folders that are dependencies, not the owner's work (ported from the prototype's dependency detector) ──
const DEP_DIR = { node_modules: 'npm package', '.git': 'git internals', '.svn': 'svn internals', __pycache__: 'python bytecode', 'site-packages': 'python environment', 'dist-packages': 'python environment', '.venv': 'python environment', venv: 'python environment', '.virtualenv': 'python environment', '.cargo': 'rust cache', '.gradle': 'gradle cache', '.m2': 'maven cache', '.nuget': 'nuget cache', '.next': 'build output', '.nuxt': 'build output', '.cache': 'cache', '$recycle.bin': 'recycle bin', 'system volume information': 'system', appdata: 'application data', programdata: 'program data', windows: 'windows system', 'program files': 'installed programs', 'program files (x86)': 'installed programs', steamapps: 'game library', intermediate: 'engine build files', deriveddatacache: 'engine cache', binaries: 'build binaries', '.vs': 'visual studio cache', '.idea': 'ide settings' };
const BUILD_DIR = new Set(['dist', 'build', 'target', 'out', 'bin', 'obj', 'saved']);                       // only a dependency next to a project manifest
const MANIFEST = ['package.json', 'cargo.toml', 'pom.xml', 'build.gradle', 'cmakelists.txt', 'pyproject.toml', 'setup.py', 'requirements.txt'];
const SKIP_EXT = new Set(['.pyc', '.pyo', '.pyd', '.class', '.tmp', '.temp', '.bak~', '.lnk']);

const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const human = (b) => (b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(0) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(1) + ' MB' : (b / 1073741824).toFixed(2) + ' GB');
const lc = (s) => String(s || '').toLowerCase();
const isInside = (child, parent) => { const a = WIN ? lc(child) : child, b = WIN ? lc(parent) : parent; return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep); };

function classifyDependency(dirName, parentEntries) {
  const n = lc(dirName);
  if (DEP_DIR[n]) return DEP_DIR[n];
  if (BUILD_DIR.has(n) && parentEntries && parentEntries.some((e) => MANIFEST.includes(lc(e)))) return 'build output';
  return null;
}
const secretFile = (name) => SECRET_FILE.test(name) || SECRET_EXT.has(path.extname(name).toLowerCase());
const privateName = (rel) => PRIVATE_NAME.test(rel);

// ── names: the stem of a file without its copy/version noise, for "possible duplicates by name" ──
function nameStem(name) {
  let s = lc(path.basename(name, path.extname(name)));
  s = s.replace(/[\s_-]*\(\d+\)$/, '').replace(/[\s_-]*(copy|copia|copy of|copia de)([\s_-]*\d+)?$/i, '').replace(/^(copy|copia)( of| de)?[\s_-]+/i, '')
    .replace(/[\s_.-]*(v|ver|version)[\s_.-]?\d+([._]\d+)*$/i, '').replace(/[\s_.-]*(final|finale|def|definitivo|nuevo|new|old|viejo|backup|bak|edit|edited|rev\d*)[\s_.-]*\d*$/i, '')
    .replace(/[\s_.-]*(19|20)\d{2}[-_.]?\d{2}[-_.]?\d{2}$/, '').replace(/[\s_.-]+\d{1,3}$/, '');
  return s.replace(/[\s_.-]+/g, ' ').trim();
}

// ── similarity of text: a 64-bit simhash of word triples, as two 32-bit halves ──
function fnv32(str, seed) { let h = seed >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
function simhash(text) {
  const words = lc(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
  if (words.length < 12) return null;                                            // too little text to say anything about
  const acc = new Array(64).fill(0);
  for (let i = 0; i + 2 < words.length; i++) {
    const sh = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2], a = fnv32(sh, 2166136261), b = fnv32(sh, 0x9e3779b9);
    for (let k = 0; k < 32; k++) { acc[k] += (a >>> k) & 1 ? 1 : -1; acc[32 + k] += (b >>> k) & 1 ? 1 : -1; }
  }
  let hi = 0, lo = 0; for (let k = 0; k < 32; k++) { if (acc[k] > 0) lo |= 1 << k; if (acc[32 + k] > 0) hi |= 1 << k; }
  return [hi >>> 0, lo >>> 0];
}
const popcount = (x) => { x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
const hamming = (a, b) => popcount((a[0] ^ b[0]) >>> 0) + popcount((a[1] ^ b[1]) >>> 0);

// ── reading: a head sample of a text file, or the text of an office file (a zip of XML) ──
function readHead(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes), n = fs.readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n); } finally { fs.closeSync(fd); }
}
const looksBinary = (buf) => { const n = Math.min(buf.length, 2048); let odd = 0; for (let i = 0; i < n; i++) { const c = buf[i]; if (c === 0) return true; if (c < 7 || (c > 13 && c < 32)) odd++; } return n > 0 && odd / n > 0.1; };
function decodeText(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\ufeff/, '');
  return buf.toString('utf8').replace(/^\ufeff/, '');
}
function readZipText(file, wanted, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
    if (size < 22) return '';
    const tail = Buffer.alloc(Math.min(size, 66000)); fs.readSync(fd, tail, 0, tail.length, size - tail.length);
    let e = -1; for (let i = tail.length - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
    if (e < 0) return '';
    const cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
    if (cdOff === 0xffffffff || cdSize > 4 * 1024 * 1024 || cdOff + cdSize > size) return '';             // zip64 or nonsense: not read
    const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
    const hits = [];
    for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
      const method = cd.readUInt16LE(p + 10), csz = cd.readUInt32LE(p + 20), nl = cd.readUInt16LE(p + 28), xl = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32), off = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      if (wanted(name)) hits.push({ name, method, csz, off });
      p += 46 + nl + xl + cl;
    }
    hits.sort((a, b) => (a.name < b.name ? -1 : 1));
    let out = '';
    for (const h of hits.slice(0, 6)) {
      if (h.csz > 8 * 1024 * 1024) continue;
      const lh = Buffer.alloc(30); fs.readSync(fd, lh, 0, 30, h.off);
      if (lh.readUInt32LE(0) !== 0x04034b50) continue;
      const data = Buffer.alloc(h.csz); fs.readSync(fd, data, 0, h.csz, h.off + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28));
      let raw; try { raw = h.method === 0 ? data : h.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: 4 * 1024 * 1024 }) : null; } catch (err) { raw = null; }
      if (raw) out += raw.toString('utf8') + '\n';
      if (out.length > maxBytes) break;
    }
    return out;
  } catch (err) { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (e) { /* closed */ } }
}
const xmlText = (x) => String(x).replace(/<\/(w:p|a:p|text:p|text:h|row|si)>/g, '\n').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Math.min(+d, 0x10ffff))).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n');
function officeText(file, ext) {
  const pick = { '.docx': (n) => n === 'word/document.xml', '.xlsx': (n) => n === 'xl/sharedStrings.xml', '.pptx': (n) => /^ppt\/slides\/slide[1-4]\.xml$/.test(n), '.odt': (n) => n === 'content.xml', '.ods': (n) => n === 'content.xml', '.odp': (n) => n === 'content.xml' }[ext];
  return pick ? xmlText(readZipText(file, pick, ZIP_TEXT_BYTES)) : '';
}
// What the model gets to see of a file: { text, how } - text is '' when the file is not one we read.
function sampleOf(file, ext, kind, size) {
  try {
    if (ZIP_DOCS.has(ext)) { const t = officeText(file, ext); return { text: t.slice(0, SAMPLE_BYTES), how: t ? 'office' : '' }; }
    if (kind === 'text' || kind === 'code' || kind === 'other') {
      if (kind === 'other' && size > 2 * 1024 * 1024) return { text: '', how: '' };
      const buf = readHead(file, SAMPLE_BYTES);
      if (looksBinary(buf)) return { text: '', how: 'binary' };
      return { text: decodeText(buf), how: 'text' };
    }
  } catch (e) { return { text: '', how: 'unreadable' }; }
  return { text: '', how: '' };
}

// ── the model's answers ──
function jsonFrom(text) {
  const s = String(text || '').replace(/```(?:json)?/gi, '').replace(/<think>[\s\S]*?<\/think>/g, '');
  const i = s.indexOf('{'); if (i < 0) return null;
  for (let j = s.lastIndexOf('}'); j > i; j = s.lastIndexOf('}', j - 1)) { try { return JSON.parse(s.slice(i, j + 1).replace(/,\s*([}\]])/g, '$1')); } catch (e) { /* try a shorter slice */ } }
  return null;
}
const SYS_FILE = 'You catalog a person\'s old files for them. They also run a company called G741 Studio (ArchViz, pixel streaming); these files are NOT part of it unless the path or text clearly says so. Reply with ONE JSON object and nothing else: {"summary": "what this file is, 22 words at most", "topic": "1 to 3 words", "project": "short name of the project, course, trip, client or theme it belongs to, or empty if unclear", "tags": ["up to 4 short tags"], "g741": false}. Use only what you are given; never invent details; write in the language of the text.';
const SYS_FOLDER = 'You catalog a person\'s old files for them. They also run a company called G741 Studio; these files are NOT part of it unless the path clearly says so. You are shown ONE folder whose files could not be read (images, video, audio, 3D, binaries), so judge from the folder path, the file names and what its readable neighbours are about. Reply with ONE JSON object and nothing else: {"summary": "what this folder seems to hold, 25 words at most", "topic": "1 to 3 words", "project": "short name of the project, trip, course or theme, or empty if unclear", "g741": false}. Never invent details.';
const SYS_GROUP = 'You group labels into projects. You get a list of labels (each with how many files carry it). Reply with ONE JSON object and nothing else: {"projects": [{"name": "short project or theme name", "description": "15 words at most", "labels": ["exact label", "..."]}]}. At most MAX projects. Every label must be placed in exactly one project, spelled exactly as given. Put leftovers in a project called "Misc".';

function createArchivist(opts) {
  const { stateDir, llm, now = Date.now, log = () => {} } = opts;
  const limits = { ...DEFAULTS, ...(opts.limits || {}) };
  const rootsOf = () => (typeof opts.roots === 'function' ? opts.roots() : opts.roots || []).filter((r) => typeof r === 'string' && path.isAbsolute(r));
  fs.mkdirSync(stateDir, { recursive: true });

  // ── which folder may be scanned ──
  function check(input) {
    const s = String(input == null ? '' : input).trim();
    if (!s || s.length > 500 || /[\u0000-\u001f]/.test(s) || !path.isAbsolute(s)) return { ok: false, code: 'bad_path', error: 'Give a full local path, for example D:\\Old stuff' };
    const roots = rootsOf();
    if (!roots.length) return { ok: false, code: 'no_roots', error: 'No folder is allowed on this PC yet. On PC-1 run:  node bridge/archive-allow.js "' + s + '"' };
    let real; try { real = fs.realpathSync.native ? fs.realpathSync.native(s) : fs.realpathSync(s); } catch (e) { return { ok: false, code: 'not_found', error: 'That folder does not exist on this PC.' }; }
    let st; try { st = fs.statSync(real); } catch (e) { return { ok: false, code: 'not_found', error: 'That folder cannot be read.' }; }
    if (!st.isDirectory()) return { ok: false, code: 'not_dir', error: 'That is a file, not a folder.' };
    let allowed = false;
    for (const r of roots) { let rr; try { rr = fs.realpathSync.native ? fs.realpathSync.native(r) : fs.realpathSync(r); } catch (e) { continue; } if (isInside(real, rr)) { allowed = true; break; } }
    if (!allowed) return { ok: false, code: 'not_allowed', error: 'That folder is not on this PC\'s allowed list. On PC-1 run:  node bridge/archive-allow.js "' + s + '"' };
    return { ok: true, root: real };
  }

  // ── walking ──
  // Everything below `root`: files with their folder, minus links, dependency trees, secret folders. Counts every file; stops at walkCap.
  function walk(root, cancelled) {
    const files = [], deps = [], secrets = [], errors = { unreadable: 0 };
    let realRoot = root; try { realRoot = fs.realpathSync.native ? fs.realpathSync.native(root) : fs.realpathSync(root); } catch (e) { /* the check() already resolved it */ }
    const stack = [{ abs: root, rel: '' }]; let truncated = false;
    while (stack.length) {
      if (cancelled && cancelled()) break;
      const dir = stack.pop();
      try { const real = fs.realpathSync.native ? fs.realpathSync.native(dir.abs) : fs.realpathSync(dir.abs); if (!isInside(real, realRoot)) { errors.unreadable++; continue; } } catch (e) { errors.unreadable++; continue; }     // a junction the dirent did not show as a link: never read outside the root
      let ents; try { ents = fs.readdirSync(dir.abs, { withFileTypes: true }); } catch (e) { errors.unreadable++; continue; }
      const names = ents.map((e) => e.name);
      ents.sort((a, b) => (a.name < b.name ? 1 : -1));                                      // reversed: the stack pops them in name order
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;                                                    // never follow a link out of the root
        const rel = dir.rel ? dir.rel + '/' + e.name : e.name;
        if (e.isDirectory()) {
          const n = lc(e.name);
          if (SECRET_DIR.has(n)) { secrets.push({ rel, kind: 'folder' }); continue; }
          const dep = classifyDependency(e.name, names);
          if (dep) { if (deps.length < 300) deps.push({ rel, label: dep }); continue; }
          stack.push({ abs: path.join(dir.abs, e.name), rel });
        } else if (e.isFile()) {
          const ext = path.extname(e.name).toLowerCase();
          if (SKIP_EXT.has(ext) || e.name === 'desktop.ini' || e.name === 'Thumbs.db' || e.name === '.DS_Store') continue;
          let st; try { st = fs.statSync(path.join(dir.abs, e.name)); } catch (er) { errors.unreadable++; continue; }
          files.push({ rel, dir: dir.rel, name: e.name, ext, size: st.size, mtime: Math.round(st.mtimeMs) });
          if (files.length >= limits.walkCap) { truncated = true; stack.length = 0; break; }
        }
      }
    }
    return { files, deps, secrets, truncated, errors };
  }

  // ── state on disk: one folder per run ──
  const runDir = (id) => path.join(stateDir, id);
  const validRun = (id) => /^ar_[0-9a-f]{10}(_\d{1,10})?$/.test(String(id || ''));
  const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return fb; } };
  function writeJson(f, obj) { const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(obj)); fs.renameSync(tmp, f); }
  const runIdFor = (root, fresh) => 'ar_' + crypto.createHash('sha1').update(WIN ? lc(root) : root).digest('hex').slice(0, 10) + (fresh ? '_' + (now() % 1e9) : '');

  // ── the scan ──
  // params: { path, runId?, fresh?, maxFiles? }.  ctl: { cancelled(), deadline (ms timestamp), progress(p) }.  Resolves to a digest { done, runId, ... }; throws only for a path that is not allowed.
  async function scan(params, ctl = {}) {
    const chk = check(params && params.path); if (!chk.ok) { const e = new Error(chk.error); e.code = chk.code; throw e; }
    const root = chk.root, started = now(), deadline = ctl.deadline || started + limits.sliceMs;
    const cancelled = () => !!(ctl.cancelled && ctl.cancelled());
    const maxFiles = Math.min(Math.max(parseInt(params.maxFiles, 10) || limits.maxFiles, 1), limits.maxFilesHard);
    const id = validRun(params.runId) ? params.runId : runIdFor(root, !!params.fresh), dir = runDir(id);
    const progress = (p) => { try { if (ctl.progress) ctl.progress({ ...p, runId: id }); } catch (e) { /* a progress hook must not stop the scan */ } };     // the run id lets the PC refuse to forget a run that is being read
    fs.mkdirSync(dir, { recursive: true });
    const meta = readJson(path.join(dir, 'meta.json'), null) || { id, root, createdAt: started, slices: 0 };
    if (meta.root !== root) { const e = new Error('that run belongs to another folder'); e.code = 'bad_run'; throw e; }
    meta.status = 'running'; meta.slices = (meta.slices || 0) + 1; meta.maxFiles = maxFiles; meta.updatedAt = started;
    const prevList = readJson(path.join(dir, 'files.json'), []), prev = new Map(prevList.map((f) => [f.rel, f]));

    // 1. walk
    progress({ phase: 'walking', done: 0, total: 0 });
    const w = walk(root, cancelled);
    const folders = new Map();
    const fold = (d) => { let f = folders.get(d); if (!f) { f = { dir: d, files: 0, bytes: 0, kinds: {}, catalogued: 0 }; folders.set(d, f); } return f; };
    const catalog = [];
    w.files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    let id1 = 0;
    for (const f of w.files) {
      const kind = kindOf(f.ext), fo = fold(f.dir); fo.files++; fo.bytes += f.size; fo.kinds[kind] = (fo.kinds[kind] || 0) + 1;
      if (catalog.length >= maxFiles) continue;
      const old = prev.get(f.rel), same = old && old.size === f.size && old.mtime === f.mtime;
      const entry = same ? old : { rel: f.rel, dir: f.dir, name: f.name, ext: f.ext, kind, size: f.size, mtime: f.mtime, summary: '', topic: '', project: '', tags: [], interpreted: null };
      entry.id = ++id1; entry.kind = kind;
      entry.flags = {};
      if (secretFile(f.name)) entry.flags.sensitive = true;
      else if (privateName(f.rel)) entry.flags.private = true;
      if (G741.test(f.rel)) entry.flags.g741 = true;
      fo.catalogued++; catalog.push(entry);
    }
    meta.walk = { files: w.files.length, bytes: w.files.reduce((s, f) => s + f.size, 0), truncated: w.truncated, dependencies: w.deps.length, secretFolders: w.secrets.length, unreadable: w.errors.unreadable };
    if (cancelled()) { meta.status = 'cancelled'; return finish(dir, meta, catalog, folders, w, id, false, 'cancelled'); }

    // 2. exact duplicates: hash only files that share a size with another file
    progress({ phase: 'hashing', done: 0, total: catalog.length });
    const bySize = new Map(); for (const f of catalog) if (f.size > 0 && !f.flags.sensitive) { const a = bySize.get(f.size) || []; a.push(f); bySize.set(f.size, a); }
    let hashed = 0, hashStopped = false; const toHash = [...bySize.values()].filter((a) => a.length > 1).flat().filter((f) => !f.hash);
    for (const f of toHash) {
      if (cancelled()) break;
      if (now() > deadline) { hashStopped = true; break; }
      try { const h = hashFile(path.join(root, f.rel), f.size); f.hash = h.hash; if (h.partial) f.hashPartial = true; } catch (e) { f.flags.unreadable = true; }
      if (++hashed % 25 === 0) progress({ phase: 'hashing', done: hashed, total: toHash.length });
    }

    // 3. read and interpret, one file at a time
    const readable = catalog.filter((f) => !f.interpreted && !f.flags.sensitive && !f.flags.private && (f.kind === 'text' || f.kind === 'code' || f.kind === 'other' || ZIP_DOCS.has(f.ext)));
    let done = 0, sinceSave = 0, lastSave = now(), stopped = hashStopped ? 'slice' : null, modelErrors = 0;
    // Saving also refreshes the summary, so the page can show the map filling in while the model is still reading (projects are provisional until the end).
    const persist = () => {
      writeJson(path.join(dir, 'files.json'), catalog); writeJson(path.join(dir, 'meta.json'), meta);
      const defs = provisionalGroups(catalog); writeJson(path.join(dir, 'summary.json'), summarize({ ...meta, status: 'running', updatedAt: now() }, catalog, folders, w, defs)); cache.delete(id);
      sinceSave = 0; lastSave = now();
    };
    for (const f of readable) {
      if (cancelled()) { stopped = 'cancelled'; break; }
      if (now() > deadline) { stopped = 'slice'; break; }
      progress({ phase: 'reading', done: done + 1, total: readable.length, current: f.rel });
      const s = sampleOf(path.join(root, f.rel), f.ext, f.kind, f.size);
      if (s.how === 'binary' || s.how === 'unreadable' || !s.text.trim()) { f.interpreted = 'name'; f.summary = s.how === 'binary' ? 'Binary file (not readable as text).' : ''; if (s.how === 'unreadable') f.flags.unreadable = true; }
      else {
        f.sim = simhash(s.text.slice(0, NEAR_BYTES)) || undefined;
        let r; try { r = await interpret({ rel: f.rel, kind: f.kind, size: f.size, mtime: f.mtime, text: s.text }); modelErrors = 0; }
        catch (e) { if (/^(rendering:|llm_unavailable)/.test(e.message) || ++modelErrors >= 5) { persist(); throw e; } r = null; }   // a model that is gone stops the slice (it resumes later); one odd answer does not
        if (r) { f.summary = r.summary; f.topic = r.topic; f.project = r.project; f.tags = r.tags; f.interpreted = 'content'; if (r.g741) f.flags.g741 = true; }
        else { f.interpreted = 'name'; f.summary = clip(s.text, 140); }
      }
      done++; if (++sinceSave >= limits.saveEvery || now() - lastSave > limits.saveMs) persist();
    }
    if (stopped === 'cancelled') { meta.status = 'cancelled'; return finish(dir, meta, catalog, folders, w, id, false, 'cancelled'); }

    // 4. folders whose files could not be read: one question per folder, using the neighbours' summaries
    if (!stopped) {
      let folderErrors = 0;
      const todo = new Map();
      for (const f of catalog) if (!f.interpreted && !f.flags.sensitive && !f.flags.private) { const a = todo.get(f.dir) || []; a.push(f); todo.set(f.dir, a); }
      let n = 0;
      for (const [d, list] of todo) {
        if (cancelled()) { stopped = 'cancelled'; break; }
        if (now() > deadline) { stopped = 'slice'; break; }
        progress({ phase: 'folders', done: ++n, total: todo.size, current: d || '(top folder)' });
        const sib = catalog.filter((x) => x.dir === d && x.interpreted === 'content' && x.summary).slice(0, 5).map((x) => x.summary);
        let r; try { r = await interpretFolder({ dir: d || '(top folder of the scan)', files: list, siblings: sib }); folderErrors = 0; }
        catch (e) { if (/^(rendering:|llm_unavailable)/.test(e.message) || ++folderErrors >= 5) { persist(); throw e; } r = { summary: 'Folder of ' + list.length + ' unread file' + (list.length === 1 ? '' : 's') + '.', topic: '', project: '', g741: false }; }
        for (const f of list) { f.interpreted = 'folder'; f.summary = r.summary; f.topic = r.topic; f.project = r.project; if (r.g741) f.flags.g741 = true; }
        persist();
      }
      if (stopped === 'cancelled') { meta.status = 'cancelled'; return finish(dir, meta, catalog, folders, w, id, false, 'cancelled'); }
    }
    for (const f of catalog) if (!f.interpreted && (f.flags.sensitive || f.flags.private)) { f.interpreted = 'name'; f.summary = f.flags.sensitive ? 'Sensitive file: listed by name only, never read.' : 'Looks private by its name: not read.'; }

    // 5. projects, then the summary
    progress({ phase: 'grouping', done: 0, total: 0 });
    const complete = !stopped;
    await groupProjects(catalog, meta, dir);
    return finish(dir, meta, catalog, folders, w, id, complete, stopped);
  }

  // The digest for the launcher: small, and says whether another slice is needed.
  function finish(dir, meta, catalog, folders, w, id, complete, why) {
    meta.status = why === 'cancelled' ? 'cancelled' : complete ? 'done' : 'partial'; meta.updatedAt = now(); if (complete) meta.finishedAt = meta.updatedAt;
    writeJson(path.join(dir, 'files.json'), catalog);
    const summary = summarize(meta, catalog, folders, w, complete && meta.projectDefs ? null : provisionalGroups(catalog));       // a run that stopped early keeps provisional projects
    writeJson(path.join(dir, 'summary.json'), summary); writeJson(path.join(dir, 'meta.json'), meta);
    cache.delete(id);
    return { done: complete, status: meta.status, runId: id, root: meta.root, counts: summary.counts, projects: summary.projects.slice(0, 8).map((p) => ({ name: p.name, files: p.files })), duplicates: { exact: summary.duplicates.exact.length, near: summary.duplicates.near.length, versions: summary.duplicates.versions.length, wastedBytes: summary.duplicates.wastedBytes }, remaining: summary.counts.pending };
  }

  function hashFile(file, size) {
    const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r');
    try {
      if (size <= limits.hashFullBytes) { const buf = Buffer.alloc(1 << 20); for (let pos = 0; ; ) { const n = fs.readSync(fd, buf, 0, buf.length, pos); if (n <= 0) break; h.update(buf.subarray(0, n)); pos += n; } return { hash: h.digest('hex') }; }
      const part = limits.hashPartBytes, buf = Buffer.alloc(part);                          // very big file: size + head + middle + tail
      h.update(String(size));
      for (const pos of [0, Math.floor(size / 2) - Math.floor(part / 2), size - part]) { const n = fs.readSync(fd, buf, 0, part, Math.max(pos, 0)); h.update(buf.subarray(0, n)); }
      return { hash: h.digest('hex'), partial: true };
    } finally { fs.closeSync(fd); }
  }

  // ── asking Qwen ──
  async function interpret({ rel, kind, size, mtime, text }) {
    const body = text.replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').slice(0, PROMPT_CHARS);
    const answer = await llm({ messages: [{ role: 'system', content: SYS_FILE }, { role: 'user', content: 'Path: ' + rel + '\nKind: ' + kind + '   Size: ' + human(size) + '   Modified: ' + new Date(mtime).toISOString().slice(0, 10) + '\n--- start of the file (first ' + body.length + ' characters) ---\n' + body + '\n--- end ---' }], maxTokens: 220, temperature: 0.2 });
    return cleanAnswer(jsonFrom(answer), body);
  }
  async function interpretFolder({ dir, files, siblings }) {
    const kinds = {}; for (const f of files) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
    const names = files.slice(0, 40).map((f) => f.name).join('\n');
    const answer = await llm({ messages: [{ role: 'system', content: SYS_FOLDER }, { role: 'user', content: 'Folder: ' + dir + '\nUnread files: ' + files.length + ' (' + Object.entries(kinds).map(([k, n]) => n + ' ' + k).join(', ') + ')\nSome names:\n' + names + (siblings.length ? '\nReadable files next to them are about:\n- ' + siblings.join('\n- ') : '') }], maxTokens: 160, temperature: 0.2 });
    const r = cleanAnswer(jsonFrom(answer), '');
    if (!r.summary) r.summary = 'Folder of ' + files.length + ' file' + (files.length === 1 ? '' : 's') + ' (' + Object.entries(kinds).map(([k, n]) => n + ' ' + k).join(', ') + ').';
    return r;
  }
  function cleanAnswer(j, fallbackText) {
    const o = j && typeof j === 'object' ? j : {};
    return { summary: clip(o.summary, 220) || clip(fallbackText, 140), topic: clip(o.topic, 40), project: clip(o.project, 60), tags: (Array.isArray(o.tags) ? o.tags : []).map((t) => clip(t, 24)).filter(Boolean).slice(0, 4), g741: o.g741 === true };
  }

  // ── projects: the labels the model gave are grouped into a few projects ──
  const normLabel = (s) => lc(s).replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/^(the|my|mi|el|la|los|las|proyecto|project)\s+/i, '').trim();
  async function groupProjects(catalog, meta, dir) {
    const counts = new Map();
    for (const f of catalog) { if (f.flags.g741 || f.flags.sensitive) continue; const l = normLabel(f.project) || normLabel(f.topic); if (l) { const c = counts.get(l) || { label: l, n: 0, sample: f.project || f.topic }; c.n++; counts.set(l, c); } }
    const labels = [...counts.values()].sort((a, b) => b.n - a.n);
    const sig = crypto.createHash('sha1').update(JSON.stringify(labels.map((l) => [l.label, l.n]))).digest('hex');
    let projects = meta.projectDefs;
    if (!projects || meta.projectSig !== sig) {
      projects = null;
      if (labels.length > limits.maxProjects) {
        try {
          const list = labels.slice(0, 160).map((l) => l.label + ' (' + l.n + ')').join('\n');
          const j = jsonFrom(await llm({ messages: [{ role: 'system', content: SYS_GROUP.replace('MAX', String(limits.maxProjects)) }, { role: 'user', content: list }], maxTokens: 1400, temperature: 0.2 }));
          if (j && Array.isArray(j.projects)) projects = j.projects.slice(0, limits.maxProjects + 1).map((p) => ({ name: clip(p && p.name, 60), description: clip(p && p.description, 120), labels: (Array.isArray(p && p.labels) ? p.labels : []).map(normLabel).filter(Boolean) })).filter((p) => p.name && p.labels.length);
        } catch (e) { if (/^(rendering:|llm_unavailable)/.test(e.message)) throw e; projects = null; }
      }
      if (!projects || !projects.length) projects = labels.slice(0, limits.maxProjects).map((l) => ({ name: l.sample.slice(0, 60), description: '', labels: [l.label] }));     // each frequent label is its own project
      meta.projectDefs = projects; meta.projectSig = sig;
    }
    assignGroups(catalog, projects);
    writeJson(path.join(dir, 'meta.json'), meta);
  }
  function assignGroups(catalog, projects) {
    const byLabel = new Map(); projects.forEach((p, i) => p.labels.forEach((l) => { if (!byLabel.has(l)) byLabel.set(l, i); }));
    for (const f of catalog) {
      const l = normLabel(f.project) || normLabel(f.topic);
      if (f.flags.g741) f.group = 'g741'; else if (f.flags.sensitive) f.group = 'sensitive'; else if (f.flags.private) f.group = 'private';
      else f.group = byLabel.has(l) ? 'p' + byLabel.get(l) : (l ? 'misc' : 'none');
    }
  }
  // Until the real grouping question has been asked, each of the most frequent labels is its own project (also what a run that stopped early shows).
  function provisionalGroups(catalog) {
    const counts = new Map();
    for (const f of catalog) { if (f.flags.g741 || f.flags.sensitive) continue; const l = normLabel(f.project) || normLabel(f.topic); if (l) { const c = counts.get(l) || { label: l, n: 0, sample: f.project || f.topic }; c.n++; counts.set(l, c); } }
    const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, limits.maxProjects), defs = top.map((l) => ({ name: l.sample.slice(0, 60), description: '', labels: [l.label] }));
    assignGroups(catalog, defs);
    return defs;
  }

  // ── the summary: counts, projects, duplicates, and the folder map the 3D page draws ──
  function summarize(meta, catalog, folders, w, defsOverride) {
    const kinds = {}; let bytes = 0, content = 0, folderLevel = 0, nameOnly = 0, pending = 0, sensitive = 0, priv = 0, g741 = 0;
    const pr = new Map(), defs = defsOverride || meta.projectDefs || [];
    for (const f of catalog) {
      kinds[f.kind] = (kinds[f.kind] || 0) + 1; bytes += f.size;
      if (f.interpreted === 'content') content++; else if (f.interpreted === 'folder') folderLevel++; else if (f.interpreted === 'name') nameOnly++; else pending++;
      if (f.flags.sensitive) sensitive++; if (f.flags.private) priv++; if (f.flags.g741) g741++;
      const key = f.group || 'none'; let p = pr.get(key); if (!p) { p = { key, files: 0, bytes: 0, kinds: {}, dirs: new Map(), examples: [] }; pr.set(key, p); }
      p.files++; p.bytes += f.size; p.kinds[f.kind] = (p.kinds[f.kind] || 0) + 1; p.dirs.set(f.dir, (p.dirs.get(f.dir) || 0) + 1); if (p.examples.length < 5) p.examples.push(f.rel);
    }
    const nameOf = (key) => (key === 'g741' ? 'G741 business (set aside)' : key === 'sensitive' ? 'Sensitive (never read)' : key === 'private' ? 'Private by name (not read)' : key === 'misc' ? 'Misc' : key === 'none' ? 'Unsorted' : (defs[+key.slice(1)] || {}).name || key);
    const projects = [...pr.values()].map((p, i) => ({ id: p.key, name: nameOf(p.key), description: p.key[0] === 'p' ? (defs[+p.key.slice(1)] || {}).description || '' : '', files: p.files, bytes: p.bytes, kinds: p.kinds, folders: [...p.dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d || '(top)'), examples: p.examples })).sort((a, b) => (a.id[0] === 'p' ? 0 : 1) - (b.id[0] === 'p' ? 0 : 1) || b.files - a.files);
    const duplicates = findDuplicates(catalog);
    const dupFiles = new Set(); for (const g of [...duplicates.exact, ...duplicates.near]) g.files.forEach((x) => dupFiles.add(x.rel));
    // folder map
    const projOf = new Map(); for (const f of catalog) { const m = projOf.get(f.dir) || {}; m[f.group || 'none'] = (m[f.group || 'none'] || 0) + 1; projOf.set(f.dir, m); }
    const stat = new Map(); for (const f of catalog) { const s = stat.get(f.dir) || { interpreted: 0, priv: 0, dup: 0 }; if (f.interpreted === 'content' || f.interpreted === 'folder') s.interpreted++; if (f.flags.private || f.flags.sensitive) s.priv++; if (dupFiles.has(f.rel)) s.dup++; stat.set(f.dir, s); }
    const all = [...folders.values()].sort((a, b) => b.bytes - a.bytes);
    const keep = all.slice(0, limits.maxFolders).sort((a, b) => (a.dir < b.dir ? -1 : 1));
    const map = keep.map((f) => { const votes = projOf.get(f.dir) || {}, top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0], s = stat.get(f.dir) || {}; const dom = Object.entries(f.kinds).sort((a, b) => b[1] - a[1])[0]; return { dir: f.dir, name: f.dir ? f.dir.split('/').pop() : '(top)', files: f.files, bytes: f.bytes, catalogued: f.catalogued, interpreted: s.interpreted || 0, kind: dom ? dom[0] : 'other', project: top ? top[0] : 'none', private: s.priv || 0, dup: s.dup || 0 }; });
    return { runId: meta.id, root: meta.root, status: meta.status, createdAt: meta.createdAt, updatedAt: meta.updatedAt, finishedAt: meta.finishedAt || null, slices: meta.slices,
      counts: { files: catalog.length, bytes, walked: meta.walk ? meta.walk.files : catalog.length, walkedBytes: meta.walk ? meta.walk.bytes : bytes, beyondLimit: meta.walk ? Math.max(0, meta.walk.files - catalog.length) : 0, byKind: kinds, interpretedContent: content, interpretedFolder: folderLevel, nameOnly, pending, sensitive, private: priv, g741, dependencyFolders: meta.walk ? meta.walk.dependencies : 0, secretFolders: meta.walk ? meta.walk.secretFolders : 0, truncated: !!(meta.walk && meta.walk.truncated), foldersShown: map.length, foldersTotal: all.length },
      projects, duplicates, folders: map, dependencies: (w && w.deps ? w.deps.slice(0, 60) : []),
      notes: ['Images, video, audio and 3D files are sorted from their folder and names: the local model reads text, not pictures.', 'Nothing on disk was changed. Duplicates are suggestions: look before you delete.'] };
  }

  function findDuplicates(catalog) {
    const exact = [], near = [], versions = [];
    const byHash = new Map(); for (const f of catalog) if (f.hash) { const k = f.size + ':' + f.hash; const a = byHash.get(k) || []; a.push(f); byHash.set(k, a); }
    let wasted = 0; let gid = 0;
    for (const a of byHash.values()) if (a.length > 1) { const w = a[0].size * (a.length - 1); wasted += w; exact.push({ id: 'x' + ++gid, size: a[0].size, hash: a[0].hash.slice(0, 12), partial: !!a[0].hashPartial, count: a.length, wasted: w, files: a.map((f) => ({ rel: f.rel, mtime: f.mtime })).sort((x, y) => x.mtime - y.mtime) }); }
    exact.sort((a, b) => b.wasted - a.wasted);
    // near: text files whose simhash differs in at most 3 of 64 bits (and that are not exact copies); bands of 16 bits find the candidates
    const inExact = new Set(); for (const g of exact) g.files.forEach((x) => inExact.add(x.rel));
    const sims = catalog.filter((f) => f.sim && !inExact.has(f.rel));
    const bands = new Map();
    const bandKeys = (s) => [0, 1, 2, 3].map((b) => b + ':' + (b < 2 ? (s[1] >>> (b * 16)) & 0xffff : (s[0] >>> ((b - 2) * 16)) & 0xffff));
    for (const f of sims) for (const k of bandKeys(f.sim)) { const a = bands.get(k) || []; a.push(f); bands.set(k, a); }
    const seen = new Set(), parent = new Map(); const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
    for (const f of sims) parent.set(f.rel, f.rel);
    const bestDist = new Map();
    for (const list of bands.values()) { if (list.length > 60) continue; for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j], key = a.rel < b.rel ? a.rel + '\u0000' + b.rel : b.rel + '\u0000' + a.rel; if (seen.has(key)) continue; seen.add(key); const d = hamming(a.sim, b.sim); if (d <= 3 && Math.min(a.size, b.size) / Math.max(a.size, b.size) > 0.6) { const ra = find(a.rel), rb = find(b.rel); if (ra !== rb) parent.set(ra, rb); bestDist.set(a.rel, Math.min(d, bestDist.get(a.rel) ?? 64)); bestDist.set(b.rel, Math.min(d, bestDist.get(b.rel) ?? 64)); } } }
    const comps = new Map(); for (const f of sims) { const r = find(f.rel); const a = comps.get(r) || []; a.push(f); comps.set(r, a); }
    let n = 0; for (const a of comps.values()) if (a.length > 1) near.push({ id: 'n' + ++n, similarity: Math.round((1 - Math.max(...a.map((f) => bestDist.get(f.rel) ?? 0)) / 64) * 100) / 100, count: a.length, files: a.map((f) => ({ rel: f.rel, mtime: f.mtime })).sort((x, y) => x.mtime - y.mtime) });
    near.sort((a, b) => b.count - a.count);
    // versions: the same name apart from "(1)", "copy", "v2", "final", dates - not necessarily the same content
    const inNear = new Set(); for (const g of near) g.files.forEach((x) => inNear.add(x.rel));
    const byStem = new Map(); for (const f of catalog) { if (inExact.has(f.rel) || inNear.has(f.rel) || f.size === 0) continue; const s = nameStem(f.name); if (s.length < 3) continue; const k = s + '|' + f.ext; const a = byStem.get(k) || []; a.push(f); byStem.set(k, a); }
    let v = 0; for (const [k, a] of byStem) if (a.length > 1) versions.push({ id: 'v' + ++v, stem: k.split('|')[0], count: a.length, files: a.map((f) => ({ rel: f.rel, mtime: f.mtime, size: f.size })).sort((x, y) => x.mtime - y.mtime) });
    versions.sort((a, b) => b.count - a.count);
    return { exact: exact.slice(0, 200), near: near.slice(0, 100), versions: versions.slice(0, 100), wastedBytes: wasted };
  }

  // ── reading runs back ──
  const cache = new Map();
  function listRuns() {
    let names = []; try { names = fs.readdirSync(stateDir).filter(validRun); } catch (e) { return []; }
    return names.map((id) => { const m = readJson(path.join(runDir(id), 'meta.json'), null), s = readJson(path.join(runDir(id), 'summary.json'), null); if (!m) return null;
      return { runId: id, root: m.root, status: m.status, createdAt: m.createdAt, updatedAt: m.updatedAt, finishedAt: m.finishedAt || null, slices: m.slices || 0, files: s ? s.counts.files : 0, pending: s ? s.counts.pending : null, projects: s ? s.projects.filter((p) => p.id[0] === 'p').length : 0, duplicates: s ? s.duplicates.exact.length + s.duplicates.near.length : 0 }; })
      .filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  const getSummary = (id) => (validRun(id) ? readJson(path.join(runDir(id), 'summary.json'), null) : null);
  function getFiles(id, q = {}) {
    if (!validRun(id)) return null;
    const f = path.join(runDir(id), 'files.json');
    let list = cache.get(id); if (!list) { list = readJson(f, null); if (!list) return null; cache.set(id, list); if (cache.size > 4) cache.delete(cache.keys().next().value); }
    let out = list;
    if (q.dir !== undefined && q.dir !== null && q.dir !== '*') out = out.filter((x) => x.dir === q.dir);
    if (q.group) out = out.filter((x) => x.group === q.group);
    if (q.kind) out = out.filter((x) => x.kind === q.kind);
    if (q.q) { const t = lc(q.q).slice(0, 80); out = out.filter((x) => lc(x.rel).includes(t) || lc(x.summary).includes(t) || lc(x.topic).includes(t)); }
    const offset = Math.max(parseInt(q.offset, 10) || 0, 0), limit = Math.min(Math.max(parseInt(q.limit, 10) || 100, 1), 500);
    return { total: out.length, offset, files: out.slice(offset, offset + limit).map(({ sim, ...rest }) => rest) };
  }
  function deleteRun(id) { if (!validRun(id)) return false; try { fs.rmSync(runDir(id), { recursive: true, force: true }); cache.delete(id); return true; } catch (e) { return false; } }

  return { check, scan, listRuns, getSummary, getFiles, deleteRun, walk, limits, runIdFor };
}

module.exports = { createArchivist, kindOf, classifyDependency, secretFile, privateName, nameStem, simhash, hamming, jsonFrom, sampleOf, officeText, isInside, DEFAULTS, G741 };
