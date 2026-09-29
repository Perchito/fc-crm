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
//
//   DISCOVER_AREA="Bolton" DISCOVER_TARGET=20 node worker/discover.mjs
//
// Requires: `claude` CLI installed and logged in (`claude login`) as this user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { ensureSignature } from '../lib/signature.mjs';
import { subjectFor, bodyFor } from '../lib/leadTemplate.mjs';
import { draftEmailAI } from '../lib/aiDraft.mjs';

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

Return ONLY a JSON array (no prose), each item:
{"business":"","email":"","contactName":null,"phone":"","address":"","website":""}`;

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

async function campaignFor(pool) {
  const name = `${BOROUGH} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
  const { rows: [existing] } = await pool.query(`select id from campaigns where name = $1`, [name]);
  if (existing) return existing.id;
  const { rows: [c] } = await pool.query(`insert into campaigns (name) values ($1) returning id`, [name]);
  return c.id;
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  const campaignId = await campaignFor(pool);
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

      const { rows } = await pool.query(
        `insert into contacts (business, contact_name, email, phone, address, website, source)
         values ($1,$2,$3,$4,$5,$6,'ai-discover')
         on conflict do nothing returning id, business`,
        [l.business || null, l.contactName || null, l.email, l.phone || null, l.address || null, l.website || null]
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
    empty = newThisBatch ? 0 : empty + 1;
    console.log(`discover ${BOROUGH}: batch +${newThisBatch} (${inserted}/${TARGET} so far)`);
  }

  console.log(`discover ${BOROUGH}: ${inserted} new leads drafted (${aiDrafted} AI-researched)` +
    (inserted < TARGET ? ` — stopped short: ${empty >= MAX_EMPTY ? 'area ran dry' : 'hit deadline'}` : ''));
  await pool.end();
}

main().catch((err) => { console.error('discover failed:', err.message || err); process.exit(1); });
