import nodemailer from 'nodemailer';

let _t;
function transport() {
  if (!_t) {
    _t = nodemailer.createTransport({
      host: 'smtp.mail.me.com',
      port: 587,
      secure: false,
      auth: { user: process.env.ICLOUD_SMTP_USER, pass: process.env.ICLOUD_SMTP_PASS },
    });
  }
  return _t;
}

export function emailConfigured() {
  return !!(process.env.ICLOUD_SMTP_USER && process.env.ICLOUD_SMTP_PASS);
}

export async function sendEmail({ to, subject, text }) {
  if (!emailConfigured()) throw new Error('ICLOUD_SMTP_USER/ICLOUD_SMTP_PASS not set');
  const fromName = process.env.FROM_NAME || 'FC Cleaning Company';
  const fromAddress = process.env.FROM_ADDRESS || process.env.ICLOUD_SMTP_USER;
  return transport().sendMail({ from: { name: fromName, address: fromAddress }, to, subject, text });
}
