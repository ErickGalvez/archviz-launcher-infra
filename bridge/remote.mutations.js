'use strict';
// Mutations for the Dev Console's Launchers card on the bridge side (an agent restarting itself, the hub picking which PC, starting the models):
// bridge.mutation.js breaks ONE protection at a time in a copy of bridge/ and requires bridge.test.js to go red.
// [name, file, exact text to find, replacement]
module.exports = [
  ['an agent started by hand restarts anyway (and never comes back)', 'node-agent.js', "if (!exit) return send(409, { ok: false, error: 'this agent was started by hand", "if (false) return send(409, { ok: false, error: 'this agent was started by hand"],
  ['an agent restarts under a running job', 'node-agent.js', "if (running || queue.length) return send(409, { ok: false, error: 'busy: a job is running on this PC' });", ''],
  ['an agent asked twice restarts twice', 'node-agent.js', 'if (!restarting) {', 'if (true) {'],
  ['an agent exits without stopping its model and server first', 'node-agent.js', 'stop().catch(() => {}).then(() => exit());', 'exit();'],
  ['the hub restarts every PC when one is asked for', 'hub.js', "(d.source === 'local' ? 1 : 2) === pc", 'true'],
  ['the hub reports success for an agent that refused', 'hub.js', "catch (e) { return { ok: false, alias: nameOf(d), error: String(e.message).slice(0, 120) }; }", "catch (e) { return { ok: true, alias: nameOf(d) }; }"],
  ['start agents starts the model on a PC reserved for rendering', 'hub.js', "else if (reservedOf(d)) skip('reserved for rendering');", ''],
  ['start agents restarts a model that is already running', 'hub.js', 'else if (d.stats && d.stats.llm && d.stats.llm.up) out.ready.push(name);', ''],
  ['start agents reports a PC with no model set up as starting', 'hub.js', "else if (!d.stats || !d.stats.model || d.stats.model.canStart === false) skip(", "else if (false) skip("],
];
module.exports.TESTS = ['bridge.test.js'];
