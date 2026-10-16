// Site-visit booking: availability, the public booking flow, emails and the
// phone-calendar (ICS) feed.
//
// Fernando works ~50h/week at Dave's Hot Chicken, so visits fit around his
// shifts: anything in `blocks` (dragged onto the Calendar page) or an existing
// visit is unavailable, plus a travel gap either side of every visit.
// Times are Europe/London (perchito's TZ; server.mjs pins process.env.TZ).

import { randomBytes } from 'node:crypto';
import { sendEmail, emailConfigured } from './mailer.mjs';
import { brandEmail, hi, p, facts, esc } from './emails.mjs';
// customer-facing booking emails come from bookings@; internal notices keep the default sender
const FROM = process.env.BOOKING_FROM_ADDRESS || 'bookings@fccleaningcompany.com';

export const DEFAULT_BOOKING = {
  visit_minutes: 45,
  gap_minutes: 30,      // travel/buffer before and after every visit
  day_start: '08:00',   // earliest visit start
  day_end: '20:00',     // latest visit end
  days: [1, 2, 3, 4, 5, 6, 7], // ISO dow, Mon=1
  min_notice_hours: 24,
  horizon_days: 21,
  step_minutes: 30,     // offered start times every N minutes
};

export const PUBLIC_URL = process.env.PUBLIC_URL || 'https://crm.perchito.app';
// customer-facing booking page (personal links: `${BOOK_URL}?c=<token>`, manage: `${BOOK_URL}/manage/<token>`)
export const BOOK_URL = process.env.BOOK_URL || 'https://book.fccleaningcompany.com';

export async function getBooking(pool) {
  const { rows: [r] } = await pool.query(`select v from meta where k = 'booking'`);
  return { ...DEFAULT_BOOKING, ...(r ? r.v : {}) };
}

export async function saveBooking(pool, patch) {
  const allowed = Object.keys(DEFAULT_BOOKING);
  const next = { ...(await getBooking(pool)) };
  for (const k of allowed) if (k in patch) next[k] = patch[k];
  await pool.query(`insert into meta (k, v) values ('booking', $1) on conflict (k) do update set v = excluded.v`, [JSON.stringify(next)]);
  return next;
}

// Secret for the read-only calendar feed URL (generated once).
export async function icsSecret(pool) {
  const { rows: [r] } = await pool.query(`select v from meta where k = 'ics_secret'`);
  if (r) return r.v;
  const s = randomBytes(16).toString('hex');
  await pool.query(`insert into meta (k, v) values ('ics_secret', $1) on conflict do nothing`, [JSON.stringify(s)]);
  return s;
}

const hm = (s) => s.split(':').map(Number);
const MIN = 60_000;

// Busy intervals overlapping [from, to]: blocks + scheduled visits (manual
// appointments without an end count as one visit long).
// Each area is its own diary: Manchester = Fernando's shifts and visits, London = Luis's.
async function busy(db, from, to, visitMin, excludeApptId = null, area = 'manchester') {
  const { rows } = await db.query(`
    select starts_at, ends_at from blocks where starts_at < $2 and ends_at > $1 and area = $5
    union all
    select starts_at, coalesce(ends_at, starts_at + make_interval(mins => $3)) from appointments
     where status = 'scheduled' and starts_at < $2 and coalesce(ends_at, starts_at + make_interval(mins => $3)) > $1
       and ($4::uuid is null or id <> $4) and contact_id in (select id from contacts where area = $5)`, [from, to, visitMin, excludeApptId, area]);
  return rows.map((r) => [new Date(r.starts_at).getTime(), new Date(r.ends_at).getTime()]);
}

// ponytail: brute-force scan of every step in the horizon (~1k candidates); fine for one person's diary
export async function freeSlots(db, cfg, { excludeApptId = null, area = 'manchester' } = {}) {
  const now = Date.now();
  const earliest = now + cfg.min_notice_hours * 60 * MIN;
  const visit = cfg.visit_minutes * MIN, gap = cfg.gap_minutes * MIN;
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  const end = new Date(day0); end.setDate(end.getDate() + cfg.horizon_days + 1);
  const taken = await busy(db, new Date(now - gap), new Date(end.getTime() + gap), cfg.visit_minutes, excludeApptId, area);
  const days = [];
  for (let d = new Date(day0); d < end; d.setDate(d.getDate() + 1)) {
    const iso = ((d.getDay() + 6) % 7) + 1;
    if (!cfg.days.includes(iso)) continue;
    const [sh, sm] = hm(cfg.day_start), [eh, em] = hm(cfg.day_end);
    const first = new Date(d); first.setHours(sh, sm, 0, 0);
    const last = new Date(d); last.setHours(eh, em, 0, 0);
    const slots = [];
    for (let t = first.getTime(); t + visit <= last.getTime(); t += cfg.step_minutes * MIN) {
      if (t < earliest) continue;
      if (taken.some(([s, e]) => s < t + visit + gap && e > t - gap)) continue;
      slots.push(new Date(t).toISOString());
    }
    if (slots.length) days.push({ date: d.toLocaleDateString('en-CA'), slots });
  }
  return days;
}

export async function isFree(db, cfg, start, excludeApptId = null, area = 'manchester') {
  const days = await freeSlots(db, cfg, { excludeApptId, area });
  return days.some((d) => d.slots.includes(start.toISOString()));
}

export const fmtWhen = (d) => new Date(d).toLocaleString('en-GB', {
  weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Europe/London',
}).replace(' at ', ', ');

// ── emails (transactional: no marketing footer) ─────────────
const SIGN = () => `Fernando C.
Operations Director, FC Cleaning Company Ltd
${process.env.SENDER_PHONE || '+44 7337 397269'} · fccleaningcompany.com`;
const signHtml = () => p(`Best,<br><strong style="color:#05101f">Fernando C.</strong><br>Operations Director, FC Cleaning Company Ltd<br>${esc(process.env.SENDER_PHONE || '+44 7337 397269')} · fccleaningcompany.com`);
const visitFacts = (contact, appt, when) => facts([['When', when], ['Length', `About ${Math.round((new Date(appt.ends_at) - new Date(appt.starts_at)) / MIN)} minutes`],
  ['Business', contact.business], ['Contact', contact.contact_name], ['Phone', contact.phone], ['Email', contact.email], ['Address', contact.address], ['Notes', appt.notes]]);

export async function sendBookingEmails({ contact, appt, rescheduled = false, byUs = false }) {
  if (!emailConfigured()) return console.warn('booking emails skipped: SMTP not configured');
  const when = fmtWhen(appt.starts_at);
  const manage = `${BOOK_URL}/manage/${appt.token}`;
  const first = (contact.contact_name || '').split(' ')[0];
  const jobs = [];
  if (contact.email) jobs.push(sendEmail({
    from: FROM, to: contact.email,
    subject: `${rescheduled ? 'Updated: ' : ''}Your site visit with FC Cleaning Company — ${when}`,
    html: brandEmail({ url: BOOK_URL, title: byUs || rescheduled ? 'Your site visit has moved' : 'Your site visit is booked',
      button: 'Change or cancel', buttonUrl: manage, body: hi(first || 'there')
        + p(byUs ? 'I need to move our site visit, sorry for any trouble. Here are the new details — if this time doesn\'t work, use the button below to pick another.' : rescheduled ? 'Your site visit has been moved — here are the new details.' : 'Thanks for booking a site visit with FC Cleaning Company.')
        + facts([['When', when], ['Length', `About ${Math.round((new Date(appt.ends_at) - new Date(appt.starts_at)) / MIN)} minutes`], ['Where', contact.address || 'The address you gave us']])
        + p("I'll have a look round, talk through what you need, and send you a free written quote afterwards.")
        + p('Need to change or cancel? Use the button below, or just reply to this email or call me.') + signHtml() }),
    text: `Hi ${first || 'there'},

${byUs ? 'I need to move our site visit, sorry for any trouble. Here are the new details — if this time doesn\'t work, use the link below to pick another.' : rescheduled ? 'Your site visit has been moved — here are the new details.' : 'Thanks for booking a site visit with FC Cleaning Company.'}

When: ${when} (about ${Math.round((new Date(appt.ends_at) - new Date(appt.starts_at)) / MIN)} minutes)
Where: ${contact.address || 'the address you gave us'}

I'll have a look round, talk through what you need, and send you a free written quote afterwards.

Need to change or cancel? Use this link: ${manage}
Or just reply to this email or call me.

Best,
${SIGN()}`,
  }));
  const notify = process.env.BOOKING_NOTIFY_EMAIL || process.env.ICLOUD_FROM_ADDRESS || process.env.ICLOUD_SMTP_USER;
  if (notify && !byUs) jobs.push(sendEmail({
    to: notify,
    subject: `${rescheduled ? 'Visit moved' : 'New site visit'}: ${contact.business || contact.contact_name} — ${when}`,
    html: brandEmail({ url: BOOK_URL, title: rescheduled ? 'Site visit moved' : 'New site visit booked', button: 'Open the CRM', buttonUrl: PUBLIC_URL,
      body: p(`${rescheduled ? 'A site visit was rescheduled' : 'A site visit was just booked'} through the booking page.`) + visitFacts(contact, appt, when) }),
    text: `${rescheduled ? 'A site visit was rescheduled' : 'A site visit was just booked'} through the booking page.

When: ${when}
Business: ${contact.business || '—'}
Contact: ${contact.contact_name || '—'}
Phone: ${contact.phone || '—'}
Email: ${contact.email || '—'}
Address: ${contact.address || '—'}
${appt.notes ? `Notes: ${appt.notes}\n` : ''}
Open in the CRM: ${PUBLIC_URL}`,
  }));
  for (const r of await Promise.allSettled(jobs)) if (r.status === 'rejected') console.error('booking email failed:', r.reason?.message || r.reason);
}

export async function sendCustomerCancelEmail(contact, appt) {
  if (!emailConfigured() || !contact.email) return;
  const first = (contact.contact_name || '').split(' ')[0];
  await sendEmail({
    from: FROM, to: contact.email,
    subject: `Site visit cancelled — ${fmtWhen(appt.starts_at)}`,
    html: brandEmail({ url: BOOK_URL, title: 'Site visit cancelled', button: 'Pick a new time', buttonUrl: `${BOOK_URL}${contact.booking_token ? `?c=${contact.booking_token}` : ''}`,
      body: hi(first || 'there') + p(`Sorry, I've had to cancel our site visit on <strong style="color:#05101f">${esc(fmtWhen(appt.starts_at))}</strong>.`)
        + p("If you'd still like a free quote, use the button below to pick a new time, or just reply to this email or call me.") + signHtml() }),
    text: `Hi ${first || 'there'},

Sorry, I've had to cancel our site visit on ${fmtWhen(appt.starts_at)}.

If you'd still like a free quote, you can pick a new time here: ${BOOK_URL}${contact.booking_token ? `?c=${contact.booking_token}` : ''}
Or just reply to this email or call me.

Best,
${SIGN()}`,
  }).catch((err) => console.error('customer cancel email failed:', err.message));
}

export async function sendCancelEmail(contact, appt) {
  const notify = process.env.BOOKING_NOTIFY_EMAIL || process.env.ICLOUD_FROM_ADDRESS || process.env.ICLOUD_SMTP_USER;
  if (!emailConfigured() || !notify) return;
  await sendEmail({
    to: notify,
    subject: `Visit cancelled: ${contact.business || contact.contact_name} — ${fmtWhen(appt.starts_at)}`,
    html: brandEmail({ url: BOOK_URL, title: 'Site visit cancelled', button: 'Open the CRM', buttonUrl: PUBLIC_URL,
      body: p('The customer cancelled their site visit.') + facts([['When', fmtWhen(appt.starts_at)], ['Business', contact.business], ['Contact', contact.contact_name], ['Phone', contact.phone], ['Email', contact.email]]) }),
    text: `The customer cancelled their site visit on ${fmtWhen(appt.starts_at)}.\n\nBusiness: ${contact.business || '—'}\nPhone: ${contact.phone || '—'}\nEmail: ${contact.email || '—'}\n\n${PUBLIC_URL}`,
  }).catch((err) => console.error('cancel email failed:', err.message));
}

// ── ICS feed ──────────────────────────────────────────────
const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

export function buildIcs(appts, visitMin) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FC Cleaning//fc-crm//EN', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:FC Cleaning visits', 'X-PUBLISHED-TTL:PT15M', 'REFRESH-INTERVAL;VALUE=DURATION:PT15M'];
  for (const a of appts) {
    const end = a.ends_at || new Date(new Date(a.starts_at).getTime() + visitMin * MIN);
    lines.push('BEGIN:VEVENT', `UID:${a.id}@crm.perchito.app`, `DTSTAMP:${icsDate(a.created_at || Date.now())}`,
      `DTSTART:${icsDate(a.starts_at)}`, `DTEND:${icsDate(end)}`,
      `SUMMARY:${icsText(`${a.title}${a.business ? ` — ${a.business}` : ''}`)}`,
      `LOCATION:${icsText(a.address || '')}`,
      `DESCRIPTION:${icsText([a.contact_name, a.phone, a.email, a.notes].filter(Boolean).join('\n'))}`,
      'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Site visit', 'TRIGGER:-PT1H', 'END:VALARM', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ── 24h reminder ──────────────────────────────────────────
// Same WhatsApp number as fccleaningcompany.com; the message says who's writing.
const whatsappUrl = (name, business) => 'https://wa.me/447337397269?text=' + encodeURIComponent(
  `Hi FC Cleaning, it's ${[name, business && `from ${business}`].filter(Boolean).join(' ') || 'a client'}. I have a question about my site visit.`);

// Visits starting in the next 24h that were booked more than 24h ahead (a
// last-minute booking just got its confirmation) get one reminder. Claiming
// the row with reminded_at first means a crash never double-sends.
export async function sendReminders(pool) {
  if (!emailConfigured()) return;
  const { rows } = await pool.query(`
    update appointments a set reminded_at = now()
      from contacts c
     where c.id = a.contact_id and a.status = 'scheduled' and a.reminded_at is null
       and a.starts_at > now() and a.starts_at <= now() + interval '24 hours'
       and a.created_at < a.starts_at - interval '24 hours' and c.email is not null
    returning a.*, c.contact_name, c.business, c.email`);
  const phone = process.env.SENDER_PHONE || '+44 7337 397269';
  const tel = `tel:${phone.replace(/[^\d+]/g, '')}`;
  for (const a of rows) {
    const when = fmtWhen(a.starts_at), first = (a.contact_name || '').split(' ')[0] || 'there';
    const manage = `${BOOK_URL}/manage/${a.token}`;
    const WHATSAPP_URL = whatsappUrl(a.contact_name, a.business);
    const mins = Math.round(((a.ends_at ? new Date(a.ends_at) : new Date(a.starts_at).getTime() + 45 * MIN) - new Date(a.starts_at)) / MIN);
    await sendEmail({
      from: FROM, to: a.email,
      subject: `Reminder: your site visit with FC Cleaning Company — ${when}`,
      html: brandEmail({ url: BOOK_URL, title: 'See you tomorrow', button: 'Message us on WhatsApp', buttonUrl: WHATSAPP_URL,
        body: hi(first) + p("Just a quick reminder that I'll be coming to see you for your free site visit:")
          + facts([['When', when], ['Length', `About ${mins} minutes`]])
          + p("I'll have a look round, talk through what you need, and send you a free written quote afterwards. If you can, have someone there who can show me around and answer a few questions about the space.")
          + p(`Need anything before then? Message us on <a href="${WHATSAPP_URL}" style="color:#05101f">WhatsApp</a> or call <a href="${tel}" style="color:#05101f">${esc(phone)}</a>.`)
          + p(`Need to change or cancel? <a href="${esc(manage)}" style="color:#05101f">Manage your booking</a>.`) + signHtml() }),
      text: `Hi ${first},

Just a quick reminder that I'll be coming to see you for your free site visit:

When: ${when} (about ${mins} minutes)

I'll have a look round, talk through what you need, and send you a free written quote afterwards. If you can, have someone there who can show me around and answer a few questions about the space.

Need anything before then? Message us on WhatsApp: ${WHATSAPP_URL}
Or call us: ${phone}

Need to change or cancel? ${manage}

Best,
${SIGN()}`,
    }).catch((err) => console.error('reminder email failed:', a.id, err.message));
  }
}
