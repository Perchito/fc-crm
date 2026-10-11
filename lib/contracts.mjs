// Service agreements. A contract is its own record: created from an accepted proposal by
// COPYING that proposal's issued snapshot (never a live link), edited as a draft, checked
// for missing information, issued as immutable versions, signed through DocuSeal
// (lib/docuseal.mjs), then activated, renewed or ended.
import { renderContract, merge, unresolved } from './pdf.mjs';
import { saveDocument, readDocument } from './documents.mjs';
import { audit, requireRole } from './auth.mjs';
import { httpError, logEvent, initials, tx, str, validEmail, todayIso, addMonthsIso, addDaysIso } from './biz.mjs';
import { getCompany, customerParts, normaliseData, defaultSections, insertWithNumber } from './proposals.mjs';
import { runAutomation } from './automation.mjs';

export const STATUSES = ['draft', 'review', 'ready', 'sent', 'partially_signed', 'signed', 'active', 'renewal_due', 'expired', 'terminated', 'cancelled', 'declined'];
export const EDITABLE = ['draft', 'review'];
// manual moves; signature-driven ones (sent → partially_signed → signed / declined) come from DocuSeal
const MOVES = {
  draft: ['review', 'cancelled'],
  review: ['draft', 'ready', 'cancelled'],
  ready: ['review', 'cancelled'],
  sent: ['cancelled'],
  partially_signed: ['cancelled'],
  signed: ['active'],
  active: ['renewal_due', 'terminated'],
  renewal_due: ['active', 'terminated', 'expired'],
  expired: ['active'],
  declined: [], terminated: [], cancelled: [],
};
export const canMove = (from, to) => (MOVES[from] || []).includes(to);
const REQUIRED_CLAUSES = ['overview', 'scope', 'commercial_terms', 'term_termination', 'liability_insurance', 'governing_law', 'acceptance'];

export async function contractSnapshot(db, k, version) {
  const company = await getCompany(db);
  const parts = await customerParts(db, k.contact_id, k.person_id, k.site_id);
  const { data, priced } = normaliseData(k.data);
  const vars = { client: parts.customer.business, site_address: parts.site?.address || parts.customer.address || '[[site address]]', company: company.name,
    signatory_name: company.signatory_name, signatory_title: company.signatory_title, reference: k.number,
    minimum_term: data.minimum_term || '[[minimum term]]', notice_period: data.notice_period || '[[notice period]]', start_date: k.start_date };
  return {
    kind: 'contract', number: k.number, version, issue_date: todayIso(), valid_until: addDaysIso(todayIso(), company.proposal_valid_days || 30), start_date: k.start_date, renewal_date: k.renewal_date, end_date: k.end_date,
    proposal_ref: k.data.proposal_ref || null, company, ...parts, signer: parts.person,
    vat_rate_bp: data.vat_rate_bp, lines: priced.lines, totals: priced.totals, assumptions: priced.assumptions,
    sections: data.sections.filter((s) => s.enabled).map((s) => ({ key: s.key, title: s.title, body: merge(s.body, vars) })),
    schedule_notes: merge(data.schedule_notes, vars), payment_terms: merge(k.data.payment_terms || '', vars),
    minimum_term: data.minimum_term, notice_period: data.notice_period,
  };
}

/** Everything that must be sorted before a contract can go out for signature. */
export function contractProblems(s) {
  const out = [];
  if (!s.start_date) out.push('Set the effective (start) date.');
  if (!(s.site?.address || s.customer.address)) out.push('Add the service address.');
  if (!s.signer?.name) out.push('Choose who signs for the customer (a contact person).');
  else if (!validEmail(s.signer.email)) out.push(`Add a valid email for ${s.signer.name} — DocuSeal sends the signing link there.`);
  if (!s.company.signatory_name || !validEmail(s.company.signatory_email)) out.push('Company signatory name/email are missing (Settings → Company).');
  if (!s.lines.some((l) => !l.optional)) out.push('The agreement has no priced service.');
  if (!s.minimum_term) out.push('Set the minimum / introductory term.');
  if (!s.notice_period) out.push('Set the notice period.');
  const keys = new Set(s.sections.map((x) => x.key));
  for (const k of REQUIRED_CLAUSES) if (!keys.has(k)) out.push(`The “${k.replace(/_/g, ' ')}” clause is switched off or missing.`);
  const left = unresolved([...s.sections.map((x) => x.body), s.schedule_notes, s.payment_terms, ...s.lines.map((l) => l.scope)]);
  if (left.length) out.push(`Fill in or remove: ${left.join(', ')}`);
  return out;
}

export function contractRoutes(app, pool) {
  const load = async (db, id, lock = false) => {
    const { rows: [k] } = await db.query(`select * from contracts where id = $1 ${lock ? 'for update' : ''}`, [id]);
    if (!k) throw httpError(404, 'Contract not found');
    return k;
  };

  app.get('/api/contracts', async (req, res) => {
    const p = [], w = [req.query.archived === '1' ? 'k.archived_at is not null' : 'k.archived_at is null'];
    if (req.query.contact_id) { p.push(req.query.contact_id); w.push(`k.contact_id = $${p.length}`); }
    if (req.query.status) { p.push(String(req.query.status).split(',')); w.push(`k.status = any($${p.length})`); }
    if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`(lower(k.number) like $${p.length} or lower(c.business) like $${p.length})`); }
    const { rows } = await pool.query(
      `select k.id, k.number, k.status, k.version, k.issued_version, k.start_date, k.renewal_date, k.end_date, k.monthly_net_pence, k.one_off_net_pence, k.annual_net_pence,
              k.created_at, k.updated_at, k.signed_at, k.activated_at, k.contact_id, c.business, pr.number as proposal_number,
              (select status from signature_requests s where s.contract_id = k.id order by created_at desc limit 1) as signing_status
       from contracts k join contacts c on c.id = k.contact_id left join proposals pr on pr.id = k.proposal_id
       where ${w.join(' and ')} order by k.updated_at desc limit 500`, p);
    res.json(rows);
  });

  // from an accepted proposal (its latest issued version), or blank for a customer
  app.post('/api/contracts', requireRole('manager'), async (req, res) => {
    const b = req.body || {};
    const k = await tx(pool, async (db) => {
      let contactId = b.contact_id, data, proposal = null, pv = null, person = null, site = null;
      const sections = await defaultSections(db, 'contract');
      if (b.proposal_id) {
        ({ rows: [proposal] } = await db.query(`select * from proposals where id = $1 for update`, [b.proposal_id]));
        if (!proposal) throw httpError(404, 'Proposal not found');
        if (proposal.status !== 'accepted') throw httpError(409, 'Only an accepted proposal can become a contract.');
        const { rows: [existing] } = await db.query(`select id, number from contracts where proposal_id = $1 and status not in ('cancelled','declined')`, [proposal.id]);
        if (existing) throw httpError(409, `Contract ${existing.number} already exists for this proposal.`, { contract_id: existing.id });
        ({ rows: [pv] } = await db.query(`select * from proposal_versions where proposal_id = $1 and version = $2`, [proposal.id, proposal.issued_version]));
        if (!pv) throw httpError(409, 'The proposal has no issued version to copy.');
        const s = pv.snapshot;
        contactId = proposal.contact_id; person = proposal.person_id; site = proposal.site_id;
        // copy the agreed commercial terms from the snapshot the customer accepted
        data = { lines: s.lines.map((l) => ({ id: l.id, name: l.name, billing: l.billing, frequency: l.frequency, visits_per_week: l.visits_t == null ? '' : l.visits_t / 10,
          hours_per_visit: l.hours_c == null ? '' : l.hours_c / 100, staff: l.staff ?? '', rate_pence: l.rate_pence ?? '', price_pence: l.price_pence ?? '', discount_type: l.discount_type,
          discount_value: l.discount_value, optional: l.optional, scope: l.scope, schedule: l.schedule, notes: l.notes })),
        vat_rate_bp: s.vat_rate_bp, sections, schedule_notes: s.schedule_notes || '', minimum_term: s.minimum_term || '', notice_period: s.notice_period || '',
        payment_terms: s.customer.payment_terms || '', proposal_ref: `${s.number} v${s.version}`, summary_rows: [], terms_extra: [] };
      } else {
        if (!contactId) throw httpError(400, 'Choose a customer or an accepted proposal.');
        const company = await getCompany(db);
        data = { lines: [], vat_rate_bp: company.vat_rate_bp ?? 2000, sections, schedule_notes: '', minimum_term: '3 months', notice_period: '30 days', payment_terms: '', summary_rows: [], terms_extra: [] };
      }
      const { rows: [c] } = await db.query(`select * from contacts where id = $1`, [contactId]);
      if (!c) throw httpError(404, 'Customer not found');
      let priced = null;
      try { priced = normaliseData(data).priced; } catch { /* blank contract: priced once lines are added */ }
      const k = await insertWithNumber(db, `AGR-${initials(c.business || c.contact_name)}`, (number) => db.query(
        `insert into contracts (number, contact_id, proposal_id, proposal_version_id, site_id, person_id, data, totals, monthly_net_pence, one_off_net_pence, annual_net_pence, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
        [number, contactId, proposal?.id || null, pv?.id || null, site, person, data, priced?.totals || {}, priced?.totals.monthly_net || 0, priced?.totals.one_off_net || 0, priced?.totals.annual_net || 0, req.user.id]), 'contracts');
      await logEvent(db, contactId, 'contract', `Contract ${k.number} drafted${proposal ? ` from proposal ${proposal.number}` : ''}`, { contract_id: k.id });
      await audit(db, req, 'contract_created', 'contract', k.id, { number: k.number, proposal_id: proposal?.id });
      return k;
    });
    res.status(201).json(k);
  });

  app.get('/api/contracts/:id', async (req, res) => {
    const k = await load(pool, req.params.id);
    const q = (sql, p = [k.id]) => pool.query(sql, p).then((r) => r.rows);
    const [versions, signatures, history, [contact], people, sites] = await Promise.all([
      q(`select v.id, v.version, v.issued_at, v.document_id, u.name as issued_by_name from contract_versions v left join users u on u.id = v.issued_by where contract_id = $1 order by version desc`),
      q(`select id, contract_version, status, docuseal_submission_id, docuseal_template_id, signers, error, created_at, updated_at, completed_at, signed_document_id, audit_document_id from signature_requests where contract_id = $1 order by created_at desc`),
      q(`select at, type, body from events where meta->>'contract_id' = $1::text order by at desc limit 200`),
      q(`select id, business, contact_name, email, address, payment_terms from contacts where id = $1`, [k.contact_id]),
      q(`select * from contact_people where contact_id = $1 order by is_primary desc, name`, [k.contact_id]),
      q(`select * from sites where contact_id = $1 and archived_at is null order by created_at`, [k.contact_id]),
    ]);
    const { rows: [proposal] } = k.proposal_id ? await pool.query(`select id, number, status from proposals where id = $1`, [k.proposal_id]) : { rows: [] };
    let problems = [], priced = null;
    try {
      const snap = await contractSnapshot(pool, k, k.version);
      problems = contractProblems(snap);
      priced = { lines: snap.lines.map((l) => ({ id: l.id, price: l.price })), totals: snap.totals, assumptions: snap.assumptions };
    } catch (e) { problems = [e.message]; }
    res.json({ ...k, contact, people, sites, proposal: proposal || null, versions, signatures, history, problems, priced, moves: MOVES[k.status] || [] });
  });

  app.patch('/api/contracts/:id', requireRole('manager'), async (req, res) => {
    const out = await tx(pool, async (db) => {
      const k = await load(db, req.params.id, true);
      if (!EDITABLE.includes(k.status)) throw httpError(409, 'Only draft or in-review contracts can be edited. Issued versions are fixed — revise to make a new version.');
      const b = req.body || {};
      let data = k.data, priced = null;
      if (b.data) {
        const n = normaliseData(b.data);
        priced = n.priced;
        data = { ...n.data, payment_terms: str(b.data.payment_terms, 4000), proposal_ref: k.data.proposal_ref || null };
      }
      for (const key of ['person_id', 'site_id']) if (b[key]) {
        const t = key === 'person_id' ? 'contact_people' : 'sites';
        const { rows: [x] } = await db.query(`select id from ${t} where id = $1 and contact_id = $2`, [b[key], k.contact_id]);
        if (!x) throw httpError(400, 'That contact or site belongs to another customer.');
      }
      const date = (v) => (v === '' ? null : v);
      const start = b.start_date !== undefined ? date(b.start_date) : k.start_date;
      // default renewal = start + minimum term when the term is "N months"
      let renewal = b.renewal_date !== undefined ? date(b.renewal_date) : k.renewal_date;
      const months = Number(String(data.minimum_term || '').match(/^(\d+)\s*months?/i)?.[1]);
      if (!renewal && start && months) renewal = addMonthsIso(start, months);
      const { rows: [u] } = await db.query(
        `update contracts set data = $2, totals = coalesce($3, totals), monthly_net_pence = coalesce($4, monthly_net_pence), one_off_net_pence = coalesce($5, one_off_net_pence),
           annual_net_pence = coalesce($6, annual_net_pence), person_id = coalesce($7, person_id), site_id = coalesce($8, site_id),
           start_date = $9, renewal_date = $10, end_date = $11, updated_at = now() where id = $1 returning *`,
        [k.id, data, priced?.totals || null, priced?.totals.monthly_net ?? null, priced?.totals.one_off_net ?? null, priced?.totals.annual_net ?? null,
          b.person_id || null, b.site_id || null, start, renewal, b.end_date !== undefined ? date(b.end_date) : k.end_date]);
      await audit(db, req, 'contract_edited', 'contract', k.id);
      return u;
    });
    res.json(out);
  });

  app.get('/api/contracts/:id/pdf', requireRole('manager'), async (req, res) => {
    const k = await load(pool, req.params.id);
    let buf;
    if (req.query.version) {
      const { rows: [v] } = await pool.query(`select d.storage_key from contract_versions v join documents d on d.id = v.document_id where v.contract_id = $1 and v.version = $2`, [k.id, Number(req.query.version)]);
      if (!v) throw httpError(404, 'Version not found');
      buf = await readDocument(v);
    } else buf = (await renderContract(await contractSnapshot(pool, k, k.version))).buffer;
    await audit(pool, req, 'contract_pdf_viewed', 'contract', k.id, { version: req.query.version || 'draft' });
    res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'private, no-store', 'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${k.number}${req.query.version ? `-v${req.query.version}` : '-draft'}.pdf"` }).send(buf);
  });

  app.post('/api/contracts/:id/status', requireRole('manager'), async (req, res) => {
    const to = String(req.body?.to || ''), reason = str(req.body?.reason, 500);
    const k = await tx(pool, async (db) => {
      const k = await load(db, req.params.id, true);
      if (!canMove(k.status, to)) throw httpError(409, `A contract can’t go from “${k.status.replace('_', ' ')}” to “${to.replace('_', ' ')}”.`);
      if (['ready', 'active'].includes(to)) {
        const problems = contractProblems(await contractSnapshot(db, k, k.version));
        if (problems.length) throw httpError(422, 'Sort these out first:', { problems });
      }
      if (to === 'active' && !k.signed_document_id) throw httpError(409, 'Activate only once the signed PDF has been received from DocuSeal.');
      if (to === 'cancelled') {
        const { rows: [live] } = await db.query(`select id from signature_requests where contract_id = $1 and status in ('creating','sent','partially_signed')`, [k.id]);
        if (live) throw httpError(409, 'Cancel the signature request first (Signing → Cancel request).');
      }
      if (to === 'terminated' && !reason) throw httpError(400, 'Give a reason for ending the contract.');
      const extra = to === 'active' ? `, activated_at = coalesce(activated_at, now())` : ['terminated', 'expired', 'cancelled'].includes(to) ? ', ended_at = now()' : '';
      const renewal = to === 'active' && req.body?.renewal_date ? req.body.renewal_date : null;
      await db.query(`update contracts set status = $2, renewal_date = coalesce($3::date, renewal_date), updated_at = now() ${extra} where id = $1`, [k.id, to, renewal]);
      await logEvent(db, k.contact_id, 'contract', `Contract ${k.number}: ${k.status.replace('_', ' ')} → ${to.replace('_', ' ')}${reason ? ` (${reason})` : ''}`, { contract_id: k.id, from: k.status, to });
      await audit(db, req, 'contract_status', 'contract', k.id, { from: k.status, to, reason: reason || undefined });
      if (to === 'active') {
        const { rows: [c] } = await db.query(`select pipeline_stage from contacts where id = $1`, [k.contact_id]);
        if (c.pipeline_stage !== 'won') { await db.query(`update contacts set pipeline_stage = 'won', updated_at = now() where id = $1`, [k.contact_id]); await logEvent(db, k.contact_id, 'stage_change', 'won'); }
      }
      return k;
    });
    if (to === 'active') runAutomation(pool, 'contract_active', { contract_id: k.id }).catch((e) => console.error('[automation]', e));
    res.json({ ok: true });
  });

  app.post('/api/contracts/:id/revise', requireRole('manager'), async (req, res) => {
    await tx(pool, async (db) => {
      const k = await load(db, req.params.id, true);
      if (!['ready', 'declined'].includes(k.status)) throw httpError(409, 'Only a ready or declined contract can be revised.');
      await db.query(`update contracts set status = 'draft', version = coalesce(issued_version, version) + 1, updated_at = now() where id = $1`, [k.id]);
      await logEvent(db, k.contact_id, 'contract', `Contract ${k.number}: new draft version ${(k.issued_version || k.version) + 1}`, { contract_id: k.id });
      await audit(db, req, 'contract_revised', 'contract', k.id);
    });
    res.json({ ok: true });
  });

  app.post('/api/contracts/:id/archive', requireRole('manager'), async (req, res) => {
    const on = req.body?.archived !== false;
    const { rows: [k] } = await pool.query(`update contracts set archived_at = ${on ? 'now()' : 'null'} where id = $1 and status in ('cancelled','declined','terminated','expired') returning id`, [req.params.id]);
    if (!k) throw httpError(409, 'Only cancelled, declined, ended or expired contracts can be archived.');
    await audit(pool, req, on ? 'contract_archived' : 'contract_unarchived', 'contract', k.id);
    res.json({ ok: true });
  });
}

/** Freezes the contract as version N (snapshot + PDF + signature field positions). Idempotent. */
export async function issueContract(db, k, req) {
  const { rows: [existing] } = await db.query(`select * from contract_versions where contract_id = $1 and version = $2`, [k.id, k.version]);
  if (existing) return existing;
  const snap = await contractSnapshot(db, k, k.version);
  const problems = contractProblems(snap);
  if (problems.length) throw httpError(422, 'The contract isn’t ready to issue:', { problems });
  const { buffer, fields } = await renderContract(snap);
  const doc = await saveDocument(db, { buffer, mime: 'application/pdf', filename: `${k.number}-v${k.version}.pdf`, title: `Service agreement ${k.number} v${k.version}`,
    kind: 'contract_pdf', contact_id: k.contact_id, contract_id: k.id, user_id: req.user.id });
  const { rows: [v] } = await db.query(`insert into contract_versions (contract_id, version, snapshot, document_id, issued_by) values ($1,$2,$3,$4,$5) returning *`,
    [k.id, k.version, { ...snap, signature_fields: fields }, doc.id, req.user.id]);
  await db.query(`update contracts set issued_version = $2, totals = $3, monthly_net_pence = $4, one_off_net_pence = $5, annual_net_pence = $6 where id = $1`,
    [k.id, k.version, snap.totals, snap.totals.monthly_net, snap.totals.one_off_net, snap.totals.annual_net]);
  await logEvent(db, k.contact_id, 'contract', `Contract ${k.number} v${k.version} issued`, { contract_id: k.id, version: k.version });
  await audit(db, req, 'contract_issued', 'contract', k.id, { version: k.version, document_id: doc.id });
  return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  assert.ok(canMove('review', 'ready') && !canMove('draft', 'active') && !canMove('sent', 'signed') && canMove('signed', 'active'));
  const base = { start_date: '2026-11-01', site: { address: 'x' }, customer: { address: 'x' }, signer: { name: 'A', email: 'a@b.co' }, company: { signatory_name: 'F', signatory_email: 'f@x.co' },
    lines: [{ optional: false, scope: '' }], minimum_term: '3 months', notice_period: '30 days', schedule_notes: '', payment_terms: '',
    sections: REQUIRED_CLAUSES.map((key) => ({ key, body: 'ok' })) };
  assert.deepEqual(contractProblems(base), []);
  const bad = contractProblems({ ...base, start_date: null, signer: { name: 'A', email: 'nope' }, sections: [{ key: 'overview', body: '[[insurer]]' }] });
  assert.ok(bad.some((x) => /start/.test(x)) && bad.some((x) => /valid email/.test(x)) && bad.some((x) => /governing law/.test(x)) && bad.some((x) => /\[\[insurer\]\]/.test(x)));
  console.log('contracts ok');
}
