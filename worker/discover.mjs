#!/usr/bin/env node
// fc-crm — AI lead discovery + drafting. Runs on this same machine, so no
// HTTP job queue is needed (unlike fc-outreach's remote worker): shell out to
// headless Claude Code directly and write straight to Postgres.
//
// Two claude -p passes: one discovery call for the whole batch, then one
// researched drafting call per new lead (lib/aiDraft.mjs — Luis's writer
// brief, needs its own web search per business so can't be folded into the
// discovery call). Falls back to the fixed template (lib/leadTemplate.mjs)
// if a lead's drafting call fails, so one bad draft never blocks the batch —
// same "queue is never blocked" principle as fc-outreach's queue.js.
//
// Independent/owner-run only (Luis: they decide on a cleaning contractor
// themselves — a chain's head office doesn't). Hospitality + small offices.
// Covers all of Greater Manchester by rotating one borough per day, so a
// fixed area doesn't keep returning venues we already have.
//
//   DISCOVER_AREA="Bolton, Greater Manchester" DISCOVER_COUNT=8 node worker/discover.mjs
//
// Requires: `claude` CLI installed and logged in (`claude login`) as this user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { ensureSignature } from '../lib/signature.mjs';
import { subjectFor, bodyFor } from '../lib/leadTemplate.mjs';
import { draftEmailAI } from '../lib/aiDraft.mjs';

const run = promisify(execFile);
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const BOROUGHS = ['Manchester', 'Salford', 'Trafford', 'Stockport', 'Tameside', 'Oldham', 'Rochdale', 'Bury', 'Bolton', 'Wigan'];
const day = Math.floor(Date.now() / 86_400_000);
const AREA = process.env.DISCOVER_AREA || `${BOROUGHS[day % BOROUGHS.length]}, Greater Manchester`;
const COUNT = Number(process.env.DISCOVER_COUNT || 8);

const prompt = `Find ${COUNT} independent, owner-run businesses in or near ${AREA}, UK — roughly half
hospitality (bars, restaurants, cafés) and half offices (e.g. accountants, solicitors, estate and
letting agents, recruitment agencies, architects, marketing/IT firms, other small companies with
their own office premises).

ONLY include a business that is genuinely independent — a single site, or at most 2-3 sites run by
the same named owner(s)/partners. EXCLUDE: national or regional chains, franchises, pub companies /
breweries that own the pub (a free house is fine), hotel groups, restaurant groups of 4+ sites,
branches of national firms, serviced/co-working offices, and anything run by a larger parent
company or head office. An owner or family who runs the place themselves is exactly who we want —
they decide on a cleaning contractor themselves, not a head office. When in doubt, check the
business's own site or Companies House for how many sites / who owns it, and leave it out if it
looks corporate.

For each kept business, search the web and only include ones where you find a real published
contact email (a mailto: link or an address shown on a Contact/About page) — never invent one.

Return ONLY a JSON array (no prose), each item:
{"business":"","email":"","contactName":null,"phone":"","address":"","website":""}`;

function extractJson(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function main() {
  const { stdout } = await run('claude', ['-p', prompt, '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch'], {
    timeout: 10 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let result = stdout;
  try { result = JSON.parse(stdout).result ?? stdout; } catch { /* raw text */ }
  const leads = extractJson(result) || [];
  if (!leads.length) { console.log('discover: no leads returned'); return; }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  let inserted = 0, drafted = 0, aiDrafted = 0;
  for (const l of leads) {
    if (!l.email) continue;
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
    inserted++;

    let body;
    try {
      body = ensureSignature(await draftEmailAI(l));
      aiDrafted++;
    } catch (err) {
      console.error(`draft failed for ${contact.business}, using template:`, err.message || err);
      body = ensureSignature(bodyFor(contact));
    }

    await pool.query(
      `insert into sends (contact_id, channel, subject, body, status) values ($1,'email',$2,$3,'draft')`,
      [contact.id, subjectFor(contact), body]
    );
    await pool.query(`insert into events (contact_id, type, body) values ($1,'draft',$2)`, [contact.id, subjectFor(contact)]);
    drafted++;
  }
  console.log(`discover: ${inserted}/${leads.length} new contacts added, ${drafted} drafted (${aiDrafted} AI-researched)`);
  await pool.end();
}

main().catch((err) => { console.error('discover failed:', err.message || err); process.exit(1); });
