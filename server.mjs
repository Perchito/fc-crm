process.env.TZ ||= 'Europe/London'; // booking slots are London wall-clock times
import express from 'express';
import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { runDueSteps, enroll, advance, getSettings, saveSettings } from './lib/engine.mjs';
import { emailConfigured, sendEmail } from './lib/mailer.mjs';
import { smsConfigured } from './lib/sms.mjs';
import { getBooking, saveBooking, freeSlots, isFree, icsSecret, buildIcs, sendBookingEmails, sendCancelEmail, PUBLIC_URL, BOOK_URL } from './lib/booking.mjs';

const { DATABASE_URL, CRM_USER = 'fc', CRM_PASS, PORT = 4600, ENGINE_TICK_MS = 5 * 60_000 } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const app = express();
app.use(express.json());

// ── public: customer booking page + phone calendar feed ─────────────────────
// Registered before the Basic-auth gate on purpose: customers book without a
// login. Personal links (/book?c=<contact.booking_token>) prefill their details
// and attach the visit to their lead.
const MIN = 60_000;
const sendBookPage = (req, res) => res.set('Cache-Control', 'no-cache').sendFile('book.html', { root: 'public' });
// book.fccleaningcompany.com (docuseal's Cloudflare tunnel -> :4600) is booking-only:
// the page lives at its root, and nothing else of the CRM is reachable on that host.
app.use((req, res, next) => {
  if (!/^book\./i.test(req.hostname)) return next();
  if (req.path === '/' || /^\/manage\/[\w-]+$/.test(req.path)) return sendBookPage(req, res);
  if (req.path.startsWith('/api/public/') || req.path === '/fc-logo.webp') return next();
  res.redirect('/');
});
app.get(['/book', '/book/manage/:token'], sendBookPage);

app.get('/api/public/slots', async (req, res) => {
  const cfg = await getBooking(pool);
  let contact = null, appt = null;
  if (req.query.c) {
    const { rows: [c] } = await pool.query(`select business, contact_name, email, phone, address from contacts where booking_token = $1`, [String(req.query.c)]);
    contact = c || null;
  }
  if (req.query.r) {
    const { rows: [a] } = await pool.query(
      `select a.id, a.starts_at, c.business, c.contact_name, c.email, c.phone, c.address from appointments a
       join contacts c on c.id = a.contact_id where a.token = $1 and a.status = 'scheduled'`, [String(req.query.r)]);
    if (a) { appt = a; contact = { business: a.business, contact_name: a.contact_name, email: a.email, phone: a.phone, address: a.address }; }
  }
  res.json({
    visit_minutes: cfg.visit_minutes,
    contact,
    rescheduling: appt ? { starts_at: appt.starts_at } : null,
    days: await freeSlots(pool, cfg, { excludeApptId: appt?.id }),
  });
});

app.post('/api/public/book', async (req, res) => {
  const b = req.body || {};
  const clean = (v, n = 200) => String(v ?? '').trim().slice(0, n);
  const f = { contact_name: clean(b.name), business: clean(b.business), email: clean(b.email).toLowerCase(), phone: clean(b.phone, 40), address: clean(b.address, 300), notes: clean(b.notes, 1000) };
  const start = new Date(b.starts_at);
  if (!f.contact_name || !f.address || (!f.email && !f.phone)) return res.status(400).json({ error: 'Please add your name, the address for the visit, and an email or phone number.' });
  if (f.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) return res.status(400).json({ error: 'That email address doesn’t look right.' });
  if (isNaN(start)) return res.status(400).json({ error: 'Please pick a time.' });

  const cfg = await getBooking(pool);
  const client = await pool.connect();
  let contact, appt, old = null;
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(4600)'); // one booking at a time: no double-booking a slot
    if (b.reschedule) {
      ({ rows: [old] } = await client.query(`select * from appointments where token = $1 and status = 'scheduled'`, [clean(b.reschedule, 64)]));
    }
    if (!(await isFree(client, cfg, start, old?.id))) {
      await client.query('rollback');
      return res.status(409).json({ error: 'Sorry — that time was just taken. Please pick another.' });
    }
    if (old) ({ rows: [contact] } = await client.query(`select * from contacts where id = $1`, [old.contact_id]));
    if (!contact && b.c) ({ rows: [contact] } = await client.query(`select * from contacts where booking_token = $1`, [clean(b.c, 64)]));
    if (!contact && f.email) ({ rows: [contact] } = await client.query(`select * from contacts where lower(email) = $1`, [f.email]));
    if (contact) {
      ({ rows: [contact] } = await client.query(
        `update contacts set contact_name = coalesce(nullif($2,''), contact_name), business = coalesce(nullif($3,''), business),
           email = coalesce(email, nullif($4,'')), phone = coalesce(nullif($5,''), phone), address = coalesce(nullif($6,''), address), updated_at = now()
         where id = $1 returning *`, [contact.id, f.contact_name, f.business, f.email, f.phone, f.address]));
    } else {
      ({ rows: [contact] } = await client.query(
        `insert into contacts (contact_name, business, email, phone, address, source) values ($1,$2,nullif($3,''),$4,$5,'booking-page') returning *`,
        [f.contact_name, f.business || null, f.email, f.phone || null, f.address]));
    }
    if (old) {
      await client.query(`update appointments set status = 'cancelled' where id = $1`, [old.id]);
    }
    ({ rows: [appt] } = await client.query(
      `insert into appointments (contact_id, title, starts_at, ends_at, notes) values ($1,'Site visit',$2,$3,$4) returning *`,
      [contact.id, start, new Date(start.getTime() + cfg.visit_minutes * MIN), f.notes || null]));
    await client.query(`insert into events (contact_id, type, body) values ($1,'appointment',$2)`,
      [contact.id, `${old ? 'Rescheduled' : 'Booked'} site visit via booking page: ${start.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`]);
    if (['new', 'contacted'].includes(contact.pipeline_stage)) {
      await client.query(`update contacts set pipeline_stage = 'visit_booked', updated_at = now() where id = $1`, [contact.id]);
      await client.query(`insert into events (contact_id, type, body) values ($1,'stage_change','visit_booked')`, [contact.id]);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    console.error('booking failed:', err);
    return res.status(500).json({ error: 'Something went wrong — please call us instead.' });
  } finally {
    client.release();
  }
  sendBookingEmails({ contact, appt, rescheduled: !!old }); // fire-and-forget; never blocks the booking
  res.status(201).json({ token: appt.token, starts_at: appt.starts_at, ends_at: appt.ends_at });
});

app.get('/api/public/appointment/:token', async (req, res) => {
  const { rows: [a] } = await pool.query(
    `select a.starts_at, a.ends_at, a.status, c.business, c.contact_name, c.address from appointments a
     join contacts c on c.id = a.contact_id where a.token = $1`, [req.params.token]);
  if (!a) return res.status(404).json({ error: 'Booking not found' });
  res.json(a);
});

app.post('/api/public/appointment/:token/cancel', async (req, res) => {
  const { rows: [a] } = await pool.query(`update appointments set status = 'cancelled' where token = $1 and status = 'scheduled' returning *`, [req.params.token]);
  if (!a) return res.status(404).json({ error: 'Booking not found or already cancelled' });
  const { rows: [c] } = await pool.query(`select * from contacts where id = $1`, [a.contact_id]);
  await pool.query(`insert into events (contact_id, type, body) values ($1,'appointment','Customer cancelled their site visit')`, [a.contact_id]);
  sendCancelEmail(c, a);
  res.json({ ok: true });
});

app.get('/cal/:secret.ics', async (req, res) => {
  if (req.params.secret !== await icsSecret(pool)) return res.status(404).end();
  const cfg = await getBooking(pool);
  const { rows } = await pool.query(
    `select a.*, c.business, c.contact_name, c.phone, c.email, c.address from appointments a join contacts c on c.id = a.contact_id
     where a.status = 'scheduled' and a.starts_at > now() - interval '60 days' order by a.starts_at`);
  res.type('text/calendar').set('Cache-Control', 'no-cache').send(buildIcs(rows, cfg.visit_minutes));
});

// HTTP Basic auth (same pattern as fc-outreach /ops) — skipped entirely if no
// CRM_PASS is set, so local dev works without fuss.
//
// Brute-force guard (this is public via Tailscale Funnel, where every request
// arrives from the local proxy, so no per-IP limits apply): a login header
// that already passed is let through at once; any other one is checked at
// most once per second across all clients, so guessing is capped at ~1
// try/s without ever locking the owner out. Ported verbatim from
// fc-outreach's homeserver/app-server.mjs (commit 272316c).
if (CRM_PASS) {
  const CHECK_EVERY_MS = 1000;
  const knownGood = new Set();
  let nextCheckAt = 0;

  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    if (hdr.startsWith('Basic ') && knownGood.has(hdr)) return next();
    const now = Date.now();
    if (now < nextCheckAt) {
      res.set('Retry-After', '1').set('Cache-Control', 'no-store');
      return res.status(429).send('Too many login attempts — wait a second and try again.');
    }
    nextCheckAt = now + CHECK_EVERY_MS;
    const [user, pass] = Buffer.from(hdr.replace('Basic ', ''), 'base64').toString().split(':');
    if (user === CRM_USER && pass === CRM_PASS) {
      if (knownGood.size > 50) knownGood.clear();
      knownGood.add(hdr);
      return next();
    }
    const from = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim();
    console.warn(`[auth] wrong login from ${from}`);
    res.set('WWW-Authenticate', 'Basic realm="fc-crm"').set('Cache-Control', 'no-store').status(401).send('Auth required');
  });
}

const STAGES = ['new', 'contacted', 'visit_booked', 'quoted', 'won', 'lost'];

// booleans only — never echoes the actual credentials
app.get('/api/health', (req, res) => res.json({ email: emailConfigured(), sms: smsConfigured() }));

// ── contacts ────────────────────────────────────────────
app.get('/api/contacts', async (req, res) => {
  const { rows } = await pool.query('select * from contacts order by updated_at desc');
  res.json(rows);
});

app.post('/api/contacts', async (req, res) => {
  const { business, contact_name, email, phone, address, website, source, tags, notes } = req.body;
  const { rows } = await pool.query(
    `insert into contacts (business, contact_name, email, phone, address, website, source, tags, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [business, contact_name, email, phone, address, website, source, tags || [], notes || '']
  );
  res.status(201).json(rows[0]);
});

app.patch('/api/contacts/:id', async (req, res) => {
  const fields = ['business', 'contact_name', 'email', 'phone', 'address', 'website', 'source', 'tags', 'notes', 'pipeline_stage'];
  const updates = Object.keys(req.body).filter((k) => fields.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'no valid fields' });
  if (updates.includes('pipeline_stage') && !STAGES.includes(req.body.pipeline_stage)) {
    return res.status(400).json({ error: `pipeline_stage must be one of ${STAGES.join(', ')}` });
  }
  const set = updates.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `update contacts set ${set}, updated_at = now() where id = $1 returning *`,
    [req.params.id, ...updates.map((k) => req.body[k])]
  );
  if (!rows[0]) return res.status(404).end();
  if (updates.includes('pipeline_stage')) {
    await pool.query(
      `insert into events (contact_id, type, body) values ($1, 'stage_change', $2)`,
      [req.params.id, req.body.pipeline_stage]
    );
    // auto-enrol into any campaign triggered by this stage
    const { rows: campaigns } = await pool.query(
      `select id from campaigns where status = 'active' and trigger_stage = $1`,
      [req.body.pipeline_stage]
    );
    for (const c of campaigns) await enroll(pool, c.id, req.params.id);
  }
  res.json(rows[0]);
});

app.delete('/api/contacts/:id', async (req, res) => {
  await pool.query('delete from contacts where id = $1', [req.params.id]);
  res.status(204).end();
});

app.get('/api/contacts/:id/events', async (req, res) => {
  const { rows } = await pool.query('select * from events where contact_id = $1 order by at desc', [req.params.id]);
  res.json(rows);
});

app.post('/api/contacts/:id/notes', async (req, res) => {
  const { body } = req.body;
  if (!body) return res.status(400).json({ error: 'body required' });
  const { rows } = await pool.query(
    `insert into events (contact_id, type, body) values ($1, 'note', $2) returning *`,
    [req.params.id, body]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/contacts/:id/enrollments', async (req, res) => {
  const { rows } = await pool.query(
    `select e.*, c.name as campaign_name from enrollments e join campaigns c on c.id = e.campaign_id
     where e.contact_id = $1 order by e.enrolled_at desc`,
    [req.params.id]
  );
  res.json(rows);
});

app.get('/api/contacts/:id/tasks', async (req, res) => {
  const { rows } = await pool.query('select * from tasks where contact_id = $1 order by done, due_at nulls last', [req.params.id]);
  res.json(rows);
});

app.post('/api/contacts/:id/tasks', async (req, res) => {
  const { title, due_at } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const { rows } = await pool.query(
    `insert into tasks (contact_id, title, due_at) values ($1,$2,$3) returning *`,
    [req.params.id, title, due_at || null]
  );
  res.status(201).json(rows[0]);
});

app.patch('/api/tasks/:id', async (req, res) => {
  const { rows } = await pool.query(
    `update tasks set done = $2 where id = $1 returning *`,
    [req.params.id, !!req.body.done]
  );
  res.json(rows[0]);
});

// ── campaigns (sequences) ──────────────────────────────
app.get('/api/campaigns', async (req, res) => {
  const { rows: campaigns } = await pool.query('select * from campaigns order by created_at desc');
  const { rows: steps } = await pool.query('select * from campaign_steps order by campaign_id, step_index');
  const { rows: counts } = await pool.query(
    `select campaign_id, status, count(*)::int as n from enrollments group by campaign_id, status`
  );
  res.json(campaigns.map((c) => ({
    ...c,
    steps: steps.filter((s) => s.campaign_id === c.id),
    enrollments: counts.filter((n) => n.campaign_id === c.id).reduce((a, n) => ({ ...a, [n.status]: n.n }), {}),
  })));
});

app.post('/api/campaigns', async (req, res) => {
  const { name, trigger_stage, daily_cap, steps = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows: [c] } = await client.query(
      `insert into campaigns (name, trigger_stage, daily_cap) values ($1,$2,$3) returning *`,
      [name, trigger_stage || null, daily_cap || 50]
    );
    for (const [i, s] of steps.entries()) {
      await client.query(
        `insert into campaign_steps (campaign_id, step_index, channel, wait_days, subject_tmpl, body_tmpl)
         values ($1,$2,$3,$4,$5,$6)`,
        [c.id, i, s.channel || 'email', s.wait_days || 0, s.subject_tmpl || null, s.body_tmpl || '']
      );
    }
    await client.query('commit');
    res.status(201).json(c);
  } catch (err) {
    await client.query('rollback');
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    client.release();
  }
});

app.patch('/api/campaigns/:id', async (req, res) => {
  const fields = ['name', 'status', 'trigger_stage', 'daily_cap'];
  const updates = Object.keys(req.body).filter((k) => fields.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'no valid fields' });
  const set = updates.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `update campaigns set ${set}, updated_at = now() where id = $1 returning *`,
    [req.params.id, ...updates.map((k) => req.body[k])]
  );
  res.json(rows[0]);
});

app.delete('/api/campaigns/:id', async (req, res) => {
  await pool.query('delete from campaigns where id = $1', [req.params.id]);
  res.status(204).end();
});

app.post('/api/campaigns/:id/enroll', async (req, res) => {
  const { contact_id } = req.body;
  const row = await enroll(pool, req.params.id, contact_id);
  res.status(row ? 201 : 200).json(row || { alreadyEnrolled: true });
});

// ── appointments ────────────────────────────────────────
app.get('/api/appointments', async (req, res) => {
  const { rows } = await pool.query(
    `select a.*, c.business, c.contact_name from appointments a
     join contacts c on c.id = a.contact_id
     where a.status != 'cancelled' order by a.starts_at asc`
  );
  res.json(rows);
});

app.get('/api/contacts/:id/appointments', async (req, res) => {
  const { rows } = await pool.query('select * from appointments where contact_id = $1 order by starts_at', [req.params.id]);
  res.json(rows);
});

app.post('/api/contacts/:id/appointments', async (req, res) => {
  const { title, starts_at, ends_at, notes } = req.body;
  if (!title || !starts_at) return res.status(400).json({ error: 'title and starts_at required' });
  const { rows } = await pool.query(
    `insert into appointments (contact_id, title, starts_at, ends_at, notes) values ($1,$2,$3,$4,$5) returning *`,
    [req.params.id, title, starts_at, ends_at || null, notes || null]
  );
  res.status(201).json(rows[0]);
});

app.patch('/api/appointments/:id', async (req, res) => {
  const fields = ['title', 'starts_at', 'ends_at', 'notes', 'status'];
  const updates = Object.keys(req.body).filter((k) => fields.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'no valid fields' });
  const set = updates.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `update appointments set ${set} where id = $1 returning *`,
    [req.params.id, ...updates.map((k) => req.body[k])]
  );
  res.json(rows[0]);
});

// ── AI-drafted emails (awaiting review before send) ────
app.get('/api/drafts', async (req, res) => {
  const { rows } = await pool.query(
    `select s.*, c.business, c.contact_name, c.email, c.website, c.address, c.notes, cp.name as campaign_name from sends s
     join contacts c on c.id = s.contact_id
     left join campaigns cp on cp.id = s.campaign_id
     where s.status = 'draft' order by s.sent_at desc`
  );
  res.json(rows);
});

app.get('/api/contacts/:id/drafts', async (req, res) => {
  const { rows } = await pool.query(`select * from sends where contact_id = $1 and status = 'draft' order by sent_at desc`, [req.params.id]);
  res.json(rows);
});

app.patch('/api/sends/:id', async (req, res) => {
  const fields = ['subject', 'body'];
  const updates = Object.keys(req.body).filter((k) => fields.includes(k));
  if (!updates.length) return res.status(400).json({ error: 'no valid fields' });
  const set = updates.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const { rows } = await pool.query(
    `update sends set ${set} where id = $1 and status = 'draft' returning *`,
    [req.params.id, ...updates.map((k) => req.body[k])]
  );
  if (!rows[0]) return res.status(404).json({ error: 'not found or already sent' });
  res.json(rows[0]);
});

app.post('/api/sends/:id/send', async (req, res) => {
  const { rows: [draft] } = await pool.query(
    `select s.*, c.email, c.pipeline_stage from sends s join contacts c on c.id = s.contact_id where s.id = $1 and s.status = 'draft'`,
    [req.params.id]
  );
  if (!draft) return res.status(404).json({ error: 'not found or already sent' });
  try {
    await sendEmail({ to: draft.email, subject: draft.subject, text: draft.body });
    await pool.query(`update sends set status = 'sent', sent_at = now() where id = $1`, [draft.id]);
    // AI-discovery campaigns: the draft is step 0, so move the enrollment on (completes it unless follow-up steps exist)
    if (draft.enrollment_id) {
      const { rows: [enr] } = await pool.query(`select * from enrollments where id = $1`, [draft.enrollment_id]);
      if (enr) await advance(pool, enr);
    }
    await pool.query(`insert into events (contact_id, type, body) values ($1,'email',$2)`, [draft.contact_id, draft.subject]);
    if (draft.pipeline_stage === 'new') {
      await pool.query(`update contacts set pipeline_stage = 'contacted', updated_at = now() where id = $1`, [draft.contact_id]);
      await pool.query(`insert into events (contact_id, type, body) values ($1,'stage_change','contacted')`, [draft.contact_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.post('/api/sends/:id/discard', async (req, res) => {
  const { rows: [d] } = await pool.query(`update sends set status = 'discarded' where id = $1 and status = 'draft' returning enrollment_id`, [req.params.id]);
  if (d?.enrollment_id) await pool.query(`update enrollments set status = 'stopped', stopped_reason = 'discarded', updated_at = now() where id = $1`, [d.enrollment_id]);
  res.status(204).end();
});

app.get('/api/activity', async (req, res) => {
  const { rows } = await pool.query(
    `select e.*, c.business from events e join contacts c on c.id = e.contact_id order by e.at desc limit 15`
  );
  res.json(rows);
});

// ── calendar: busy blocks + booking settings ───────────
app.get('/api/calendar', async (req, res) => {
  const from = new Date(req.query.from), to = new Date(req.query.to);
  if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'from and to required' });
  const { rows: blocks } = await pool.query(`select * from blocks where starts_at < $2 and ends_at > $1 order by starts_at`, [from, to]);
  const { rows: appts } = await pool.query(
    `select a.*, c.business, c.contact_name, c.address from appointments a join contacts c on c.id = a.contact_id
     where a.status = 'scheduled' and a.starts_at < $2 and a.starts_at >= $1::timestamptz - interval '1 day' order by a.starts_at`, [from, to]);
  res.json({ blocks, appointments: appts });
});

app.post('/api/blocks', async (req, res) => {
  const { starts_at, ends_at, title } = req.body;
  if (!(new Date(ends_at) > new Date(starts_at))) return res.status(400).json({ error: 'end must be after start' });
  const { rows } = await pool.query(`insert into blocks (starts_at, ends_at, title) values ($1,$2,$3) returning *`, [starts_at, ends_at, title || 'Busy']);
  res.status(201).json(rows[0]);
});

app.delete('/api/blocks/:id', async (req, res) => {
  await pool.query('delete from blocks where id = $1', [req.params.id]);
  res.status(204).end();
});

// Copy every block from the week starting `from` into the week starting `to` (rota repeats)
app.post('/api/blocks/copy-week', async (req, res) => {
  const from = new Date(req.body.from), to = new Date(req.body.to);
  if (isNaN(from) || isNaN(to)) return res.status(400).json({ error: 'from and to required' });
  const { rowCount } = await pool.query(
    `insert into blocks (starts_at, ends_at, title)
     select starts_at + ($2::timestamptz - $1::timestamptz), ends_at + ($2::timestamptz - $1::timestamptz), title
     from blocks where starts_at >= $1 and starts_at < $1::timestamptz + interval '7 days'`, [from, to]);
  res.json({ copied: rowCount });
});

app.get('/api/booking-settings', async (req, res) => {
  res.json({ ...(await getBooking(pool)), booking_url: BOOK_URL, ics_url: `${PUBLIC_URL}/cal/${await icsSecret(pool)}.ics` });
});
app.put('/api/booking-settings', async (req, res) => res.json(await saveBooking(pool, req.body)));

// ── settings + suppression ─────────────────────────────
app.get('/api/settings', async (req, res) => res.json(await getSettings(pool)));
app.put('/api/settings', async (req, res) => res.json(await saveSettings(pool, req.body)));

app.get('/api/suppression', async (req, res) => {
  const { rows } = await pool.query('select * from suppression order by created_at desc');
  res.json(rows);
});

app.post('/api/suppression', async (req, res) => {
  const { email, reason } = req.body;
  if (!email) return res.status(400).json({ error: 'email required' });
  const { rows } = await pool.query(
    `insert into suppression (email, reason) values ($1,$2)
     on conflict (email) do update set reason = excluded.reason returning *`,
    [email.toLowerCase(), reason || 'manual']
  );
  res.status(201).json(rows[0]);
});

app.delete('/api/suppression/:email', async (req, res) => {
  await pool.query('delete from suppression where email = $1', [req.params.email.toLowerCase()]);
  res.status(204).end();
});

// Cloudflare tells browsers to cache .js/.css for 4h, so stamp them with this
// process's start time: every deploy (restart) makes browsers fetch fresh copies.
const VERSION = Date.now();
const indexHtml = (await readFile('public/index.html', 'utf8')).replace(/(app\.js|style\.css)"/g, `$1?v=${VERSION}"`);
app.get(['/', '/index.html'], (req, res) => res.set('Cache-Control', 'no-cache').type('html').send(indexHtml));
app.use(express.static('public'));

app.listen(PORT, () => console.log(`fc-crm listening on :${PORT}`));

setInterval(() => runDueSteps(pool).catch((err) => console.error('engine tick failed:', err)), Number(ENGINE_TICK_MS));
runDueSteps(pool).catch((err) => console.error('engine tick failed:', err));
