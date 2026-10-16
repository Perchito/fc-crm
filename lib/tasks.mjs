// Tasks (personal + team, assigned, prioritised, recurring) and the appointment list.
// Upgrades the original routes in place: PATCH /api/tasks/:id {done} still works.
import { audit } from './auth.mjs';
import { httpError, logEvent, str, areaOf, inArea } from './biz.mjs';
import { runAutomation } from './automation.mjs';

const PRIORITIES = ['low', 'normal', 'high'];
const KINDS = ['task', 'follow_up', 'onboarding', 'quality', 'renewal', 'internal'];

export function taskRoutes(app, pool) {
  // ?view=mine|team|overdue|today|upcoming|done  ?contact_id ?kind ?assigned_to
  app.get('/api/tasks', async (req, res) => {
    const p = [], w = [];
    const view = String(req.query.view || 'open');
    if (view === 'done') w.push('t.done'); else w.push('not t.done');
    if (view === 'mine') { p.push(req.user.id); w.push(`t.assigned_to = $${p.length}`); }
    if (view === 'overdue') w.push(`t.due_at < (now() at time zone 'Europe/London')::date`);
    if (view === 'today') w.push(`(t.due_at at time zone 'Europe/London')::date = (now() at time zone 'Europe/London')::date`);
    if (view === 'upcoming') w.push(`t.due_at >= now()`);
    if (req.query.contact_id) { p.push(req.query.contact_id); w.push(`t.contact_id = $${p.length}`); }
    if (req.query.kind) { p.push(String(req.query.kind)); w.push(`t.kind = $${p.length}`); }
    if (req.query.assigned_to) { p.push(req.query.assigned_to); w.push(`t.assigned_to = $${p.length}`); }
    if (areaOf(req)) w.push(`(t.contact_id is null or ${inArea(areaOf(req), 't.contact_id')})`);
    const { rows } = await pool.query(
      `select t.*, c.business, u.name as assigned_name, k.number as contract_number, pr.number as proposal_number
       from tasks t left join contacts c on c.id = t.contact_id left join users u on u.id = t.assigned_to
       left join contracts k on k.id = t.contract_id left join proposals pr on pr.id = t.proposal_id
       where ${w.join(' and ')} order by ${view === 'done' ? 't.completed_at desc nulls last' : 't.due_at nulls last, t.priority = \'high\' desc, t.created_at'} limit 500`, p);
    res.json(rows);
  });

  const clean = (b, partial) => {
    const f = {};
    if ('title' in b) { f.title = str(b.title, 300); if (!f.title) throw httpError(400, 'Give the task a title.'); }
    else if (!partial) throw httpError(400, 'title required');
    if ('due_at' in b) { f.due_at = b.due_at ? new Date(b.due_at) : null; if (f.due_at && isNaN(f.due_at)) throw httpError(400, 'Bad due date'); }
    if ('priority' in b) { if (!PRIORITIES.includes(b.priority)) throw httpError(400, 'Bad priority'); f.priority = b.priority; }
    if ('kind' in b) { if (!KINDS.includes(b.kind)) throw httpError(400, 'Bad kind'); f.kind = b.kind; }
    if ('notes' in b) f.notes = str(b.notes, 4000);
    if ('assigned_to' in b) f.assigned_to = b.assigned_to || null;
    if ('contact_id' in b) f.contact_id = b.contact_id || null;
    if ('recur_days' in b) { f.recur_days = b.recur_days ? Number(b.recur_days) : null; if (f.recur_days != null && !(Number.isInteger(f.recur_days) && f.recur_days > 0 && f.recur_days <= 366)) throw httpError(400, 'Repeat every 1–366 days'); }
    return f;
  };
  const insert = async (f, req) => {
    const cols = Object.keys(f).concat('created_by'), vals = Object.values(f).concat(req.user.id);
    const { rows: [t] } = await pool.query(`insert into tasks (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, vals);
    await audit(pool, req, 'task_created', 'task', t.id, { title: t.title });
    return t;
  };

  app.post('/api/tasks', async (req, res) => {
    const f = clean(req.body || {}, false);
    f.assigned_to ??= req.user.id;
    res.status(201).json(await insert(f, req));
  });
  // original route, kept: customer-linked task
  app.post('/api/contacts/:id/tasks', async (req, res) => {
    const f = clean({ ...req.body, contact_id: req.params.id }, false);
    f.assigned_to ??= req.user.id;
    res.status(201).json(await insert(f, req));
  });
  app.get('/api/contacts/:id/tasks', async (req, res) => {
    const { rows } = await pool.query('select * from tasks where contact_id = $1 order by done, due_at nulls last', [req.params.id]);
    res.json(rows);
  });

  app.patch('/api/tasks/:id', async (req, res) => {
    const f = clean(req.body || {}, true);
    const { rows: [before] } = await pool.query(`select * from tasks where id = $1`, [req.params.id]);
    if (!before) throw httpError(404, 'Task not found');
    if ('done' in req.body) { f.done = !!req.body.done; f.completed_at = f.done ? new Date() : null; }
    const keys = Object.keys(f);
    if (!keys.length) throw httpError(400, 'no valid fields');
    const { rows: [t] } = await pool.query(`update tasks set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1 returning *`, [req.params.id, ...keys.map((k) => f[k])]);
    if (f.done && !before.done) {
      if (t.contact_id) await logEvent(pool, t.contact_id, 'task_done', t.title, { task_id: t.id });
      // recurring: the next one appears when this one is ticked off
      if (t.recur_days) {
        const base = t.due_at && new Date(t.due_at) > new Date(Date.now() - 86400_000 * t.recur_days) ? new Date(t.due_at) : new Date();
        await pool.query(`insert into tasks (contact_id, title, due_at, kind, priority, notes, assigned_to, created_by, recur_days, proposal_id, contract_id)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [t.contact_id, t.title, new Date(base.getTime() + t.recur_days * 86400_000), t.kind, t.priority, t.notes, t.assigned_to, req.user.id, t.recur_days, t.proposal_id, t.contract_id]);
      }
    }
    await audit(pool, req, 'task_updated', 'task', t.id, { fields: keys });
    res.json(t);
  });
  app.delete('/api/tasks/:id', async (req, res) => {
    const { rows: [t] } = await pool.query(`delete from tasks where id = $1 returning title`, [req.params.id]);
    if (t) await audit(pool, req, 'task_deleted', 'task', req.params.id, { title: t.title });
    res.status(204).end();
  });

  // ── appointments (original list kept; ?from ?to added) ──
  app.get('/api/appointments', async (req, res) => {
    const p = [], w = [`a.status != 'cancelled'`, inArea(areaOf(req), 'a.contact_id')];
    if (req.query.from) { p.push(new Date(req.query.from)); w.push(`a.starts_at >= $${p.length}`); }
    if (req.query.to) { p.push(new Date(req.query.to)); w.push(`a.starts_at < $${p.length}`); }
    const { rows } = await pool.query(`select a.*, c.business, c.contact_name, c.address, u.name as assigned_name from appointments a join contacts c on c.id = a.contact_id
      left join users u on u.id = a.assigned_to where ${w.join(' and ')} order by a.starts_at asc`, p);
    res.json(rows);
  });
  app.post('/api/contacts/:id/appointments', async (req, res) => {
    const { title, starts_at, ends_at, notes, kind, assigned_to } = req.body || {};
    if (!title || !starts_at || isNaN(new Date(starts_at))) throw httpError(400, 'title and starts_at required');
    const { rows: [a] } = await pool.query(
      `insert into appointments (contact_id, title, starts_at, ends_at, notes, kind, assigned_to) values ($1,$2,$3,$4,$5,$6,$7) returning *`,
      [req.params.id, str(title, 200), starts_at, ends_at || null, str(notes, 4000) || null, ['site_visit', 'quality_check', 'meeting', 'other'].includes(kind) ? kind : 'site_visit', assigned_to || req.user.id]);
    await logEvent(pool, a.contact_id, 'appointment', `${a.title} booked for ${new Date(a.starts_at).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' })}`, { appointment_id: a.id });
    if (a.kind === 'site_visit') {
      const { rowCount } = await pool.query(`update contacts set pipeline_stage = 'visit_booked', updated_at = now() where id = $1 and pipeline_stage in ('new','contacted')`, [a.contact_id]);
      if (rowCount) await logEvent(pool, a.contact_id, 'stage_change', 'visit_booked');
      runAutomation(pool, 'visit_booked', { appointment_id: a.id }).catch((e) => console.error('[automation]', e));
    }
    await audit(pool, req, 'appointment_created', 'appointment', a.id);
    res.status(201).json(a);
  });
}
