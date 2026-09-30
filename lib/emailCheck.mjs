// Checks an email address can actually receive mail before discovery spends a
// research + drafting call on it. Two past campaigns had bounces from dead
// domains and non-existent mailboxes.
//
//   1. syntax
//   2. DNS: the domain must publish an MX record (no MX = nowhere to deliver)
//   3. SMTP: ask the mail server whether it accepts RCPT TO for the mailbox,
//      then QUIT before any DATA, so nothing is ever sent.
//
// Only a definite "no" rejects: a 5xx that names the recipient (5.1.x / user
// unknown). Timeouts, greylisting, and policy blocks against our home IP
// (5.7.x) count as "unknown" and pass, so a flaky check never drops a good lead.
//
//   node lib/emailCheck.mjs someone@example.com   # manual check

import dns from 'node:dns/promises';
import net from 'node:net';

const SYNTAX = /^[^\s@"<>(),;:]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const MAILBOX_GONE = /\b5\.1\.[0-9]\b|user unknown|unknown user|no such (user|mailbox)|does ?n[o']t exist|not exist|mailbox (unavailable|not found)|recipient (rejected|not found|address rejected)|invalid recipient|address rejected|unrouteable/i;

// One SMTP conversation; resolves with the reply to RCPT TO (or throws).
function rcpt(host, email, from, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(25, host);
    const cmds = [`EHLO ${process.env.EMAIL_CHECK_HELO || 'perchito.app'}`, `MAIL FROM:<${from}>`, `RCPT TO:<${email}>`];
    let buf = '', step = 0;
    const done = (fn, v) => { sock.write('QUIT\r\n'); sock.end(); fn(v); };
    sock.setTimeout(timeoutMs, () => { sock.destroy(); reject(new Error('timeout')); });
    sock.on('error', reject);
    sock.on('data', (d) => {
      buf += d;
      // a reply is complete when its last line is "NNN text" (not "NNN-text")
      const lines = buf.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1];
      if (!/^\d{3} /.test(last || '') || !buf.endsWith('\r\n')) return;
      buf = '';
      const code = Number(last.slice(0, 3));
      if (step === 3) return done(resolve, { code, text: lines.join(' ') });
      if (code >= 400) return done(resolve, { code, text: lines.join(' '), early: true });
      sock.write(cmds[step++] + '\r\n');
    });
  });
}

export async function checkEmail(email, { from = process.env.ICLOUD_FROM_ADDRESS || process.env.ICLOUD_SMTP_USER || 'postmaster@perchito.app', timeoutMs = 15_000 } = {}) {
  email = String(email || '').trim();
  if (!SYNTAX.test(email)) return { ok: false, reason: 'bad syntax' };
  const domain = email.split('@')[1].toLowerCase();

  let mx;
  try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority); }
  catch (err) {
    if (['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(err.code)) return { ok: false, reason: `no mail server for ${domain} (${err.code})` };
    return { ok: true, reason: `dns unknown (${err.code})` };
  }
  if (!mx.length || mx[0].exchange === '' || mx[0].exchange === '.') return { ok: false, reason: `no mail server for ${domain}` };

  // ponytail: first two MX hosts only; add retries/backoff if greylisting makes "unknown" common
  for (const { exchange } of mx.slice(0, 2)) {
    try {
      const r = await rcpt(exchange, email, from, timeoutMs);
      if (r.code === 250 || r.code === 251) return { ok: true, reason: 'mailbox accepted' };
      if (!r.early && r.code >= 500 && MAILBOX_GONE.test(r.text) && !/\b5\.7\.\d\b/.test(r.text)) {
        return { ok: false, reason: `mailbox rejected: ${r.text.slice(0, 160)}` };
      }
      return { ok: true, reason: `smtp unknown: ${r.text.slice(0, 160)}` };
    } catch { /* try the next MX */ }
  }
  return { ok: true, reason: 'smtp unreachable' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const e of process.argv.slice(2)) console.log(e, await checkEmail(e));
}
