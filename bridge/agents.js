'use strict';
// Autopilot, one switch per agent (agents-state.json beside the launcher, gitignored).
//
//   ON  (the default) - the agent's own routines run by themselves: in the night window, or earlier when a PC is idle (see routines.js), and Hex's
//                       daily range run happens (redteam/range.js reads this same file).
//   OFF               - nothing runs on its own. The agent still answers when you ask it, and "Run now" still works: autopilot only decides
//                       whether the agent starts work without you.
//
// Autopilot never widens what an agent may do. A routine still only drafts, a cloud-lane brief still waits for your approval, and nothing is sent,
// posted or merged by an agent. Names are checked (letters only, at most 40 agents) so the file cannot grow without bound or hold markup.
const fs = require('fs');
const path = require('path');

const NAME_RE = /^[A-Za-zÀ-ÖØ-öø-ÿ]{2,20}$/;
const MAX_AGENTS = 40;

function createAgents({ dir, now = Date.now, log = () => {} }) {
  const file = path.join(dir, 'agents-state.json');
  const load = () => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return j && typeof j === 'object' && j.autopilot && typeof j.autopilot === 'object' ? j : { autopilot: {} }; } catch (e) { return { autopilot: {} }; } };
  const save = (st) => { try { fs.writeFileSync(file, JSON.stringify(st, null, 2)); return true; } catch (e) { log('could not save agents-state.json: ' + e.message); return false; } };

  // An agent nobody has switched is on: that is how the routines behaved before autopilot existed.
  const autopilotOn = (name) => { const v = load().autopilot[name]; return v === undefined ? true : v.on !== false; };

  function state() {
    const st = load(), out = {};
    for (const [k, v] of Object.entries(st.autopilot)) if (NAME_RE.test(k)) out[k] = { on: v.on !== false, changedAt: v.changedAt || null };
    return { ok: true, autopilot: out, defaultOn: true };
  }

  function setAutopilot(name, on) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) return { ok: false, error: 'name must be an agent name (letters only)' };
    if (typeof on !== 'boolean') return { ok: false, error: 'on must be true or false' };
    const st = load();
    if (!(name in st.autopilot) && Object.keys(st.autopilot).length >= MAX_AGENTS) return { ok: false, error: 'too many agents' };
    st.autopilot[name] = { on, changedAt: new Date(now()).toISOString() };
    if (!save(st)) return { ok: false, error: 'the autopilot state could not be saved' };
    log('autopilot ' + (on ? 'on' : 'off') + ' for ' + name);
    return { ok: true, name, on };
  }

  return { state, setAutopilot, autopilotOn, file };
}

module.exports = { createAgents, NAME_RE };
