import express from 'express';
import pg from 'pg';
import { runDueSteps, enroll, getSettings, saveSettings } from './lib/engine.mjs';
import { emailConfigured } from './lib/mailer.mjs';
import { smsConfigured } from './lib/sms.mjs';

const { DATABASE_URL, CRM_USER = 'fc', CRM_PASS, PORT = 4600, ENGINE_TICK_MS = 5 * 60_000 } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const pool = new pg.Pool({ connectionString: DATABASE_URL });
const app = express();
app.use(express.json());

// HTTP Basic auth (same pattern as fc-outreach /ops) — skipped entirely if no
// CRM_PASS is set, so local dev works without fuss.
if (CRM_PASS) {
  app.use((req, res, next) => {
    const hdr = req.headers.authorization || '';
    const [user, pass] = Buffer.from(hdr.replace('Basic ', ''), 'base64').toString().split(':');
    if (user === CRM_USER && pass === CRM_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="fc-crm"').status(401).send('Auth required');
  });
}

const STAGES = ['new', 'contacted', 'quoted', 'won', 'lost'];

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

app.get('/api/activity', async (req, res) => {
  const { rows } = await pool.query(
    `select e.*, c.business from events e join contacts c on c.id = e.contact_id order by e.at desc limit 15`
  );
  res.json(rows);
});

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

app.use(express.static('public'));

app.listen(PORT, () => console.log(`fc-crm listening on :${PORT}`));

setInterval(() => runDueSteps(pool).catch((err) => console.error('engine tick failed:', err)), Number(ENGINE_TICK_MS));
runDueSteps(pool).catch((err) => console.error('engine tick failed:', err));
