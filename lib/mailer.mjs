import nodemailer from 'nodemailer';

const _t = {};
function transport(user, pass) {
  _t[user] ??= nodemailer.createTransport({ host: 'smtp.mail.me.com', port: 587, secure: false, auth: { user, pass } });
  return _t[user];
}

// Daniel's London address lives on his own iCloud account, so it has its own login (LONDON_SMTP_USER/PASS)
export const londonMailConnected = () => !!(process.env.LONDON_SMTP_USER && process.env.LONDON_SMTP_PASS);

export function emailConfigured() {
  return !!(process.env.ICLOUD_SMTP_USER && process.env.ICLOUD_SMTP_PASS);
}

export async function sendEmail({ to, cc, subject, text, html, attachments, replyTo, from }) {
  if (!emailConfigured()) throw new Error('ICLOUD_SMTP_USER/ICLOUD_SMTP_PASS not set');
  // same var names as fc-outreach's config.js, so both tools share one identity
  const fromName = process.env.ICLOUD_FROM_NAME || 'FC Cleaning Company';
  const fromAddress = from || process.env.ICLOUD_FROM_ADDRESS || process.env.ICLOUD_SMTP_USER;
  const london = process.env.LONDON_FROM_ADDRESS && fromAddress.toLowerCase() === process.env.LONDON_FROM_ADDRESS.toLowerCase();
  if (london && !londonMailConnected()) throw new Error(`${fromAddress} isn't connected yet (LONDON_SMTP_USER/LONDON_SMTP_PASS)`);
  const t = london ? transport(process.env.LONDON_SMTP_USER, process.env.LONDON_SMTP_PASS) : transport(process.env.ICLOUD_SMTP_USER, process.env.ICLOUD_SMTP_PASS);
  return t.sendMail({ from: { name: fromName, address: fromAddress }, to, cc, subject, text, html, attachments, replyTo });
}
