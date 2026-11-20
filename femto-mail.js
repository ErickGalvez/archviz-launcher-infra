'use strict';
// Femto Group's mail: the email-confirmation messages, sent from the studio's own domain through its Hostinger mailbox.
//
// The mailbox settings live in femto-mail.key beside launcher-server.js (gitignored, like every other key), as JSON:
//   { "host": "smtp.hostinger.com", "port": 465, "user": "no-reply@g-741studio.com", "pass": "<the mailbox password>",
//     "from": "G741 Studio <no-reply@g-741studio.com>" }
// Only implicit TLS (port 465) is spoken. The password is read when a message is sent and never logged or returned.
//
// Until that file exists nothing is sent: the message is written to femto-data/outbox/ as an .eml file instead, so the sign-up can still be
// tried end to end and the owner can forward the link by hand.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

const DEFAULT_FROM = 'G741 Studio <no-reply@g-741studio.com>';
const ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const hasLineBreak = (s) => /[\r\n]/.test(String(s));
const addressOf = (from) => { const m = /<([^<>]+)>\s*$/.exec(String(from)); return (m ? m[1] : String(from)).trim(); };
const encodeWord = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : '=?UTF-8?B?' + Buffer.from(s, 'utf8').toString('base64') + '?=');
const wrap76 = (s) => s.replace(/(.{76})/g, '$1\r\n');

// A plain-text message, UTF-8, base64 body (so no line of the body can start with a dot or run too long).
function buildMessage({ from, to, subject, text, date, messageId }) {
  for (const v of [from, to, subject]) if (hasLineBreak(v)) throw new Error('header value with a line break');
  const fromHeader = String(from).replace(/^([^<]+?)\s*</, (all, name) => encodeWord(name.trim()) + ' <');
  return [
    'From: ' + fromHeader,
    'To: <' + to + '>',
    'Subject: ' + encodeWord(subject),
    'Date: ' + date.toUTCString().replace('GMT', '+0000'),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64')),
  ].join('\r\n');
}

// One SMTP conversation: greeting, EHLO, AUTH LOGIN, MAIL FROM, RCPT TO, DATA, QUIT. Resolves once the server accepted the message.
function smtpSend({ socket, user, pass, fromAddr, to, data, heloName = 'g741-launcher', timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    let buf = '', step = 0, finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      if (err) { try { socket.destroy(); } catch (e) { /* already gone */ } reject(err); } else { try { socket.end(); } catch (e) { /* already gone */ } resolve(); }
    };
    const timer = setTimeout(() => finish(new Error('the mail server did not answer in time')), timeoutMs);
    const send = (line) => socket.write(line + '\r\n');
    const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
    const steps = [
      { expect: [220], then: () => send('EHLO ' + heloName) },
      { expect: [250], then: () => send('AUTH LOGIN') },
      { expect: [334], then: () => send(b64(user)) },
      { expect: [334], then: () => send(b64(pass)) },
      { expect: [235], then: () => send('MAIL FROM:<' + fromAddr + '>') },
      { expect: [250], then: () => send('RCPT TO:<' + to + '>') },
      { expect: [250, 251], then: () => send('DATA') },
      { expect: [354], then: () => socket.write(data.replace(/^\./gm, '..') + '\r\n.\r\n') },
      { expect: [250], then: () => { send('QUIT'); finish(null); } },
    ];
    const what = ['greeting', 'EHLO', 'AUTH', 'user name', 'password', 'sender', 'recipient', 'DATA', 'message'];
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while (!finished && (i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (/^\d{3}-/.test(line)) continue;                       // a continuation line of a multi-line reply
        const code = parseInt(line.slice(0, 3), 10), st = steps[step];
        if (!st) continue;
        if (!st.expect.includes(code)) { finish(new Error('the mail server refused the ' + what[step] + ' (' + line.slice(0, 80) + ')')); return; }
        step++;
        st.then();
      }
    });
    socket.on('error', (e) => finish(new Error('mail connection failed: ' + e.message)));
    socket.on('close', () => finish(new Error('the mail server closed the connection early')));
  });
}

function createMailer({ configFile, outboxDir, connect = null, now = () => Date.now(), randomBytes = crypto.randomBytes, fsImpl = fs } = {}) {
  function config() {
    let c = null;
    try { c = JSON.parse(fsImpl.readFileSync(configFile, 'utf8')); } catch (e) { return null; }
    if (!c || typeof c.host !== 'string' || !c.host || typeof c.user !== 'string' || typeof c.pass !== 'string' || !c.pass) return null;
    return { host: c.host, port: Number(c.port) || 465, user: c.user, pass: c.pass, from: typeof c.from === 'string' && c.from ? c.from : c.user };
  }

  async function send({ to, subject, text }) {
    if (typeof to !== 'string' || to.length > 254 || !ADDRESS_RE.test(to)) throw new Error('bad recipient');
    if (hasLineBreak(subject)) throw new Error('bad subject');
    const c = config();
    const from = c ? c.from : DEFAULT_FROM;
    const domain = addressOf(from).split('@')[1] || 'g-741studio.com';
    const data = buildMessage({ from, to, subject, text, date: new Date(now()), messageId: '<' + randomBytes(12).toString('hex') + '@' + domain + '>' });
    if (!c) {
      fsImpl.mkdirSync(outboxDir, { recursive: true });
      const file = path.join(outboxDir, new Date(now()).toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex') + '.eml');
      fsImpl.writeFileSync(file, data);
      return { ok: true, delivered: false, outbox: file };
    }
    const socket = connect ? connect(c) : tls.connect({ host: c.host, port: c.port, servername: c.host });
    await smtpSend({ socket, user: c.user, pass: c.pass, fromAddr: addressOf(from), to, data });
    return { ok: true, delivered: true };
  }

  return { send, configured: () => !!config() };
}

module.exports = { createMailer, buildMessage, smtpSend, addressOf, ADDRESS_RE };
