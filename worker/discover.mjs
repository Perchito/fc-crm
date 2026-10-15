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
// Hospitality and offices, chains included (Luis, 2026-10-15; was independent hospitality only).
// Candidates come from OpenStreetMap first (free), then AI search listings; code reads each website
// for the email, so tokens go almost entirely on the drafts.
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

import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { ensureSignature, withSignature } from '../lib/signature.mjs';
import { subjectFor, bodyFor, FOLLOW_UP } from '../lib/leadTemplate.mjs';
import { draftEmailAI, claude } from '../lib/aiDraft.mjs';
import { checkEmail } from '../lib/emailCheck.mjs';
import { findSiteEmail } from '../lib/siteEmail.mjs';
import { BOOK_URL } from '../lib/booking.mjs';

const { DATABASE_URL } = process.env;
if (!DATABASE_URL) throw new Error('DATABASE_URL is required');

const BOROUGHS = ['Manchester', 'Salford', 'Trafford', 'Stockport', 'Tameside', 'Oldham', 'Rochdale', 'Bury', 'Bolton', 'Wigan'];
const day = Math.floor(Date.now() / 86_400_000);
const BOROUGH = process.env.DISCOVER_AREA || BOROUGHS[day % BOROUGHS.length];
const TARGET = Number(process.env.DISCOVER_TARGET || 20);
// Sonnet, search-only listing calls with a low turn cap: a 10-venue Opus batch that fetched pages itself ran
// 150-250 turns (10-25M cached tokens) and emptied the 5-hour usage window (2026-10-09); a 5-venue Sonnet one
// still cost ~$1 for 0-3 leads (2026-10-15).
const BATCH = 15;
const DISCOVER_MODEL = process.env.DISCOVER_MODEL || 'sonnet';
const DEADLINE_HOUR = Number(process.env.DISCOVER_DEADLINE_HOUR || 7);
const MAX_EMPTY = 3; // consecutive batches with no new leads = the area's dried up

const deadline = new Date();
deadline.setHours(DEADLINE_HOUR, 0, 0, 0);
if (deadline <= new Date()) deadline.setDate(deadline.getDate() + 1); // manual daytime run: give it until tomorrow 07:00

// Alternates per batch. Luis (2026-10-15): chains are fine now, and offices are in alongside hospitality.
const SECTORS = [
  { key: 'hospitality', what: 'bars, pubs, restaurants and cafés', eg: '"Italian restaurant", "Real-ale pub", "Café"' },
  { key: 'office', what: 'businesses that work from their own office premises — e.g. accountants, solicitors, estate and letting agents, recruitment agencies, marketing and design agencies, architects, IT and tech firms, insurance brokers, coworking spaces',
    eg: '"Accountants", "Solicitors", "Recruitment agency"' },
];

// The AI only lists candidates from search results (no page fetching; each search is a Haiku call, ~$0.04). Code then reads each
// website for the email (lib/siteEmail.mjs) — that page-by-page hunt is what cost ~$1 a batch when Claude did it.
const promptFor = (sector, skip) => `Using web search only, list up to ${BATCH} ${sector.what} in or near
${BOROUGH}${BOROUGHS.includes(BOROUGH) ? ', Greater Manchester' : ''}, UK. Prefer ones with their own website.
${skip.length ? `\nWe already have these — do NOT return any of them:\n${skip.join('; ')}\n` : ''}
Do not open or fetch any pages: work only from search results. Use at most 6 searches, then reply
straight away with the JSON.
"website" is the business's own site (not Facebook, TripAdvisor, Google or a directory); leave it "" if
you didn't see one. "email" only if you saw the address written in a search result, else "" — never guess
one. "type" is a few words (e.g. ${sector.eg}). "about" is 1-2 short factual sentences from the search
results (what it is, size or anything notable). Only facts you saw.

Return ONLY a JSON array (no prose), each item:
{"business":"","type":"","about":"","email":"","phone":"","address":"","website":""}`;

function extractJson(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// web pages give us "Wine &amp; Dine"
const unescape = (v) => typeof v !== 'string' ? v : v.replace(/&(amp|quot|#39|apos|lt|gt|#(\d+));/g, (_, e, n) =>
  n ? String.fromCharCode(+n) : { amp: '&', quot: '"', '#39': "'", apos: "'", lt: '<', gt: '>' }[e]);

async function findLeads(sector, skip) {
  let stdout;
  try {
    ({ stdout } = await claude(['-p', promptFor(sector, skip), '--model', DISCOVER_MODEL, '--max-turns', '20'], {
      tools: 'WebSearch',
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      label: `discover ${sector.key} ${BOROUGH}`,
    }));
  } catch (err) {
    // the CLI sometimes exits non-zero after a finished answer: keep the answer rather than retrying a $1 batch
    if (!/"subtype":"success"/.test(err.stdout || '')) throw err;
    stdout = err.stdout;
  }
  let result = stdout;
  try { result = JSON.parse(stdout).result ?? stdout; } catch { /* raw text */ }
  const leads = extractJson(result);
  if (!leads) console.log(`discover batch returned no JSON: ${String(result).slice(0, 200)}`);
  return (leads || []).map((l) => ({ ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, unescape(v)])), sector: sector.key }));
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
  // personal booking link, added in code just above the sign-off (not left to the LLM)
  const link = `If it's easier, you can pick a time for a quick visit here: ${BOOK_URL}?c=${contact.booking_token}`;
  const at = body.search(/\n\s*Best,\s*\n/);
  body = at === -1 ? `${body}\n\n${link}` : `${body.slice(0, at).trimEnd()}\n\n${link}${body.slice(at)}`;
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

// The writer decided not to email it (closed, moved...): lost + suppressed so it's never found or drafted again.
async function skipLead(pool, contact, email, reason) {
  await pool.query(`update contacts set pipeline_stage = 'lost' where id = $1`, [contact.id]);
  await pool.query(`insert into suppression (email, reason) values (lower($1), $2) on conflict do nothing`, [email, `not emailed: ${reason}`.slice(0, 500)]);
  await pool.query(`insert into events (contact_id, type, body) values ($1,'note',$2)`, [contact.id, `Not emailed — ${reason}`]);
  console.log(`not drafted ${contact.business}: ${reason}`);
}

async function profileFor(c) {
  const { stdout } = await claude(['-p', `Look up this UK business on its website and the web:
${c.business}${c.website ? ` — ${c.website}` : ''}${c.address ? ` — ${c.address}` : ''}

Return ONLY JSON {"type":"","about":""}. "type" is a few words (e.g. "Italian restaurant").
"about" is 2-4 short factual sentences a cleaning company would want before calling: what the place
is, who owns/runs it if published, rough size, opening hours or busiest times, and anything like
events, a function room or a big kitchen. Only facts you actually found.`,
    '--model', DISCOVER_MODEL, '--max-turns', '10'], { timeout: 8 * 60_000, maxBuffer: 4 << 20, label: `profile ${c.business}` });
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
      if (err.skip) { await skipLead(pool, c, c.email, err.skip); continue; }
      console.error(`draft failed for ${c.business}, using template:`, err.message || err);
      body = ensureSignature(bodyFor(c));
    }
    await addDraft(pool, campaignId, c, body);
    drafted++;
  }
  console.log(`manual leads: ${drafted}/${rows.length} drafted`);
}

// OpenStreetMap lists the area's venues and offices for free (no tokens), many with a website or email already
// tagged: that's the first source; the AI listing (findLeads) only runs once it's used up.
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'];
const OSM_OFFICES = 'accountant|lawyer|estate_agent|employment_agency|insurance|architect|it|company|financial|advertising_agency|coworking|consulting|property_management|tax_advisor';
const nice = (v) => String(v || '').replace(/_/g, ' ').replace(/;/g, ', ');

async function osmCandidates() {
  const area = BOROUGH.replace(/"/g, '');
  const q = `[out:json][timeout:90];area["name"="${area}"]["boundary"="administrative"]->.a;(nwr(area.a)["amenity"~"^(restaurant|cafe|bar|pub)$"]["name"];nwr(area.a)["office"~"^(${OSM_OFFICES})$"]["name"];);out tags center;`;
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: q }), signal: AbortSignal.timeout(120_000),
        headers: { 'User-Agent': 'fc-crm/1.0 (lead research; fernando.c@fccleaningcompany.com)' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { elements } = await r.json();
      const uk = (e) => { const c = e.center || e; return c.lat > 49.8 && c.lat < 60.9 && c.lon > -8.7 && c.lon < 1.8; }; // same-named places abroad
      return elements.filter(uk).map(({ tags: t }) => {
        const office = !t.amenity;
        const address = [[t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' '), t['addr:city'] || t['addr:town'] || t['addr:suburb'], t['addr:postcode']].filter(Boolean).join(', ');
        return { business: t.name, sector: office ? 'office' : 'hospitality',
          type: office ? nice(t.office === 'company' ? 'office' : t.office) : [nice(t.cuisine), nice(t.amenity)].filter(Boolean).join(' '),
          about: [t.brand && `Part of ${t.brand}.`, t.opening_hours && `Opening hours: ${t.opening_hours}.`].filter(Boolean).join(' '),
          email: t.email || t['contact:email'] || '', phone: t.phone || t['contact:phone'] || '',
          address: address.toLowerCase().includes(area.toLowerCase()) ? address : [address, area].filter(Boolean).join(', '),
          website: t.website || t['contact:website'] || '' };
      }).filter((l) => l.email || l.website);
    } catch (err) { console.error(`overpass ${url} failed: ${err.message}`); }
  }
  return [];
}

async function main() {
  const pool = new pg.Pool({ connectionString: DATABASE_URL });
  await draftManualLeads(pool);
  const campaignId = await campaignNamed(pool,
    `${BOROUGH} — ${new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`);
  let inserted = 0, aiDrafted = 0, empty = 0, batchNo = 0;

  // ponytail: skip-list is every business name in the area we hold; trim if it ever blows the prompt size
  // address alone misses towns inside a borough (Tameside's leads say Hyde, Ashton...), so also everyone already
  // in one of this area's campaigns — otherwise the AI re-finds them and the batch is wasted on duplicates
  const knownNames = async () => (await pool.query(
    `select distinct business from contacts c where business is not null and (address ilike $1
       or exists (select 1 from enrollments e join campaigns k on k.id = e.campaign_id where e.contact_id = c.id and k.name like $2))`,
    [`%${BOROUGH}%`, `${BOROUGH} — %`])).rows.map((r) => r.business);
  // websites we already hold anywhere: dropped before any fetching or drafting
  const knownHosts = new Set((await pool.query(`select distinct lower(regexp_replace(website, '^(https?://)?(www\\.)?([^/]+).*$', '\\3')) h from contacts where website is not null`)).rows.map((r) => r.h));
  const hostOf = (w) => String(w || '').toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];

  // one candidate → a drafted lead, or the reason it was dropped. Tokens are only spent on the draft.
  async function tryLead(l) {
    const host = hostOf(l.website);
    if (host && knownHosts.has(host)) return 'duplicate';
    // the site's own published address beats one from a listing or search snippet
    const onSite = await findSiteEmail(l.website);
    if (onSite) l.email = onSite;
    if (!l.email) return 'noEmail';
    const { rows: [sup] } = await pool.query(`select 1 from suppression where lower(email) = lower($1)`, [l.email]);
    if (sup) return 'suppressed';
    if (await rejectIfUndeliverable(pool, l.email)) return 'undeliverable';
    const { rows: [contact] } = await pool.query(
      `insert into contacts (business, contact_name, email, phone, address, website, notes, source)
       values ($1,$2,$3,$4,$5,$6,$7,'ai-discover')
       on conflict do nothing returning id, business, booking_token`,
      [l.business || null, l.contactName || null, l.email, l.phone || null, l.address || null, l.website || null,
       [l.type, l.about].filter(Boolean).join('\n\n')]
    );
    if (!contact) return 'duplicate';
    if (host) knownHosts.add(host);
    let body;
    try {
      body = ensureSignature(await draftEmailAI(l));
      aiDrafted++;
    } catch (err) {
      if (err.skip) { await skipLead(pool, contact, l.email, err.skip); return 'notDrafted'; }
      console.error(`draft failed for ${contact.business}, using template:`, err.message || err);
      body = ensureSignature(bodyFor(contact));
    }
    await addDraft(pool, campaignId, contact, body);
    inserted++;
    return 'added';
  }
  const tally = () => ({ added: 0, duplicate: 0, noEmail: 0, suppressed: 0, undeliverable: 0, notDrafted: 0 });

  // 1. OpenStreetMap: hospitality and offices interleaved, ones with an email tag first (no fetch needed)
  const names = new Set((await knownNames()).map((n) => n.toLowerCase()));
  const osm = (await osmCandidates()).filter((l) => !names.has(l.business.toLowerCase()));
  const bySector = (k) => osm.filter((l) => l.sector === k).sort((a, b) => !!b.email - !!a.email);
  const [h, o] = [bySector('hospitality'), bySector('office')];
  const queue = Array.from({ length: Math.max(h.length, o.length) }, (_, i) => [h[i], o[i]]).flat().filter(Boolean);
  const t = tally();
  for (const l of queue) {
    if (inserted >= TARGET || new Date() >= deadline) break;
    t[await tryLead(l)]++;
  }
  console.log(`discover ${BOROUGH} openstreetmap: ${osm.length} new candidates, ${JSON.stringify(t)} (${inserted}/${TARGET} so far)`);

  // 2. only if the map ran out: AI listing batches (search results only), code still finds the emails
  while (inserted < TARGET && empty < MAX_EMPTY && new Date() < deadline) {
    const sector = SECTORS[batchNo++ % SECTORS.length];
    let leads;
    try {
      leads = await findLeads(sector, await knownNames());
    } catch (err) {
      if (/error_max_turns/.test(err.stdout)) { console.error('discover batch hit the turn cap, next batch'); empty++; continue; }
      // most likely the Claude usage limit — wait for it to reset rather than giving up the night
      console.error('discover batch failed, retrying in 20 min:', (err.stdout || err.stderr || err.message || String(err)).slice(0, 300));
      await sleep(20 * 60_000);
      continue;
    }
    const b = tally();
    for (const l of leads) {
      if (inserted >= TARGET) break;
      b[await tryLead(l)]++;
    }
    empty = b.added ? 0 : empty + 1;
    console.log(`discover ${BOROUGH} ${sector.key}: AI listed ${leads.length}, ${JSON.stringify(b)} (${inserted}/${TARGET} so far)`);
  }

  console.log(`discover ${BOROUGH}: ${inserted} new leads drafted (${aiDrafted} AI-researched)` +
    (inserted < TARGET ? ` — stopped short: ${empty >= MAX_EMPTY ? 'area ran dry' : 'hit deadline'}` : ''));
  await pool.end();
}

main().catch((err) => { console.error('discover failed:', err.message || err); process.exit(1); });
