#!/usr/bin/env node
'use strict';
// Choose which folders the Archivist (secret department) may read on THIS PC. Run it on PC-1; the web pages can never do this.
//
//   node bridge/archive-allow.js "D:\Old stuff"       allow a folder (and everything under it) and turn the Archivist on
//   node bridge/archive-allow.js --list               show what is allowed
//   node bridge/archive-allow.js --remove "D:\Old stuff"
//   node bridge/archive-allow.js --off                turn the Archivist off (the list is kept)
//
// It edits "archive" in bridge-node.json next to this file. The agent reads that file again for every request, so no restart is needed.
// The Archivist only ever READS: it never moves, renames, edits or deletes a file. Secrets (keys, .env, password stores, ssh folders) are listed by name
// and never read; files whose names look private are not read either.
const fs = require('fs');
const path = require('path');

const cfgFile = path.join(__dirname, 'bridge-node.json');
const read = () => JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
const write = (cfg) => { const tmp = cfgFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n'); fs.renameSync(tmp, cfgFile); };
const real = (p) => (fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p));
const isDriveRoot = (p) => /^[A-Za-z]:[\\/]?$/.test(p) || p === '/';

function main(args) {
  if (!fs.existsSync(cfgFile)) { console.error('No bridge-node.json here yet. Run  node bridge/node-agent.js --init  first.'); return 2; }
  const cfg = read(); cfg.archive = cfg.archive && typeof cfg.archive === 'object' ? cfg.archive : { enabled: false, roots: [] }; cfg.archive.roots = Array.isArray(cfg.archive.roots) ? cfg.archive.roots : [];
  const list = () => { console.log('Archivist: ' + (cfg.archive.enabled ? 'ON' : 'off')); if (!cfg.archive.roots.length) console.log('No folder is allowed yet.'); for (const r of cfg.archive.roots) console.log('  ' + r + (fs.existsSync(r) ? '' : '   (does not exist now)')); };
  if (args.includes('--list') || !args.length) { list(); if (!args.length) console.log('\nTo allow a folder:  node bridge/archive-allow.js "D:\\Old stuff"'); return 0; }
  if (args.includes('--off')) { cfg.archive.enabled = false; write(cfg); console.log('The Archivist is off. Its list of folders is kept.'); return 0; }
  const rm = args.indexOf('--remove'), target = rm >= 0 ? args[rm + 1] : args.find((a) => !a.startsWith('--'));
  if (!target) { console.error('Give a folder, for example  node bridge/archive-allow.js "D:\\Old stuff"'); return 2; }
  let abs; try { abs = real(path.resolve(target)); } catch (e) { abs = path.resolve(target); if (rm < 0) { console.error('That folder does not exist: ' + target); return 2; } }
  if (rm >= 0) { const before = cfg.archive.roots.length; cfg.archive.roots = cfg.archive.roots.filter((r) => r.toLowerCase() !== abs.toLowerCase()); write(cfg); console.log(before === cfg.archive.roots.length ? 'That folder was not on the list.' : 'Removed: ' + abs); return 0; }
  if (!fs.statSync(abs).isDirectory()) { console.error('That is a file, not a folder: ' + abs); return 2; }
  if (isDriveRoot(abs) && !args.includes('--whole-drive')) { console.error('That is a whole drive. Allow a folder inside it, or add --whole-drive if you really mean all of it.'); return 2; }
  if (!cfg.archive.roots.some((r) => r.toLowerCase() === abs.toLowerCase())) cfg.archive.roots.push(abs);
  cfg.archive.enabled = true; write(cfg);
  console.log('Allowed: ' + abs); console.log('The Archivist is ON for this PC. Open the Archive page and scan it; it only reads, it never changes a file.');
  return 0;
}

module.exports = { main };
if (require.main === module) process.exit(main(process.argv.slice(2)));
