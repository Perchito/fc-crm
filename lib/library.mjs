// Reusable content: service templates (pricing items), proposal/contract clauses, company details.
import { requireRole, audit } from './auth.mjs';
import { httpError, str, validEmail } from './biz.mjs';
import { normaliseLine, PricingError } from './pricing.mjs';
import { getCompany } from './proposals.mjs';

const COMPANY_FIELDS = ['name', 'address', 'phone', 'email', 'website', 'vat_number', 'company_number', 'signatory_name', 'signatory_title', 'signatory_email'];

export function libraryRoutes(app, pool) {
  app.get('/api/library', async (req, res) => {
    const [services, blocks, company] = await Promise.all([
      pool.query(`select * from service_templates order by active desc, sort, name`).then((r) => r.rows),
      pool.query(`select * from content_blocks order by doc_type, sort`).then((r) => r.rows),
      getCompany(pool),
    ]);
    res.json({ services, blocks, company });
  });

  const service = (b) => {
    const s = { name: str(b.name, 120), billing: b.billing, frequency: b.frequency, visits_per_week: b.visits_per_week === '' ? null : b.visits_per_week ?? null,
      hours_per_visit: b.hours_per_visit === '' ? null : b.hours_per_visit ?? null, staff: b.staff === '' ? null : b.staff ?? null,
      rate_pence: b.rate_pence === '' ? null : b.rate_pence ?? null, price_pence: b.price_pence === '' ? null : b.price_pence ?? null,
      scope: str(b.scope, 8000), active: b.active !== false, sort: Number(b.sort) || 0 };
    // templates may leave the price blank (filled per proposal) but must otherwise be valid
    try { normaliseLine({ ...s, price_pence: s.price_pence ?? 0, rate_pence: s.rate_pence ?? 0, hours_per_visit: s.hours_per_visit ?? (s.billing === 'hourly' ? 1 : null), visits_per_week: s.visits_per_week ?? (s.frequency === 'one_off' ? null : 1) }); }
    catch (e) { if (e instanceof PricingError) throw httpError(400, e.message); throw e; }
    return s;
  };
  app.post('/api/library/services', requireRole('manager'), async (req, res) => {
    const s = service(req.body || {}), cols = Object.keys(s);
    const { rows: [r] } = await pool.query(`insert into service_templates (${cols}) values (${cols.map((_, i) => `$${i + 1}`)}) returning *`, Object.values(s));
    await audit(pool, req, 'service_template_created', 'service_template', r.id, { name: r.name });
    res.status(201).json(r);
  });
  app.put('/api/library/services/:id', requireRole('manager'), async (req, res) => {
    const s = service(req.body || {}), cols = Object.keys(s);
    const { rows: [r] } = await pool.query(`update service_templates set ${cols.map((c, i) => `${c} = $${i + 2}`)} where id = $1 returning *`, [req.params.id, ...Object.values(s)]);
    if (!r) throw httpError(404, 'Not found');
    await audit(pool, req, 'service_template_updated', 'service_template', r.id);
    res.json(r);
  });

  app.post('/api/library/blocks', requireRole('manager'), async (req, res) => {
    const b = req.body || {};
    const key = str(b.key, 40).toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!['proposal', 'contract'].includes(b.doc_type) || !key || !str(b.title)) throw httpError(400, 'doc_type, key and title are required');
    try {
      const { rows: [r] } = await pool.query(`insert into content_blocks (doc_type, key, title, body, sort) values ($1,$2,$3,$4,$5) returning *`, [b.doc_type, key, str(b.title, 120), str(b.body, 20000), Number(b.sort) || 80]);
      await audit(pool, req, 'clause_created', 'content_block', r.id, { key });
      res.status(201).json(r);
    } catch (e) { if (e.code === '23505') throw httpError(409, 'A section with that key exists.'); throw e; }
  });
  app.put('/api/library/blocks/:id', requireRole('manager'), async (req, res) => {
    const b = req.body || {};
    const { rows: [r] } = await pool.query(`update content_blocks set title = coalesce(nullif($2,''), title), body = $3, active = $4, sort = coalesce($5, sort), updated_at = now() where id = $1 returning *`,
      [req.params.id, str(b.title, 120), str(b.body, 20000), b.active !== false, b.sort == null ? null : Number(b.sort)]);
    if (!r) throw httpError(404, 'Not found');
    await audit(pool, req, 'clause_updated', 'content_block', r.id, { key: r.key });
    res.json(r);
  });

  app.put('/api/company', requireRole('admin'), async (req, res) => {
    const b = req.body || {}, cur = await getCompany(pool);
    const next = { ...cur };
    for (const k of COMPANY_FIELDS) if (k in b) next[k] = str(b[k], 300);
    if (next.signatory_email && !validEmail(next.signatory_email)) throw httpError(400, 'Signatory email doesn’t look right.');
    if ('vat_rate_bp' in b) { const v = Number(b.vat_rate_bp); if (!Number.isInteger(v) || v < 0 || v > 10000) throw httpError(400, 'VAT rate must be 0–100%'); next.vat_rate_bp = v; }
    if ('proposal_valid_days' in b) { const v = Number(b.proposal_valid_days); if (!Number.isInteger(v) || v < 1 || v > 365) throw httpError(400, 'Validity must be 1–365 days'); next.proposal_valid_days = v; }
    if ('sign_order' in b) { if (!['fc_first', 'client_first', 'together'].includes(b.sign_order)) throw httpError(400, 'Bad signing order'); next.sign_order = b.sign_order; }
    await pool.query(`insert into meta (k, v) values ('company', $1) on conflict (k) do update set v = excluded.v`, [next]);
    await audit(pool, req, 'company_updated', 'settings', 'company');
    res.json(next);
  });
}
