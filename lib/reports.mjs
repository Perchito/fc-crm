// Dashboard + reports, straight from Postgres. Every number has a written definition;
// proposal values are never called revenue, and contracted revenue is never called cash.
import { requireRole, audit } from './auth.mjs';
import { toCsv } from './customers.mjs';
import { todayIso, addDaysIso } from './biz.mjs';

export const DEFINITIONS = {
  leads_created: 'Customers added in the period (any source).',
  lead_to_visit: 'Of the customers added in the period, the share that have had a site visit booked (any time since).',
  visit_to_proposal: 'Of the customers whose first site visit fell in the period, the share that were later sent a proposal.',
  proposal_acceptance: 'Of the proposals sent in the period that have been decided, the share accepted (accepted ÷ accepted + rejected + expired).',
  won: 'Customers moved to “Won” in the period.',
  lost: 'Customers moved to “Lost” in the period.',
  open_pipeline_monthly: 'Monthly value (ex VAT) of proposals sent and awaiting a reply — a quote, NOT revenue.',
  open_pipeline_one_off: 'One-off value (ex VAT) of proposals awaiting a reply — a quote, NOT revenue.',
  contracted_monthly: 'Recurring monthly value (ex VAT) of contracts that are signed, active or due for renewal. Contracted, not cash collected.',
  contracted_annual: 'Annual recurring value (ex VAT) of the same contracts.',
  contracted_one_off_period: 'One-off work (ex VAT) in contracts signed in the period.',
  cash_collected: 'Not tracked here — invoices and payments live in Invoice Builder.',
};

export function reportRoutes(app, pool) {
  async function build(from, to) {
    const one = (sql, p = [from, to]) => pool.query(sql, p).then((r) => r.rows[0]);
    const all = (sql, p = []) => pool.query(sql, p).then((r) => r.rows);
    const pct = (n, d) => (Number(d) ? Math.round((Number(n) / Number(d)) * 1000) / 10 : null);
    const [leads, l2v, v2p, acc, wl, pipe, contracted, oneOff, stages, tasks, sources] = await Promise.all([
      one(`select count(*)::int n from contacts where created_at >= $1 and created_at < $2`),
      one(`select count(*)::int n, count(*) filter (where exists (select 1 from appointments a where a.contact_id = c.id and a.kind = 'site_visit'))::int v
           from contacts c where c.created_at >= $1 and c.created_at < $2`),
      one(`with fv as (select contact_id, min(starts_at) f from appointments where kind = 'site_visit' and status <> 'cancelled' group by contact_id)
           select count(*)::int n, count(*) filter (where exists (select 1 from proposals p where p.contact_id = fv.contact_id and p.sent_at is not null))::int p
           from fv where f >= $1 and f < $2`),
      one(`select count(*) filter (where status = 'accepted')::int a, count(*) filter (where status in ('accepted','rejected','expired'))::int d, count(*)::int s
           from proposals where sent_at >= $1 and sent_at < $2`),
      one(`select count(*) filter (where body = 'won')::int won, count(*) filter (where body = 'lost')::int lost from events where type = 'stage_change' and at >= $1 and at < $2`),
      one(`select count(*)::int n, coalesce(sum(monthly_net_pence),0)::bigint m, coalesce(sum(one_off_net_pence),0)::bigint o from proposals where status = 'sent' and archived_at is null`, []),
      one(`select count(*)::int n, coalesce(sum(monthly_net_pence),0)::bigint m, coalesce(sum(annual_net_pence),0)::bigint a from contracts where status in ('signed','active','renewal_due')`, []),
      one(`select coalesce(sum(one_off_net_pence),0)::bigint o from contracts where signed_at >= $1 and signed_at < $2`),
      all(`select pipeline_stage, count(*)::int n from contacts where archived_at is null group by 1`),
      one(`select count(*) filter (where not done and due_at < now())::int overdue, count(*) filter (where not done)::int open,
                  count(*) filter (where not done and kind = 'onboarding')::int onboarding, count(*) filter (where not done and kind = 'quality')::int quality from tasks`, []),
      all(`select coalesce(nullif(source,''),'unknown') source, count(*)::int n from contacts where created_at >= $1 and created_at < $2 group by 1 order by 2 desc limit 10`, [from, to]),
    ]);
    const [upcoming, awaiting, signing, renewals, overdue] = await Promise.all([
      all(`select a.id, a.title, a.starts_at, a.kind, c.id contact_id, c.business from appointments a join contacts c on c.id = a.contact_id
           where a.status = 'scheduled' and a.starts_at >= now() and a.starts_at < now() + interval '14 days' order by a.starts_at limit 20`),
      all(`select p.id, p.number, p.valid_until, p.sent_at, p.monthly_net_pence, p.one_off_net_pence, c.business from proposals p join contacts c on c.id = p.contact_id
           where p.status = 'sent' and p.archived_at is null order by p.valid_until nulls last limit 20`),
      all(`select k.id, k.number, k.status, k.updated_at, c.business from contracts k join contacts c on c.id = k.contact_id
           where k.status in ('ready','sent','partially_signed','signed') order by k.updated_at limit 20`),
      all(`select k.id, k.number, k.status, k.renewal_date, k.monthly_net_pence, c.business from contracts k join contacts c on c.id = k.contact_id
           where k.status in ('active','renewal_due') and k.renewal_date is not null and k.renewal_date <= $1::date order by k.renewal_date limit 20`, [addDaysIso(todayIso(), 90)]),
      all(`select t.id, t.title, t.due_at, t.priority, c.business, t.contact_id from tasks t left join contacts c on c.id = t.contact_id
           where not t.done and t.due_at < now() order by t.due_at limit 20`),
    ]);
    return {
      from, to, definitions: DEFINITIONS,
      metrics: {
        leads_created: leads.n,
        lead_to_visit: { pct: pct(l2v.v, l2v.n), num: l2v.v, den: l2v.n },
        visit_to_proposal: { pct: pct(v2p.p, v2p.n), num: v2p.p, den: v2p.n },
        proposal_acceptance: { pct: pct(acc.a, acc.d), num: acc.a, den: acc.d, sent: acc.s },
        won: wl.won, lost: wl.lost,
        open_pipeline: { count: pipe.n, monthly_pence: Number(pipe.m), one_off_pence: Number(pipe.o) },
        contracted: { count: contracted.n, monthly_pence: Number(contracted.m), annual_pence: Number(contracted.a), one_off_period_pence: Number(oneOff.o) },
        stages: Object.fromEntries(stages.map((s) => [s.pipeline_stage, s.n])),
        tasks, sources,
      },
      lists: { upcoming, awaiting, signing, renewals, overdue },
    };
  }
  const range = (q) => {
    const to = q.to ? new Date(`${q.to}T23:59:59.999Z`) : new Date();
    const from = q.from ? new Date(`${q.from}T00:00:00Z`) : new Date(Date.now() - 30 * 86400_000);
    return [isNaN(from) ? new Date(Date.now() - 30 * 86400_000) : from, isNaN(to) ? new Date() : to];
  };
  app.get('/api/reports', async (req, res) => res.json(await build(...range(req.query))));
  app.get('/api/reports.csv', requireRole('manager'), async (req, res) => {
    const r = await build(...range(req.query)), m = r.metrics, gbp = (p) => (p / 100).toFixed(2);
    const rows = [
      ['leads_created', m.leads_created], ['lead_to_visit_pct', m.lead_to_visit.pct], ['visit_to_proposal_pct', m.visit_to_proposal.pct],
      ['proposal_acceptance_pct', m.proposal_acceptance.pct], ['won', m.won], ['lost', m.lost],
      ['open_pipeline_monthly_gbp', gbp(m.open_pipeline.monthly_pence)], ['open_pipeline_one_off_gbp', gbp(m.open_pipeline.one_off_pence)],
      ['contracted_monthly_gbp', gbp(m.contracted.monthly_pence)], ['contracted_annual_gbp', gbp(m.contracted.annual_pence)], ['contracted_one_off_period_gbp', gbp(m.contracted.one_off_period_pence)],
    ].map(([metric, value]) => ({ metric, value, definition: DEFINITIONS[metric.replace(/_(pct|gbp)$/, '')] || '' }));
    await audit(pool, req, 'report_exported', 'report', null, { from: r.from, to: r.to });
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="fc-report-${r.from.toISOString().slice(0, 10)}-to-${r.to.toISOString().slice(0, 10)}.csv"` })
      .send(`﻿${toCsv(['metric', 'value', 'definition'], rows)}`);
  });
}
