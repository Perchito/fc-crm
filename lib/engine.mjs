import { render } from './render.mjs';
import { sendEmail } from './mailer.mjs';
import { sendSms } from './sms.mjs';

// Enrol a contact in a campaign (idempotent) and due its first step immediately.
export async function enroll(pool, campaignId, contactId) {
  const { rows } = await pool.query(
    `insert into enrollments (campaign_id, contact_id, next_due_at)
     values ($1, $2, now())
     on conflict (campaign_id, contact_id) do nothing
     returning *`,
    [campaignId, contactId]
  );
  return rows[0] || null;
}

async function advance(pool, enrollment) {
  const { rows: [next] } = await pool.query(
    `select wait_days from campaign_steps where campaign_id = $1 and active = true and step_index = $2`,
    [enrollment.campaign_id, enrollment.current_step + 1]
  );
  if (next) {
    await pool.query(
      `update enrollments set current_step = current_step + 1,
         next_due_at = now() + make_interval(days => $2), updated_at = now() where id = $1`,
      [enrollment.id, next.wait_days]
    );
  } else {
    await pool.query(`update enrollments set status = 'completed', updated_at = now() where id = $1`, [enrollment.id]);
  }
}

// One tick: send whatever step is currently due for every active enrollment,
// respecting each campaign's daily cap. Runs every few minutes from server.mjs.
// ponytail: failed sends (e.g. missing SMTP/Twilio creds) retry every tick —
// fine at one-business volume; add a backoff/pause if it gets noisy.
export async function runDueSteps(pool) {
  const { rows: due } = await pool.query(`
    select e.*, c.daily_cap, c.name as campaign_name
    from enrollments e join campaigns c on c.id = e.campaign_id
    where e.status = 'active' and c.status = 'active'
      and e.next_due_at is not null and e.next_due_at <= now()
    order by e.next_due_at asc`);

  for (const e of due) {
    const { rows: [sentToday] } = await pool.query(
      `select count(*)::int as n from sends where campaign_id = $1 and sent_at::date = current_date`,
      [e.campaign_id]
    );
    if (sentToday.n >= e.daily_cap) continue;

    const { rows: [step] } = await pool.query(
      `select * from campaign_steps where campaign_id = $1 and active = true and step_index = $2`,
      [e.campaign_id, e.current_step]
    );
    if (!step) { await pool.query(`update enrollments set status='completed', updated_at=now() where id=$1`, [e.id]); continue; }

    const { rows: [contact] } = await pool.query(`select * from contacts where id = $1`, [e.contact_id]);
    if (!contact || !contact[step.channel === 'sms' ? 'phone' : 'email']) {
      await pool.query(`update enrollments set status='stopped', stopped_reason='missing_${step.channel}', updated_at=now() where id=$1`, [e.id]);
      continue;
    }

    const subject = step.subject_tmpl ? render(step.subject_tmpl, contact) : null;
    const body = render(step.body_tmpl, contact);

    try {
      if (step.channel === 'sms') await sendSms({ to: contact.phone, body });
      else await sendEmail({ to: contact.email, subject: subject || `Update from FC Cleaning`, text: body });

      await pool.query(
        `insert into sends (enrollment_id, contact_id, campaign_id, step_index, channel, subject, body, status)
         values ($1,$2,$3,$4,$5,$6,$7,'sent')`,
        [e.id, e.contact_id, e.campaign_id, e.current_step, step.channel, subject, body]
      );
      await pool.query(
        `insert into events (contact_id, type, body, meta) values ($1,$2,$3,$4)`,
        [e.contact_id, step.channel, subject || body.slice(0, 80), JSON.stringify({ campaign: e.campaign_name })]
      );
      await advance(pool, e);
    } catch (err) {
      await pool.query(
        `insert into sends (enrollment_id, contact_id, campaign_id, step_index, channel, subject, body, status, error)
         values ($1,$2,$3,$4,$5,$6,$7,'failed',$8)`,
        [e.id, e.contact_id, e.campaign_id, e.current_step, step.channel, subject, body, String(err.message || err)]
      );
      // left due — retried next tick once the underlying issue (e.g. missing creds) is fixed
    }
  }
}
