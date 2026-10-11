// Lifecycle automations. They only create INTERNAL tasks and move statuses — nothing here
// ever emails a customer. Each rule can be switched off / re-timed in Settings → Automations,
// and every task carries an auto_key so a rule firing twice never makes a second task.
import { requireRole, audit } from './auth.mjs';
import { addDaysIso, todayIso, logEvent, httpError } from './biz.mjs';

export const RULES = {
  new_lead_task: { label: 'New lead → follow-up task', unit: 'days' },
  visit_reminder_task: { label: 'Site visit booked → preparation task (days before)', unit: 'days' },
  proposal_follow_up: { label: 'Proposal sent → follow-up task', unit: 'days' },
  accepted_contract: { label: 'Proposal accepted → “create contract” task', unit: 'days' },
  signing_follow_up: { label: 'Contract sent for signature → chase task', unit: 'days' },
  activate_on_signature: { label: 'Fully signed → activate automatically (only if nothing is missing)' },
  onboarding: { label: 'Contract active → onboarding checklist' },
  quality_follow_ups: { label: 'Contract active → weekly quality follow-ups', unit: 'weeks' },
  renewal_task: { label: 'Renewal approaching → renewal task (days before)', unit: 'days' },
  expired_proposal_flag: { label: 'Proposal past its valid-until date → mark expired + review task' },
};

export async function getAutomation(db) {
  const { rows: [r] } = await db.query(`select v from meta where k = 'automation'`);
  return r?.v || {};
}
const on = (s, k) => s[k]?.enabled !== false && !!s[k];

/** Inserts a task unless one with the same auto_key exists. Returns true if created. */
export async function autoTask(db, { key, title, contact_id = null, due, kind = 'follow_up', priority = 'normal', proposal_id = null, contract_id = null, assigned_to = null, notes = '' }) {
  const { rowCount } = await db.query(
    `insert into tasks (contact_id, title, due_at, kind, priority, proposal_id, contract_id, assigned_to, notes, auto_key)
     values ($1,$2,$3::date + time '09:00',$4,$5,$6,$7,$8,$9,$10) on conflict (auto_key) where auto_key is not null do nothing`,
    [contact_id, title, due, kind, priority, proposal_id, contract_id, assigned_to, notes, key]);
  return rowCount === 1;
}

export const ONBOARDING = [
  'Verify the signed contract and file it (start date, price, schedule)',
  'Confirm service details and checklist with the site contact',
  'Arrange site access: keys / codes / alarm, induction, parking',
  'Confirm the agreed cleaning schedule and assign the team',
  'Check chemicals, equipment and COSHH sheets for the site',
  'Set up invoicing (payment terms, billing contact, first invoice)',
];

export async function runAutomation(pool, event, ctx) {
  const s = await getAutomation(pool);
  const today = todayIso();
  if (event === 'lead_created' && on(s, 'new_lead_task')) {
    const { rows: [c] } = await pool.query(`select id, business, owner_id from contacts where id = $1`, [ctx.contact_id]);
    if (c) await autoTask(pool, { key: `lead:${c.id}`, title: `Follow up new lead: ${c.business || 'lead'}`, contact_id: c.id, due: addDaysIso(today, s.new_lead_task.days ?? 1), assigned_to: c.owner_id });
  }
  if (event === 'visit_booked' && on(s, 'visit_reminder_task')) {
    const { rows: [a] } = await pool.query(`select a.*, c.business, c.owner_id from appointments a join contacts c on c.id = a.contact_id where a.id = $1`, [ctx.appointment_id]);
    if (a) {
      const visitDay = new Date(a.starts_at).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
      const due = addDaysIso(visitDay, -(s.visit_reminder_task.days ?? 1));
      await autoTask(pool, { key: `visit:${a.id}`, title: `Prepare for site visit: ${a.business || ''} (${new Date(a.starts_at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })})`,
        contact_id: a.contact_id, due: due < today ? today : due, assigned_to: a.assigned_to || a.owner_id });
    }
  }
  if (event === 'proposal_sent' && on(s, 'proposal_follow_up')) {
    const { rows: [p] } = await pool.query(`select p.*, c.owner_id from proposals p join contacts c on c.id = p.contact_id where p.id = $1`, [ctx.proposal_id]);
    if (p) await autoTask(pool, { key: `proposal_fu:${p.id}:v${p.issued_version}`, title: `Follow up proposal ${p.number}`, contact_id: p.contact_id, proposal_id: p.id,
      due: addDaysIso(today, s.proposal_follow_up.days ?? 3), assigned_to: p.owner_id || p.created_by });
  }
  if (event === 'proposal_accepted' && on(s, 'accepted_contract')) {
    const { rows: [p] } = await pool.query(`select * from proposals where id = $1`, [ctx.proposal_id]);
    if (p) await autoTask(pool, { key: `proposal_contract:${p.id}`, title: `Create the service agreement for accepted proposal ${p.number}`, contact_id: p.contact_id, proposal_id: p.id,
      due: addDaysIso(today, s.accepted_contract.days ?? 0), priority: 'high', assigned_to: p.created_by });
  }
  if (event === 'contract_sent' && on(s, 'signing_follow_up')) {
    const { rows: [k] } = await pool.query(`select * from contracts where id = $1`, [ctx.contract_id]);
    if (k) await autoTask(pool, { key: `sign_fu:${k.id}:v${k.issued_version}`, title: `Check contract ${k.number} has been signed`, contact_id: k.contact_id, contract_id: k.id,
      due: addDaysIso(today, s.signing_follow_up.days ?? 3), assigned_to: k.created_by });
  }
  if (event === 'contract_signed') {
    const { rows: [k] } = await pool.query(`select * from contracts where id = $1`, [ctx.contract_id]);
    if (!k || k.status !== 'signed') return;
    if (on(s, 'activate_on_signature') && k.start_date) {
      const { contractSnapshot, contractProblems } = await import('./contracts.mjs');
      if (!contractProblems(await contractSnapshot(pool, k, k.version)).length) {
        await pool.query(`update contracts set status = 'active', activated_at = now(), updated_at = now() where id = $1 and status = 'signed'`, [k.id]);
        await logEvent(pool, k.contact_id, 'contract', `Contract ${k.number} activated automatically after signing`, { contract_id: k.id, to: 'active' });
        await pool.query(`update contacts set pipeline_stage = 'won', updated_at = now() where id = $1 and pipeline_stage <> 'won'`, [k.contact_id]);
        return runAutomation(pool, 'contract_active', { contract_id: k.id });
      }
    }
    await autoTask(pool, { key: `activate:${k.id}`, title: `Contract ${k.number} is signed — check it and activate`, contact_id: k.contact_id, contract_id: k.id, due: today, priority: 'high', assigned_to: k.created_by });
  }
  if (event === 'contract_active') {
    const { rows: [k] } = await pool.query(`select * from contracts where id = $1`, [ctx.contract_id]);
    if (!k) return;
    const start = k.start_date ? String(k.start_date).slice(0, 10) : today;
    if (on(s, 'onboarding')) {
      for (const [i, t] of ONBOARDING.entries()) {
        await autoTask(pool, { key: `onb:${k.id}:${i}`, title: `Onboarding ${k.number}: ${t}`, contact_id: k.contact_id, contract_id: k.id, kind: 'onboarding', due: addDaysIso(start, -1) < today ? today : addDaysIso(start, -1), assigned_to: k.created_by });
      }
    }
    if (on(s, 'quality_follow_ups')) {
      const weeks = Math.min(12, s.quality_follow_ups.weeks ?? 5);
      for (let w = 1; w <= weeks; w++) {
        await autoTask(pool, { key: `qa:${k.id}:w${w}`, title: `Quality follow-up week ${w} of ${weeks}: ${k.number}`, contact_id: k.contact_id, contract_id: k.id, kind: 'quality',
          due: addDaysIso(start, 7 * w), notes: 'Checklist review, area inspection, talk to the site contact and the team, agree corrective actions.', assigned_to: k.created_by });
      }
    }
  }
}

/** Hourly: expire proposals, flag renewals, expire ended contracts. */
export async function scanSchedules(pool) {
  const s = await getAutomation(pool);
  const today = todayIso();
  if (on(s, 'expired_proposal_flag')) {
    const { rows } = await pool.query(`update proposals set status = 'expired', expired_at = now(), updated_at = now()
      where status = 'sent' and valid_until < $1::date returning id, number, contact_id, issued_version, created_by`, [today]);
    for (const p of rows) {
      await logEvent(pool, p.contact_id, 'proposal', `Proposal ${p.number} expired (past its valid-until date)`, { proposal_id: p.id });
      await autoTask(pool, { key: `expired:${p.id}:v${p.issued_version}`, title: `Proposal ${p.number} has expired — revise, extend or close`, contact_id: p.contact_id, proposal_id: p.id, due: today, assigned_to: p.created_by });
    }
  }
  if (on(s, 'renewal_task')) {
    const days = s.renewal_task.days ?? 60;
    const { rows } = await pool.query(`update contracts set status = 'renewal_due', updated_at = now()
      where status = 'active' and renewal_date is not null and renewal_date <= $1::date + $2::int returning id, number, contact_id, renewal_date, created_by`, [today, days]);
    for (const k of rows) {
      const rd = String(k.renewal_date).slice(0, 10);
      await logEvent(pool, k.contact_id, 'contract', `Contract ${k.number}: renewal due ${rd}`, { contract_id: k.id, to: 'renewal_due' });
      await autoTask(pool, { key: `renewal:${k.id}:${rd}`, title: `Renewal / price review due for ${k.number} on ${rd}`, contact_id: k.contact_id, contract_id: k.id, kind: 'renewal', priority: 'high', due: today, assigned_to: k.created_by });
    }
  }
  const { rows: ended } = await pool.query(`update contracts set status = 'expired', ended_at = now(), updated_at = now()
    where status in ('active','renewal_due') and end_date is not null and end_date < $1::date returning id, number, contact_id`, [today]);
  for (const k of ended) await logEvent(pool, k.contact_id, 'contract', `Contract ${k.number} expired (end date passed)`, { contract_id: k.id, to: 'expired' });
}

export function automationRoutes(app, pool) {
  app.get('/api/automation', async (req, res) => res.json({ rules: RULES, settings: await getAutomation(pool) }));
  app.put('/api/automation', requireRole('admin'), async (req, res) => {
    const cur = await getAutomation(pool), next = {};
    for (const k of Object.keys(RULES)) {
      const v = req.body?.[k] ?? cur[k] ?? {};
      const n = { enabled: v.enabled !== false };
      for (const u of ['days', 'weeks']) if (v[u] != null && v[u] !== '') {
        const x = Number(v[u]);
        if (!Number.isInteger(x) || x < 0 || x > 365) throw httpError(400, `${RULES[k].label}: ${u} must be 0–365`);
        n[u] = x;
      }
      next[k] = n;
    }
    await pool.query(`insert into meta (k, v) values ('automation', $1) on conflict (k) do update set v = excluded.v`, [next]);
    await audit(pool, req, 'automation_updated', 'settings', 'automation', next);
    res.json(next);
  });
}
