#!/usr/bin/env node
// fc-crm — AI lead discovery + drafting. Runs on this same machine, so no
// HTTP job queue is needed (unlike fc-outreach's remote worker): shell out to
// headless Claude Code directly and write straight to Postgres.
//
// Two claude -p passes: one discovery call per batch, then one researched
// drafting call per new lead (lib/aiDraft.mjs — Luis's writer brief, needs
// its own web search per business so can't be folded into the discovery
// call). Falls back to the fixed template (lib/leadTemplate.mjs) if a lead's
// drafting call fails, so one bad draft never blocks the batch — same "queue
// is never blocked" principle as fc-outreach's queue.js.
//
// Hospitality-only, independent/family-owned only (Luis: they decide on a
// cleaning contractor themselves — a chain's head office doesn't).
//
// Nightly (fc-crm-discover.timer, 01:00): one Greater Manchester borough per
// day, rotating. Keeps running batches until DISCOVER_TARGET new leads or the
// 07:00 deadline — overnight so it spends Claude usage while Luis isn't using
// it; if the usage limit is hit, it waits and retries until the deadline.
// Each day's leads go into their own campaign ("Rochdale — 30 Sep"): enrolled
// with next_due_at = null, so the engine never auto-sends; the AI draft is
// step 0 and still needs reviewing/sending by hand from the Dashboard.
// Manually added leads are AI-drafted first, into a standing "Manual leads"
// campaign. Step 1 is FOLLOW_UP: sending the draft schedules it 5 days later, and the
// engine then sends it automatically (unless the stage has moved on).
//
//   DISCOVER_AREA="Bolton" DISCOVER_TARGET=20 node worker/discover.mjs
//
// Requires: `claude` CLI installed and logged in (`claude login`) as this user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { ensureSignature, withSignature } from '../lib/signature.mjs';
import { subjectFor, bodyFor, FOLLOW_UP } from '../lib/leadTemplate.mjs';
import { draftEmailAI } from '../lib/aiDraft.mjs';
import { checkEmail } from '../lib/emailCheck.mjs';

const run = promisify(execFile);
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const BOROUGHS = ['Manchester', 'Salford', 'Trafford', 'Stockport', 'Tameside', 'Oldham', 'Rochdale', 'Bury', 'Bolton', 'Wigan'];
const day = Math.floor(Date.now() / 86_400_000);
const BOROUGH = process.env.DISCOVER_AREA || BOROUGHS[day % BOROUGHS.length];
const TARGET = Number(process.env.DISCOVER_TARGET || 20);
const BATCH = 10;
const DEADLINE_HOUR = Number(process.env.DISCOVER_DEADLINE_HOUR || 7);
const MAX_EMPTY = 3; // consecutive batches with no new leads = the area's dried up

const deadline = new Date();
deadline.setHours(DEADLINE_HOUR, 0, 0, 0);
if (deadline <= new Date()) deadline.setDate(deadline.getDate() + 1); // manual daytime run: give it until tomorrow 07:00

const promptFor = (skip) => `Find ${BATCH} independent, family-owned or owner-operated bars, restaurants and
cafés in or near ${BOROUGH}, Greater Manchester, UK.

ONLY include a venue that is genuinely independent — a single site, or at most 2-3 sites run by
the same named owner(s). EXCLUDE: national or regional chains, franchises, pub companies /
breweries that own the pub (a free house is fine), hotel groups, restaurant groups of 4+ sites,
and anything run by a larger parent company or head office. A family who owns and runs the place
themselves is exactly who we want — they decide on a cleaning contractor themselves, not a head
office. When in doubt, check the venue's own site or Companies House for how many sites / who
owns it, and leave it out if it looks corporate.
${skip.length ? `\nWe already have these — do NOT return any of them:\n${skip.join('; ')}\n` : ''}
For each kept venue, search the web and only include ones where you find a real published
contact email (a mailto: link or an address shown on a Contact/About page) — never invent one.

"type" is a few words (e.g. "Italian restaurant", "Real-ale pub", "Independent café"). "about" is
2-4 short factual sentences a cleaning company would want before calling: what the place is, who
owns/runs it if published, rough size (covers/rooms/floors), opening hours or busiest times, and
anything like events, a function room or a big kitchen. Only facts you actually found.

Return ONLY a JSON array (no prose), each item:
{"business":"","type":"","about":"","email":"","contactName":null,"phone":"","address":"","website":""}`;

function extractJson(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function findLeads(skip) {
  const { stdout } = await run('claude', ['-p', promptFor(skip), '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch'], {
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let result = stdout;
  try { result = JSON.parse(stdout).result ?? stdout; } catch { /* raw text */ }
  return extractJson(result) || [];
}

async function campaignNamed(pool, name) {
  const { rows: [existing] } = await pool.query(`select id from campaigns where name = $1`, [name]);
  if (existing) return existing.id;
  const { rows: [c] } = await pool.query(`insert into campaigns (name) values ($1) returning id`, [name]);
  await pool.query(
    `insert into campaign_steps (campaign_id, step_index, channel, wait_days, subject_tmpl, body_tmpl) values ($1,1,'email',$2,$3,$4)`,
    [c.id, FOLLOW_UP.wait_days, FOLLOW_UP.subject_tmpl, withSignature(FOLLOW_UP.body_tmpl)]
  );
  return c.id;
}

// Draft step 0 for a contact and enrol it (next_due_at null = waits for Luis to send it).
async function addDraft(pool, campaignId, contact, body) {
  const { rows: [enr] } = await pool.query(
    `insert into enrollments (campaign_id, contact_id, next_due_at) values ($1,$2,null) returning id`,
    [campaignId, contact.id]
  );
  await pool.query(
    `insert into sends (enrollment_id, contact_id, campaign_id, step_index, channel, subject, body, status)
     values ($1,$2,$3,0,'email',$4,$5,'draft')`,
    [enr.id, contact.id, campaignId, subjectFor(contact), body]
  );
  await pool.query(`insert into events (contact_id, type, body) values ($1,'draft',$2)`, [contact.id, subjectFor(contact)]);
}

// Dead domain / non-existent mailbox: suppress it so it's never researched,
// drafted or re-imported (discovery drops suppressed emails before any spend).
async function rejectIfUndeliverable(pool, email, contactId = null) {
  const chk = await checkEmail(email);
  if (chk.ok) return false;
  await pool.query(`insert into suppression (email, reason) values (lower($1), $2) on conflict do nothing`,
    [email, `undeliverable: ${chk.reason}`]);
  if (contactId) await pool.query(`insert into events (contact_id, type, body) values ($1,'note',$2)`,
    [contactId, `Email not drafted — address looks undeliverable (${chk.reason})`]);
  console.log(`skipped ${email}: ${chk.reason}`);
  return true;
}

async function profileFor(c) {
  const { stdout } = await run('claude', ['-p', `Look up this UK hospitality business on its website and the web:
${c.business}${c.website ? ` — ${c.website}` : ''}${c.address ? ` — ${c.address}` : ''}

Return ONLY JSON {"type":"","about":""}. "type" is a few words (e.g. "Italian restaurant").
"about" is 2-4 short factual sentences a cleaning company would want before calling: what the place
is, who owns/runs it if published, rough size, opening hours or busiest times, and anything like
events, a function room or a big kitchen. Only facts you actually found.`,
    '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch'], { timeout: 8 * 60_000, maxBuffer: 4 << 20 });
  let text = stdout;
  try { text = JSON.parse(stdout).result ?? stdout; } catch { /* raw text */ }
  const o = JSON.parse(String(text).match(/\{[\s\S]*\}/)[0]);
  return [o.type, o.about].filter(Boolean).join('\n\n');
}

// Leads Luis added by hand (anything not from ai-discover) that have never
// been emailed or enrolled: research + AI-draft them into the "Manual leads"
// campaign, same review-before-send flow as discovered leads.
async function draftManualLeads(pool) {
  const { rows } = await pool.query(`
    select c.* from contacts c
    where c.source is distinct from 'ai-discover' and c.email is not null and c.pipeline_stage = 'new'
      and not exists (select 1 from sends s where s.contact_id = c.id)
      and not exists (select 1 from enrollments e where e.contact_id = c.id)
      and not exists (select 1 from suppression x where lower(x.email) = lower(c.email))`);
  if (!rows.length) return;
  const campaignId = await campaignNamed(pool, 'Manual leads');
  let drafted = 0;
  for (const c of rows) {
    if (await rejectIfUndeliverable(pool, c.email, c.id)) continue;
    if (!c.notes) {
      try { await pool.query(`update contacts set notes = $2 where id = $1`, [c.id, await profileFor(c)]); }
      catch (err) { console.error(`profile failed for ${c.business}:`, err.message || err); }
    }
    let body;
    try { body = ensureSignature(await draftEmailAI(c)); }
    catch (err) {
      console.error(`draft failed for ${c.business}, using template:`, err.message || err);
      body = ensureSignature(bodyFor(c));
    }
    await addDraft(pool, campaignId, c, body);
    drafted++;
  }
  console.log(`manual leads: ${drafted}/${rows.length} drafted`);
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await draftManualLeads(pool);
  const campaignId = await campaignNamed(pool,
    `${BOROUGH} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`);
  let inserted = 0, aiDrafted = 0, empty = 0;

  while (inserted < TARGET && empty < MAX_EMPTY && new Date() < deadline) {
    // ponytail: skip-list is every business name in the area we hold; trim if it ever blows the prompt size
    const { rows: known } = await pool.query(
      `select business from contacts where business is not null and address ilike $1`, [`%${BOROUGH}%`]
    );
    let leads;
    try {
      leads = await findLeads(known.map((r) => r.business));
    } catch (err) {
      // most likely the Claude usage limit — wait for it to reset rather than giving up the night
      console.error('discover batch failed, retrying in 20 min:', (err.stderr || err.message || String(err)).slice(0, 300));
      await sleep(20 * 60_000);
      continue;
    }

    let newThisBatch = 0;
    for (const l of leads) {
      if (!l.email || inserted >= TARGET) continue;
      const { rows: [sup] } = await pool.query(`select 1 from suppression where lower(email) = lower($1)`, [l.email]);
      if (sup) continue;
      if (await rejectIfUndeliverable(pool, l.email)) continue;

      const { rows } = await pool.query(
        `insert into contacts (business, contact_name, email, phone, address, website, notes, source)
         values ($1,$2,$3,$4,$5,$6,$7,'ai-discover')
         on conflict do nothing returning id, business`,
        [l.business || null, l.contactName || null, l.email, l.phone || null, l.address || null, l.website || null,
         [l.type, l.about].filter(Boolean).join('\n\n')]
      );
      const contact = rows[0];
      if (!contact) continue;
      inserted++; newThisBatch++;

      let body;
      try {
        body = ensureSignature(await draftEmailAI(l));
        aiDrafted++;
      } catch (err) {
        console.error(`draft failed for ${contact.business}, using template:`, err.message || err);
        body = ensureSignature(bodyFor(contact));
      }

      await addDraft(pool, campaignId, contact, body);
    }
    empty = newThisBatch ? 0 : empty + 1;
    console.log(`discover ${BOROUGH}: batch +${newThisBatch} (${inserted}/${TARGET} so far)`);
  }

  console.log(`discover ${BOROUGH}: ${inserted} new leads drafted (${aiDrafted} AI-researched)` +
    (inserted < TARGET ? ` — stopped short: ${empty >= MAX_EMPTY ? 'area ran dry' : 'hit deadline'}` : ''));
  await pool.end();
}

main().catch((err) => { console.error('discover failed:', err.message || err); process.exit(1); });
