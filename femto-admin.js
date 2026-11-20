#!/usr/bin/env node
'use strict';
// Femto Group accounts, run on the launcher PC by the owner. Starting passwords are written ONLY to femto-data\starting-passwords.txt
// (gitignored): open it, hand each person theirs, then delete the file. This tool never prints a password.
//
//   node femto-admin.js init                    create Hugo, Edgar and Erick (any who don't exist yet)
//   node femto-admin.js list                    who has finished signing up
//   node femto-admin.js reset <id>              a new starting password (they set their own again; their email stays)
//   node femto-admin.js agent <id> <name...>    give a person's agent its own name (empty = "Hugo's agent")
//
// --dir <folder> works on another launcher folder (tests).
const path = require('path');
const { createFemto } = require('./femto');

async function main(argv) {
  const args = argv.slice(2);
  const at = args.indexOf('--dir');
  const dir = at >= 0 ? path.resolve(args.splice(at, 2)[1] || '.') : __dirname;
  const [cmd, id, ...rest] = args;
  const femto = createFemto({ dir, autoStart: false });
  const out = (s) => process.stdout.write(s + '\n');

  if (cmd === 'init') {
    const made = await femto.admin.ensureSeed();
    out(made.length ? `Created ${made.join(', ')}. Their starting passwords are in ${femto.admin.file}` : 'Hugo, Edgar and Erick already exist. Use "reset <id>" for a new starting password.');
    return 0;
  }
  if (cmd === 'list') {
    for (const m of femto.admin.list()) {
      const email = m.email || (m.emailPending ? m.emailPending + ' (not confirmed)' : '-');
      out(`${m.id.padEnd(8)} ${m.name.padEnd(8)} stage ${m.stage.padEnd(9)} email ${email}${m.locked ? '  LOCKED' : ''}  agent ${m.agentName || "(default)"}`);
    }
    return 0;
  }
  if (cmd === 'reset' && id) {
    const r = await femto.admin.reset(id);
    out(r.ok ? `New starting password for ${id} is in ${femto.admin.file}. Their open sessions were signed out.` : r.error);
    return r.ok ? 0 : 1;
  }
  if (cmd === 'agent' && id) {
    const r = femto.admin.setAgentName(id, rest.join(' '));
    out(r.ok ? 'Done.' : r.error);
    return r.ok ? 0 : 1;
  }
  out('Usage: node femto-admin.js init | list | reset <id> | agent <id> <name>');
  return 2;
}

if (require.main === module) main(process.argv).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { main };
