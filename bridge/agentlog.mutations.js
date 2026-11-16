'use strict';
// Mutations for an agent's own log (GET /v1/log, read by the hub for the G741 app's Logs tab): bridge.mutation.js breaks ONE protection at a time in a
// copy of bridge/ and requires bridge.test.js to go red.
// [name, file, exact text to find, replacement]
module.exports = [
  ['a job\'s prompt reaches the agent\'s log', 'node-agent.js', "say('job ' + job.id + ' started: ' + job.type", "say('job ' + job.id + ' started: ' + job.messages.map((m) => m.content).join(' ') + ' ' + job.type"],
  ['a confidential job\'s error reaches the log', 'node-agent.js', "(job.confidential ? '' : ': ' + clip(job.error, 160))", "(': ' + clip(job.error, 160))"],
  ['a refused request is not a warning', 'node-agent.js', "say('rejected request from ' + req.socket.remoteAddress + ': ' + v.reason, 'warn')", "say('rejected request from ' + req.socket.remoteAddress + ': ' + v.reason)"],
  ['the log ignores the line number asked for', 'node-agent.js', 'lines: logRing.filter((e) => e.seq > since).slice(-500)', 'lines: logRing.slice(-500)'],
  ['the agent does not say it started', 'node-agent.js', "say('started: \"' + alias + '\" listening on :'", "log('started: \"' + alias + '\" listening on :'"],
  ['the hub never notices that an agent restarted', 'hub.js', 'const restarted = c.startedAt && r.startedAt !== c.startedAt;', 'const restarted = false;'],
];
module.exports.TESTS = ['bridge.test.js'];
