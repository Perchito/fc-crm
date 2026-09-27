#!/usr/bin/env node
// fc-crm — AI lead discovery. Runs on this same machine, so no HTTP job queue
// is needed (unlike fc-outreach's remote worker): shell out to headless
// Claude Code directly and write straight to Postgres.
//
// Discovery-only prompt (drafting is a fixed template, not AI — see
// lib/leadTemplate.mjs) so this stays fast and doesn't risk timing out.
//
//   DISCOVER_QUERY="cleaning leads for offices in Bolton, Greater Manchester" \
//   DISCOVER_COUNT=8 node worker/discover.mjs
//
// Requires: `claude` CLI installed and logged in (`claude login`) as this user.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pg from 'pg';
import { withSignature } from '../lib/signature.mjs';
import { subjectFor, bodyFor } from '../lib/leadTemplate.mjs';

const run = promisify(execFile);
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const QUERY = process.env.DISCOVER_QUERY || 'small businesses (offices, restaurants, gyms) near Bolton, Greater Manchester who might need a commercial cleaning contractor';
const COUNT = Number(process.env.DISCOVER_COUNT || 8);

const prompt = `Find ${COUNT} UK businesses matching: ${QUERY}.
For each, search the web and only include ones where you find a real published
contact email (a mailto: link or an address shown on a Contact/About page) —
never invent one. Return ONLY a JSON array (no prose), each item:
{"business":"","email":"","contactName":null,"phone":"","address":"","website":""}`;

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
      `insert into contacts (business, contact_name, email, phone, address, website, source)
       values ($1,$2,$3,$4,$5,$6,'ai-discover')
       on conflict do nothing returning id, business`,
      [l.business || null, l.contactName || null, l.email, l.phone || null, l.address || null, l.website || null]
    );
    const contact = rows[0];
    if (!contact) continue;
    inserted++;

    await pool.query(
      `insert into sends (contact_id, channel, subject, body, status) values ($1,'email',$2,$3,'draft')`,
      [contact.id, subjectFor(contact), withSignature(bodyFor(contact))]
    );
    await pool.query(`insert into events (contact_id, type, body) values ($1,'draft',$2)`, [contact.id, subjectFor(contact)]);
    drafted++;
  }
  console.log(`discover: ${inserted}/${leads.length} new contacts added, ${drafted} drafted`);
  await pool.end();
}

main().catch((err) => { console.error('discover failed:', err.message || err); process.exit(1); });
