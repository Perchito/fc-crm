// Proposal builder: drafts with server-priced lines, reusable sections, live PDF preview,
// immutable issued versions (snapshot + PDF), sending, accept / reject / expire, revise,
// duplicate, archive. A sent version is never edited — revising starts version N+1.
import { priceDocument, lineForEditing } from './pricing.mjs';
import { renderProposal, merge, unresolved, fmtDate } from './pdf.mjs';
import { saveDocument, readDocument } from './documents.mjs';
import { audit, requireRole, atLeast } from './auth.mjs';
import { httpError, logEvent, initials, nextNumber, tx, todayIso, addDaysIso, str, validEmail } from './biz.mjs';
import { sendEmail, emailConfigured } from './mailer.mjs';
import { brandEmail, p as para, facts, hi, esc } from './emails.mjs';
import { runAutomation } from './automation.mjs';

const PUBLIC_URL = process.env.PUBLIC_URL || 'https://crm.perchito.app';
export const GENERATED = { scope: 'Scope of Services', schedule: 'Cleaning Schedule & Frequency', pricing: 'Pricing & Service Breakdown' };
const PROPOSAL_ORDER = { executive_summary: 10, scope: 20, schedule: 25, management_qa: 40, exclusions_assumptions: 50, health_safety: 60, pricing: 65, commercial_terms: 70, acceptance: 90 };

export async function getCompany(db) {
  const { rows: [r] } = await db.query(`select v from meta where k = 'company'`);
  return r?.v || {};
}

/** Section list for a new document: library blocks + generated slots, in order. */
export async function defaultSections(db, docType) {
  const { rows } = await db.query(`select key, title, body, sort, required from content_blocks where doc_type = $1 and active order by sort`, [docType]);
  const list = rows.map((b) => ({ key: b.key, title: b.title, body: b.body, enabled: true, required: b.required, sort: b.sort }));
  const gen = docType === 'proposal' ? ['scope', 'schedule', 'pricing'] : ['scope'];
  for (const k of gen) if (!list.some((s) => s.key === k)) list.push({ key: k, title: GENERATED[k], body: '', enabled: true, generated: true, required: true, sort: docType === 'proposal' ? PROPOSAL_ORDER[k] : 20 });
  return list.sort((a, b) => a.sort - b.sort).map(({ sort, ...s }) => s);
}

/** Customer / person / site details exactly as they will be printed. */
export async function customerParts(db, contactId, personId, siteId) {
  const { rows: [c] } = await db.query(`select * from contacts where id = $1`, [contactId]);
  if (!c) throw httpError(404, 'Customer not found');
  const person = personId ? (await db.query(`select * from contact_people where id = $1 and contact_id = $2`, [personId, contactId])).rows[0] : null;
  const site = siteId ? (await db.query(`select * from sites where id = $1 and contact_id = $2`, [siteId, contactId])).rows[0] : null;
  return {
    customer: { id: c.id, business: c.business || c.contact_name || 'Customer', trading_name: c.trading_name, company_number: c.company_number, vat_number: c.vat_number,
      address: c.address, billing_address: c.billing_address, payment_terms: c.payment_terms },
    person: person ? { id: person.id, name: person.name, job_title: person.job_title, email: person.email, phone: person.phone } : (c.contact_name ? { name: c.contact_name, email: c.email, phone: c.phone } : null),
    site: site ? { id: site.id, name: site.name, address: site.address } : null,
  };
}

/** Clean editable draft data coming from the browser; prices it. */
export function normaliseData(raw = {}) {
  const priced = priceDocument({ lines: raw.lines || [], vat_rate_bp: raw.vat_rate_bp ?? 2000 });
  const sections = (Array.isArray(raw.sections) ? raw.sections : []).slice(0, 30).map((s) => ({
    key: str(s.key, 40).replace(/[^\w]/g, '') || `custom_${Math.random().toString(36).slice(2, 7)}`,
    title: str(s.title, 120) || 'Section', body: str(s.body, 20000), enabled: s.enabled !== false, required: !!s.required, generated: !!s.generated,
  }));
  const pairs = (v) => (Array.isArray(v) ? v : []).slice(0, 20).map((r) => [str(r?.[0], 80), str(r?.[1], 300)]).filter(([a, b]) => a || b);
  return {
    data: {
      lines: priced.lines.map(lineForEditing),
      vat_rate_bp: priced.totals.vat_rate_bp,
      sections,
      summary_rows: pairs(raw.summary_rows),
      terms_extra: pairs(raw.terms_extra),
      minimum_term: str(raw.minimum_term, 60),
      notice_period: str(raw.notice_period, 60),
      start_date_text: str(raw.start_date_text, 120),
      schedule_notes: str(raw.schedule_notes, 4000),
      internal_notes: str(raw.internal_notes, 4000),
    },
    priced,
  };
}

export function termsRows(d) {
  return [
    ['Start date', d.start_date_text || 'To be confirmed by the client'],
    ...(d.minimum_term ? [['Minimum term', `${d.minimum_term} from the start date`]] : []),
    ...(d.notice_period ? [['Notice period', `${d.notice_period} in writing after the minimum term`]] : []),
    ...(d.terms_extra || []),
  ];
}

/** Everything the PDF prints — stored verbatim with each issued version. */
export async function proposalSnapshot(db, p, version) {
  const company = await getCompany(db);
  const parts = await customerParts(db, p.contact_id, p.person_id, p.site_id);
  const { data, priced } = normaliseData(p.data);
  const vars = { client: parts.customer.business, site_address: parts.site?.address || parts.customer.address || '[[site address]]', company: company.name,
    signatory_name: company.signatory_name, signatory_title: company.signatory_title, reference: p.number, minimum_term: data.minimum_term, notice_period: data.notice_period };
  return {
    kind: 'proposal', number: p.number, version, title: p.title, issue_date: p.issue_date || todayIso(), valid_until: p.valid_until,
    company, ...parts, vat_rate_bp: data.vat_rate_bp, lines: priced.lines, totals: priced.totals, assumptions: priced.assumptions,
    sections: data.sections.filter((s) => s.enabled).map((s) => ({ key: s.key, title: s.title, body: merge(s.body, vars) })),
    summary_rows: data.summary_rows.map(([a, b]) => [merge(a, vars), merge(b, vars)]), terms: termsRows(data).map(([a, b]) => [a, merge(b, vars)]),
    schedule_notes: merge(data.schedule_notes, vars), minimum_term: data.minimum_term, notice_period: data.notice_period, start_date_text: data.start_date_text,
  };
}

/** Reasons a proposal can't be issued yet (empty = fine). */
export function proposalProblems(s) {
  const out = [];
  if (!s.lines.length) out.push('Add at least one priced service.');
  if (!s.lines.some((l) => !l.optional)) out.push('At least one service must not be optional.');
  if (!s.valid_until) out.push('Set a “valid until” date.');
  if (!(s.site?.address || s.customer.address)) out.push('Add the service address (a site, or the customer’s address).');
  const left = unresolved([...s.sections.map((x) => x.body), ...s.summary_rows.flat(), ...s.terms.flat(), s.schedule_notes, ...s.lines.map((l) => l.scope)]);
  if (left.length) out.push(`Fill in or remove: ${left.join(', ')}`);
  return out;
}

const STATUS_LABEL = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired' };

export function proposalRoutes(app, pool) {
  const load = async (db, id, lock = false) => {
    const { rows: [p] } = await db.query(`select * from proposals where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!p) throw httpError(404, 'Proposal not found');
    return p;
  };
  const priceRow = (priced) => [priced.totals.monthly_net, priced.totals.one_off_net, priced.totals.annual_net];

  app.get('/api/proposals', async (req, res) => {
    const p = [], w = [];
    if (req.query.contact_id) { p.push(req.query.contact_id); w.push(`pr.contact_id = $${p.length}`); }
    if (req.query.status) { p.push(String(req.query.status)); w.push(`pr.status = $${p.length}`); }
    w.push(req.query.archived === '1' ? 'pr.archived_at is not null' : 'pr.archived_at is null');
    if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`(lower(pr.number) like $${p.length} or lower(c.business) like $${p.length} or lower(pr.title) like $${p.length})`); }
    const { rows } = await pool.query(
      `select pr.id, pr.number, pr.title, pr.status, pr.version, pr.issued_version, pr.issue_date, pr.valid_until, pr.monthly_net_pence, pr.one_off_net_pence, pr.annual_net_pence,
              pr.created_at, pr.updated_at, pr.sent_at, pr.accepted_at, pr.archived_at, pr.contact_id, c.business,
              (select id from contracts k where k.proposal_id = pr.id and k.status not in ('cancelled','declined') limit 1) as contract_id
       from proposals pr join contacts c on c.id = pr.contact_id where ${w.join(' and ')} order by pr.updated_at desc limit 500`, p);
    res.json(rows);
  });

  app.post('/api/proposals', async (req, res) => {
    const contactId = req.body?.contact_id;
    if (!contactId) throw httpError(400, 'Choose a customer first.');
    const { rows: [c] } = await pool.query(`select * from contacts where id = $1 and archived_at is null`, [contactId]).catch(() => ({ rows: [] }));
    if (!c) throw httpError(404, 'Customer not found');
    const company = await getCompany(pool);
    const { rows: services } = req.body.service_ids?.length
      ? await pool.query(`select * from service_templates where id = any($1::uuid[])`, [req.body.service_ids]) : { rows: [] };
    const lines = services.map((s, i) => ({ id: `l${i + 1}`, name: s.name, billing: s.billing, frequency: s.frequency, visits_per_week: s.visits_per_week ?? '', hours_per_visit: s.hours_per_visit ?? '',
      staff: s.staff ?? '', rate_pence: s.rate_pence ?? '', price_pence: s.price_pence ?? '', scope: s.scope, discount_type: 'none', discount_value: 0, optional: false }));
    const data = { lines, vat_rate_bp: company.vat_rate_bp ?? 2000, sections: await defaultSections(pool, 'proposal'),
      summary_rows: [['Quality assurance', 'Weekly follow-ups during the first 5 weeks']], terms_extra: [['Bank holidays', 'Cleaning proceeds as scheduled unless otherwise agreed'], ['Insurance', 'Public liability & employers’ liability details available on request']],
      minimum_term: '3 months', notice_period: '1 month', start_date_text: '', schedule_notes: '', internal_notes: '' };
    // lines from templates may be incomplete (e.g. hourly without a rate) — keep them unpriced until edited
    let priced;
    try { priced = normaliseData(data).priced; } catch { priced = null; }
    const person = req.body.person_id || (await pool.query(`select id from contact_people where contact_id = $1 order by is_primary desc, created_at limit 1`, [c.id])).rows[0]?.id || null;
    const site = req.body.site_id || (await pool.query(`select id from sites where contact_id = $1 and archived_at is null order by created_at limit 1`, [c.id])).rows[0]?.id || null;
    const prop = await insertWithNumber(pool, `FCC-${initials(c.business || c.contact_name)}`, (number) => pool.query(
      `insert into proposals (number, contact_id, person_id, site_id, title, data, totals, monthly_net_pence, one_off_net_pence, annual_net_pence, issue_date, valid_until, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
      [number, c.id, person, site, str(req.body.title, 120) || 'Commercial Cleaning Proposal', data, priced?.totals || {}, ...(priced ? priceRow(priced) : [0, 0, 0]),
        todayIso(), addDaysIso(todayIso(), company.proposal_valid_days || 30), req.user.id]));
    await logEvent(pool, c.id, 'proposal', `Proposal ${prop.number} started`, { proposal_id: prop.id });
    await audit(pool, req, 'proposal_created', 'proposal', prop.id, { number: prop.number });
    res.status(201).json(prop);
  });

  app.get('/api/proposals/:id', async (req, res) => {
    const p = await load(pool, req.params.id);
    const { rows: versions } = await pool.query(`select v.id, v.version, v.issued_at, v.document_id, u.name as issued_by_name from proposal_versions v left join users u on u.id = v.issued_by where proposal_id = $1 order by version desc`, [p.id]);
    const { rows: [contact] } = await pool.query(`select id, business, contact_name, email, address, pipeline_stage from contacts where id = $1`, [p.contact_id]);
    const { rows: people } = await pool.query(`select * from contact_people where contact_id = $1 order by is_primary desc, name`, [p.contact_id]);
    const { rows: sites } = await pool.query(`select * from sites where contact_id = $1 and archived_at is null order by created_at`, [p.contact_id]);
    const { rows: [contract] } = await pool.query(`select id, number, status from contracts where proposal_id = $1 and status not in ('cancelled','declined')`, [p.id]);
    let priced = null, problems = [];
    try {
      const snap = await proposalSnapshot(pool, p, p.version);
      priced = { lines: snap.lines.map((l) => ({ id: l.id, price: l.price })), totals: snap.totals, assumptions: snap.assumptions };
      problems = proposalProblems(snap);
    } catch (e) { problems = [e.message]; }
    res.json({ ...p, contact, people, sites, versions, contract: contract || null, priced, problems });
  });

  // live price check while editing (nothing saved)
  app.post('/api/pricing/preview', (req, res) => {
    const priced = priceDocument({ lines: req.body?.lines || [], vat_rate_bp: req.body?.vat_rate_bp ?? 2000 });
    res.json({ lines: priced.lines.map((l) => ({ id: l.id, price: l.price })), totals: priced.totals, assumptions: priced.assumptions });
  });

  app.patch('/api/proposals/:id', async (req, res) => {
    const out = await tx(pool, async (db) => {
      const p = await load(db, req.params.id, true);
      if (p.status !== 'draft') throw httpError(409, 'This proposal has been sent. Use “Revise” to start a new version — the sent one stays as it was.');
      const b = req.body || {};
      const { data, priced } = b.data ? normaliseData(b.data) : { data: p.data, priced: null };
      for (const k of ['person_id', 'site_id']) if (b[k]) {
        const t = k === 'person_id' ? 'contact_people' : 'sites';
        const { rows: [x] } = await db.query(`select id from ${t} where id = $1 and contact_id = $2`, [b[k], p.contact_id]);
        if (!x) throw httpError(400, 'That contact or site belongs to another customer.');
      }
      const { rows: [u] } = await db.query(
        `update proposals set data = $2, totals = coalesce($3, totals), monthly_net_pence = coalesce($4, monthly_net_pence), one_off_net_pence = coalesce($5, one_off_net_pence),
           annual_net_pence = coalesce($6, annual_net_pence), title = coalesce(nullif($7,''), title), person_id = coalesce($8, person_id), site_id = coalesce($9, site_id),
           valid_until = coalesce($10::date, valid_until), issue_date = coalesce($11::date, issue_date), updated_at = now() where id = $1 returning *`,
        [p.id, data, priced?.totals || null, ...(priced ? priceRow(priced) : [null, null, null]), str(b.title, 120), b.person_id || null, b.site_id || null, b.valid_until || null, b.issue_date || null]);
      return u;
    });
    res.json(out);
  });

  // draft preview (DRAFT watermark-free: it's exactly what will be issued) or an issued version's PDF
  app.get('/api/proposals/:id/pdf', async (req, res) => {
    const p = await load(pool, req.params.id);
    let buf;
    if (req.query.version) {
      const { rows: [v] } = await pool.query(`select v.*, d.storage_key, d.kind from proposal_versions v join documents d on d.id = v.document_id where v.proposal_id = $1 and v.version = $2`, [p.id, Number(req.query.version)]);
      if (!v) throw httpError(404, 'Version not found');
      buf = await readDocument(v);
    } else {
      const snap = await proposalSnapshot(pool, p, p.version);
      buf = await renderProposal(snap);
    }
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${p.number}${req.query.version ? `-v${req.query.version}` : '-draft'}.pdf"` }).send(buf);
  });

  /** Freezes the current draft as version N (snapshot + PDF document). Idempotent per version. */
  async function issue(db, p, req) {
    const existing = (await db.query(`select * from proposal_versions where proposal_id = $1 and version = $2`, [p.id, p.version])).rows[0];
    if (existing) return existing;
    const snap = await proposalSnapshot(db, p, p.version);
    const problems = proposalProblems(snap);
    if (problems.length) throw httpError(422, 'This proposal isn’t ready to issue yet.', { problems });
    const pdf = await renderProposal(snap);
    const doc = await saveDocument(db, { buffer: pdf, mime: 'application/pdf', filename: `${p.number}-v${p.version}.pdf`, title: `Proposal ${p.number} v${p.version}`,
      kind: 'proposal_pdf', contact_id: p.contact_id, proposal_id: p.id, user_id: req.user.id });
    const { rows: [v] } = await db.query(`insert into proposal_versions (proposal_id, version, snapshot, document_id, issued_by) values ($1,$2,$3,$4,$5) returning *`,
      [p.id, p.version, snap, doc.id, req.user.id]);
    await db.query(`update proposals set issued_version = $2, issue_date = $3, totals = $4, monthly_net_pence = $5, one_off_net_pence = $6, annual_net_pence = $7 where id = $1`,
      [p.id, p.version, snap.issue_date, snap.totals, snap.totals.monthly_net, snap.totals.one_off_net, snap.totals.annual_net]);
    await audit(db, req, 'proposal_issued', 'proposal', p.id, { version: p.version, document_id: doc.id });
    return { ...v, snapshot: snap, pdf };
  }

  async function markSent(db, p, req, how) {
    await db.query(`update proposals set status = 'sent', sent_at = now(), updated_at = now() where id = $1`, [p.id]);
    await logEvent(db, p.contact_id, 'proposal', `Proposal ${p.number} v${p.version} ${how}`, { proposal_id: p.id, version: p.version });
    // pipeline: a sent proposal means the customer has been quoted
    const { rows: [c] } = await db.query(`select pipeline_stage from contacts where id = $1`, [p.contact_id]);
    if (['new', 'contacted', 'visit_booked'].includes(c.pipeline_stage)) {
      await db.query(`update contacts set pipeline_stage = 'quoted', updated_at = now() where id = $1`, [p.contact_id]);
      await logEvent(db, p.contact_id, 'stage_change', 'quoted');
    }
  }

  app.post('/api/proposals/:id/issue', requireRole('manager'), async (req, res) => {
    const v = await tx(pool, async (db) => issue(db, await load(db, req.params.id, true), req));
    res.json({ version: v.version, document_id: v.document_id });
  });

  app.post('/api/proposals/:id/mark-sent', requireRole('manager'), async (req, res) => {
    await tx(pool, async (db) => {
      const p = await load(db, req.params.id, true);
      if (p.status !== 'draft') throw httpError(409, `Already ${STATUS_LABEL[p.status].toLowerCase()}.`);
      await issue(db, p, req);
      await markSent(db, p, req, 'marked as sent (outside the CRM)');
    });
    runAutomation(pool, 'proposal_sent', { proposal_id: req.params.id }).catch((e) => console.error('[automation]', e));
    res.json({ ok: true });
  });

  // emails the issued PDF to the customer. The PDF is generated + stored before the email
  // goes; if the email fails the proposal stays a draft (with its issued version) and can be retried.
  app.post('/api/proposals/:id/send', requireRole('manager'), async (req, res) => {
    const b = req.body || {};
    const to = str(b.to, 200).toLowerCase(), cc = str(b.cc, 200).toLowerCase();
    if (!validEmail(to) || (cc && !validEmail(cc))) throw httpError(400, 'Enter a valid email address.');
    if (!emailConfigured()) throw httpError(503, 'Email isn’t set up on the server.');
    const { p, v } = await tx(pool, async (db) => {
      const p = await load(db, req.params.id, true);
      if (p.status !== 'draft') throw httpError(409, `Already ${STATUS_LABEL[p.status].toLowerCase()} — revise it to send a new version.`);
      return { p, v: await issue(db, p, req) };
    });
    const snap = v.snapshot || (await pool.query(`select snapshot from proposal_versions where id = $1`, [v.id])).rows[0].snapshot;
    const pdf = v.pdf || await readDocument((await pool.query(`select * from documents where id = $1`, [v.document_id])).rows[0]);
    const message = str(b.message, 4000) || `Please find attached our proposal for cleaning services at ${snap.site?.address || snap.customer.address || snap.customer.business}.`;
    const body = hi(snap.person?.name?.split(' ')[0] || 'there') + message.split(/\n{2,}/).map((x) => para(esc(x).replace(/\n/g, '<br>'))).join('')
      + facts([['Reference', `${snap.number} (version ${snap.version})`], ['Valid until', fmtDate(snap.valid_until)]])
      + para(`Any questions, just reply to this email or call ${esc(snap.company.phone || '')}.`)
      + para(`Kind regards,<br>${esc(snap.company.signatory_name || '')}<br>${esc(snap.company.signatory_title || '')}, ${esc(snap.company.name)}`);
    try {
      await sendEmail({ to, cc: cc || undefined, subject: str(b.subject, 200) || `Cleaning proposal ${snap.number} — ${snap.company.name}`,
        text: `${message}\n\nReference: ${snap.number} (version ${snap.version})\nValid until: ${fmtDate(snap.valid_until)}\n\n${snap.company.signatory_name || ''}\n${snap.company.name}`,
        html: brandEmail({ url: PUBLIC_URL, title: 'Your cleaning proposal', body }),
        attachments: [{ filename: `${snap.number}-v${snap.version}.pdf`, content: pdf, contentType: 'application/pdf' }] });
    } catch (e) {
      await audit(pool, req, 'proposal_send_failed', 'proposal', p.id, { to, error: String(e.message).slice(0, 300) });
      throw httpError(502, `The email didn’t go: ${String(e.message).slice(0, 200)}. The proposal is still a draft — try again.`);
    }
    await tx(pool, async (db) => { await markSent(db, p, req, `emailed to ${to}`); await audit(db, req, 'proposal_sent', 'proposal', p.id, { to, cc, version: p.version }); });
    runAutomation(pool, 'proposal_sent', { proposal_id: p.id }).catch((e) => console.error('[automation]', e));
    res.json({ ok: true });
  });

  const transition = (path, from, to, extra, role = 'manager') => app.post(`/api/proposals/:id/${path}`, requireRole(role), async (req, res) => {
    const p = await tx(pool, async (db) => {
      const p = await load(db, req.params.id, true);
      if (!from.includes(p.status)) throw httpError(409, `A ${STATUS_LABEL[p.status].toLowerCase()} proposal can’t be ${path === 'revise' ? 'revised' : `marked ${to}`}.`);
      await extra(db, p, req);
      await audit(db, req, `proposal_${path}`, 'proposal', p.id, { from: p.status, reason: str(req.body?.reason, 500) || undefined });
      return p;
    });
    if (path === 'accept') runAutomation(pool, 'proposal_accepted', { proposal_id: p.id }).catch((e) => console.error('[automation]', e));
    res.json({ ok: true });
  });
  transition('accept', ['sent', 'expired'], 'accepted', async (db, p) => {
    await db.query(`update proposals set status = 'accepted', accepted_at = now(), updated_at = now() where id = $1`, [p.id]);
    await logEvent(db, p.contact_id, 'proposal', `Proposal ${p.number} v${p.issued_version} accepted`, { proposal_id: p.id });
  });
  transition('reject', ['sent', 'expired'], 'rejected', async (db, p, req) => {
    await db.query(`update proposals set status = 'rejected', rejected_at = now(), updated_at = now() where id = $1`, [p.id]);
    await logEvent(db, p.contact_id, 'proposal', `Proposal ${p.number} rejected${req.body?.reason ? `: ${str(req.body.reason, 300)}` : ''}`, { proposal_id: p.id });
  });
  transition('revise', ['sent', 'rejected', 'expired'], 'draft', async (db, p) => {
    await db.query(`update proposals set status = 'draft', version = coalesce(issued_version, version) + 1, valid_until = null, updated_at = now() where id = $1`, [p.id]);
    await logEvent(db, p.contact_id, 'proposal', `Proposal ${p.number}: version ${(p.issued_version || p.version) + 1} started (v${p.issued_version} kept as sent)`, { proposal_id: p.id });
  });

  app.post('/api/proposals/:id/archive', async (req, res) => {
    const on = req.body?.archived !== false;
    const { rows: [p] } = await pool.query(`update proposals set archived_at = ${on ? 'now()' : 'null'}, updated_at = now() where id = $1 returning id`, [req.params.id]);
    if (!p) throw httpError(404, 'Proposal not found');
    await audit(pool, req, on ? 'proposal_archived' : 'proposal_unarchived', 'proposal', p.id);
    res.json({ ok: true });
  });

  app.post('/api/proposals/:id/duplicate', async (req, res) => {
    const src = await load(pool, req.params.id);
    const contactId = req.body?.contact_id || src.contact_id;
    const { rows: [c] } = await pool.query(`select * from contacts where id = $1`, [contactId]);
    if (!c) throw httpError(404, 'Customer not found');
    const same = contactId === src.contact_id;
    const company = await getCompany(pool);
    const dup = await insertWithNumber(pool, `FCC-${initials(c.business || c.contact_name)}`, (number) => pool.query(
      `insert into proposals (number, contact_id, person_id, site_id, title, data, totals, monthly_net_pence, one_off_net_pence, annual_net_pence, issue_date, valid_until, created_by, duplicated_from)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
      [number, contactId, same ? src.person_id : null, same ? src.site_id : null, src.title, src.data, src.totals, src.monthly_net_pence, src.one_off_net_pence, src.annual_net_pence,
        todayIso(), addDaysIso(todayIso(), company.proposal_valid_days || 30), req.user.id, src.id]));
    await logEvent(pool, contactId, 'proposal', `Proposal ${dup.number} created as a copy of ${src.number}`, { proposal_id: dup.id });
    await audit(pool, req, 'proposal_duplicated', 'proposal', dup.id, { from: src.id });
    res.status(201).json(dup);
  });
}

/** Insert with a generated reference, retrying if two people grab the same number at once. */
export async function insertWithNumber(db, prefix, insert, table = 'proposals') {
  for (let i = 0; i < 5; i++) {
    const number = await nextNumber(db, table, prefix);
    try { return (await insert(number)).rows[0]; } catch (e) { if (e.code !== '23505' || !String(e.constraint).includes('number')) throw e; }
  }
  throw httpError(503, 'Couldn’t allocate a reference number — try again.');
}

export { atLeast };
