#!/usr/bin/env node
// fc-crm — AI lead discovery + drafting. Runs on this same machine, so no
// HTTP job queue is needed (unlike fc-outreach's remote worker): shell out to
// headless Claude Code directly and write straight to Postgres.
//
// Discovery and drafting happen in ONE claude -p call per batch (not one
// call per lead) — drafting needs no extra web search, just the research
// already gathered that turn, and serial per-lead calls would make an
// 8-lead batch take 15+ minutes instead of ~2.
//
//   DISCOVER_QUERY="cleaning leads for offices in Bolton, Greater Manchester" \
//   DISCOVER_COUNT=8 node worker/discover.mjs
//
// Requires: `claude` CLI installed and logged in (`claude login`) as this user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { withSignature } from '../lib/signature.mjs';

const run = promisify(execFile);
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const QUERY = process.env.DISCOVER_QUERY || 'small businesses (offices, restaurants, gyms) near Bolton, Greater Manchester who might need a commercial cleaning contractor';
const COUNT = Number(process.env.DISCOVER_COUNT || 8);

const BRAND = `FC Cleaning Company Ltd — owner-managed commercial cleaning for offices,
restaurants, pubs, bars, cafés and small hotels across Greater Manchester and the North West.
Fully insured; early-morning or post-close slots so work never clashes with the client's own
service; every job personally checked by the owner. Free written quote within 24 hours.`;

const prompt = `Find ${COUNT} UK businesses matching: ${QUERY}.
Search the web and only include ones where you find a real published contact email (a mailto:
link or an address shown on a Contact/About page) — never invent one.

For each, also draft a short cold-outreach email introducing ${BRAND}. Rules for the draft:
- Plain text only, British English, 90-140 words in the body.
- Start with "Hi {contactName's first name}," or "Hi there," if no contact name was found.
- Personal and specific to the business (reference something real you found), not salesy.
- No corporate filler ("I hope this email finds you well"), no bullet lists, no links.
- One clear ask (a quick call or a free walk-through quote).
- Do NOT include a sign-off / signature — that is appended separately.

Return ONLY a JSON array (no prose), each item:
{"business":"","email":"","contactName":null,"phone":"","address":"","website":"","hook":"one-line reason they're a good fit","subject":"3-7 words, specific, not salesy","body":"the full email starting with the greeting, no sign-off"}`;

function extractJson(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function main() {
  const { stdout } = await run('claude', ['-p', prompt, '--output-format', 'json', '--allowedTools', 'WebSearch,WebFetch'], {
    timeout: 5 * 60_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  let result = stdout;
  try { result = JSON.parse(stdout).result ?? stdout; } catch { /* raw text */ }
  const leads = extractJson(result) || [];
  if (!leads.length) { console.log('discover: no leads returned'); return; }

  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  let inserted = 0, drafted = 0;
  for (const l of leads) {
    if (!l.email) continue;
    const { rows: [sup] } = await pool.query(`select 1 from suppression where lower(email) = lower($1)`, [l.email]);
    if (sup) continue;

    const { rows } = await pool.query(
      `insert into contacts (business, contact_name, email, phone, address, website, source, notes)
       values ($1,$2,$3,$4,$5,$6,'ai-discover',$7)
       on conflict do nothing returning id`,
      [l.business || null, l.contactName || null, l.email, l.phone || null, l.address || null, l.website || null, l.hook || '']
    );
    const contact = rows[0];
    if (!contact) continue;
    inserted++;

    if (l.subject && l.body) {
      await pool.query(
        `insert into sends (contact_id, channel, subject, body, status)
         values ($1,'email',$2,$3,'draft')`,
        [contact.id, l.subject, withSignature(l.body)]
      );
      await pool.query(
        `insert into events (contact_id, type, body) values ($1,'draft',$2)`,
        [contact.id, l.subject]
      );
      drafted++;
    }
  }
  console.log(`discover: ${inserted}/${leads.length} new contacts added, ${drafted} drafted`);
  await pool.end();
}

main().catch((err) => { console.error('discover failed:', err.message || err); process.exit(1); });
