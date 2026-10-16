// Customers (the contacts table), their people and service sites, duplicate detection,
// archiving (never a silent hard delete), CSV import/export.
import express from 'express';
import { audit, requireRole, atLeast } from './auth.mjs';
import { httpError, logEvent, str, validEmail, tx, AREAS, areaOf, inArea } from './biz.mjs';
import { runAutomation } from './automation.mjs';

export const STAGES = ['new', 'contacted', 'visit_booked', 'quoted', 'won', 'lost'];
export const FIELDS = ['business', 'contact_name', 'email', 'phone', 'address', 'website', 'source', 'tags', 'notes', 'pipeline_stage',
  'trading_name', 'company_number', 'vat_number', 'billing_address', 'billing_email', 'premises_type', 'requirements', 'comm_prefs', 'payment_terms', 'owner_id', 'area'];
const LIMITS = { notes: 20000, requirements: 8000, comm_prefs: 1000, payment_terms: 2000, address: 400, billing_address: 400 };

/** Cleans a contact patch; throws 400 with a readable message on bad input. */
export function cleanContact(body, { partial = true } = {}) {
  const out = {};
  for (const k of FIELDS) {
    if (!(k in body)) continue;
    let v = body[k];
    if (k === 'tags') v = (Array.isArray(v) ? v : String(v || '').split(',')).map((t) => str(t, 40)).filter(Boolean).slice(0, 30);
    else if (k === 'owner_id') v = v || null;
    else { v = str(v, LIMITS[k] || 300); if (v === '' && k !== 'notes' && k !== 'requirements' && k !== 'comm_prefs') v = null; }
    if (k === 'notes' || k === 'requirements' || k === 'comm_prefs') v ??= '';
    out[k] = v;
  }
  if ('email' in out && out.email) { out.email = out.email.toLowerCase(); if (!validEmail(out.email)) throw httpError(400, 'That email address doesn’t look right.'); }
  if ('billing_email' in out && out.billing_email && !validEmail(out.billing_email)) throw httpError(400, 'The billing email doesn’t look right.');
  if ('pipeline_stage' in out && !STAGES.includes(out.pipeline_stage)) throw httpError(400, `pipeline_stage must be one of ${STAGES.join(', ')}`);
  if ('area' in out && !AREAS.includes(out.area)) throw httpError(400, 'Area must be Manchester or London.');
  if ('website' in out && out.website && !/^https?:\/\//i.test(out.website)) out.website = `https://${out.website}`;
  if (!partial && !out.business && !out.contact_name) throw httpError(400, 'Give the business or contact name.');
  return out;
}

const digits = (p) => String(p || '').replace(/\D/g, '').replace(/^44/, '0').slice(-10);
const normBiz = (b) => String(b || '').toLowerCase().replace(/\b(ltd|limited|the|llp|plc)\b/g, '').replace(/[^a-z0-9]/g, '');

/** Likely duplicates of a would-be customer: same email, same phone, or the same business name. */
export async function findDuplicates(db, { business, email, phone }, excludeId = null) {
  const nb = normBiz(business), ph = digits(phone);
  if (!nb && !email && ph.length < 9) return [];
  const { rows } = await db.query(
    `select id, business, contact_name, email, phone, address, pipeline_stage, archived_at from contacts
     where ($4::uuid is null or id <> $4) and (
       ($1 <> '' and lower(email) = $1)
       or ($2 <> '' and right(regexp_replace(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), '^44', '0'), 10) = $2)
       or ($3 <> '' and regexp_replace(regexp_replace(lower(coalesce(business,'')), '\\m(ltd|limited|the|llp|plc)\\M', '', 'g'), '[^a-z0-9]', '', 'g') = $3))
     limit 10`, [String(email || '').toLowerCase(), ph.length >= 9 ? ph : '', nb.length >= 3 ? nb : '', excludeId]);
  return rows;
}

// ── CSV (RFC 4180) ──
export function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((x) => x.trim()));
}
// leading = + - @ are neutralised so a spreadsheet never runs an exported cell as a formula
export const csvCell = (v) => { let s = Array.isArray(v) ? v.join('; ') : String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
export const toCsv = (cols, rows) => [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n') + '\r\n';
const CSV_COLS = ['business', 'trading_name', 'contact_name', 'email', 'phone', 'address', 'billing_address', 'website', 'source', 'pipeline_stage', 'premises_type', 'company_number', 'vat_number', 'tags', 'notes'];

export function customerRoutes(app, pool) {
  // list (existing behaviour: an array). Optional ?q ?stage ?owner ?archived=1 ?limit ?offset ?sort
  app.get('/api/contacts', async (req, res) => {
    const p = [], w = [req.query.archived === '1' ? 'archived_at is not null' : 'archived_at is null'];
    if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`(lower(coalesce(business,'')) like $${p.length} or lower(coalesce(contact_name,'')) like $${p.length} or lower(coalesce(email,'')) like $${p.length} or coalesce(phone,'') like $${p.length} or lower(coalesce(address,'')) like $${p.length})`); }
    if (req.query.stage) { p.push(String(req.query.stage)); w.push(`pipeline_stage = $${p.length}`); }
    if (req.query.owner) { p.push(String(req.query.owner)); w.push(`owner_id = $${p.length}`); }
    w.push(inArea(areaOf(req), 'id'));
    const sort = { business: 'lower(business) asc nulls last', created: 'created_at desc', stage: 'pipeline_stage, updated_at desc' }[req.query.sort] || 'updated_at desc';
    const limit = Math.min(1000, Number(req.query.limit) || 5000), offset = Math.max(0, Number(req.query.offset) || 0);
    const { rows } = await pool.query(`select *, count(*) over() as total from contacts where ${w.join(' and ')} order by ${sort} limit ${limit} offset ${offset}`, p);
    res.set('X-Total-Count', String(rows[0]?.total || 0)).json(rows.map(({ total, ...r }) => r));
  });

  // board data: each open customer with its next task, days in stage and live proposal value
  app.get('/api/pipeline', async (req, res) => {
    const { rows } = await pool.query(
      `select c.id, c.business, c.contact_name, c.email, c.phone, c.source, c.pipeline_stage, c.owner_id, u.name as owner_name, c.updated_at, c.created_at, c.booking_token,
              coalesce((select max(e.at) from events e where e.contact_id = c.id and e.type = 'stage_change' and e.body = c.pipeline_stage), c.created_at) as stage_since,
              t.title as next_task, t.due_at as next_task_due,
              (select coalesce(sum(p.monthly_net_pence), 0) from proposals p where p.contact_id = c.id and p.status = 'sent' and p.archived_at is null)::bigint as quoted_monthly_pence
       from contacts c left join users u on u.id = c.owner_id
       left join lateral (select title, due_at from tasks where contact_id = c.id and not done order by due_at nulls last limit 1) t on true
       where c.archived_at is null and ${inArea(areaOf(req), 'c.id')} order by c.updated_at desc`);
    res.json(rows);
  });

  app.get('/api/contacts/duplicates', async (req, res) => res.json(await findDuplicates(pool, req.query, req.query.exclude || null)));

  app.post('/api/contacts', async (req, res) => {
    const f = cleanContact(req.body || {}, { partial: false });
    if (!req.body.force) {
      const dups = await findDuplicates(pool, f);
      if (dups.length) return res.status(409).json({ error: 'This looks like a customer you already have.', duplicates: dups });
    }
    f.owner_id ??= req.user.id;
    f.area ??= areaOf(req) || req.user.area || 'manchester';
    const cols = Object.keys(f);
    const c = await tx(pool, async (db) => {
      let row;
      try {
        ({ rows: [row] } = await db.query(`insert into contacts (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, cols.map((k) => f[k])));
      } catch (e) { if (e.code === '23505') throw httpError(409, 'A customer with that email already exists.'); throw e; }
      if (row.contact_name || row.email || row.phone) await db.query(`insert into contact_people (contact_id, name, email, phone, is_primary, is_signer) values ($1,$2,$3,$4,true,true)`, [row.id, row.contact_name || row.business, row.email, row.phone]);
      if (row.address) await db.query(`insert into sites (contact_id, name, address) values ($1,'Main site',$2)`, [row.id, row.address]);
      await logEvent(db, row.id, 'created', `Customer added${row.source ? ` (source: ${row.source})` : ''}`);
      await audit(db, req, 'customer_created', 'contact', row.id, { business: row.business });
      return row;
    });
    runAutomation(pool, 'lead_created', { contact_id: c.id }).catch((e) => console.error('[automation]', e));
    res.status(201).json(c);
  });

  app.get('/api/contacts/:id/profile', async (req, res) => {
    const id = req.params.id;
    const { rows: [c] } = await pool.query(`select c.*, u.name as owner_name from contacts c left join users u on u.id = c.owner_id where c.id = $1`, [id]);
    if (!c) throw httpError(404, 'Customer not found');
    const q = (sql) => pool.query(sql, [id]).then((r) => r.rows);
    const [people, sites, proposals, contracts, tasks, appointments, documents, [inv]] = await Promise.all([
      q(`select * from contact_people where contact_id = $1 order by is_primary desc, name`),
      q(`select * from sites where contact_id = $1 order by archived_at nulls first, created_at`),
      q(`select id, number, title, status, version, issued_version, valid_until, monthly_net_pence, one_off_net_pence, sent_at, accepted_at, archived_at, updated_at from proposals where contact_id = $1 order by created_at desc`),
      q(`select id, number, status, version, start_date, renewal_date, end_date, monthly_net_pence, one_off_net_pence, signed_at, activated_at, data->>'schedule_notes' as schedule_notes from contracts where contact_id = $1 order by created_at desc`),
      q(`select t.*, u.name as assigned_name from tasks t left join users u on u.id = t.assigned_to where t.contact_id = $1 order by t.done, t.due_at nulls last limit 200`),
      q(`select * from appointments where contact_id = $1 order by starts_at desc limit 100`),
      q(`select id, kind, title, filename, size, created_at, contract_id, proposal_id from documents where contact_id = $1 and deleted_at is null order by created_at desc`),
      q(`select count(*)::int n from invoices where contact_id = $1`),
    ]);
    res.json({ ...c, people, sites, proposals, contracts: contracts, tasks, appointments, invoice_count: atLeast(req.user, 'manager') ? inv.n : 0,
      documents: documents.filter((d) => atLeast(req.user, 'manager') || !['contract_pdf', 'signed_pdf', 'audit_trail'].includes(d.kind)) });
  });

  app.patch('/api/contacts/:id', async (req, res) => {
    const f = cleanContact(req.body || {});
    const keys = Object.keys(f);
    if (!keys.length) throw httpError(400, 'no valid fields');
    const { rows: [before] } = await pool.query(`select * from contacts where id = $1`, [req.params.id]);
    if (!before) throw httpError(404, 'Customer not found');
    let row;
    try {
      ({ rows: [row] } = await pool.query(`update contacts set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [req.params.id, ...keys.map((k) => f[k])]));
    } catch (e) { if (e.code === '23505') throw httpError(409, 'Another customer already has that email.'); throw e; }
    if ('pipeline_stage' in f && f.pipeline_stage !== before.pipeline_stage) {
      await logEvent(pool, row.id, 'stage_change', f.pipeline_stage);
      // existing behaviour: auto-enrol into any campaign triggered by this stage
      const { enroll } = await import('./engine.mjs');
      const { rows: campaigns } = await pool.query(`select id from campaigns where status = 'active' and trigger_stage = $1 and area = (select area from contacts where id = $2)`, [f.pipeline_stage, req.params.id]);
      for (const cp of campaigns) await enroll(pool, cp.id, row.id);
    }
    const changed = keys.filter((k) => JSON.stringify(before[k]) !== JSON.stringify(row[k]));
    if (changed.length) await audit(pool, req, 'customer_updated', 'contact', row.id, { fields: changed });
    res.json(row);
  });

  // "Delete" archives: proposals, contracts and signed documents must survive.
  // Permanent delete: admin only, and only for a customer with no proposals/contracts/documents.
  app.delete('/api/contacts/:id', async (req, res) => {
    if (req.query.permanent === '1') {
      if (!atLeast(req.user, 'admin')) throw httpError(403, 'Only an administrator can permanently delete a customer.');
      const { rows: [n] } = await pool.query(`select (select count(*) from proposals where contact_id = $1) + (select count(*) from contracts where contact_id = $1) + (select count(*) from documents where contact_id = $1) as n`, [req.params.id]);
      if (Number(n.n)) throw httpError(409, 'This customer has proposals, contracts or documents — archive them instead. Those records are kept.');
      const { rows: [c] } = await pool.query(`delete from contacts where id = $1 returning business`, [req.params.id]);
      if (c) await audit(pool, req, 'customer_deleted', 'contact', req.params.id, { business: c.business });
      return res.status(204).end();
    }
    const { rows: [c] } = await pool.query(`update contacts set archived_at = coalesce(archived_at, now()), updated_at = now() where id = $1 returning id, business`, [req.params.id]);
    if (!c) throw httpError(404, 'Customer not found');
    // stop any running sequences for an archived customer
    await pool.query(`update enrollments set status = 'stopped', stopped_reason = 'archived', updated_at = now() where contact_id = $1 and status = 'active'`, [c.id]);
    await logEvent(pool, c.id, 'archived', 'Customer archived');
    await audit(pool, req, 'customer_archived', 'contact', c.id);
    res.status(204).end();
  });
  app.post('/api/contacts/:id/restore', async (req, res) => {
    const { rows: [c] } = await pool.query(`update contacts set archived_at = null, updated_at = now() where id = $1 returning *`, [req.params.id]);
    if (!c) throw httpError(404, 'Customer not found');
    await logEvent(pool, c.id, 'archived', 'Customer restored');
    await audit(pool, req, 'customer_restored', 'contact', c.id);
    res.json(c);
  });

  // ── people + sites ──
  const person = (b) => {
    const p = { name: str(b.name, 120), job_title: str(b.job_title, 120) || null, email: str(b.email, 200).toLowerCase() || null, phone: str(b.phone, 40) || null, notes: str(b.notes, 2000), is_primary: !!b.is_primary, is_signer: !!b.is_signer };
    if (!p.name) throw httpError(400, 'Name is required.');
    if (p.email && !validEmail(p.email)) throw httpError(400, 'That email address doesn’t look right.');
    return p;
  };
  app.post('/api/contacts/:id/people', async (req, res) => {
    const p = person(req.body || {});
    const { rows: [r] } = await tx(pool, async (db) => {
      if (p.is_primary) await db.query(`update contact_people set is_primary = false where contact_id = $1`, [req.params.id]);
      return db.query(`insert into contact_people (contact_id, name, job_title, email, phone, notes, is_primary, is_signer) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
        [req.params.id, p.name, p.job_title, p.email, p.phone, p.notes, p.is_primary, p.is_signer]);
    });
    await audit(pool, req, 'person_added', 'contact', req.params.id, { person: r.id });
    res.status(201).json(r);
  });
  app.patch('/api/people/:id', async (req, res) => {
    const p = person(req.body || {});
    const r = await tx(pool, async (db) => {
      const { rows: [old] } = await db.query(`select contact_id from contact_people where id = $1`, [req.params.id]);
      if (!old) throw httpError(404, 'Not found');
      if (p.is_primary) await db.query(`update contact_people set is_primary = false where contact_id = $1`, [old.contact_id]);
      return (await db.query(`update contact_people set name=$2, job_title=$3, email=$4, phone=$5, notes=$6, is_primary=$7, is_signer=$8 where id = $1 returning *`,
        [req.params.id, p.name, p.job_title, p.email, p.phone, p.notes, p.is_primary, p.is_signer])).rows[0];
    });
    await audit(pool, req, 'person_updated', 'contact', r.contact_id, { person: r.id });
    res.json(r);
  });
  app.delete('/api/people/:id', async (req, res) => {
    const { rows: [r] } = await pool.query(`delete from contact_people where id = $1 returning contact_id`, [req.params.id]);
    if (r) await audit(pool, req, 'person_removed', 'contact', r.contact_id, { person: req.params.id });
    res.status(204).end();
  });
  const site = (b) => {
    const s = { name: str(b.name, 120) || 'Site', address: str(b.address, 400), access_notes: str(b.access_notes, 4000) };
    if (!s.address) throw httpError(400, 'Address is required.');
    return s;
  };
  app.post('/api/contacts/:id/sites', async (req, res) => {
    const s = site(req.body || {});
    const { rows: [r] } = await pool.query(`insert into sites (contact_id, name, address, access_notes) values ($1,$2,$3,$4) returning *`, [req.params.id, s.name, s.address, s.access_notes]);
    await audit(pool, req, 'site_added', 'contact', req.params.id, { site: r.id });
    res.status(201).json(r);
  });
  app.patch('/api/sites/:id', async (req, res) => {
    const s = site(req.body || {});
    const { rows: [r] } = await pool.query(`update sites set name=$2, address=$3, access_notes=$4 where id = $1 returning *`, [req.params.id, s.name, s.address, s.access_notes]);
    if (!r) throw httpError(404, 'Not found');
    await audit(pool, req, 'site_updated', 'contact', r.contact_id, { site: r.id });
    res.json(r);
  });
  app.delete('/api/sites/:id', async (req, res) => {
    const { rows: [r] } = await pool.query(`update sites set archived_at = now() where id = $1 returning contact_id`, [req.params.id]);
    if (r) await audit(pool, req, 'site_archived', 'contact', r.contact_id, { site: req.params.id });
    res.status(204).end();
  });

  // ── CSV ──
  app.get('/api/contacts.csv', requireRole('manager'), async (req, res) => {
    const { rows } = await pool.query(`select * from contacts where ${req.query.archived === '1' ? 'true' : 'archived_at is null'} order by lower(business)`);
    await audit(pool, req, 'customers_exported', 'contact', null, { rows: rows.length });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fc-customers-${new Date().toISOString().slice(0, 10)}.csv"`, 'Cache-Control': 'no-store' })
      .send(`﻿${toCsv(CSV_COLS, rows)}`);
  });

  // body = CSV text. ?dry_run=1 previews. Rows matching an existing customer are skipped.
  app.post('/api/contacts/import', requireRole('manager'), express.text({ type: () => true, limit: '5mb' }), async (req, res) => {
    const rows = parseCsv(req.body || '');
    if (rows.length < 2) throw httpError(400, 'The file needs a header row and at least one customer.');
    if (rows.length > 5001) throw httpError(400, 'At most 5,000 rows per import.');
    const head = rows[0].map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'));
    const unknown = head.filter((h) => h && !CSV_COLS.includes(h));
    if (!head.includes('business') && !head.includes('contact_name')) throw httpError(400, 'Needs a “business” or “contact_name” column.');
    const report = { total: rows.length - 1, created: 0, duplicates: [], errors: [], ignored_columns: unknown };
    const seen = new Set();
    await tx(pool, async (db) => {
      for (const [i, r] of rows.slice(1).entries()) {
        const raw = Object.fromEntries(head.map((h, j) => [h, r[j] ?? '']).filter(([h]) => CSV_COLS.includes(h)));
        if (raw.pipeline_stage) raw.pipeline_stage = raw.pipeline_stage.toLowerCase().replace(/\s+/g, '_'); else delete raw.pipeline_stage;
        let f;
        try { f = cleanContact(raw, { partial: false }); } catch (e) { report.errors.push({ row: i + 2, error: e.message }); continue; }
        const key = f.email || normBiz(f.business);
        const dups = seen.has(key) ? [{ business: '(earlier row in this file)' }] : await findDuplicates(db, f);
        seen.add(key);
        if (dups.length) { report.duplicates.push({ row: i + 2, business: f.business, matches: dups.map((d) => d.business || d.email) }); continue; }
        if (req.query.dry_run !== '1') {
          f.source ??= 'csv-import'; f.owner_id = req.user.id; f.area ??= areaOf(req) || req.user.area || 'manchester';
          const cols = Object.keys(f);
          const { rows: [c] } = await db.query(`insert into contacts (${cols.join(',')}) values (${cols.map((_, k) => `$${k + 1}`).join(',')}) returning id, contact_name, business, email, phone, address`, cols.map((k) => f[k]));
          if (c.contact_name || c.email || c.phone) await db.query(`insert into contact_people (contact_id, name, email, phone, is_primary, is_signer) values ($1,$2,$3,$4,true,true)`, [c.id, c.contact_name || c.business, c.email, c.phone]);
          if (c.address) await db.query(`insert into sites (contact_id, name, address) values ($1,'Main site',$2)`, [c.id, c.address]);
          await logEvent(db, c.id, 'created', 'Customer imported from CSV');
        }
        report.created++;
      }
      if (req.query.dry_run !== '1') await audit(db, req, 'customers_imported', 'contact', null, { created: report.created, duplicates: report.duplicates.length, errors: report.errors.length });
    });
    res.json({ ...report, dry_run: req.query.dry_run === '1' });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  assert.deepEqual(parseCsv('a,b\r\n"x, y","he said ""hi"""\n\n1,\n'), [['a', 'b'], ['x, y', 'he said "hi"'], ['1', '']]);
  assert.equal(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvCell(['a', 'b']), 'a; b');
  assert.equal(digits('+44 7791 355 363'), '7791355363');
  assert.equal(normBiz('The Moonbeam Coffee House Ltd'), 'moonbeamcoffeehouse');
  assert.throws(() => cleanContact({ email: 'nope' }), /email/);
  assert.throws(() => cleanContact({ pipeline_stage: 'bogus' }), /pipeline_stage/);
  assert.throws(() => cleanContact({ notes: 'x' }, { partial: false }), /business/);
  assert.deepEqual(cleanContact({ tags: 'a, b,,c', website: 'x.com', email: 'A@B.CO' }), { tags: ['a', 'b', 'c'], website: 'https://x.com', email: 'a@b.co' });
  console.log('customers ok');
}
