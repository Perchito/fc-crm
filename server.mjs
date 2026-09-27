import express from 'express';
import pg from 'pg';

const { DATABASE_URL, CRM_USER = 'fc', CRM_PASS, PORT = 4600 } = process.env;
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

app.use(express.static('public'));

app.listen(PORT, () => console.log(`fc-crm listening on :${PORT}`));
