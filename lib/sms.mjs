// Twilio REST API over plain fetch — no SDK dependency needed for one POST.

export function smsConfigured() {
  return !!(process.env.TWILIO_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM);
}

export async function sendSms({ to, body }) {
  if (!smsConfigured()) throw new Error('TWILIO_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM not set');
  const sid = process.env.TWILIO_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `Twilio ${res.status}`);
  return data;
}
