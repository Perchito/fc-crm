// End-to-end: real server process + real Postgres (an isolated schema in TEST_DATABASE_URL)
// + a mock DocuSeal API. Run on perchito:  TEST_DATABASE_URL=... node --test test/
// Never point TEST_DATABASE_URL at the production database: the schema below is dropped.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';

const BASE_URL = process.env.TEST_DATABASE_URL;
if (!BASE_URL) throw new Error('TEST_DATABASE_URL is required');
if (/\/fc_crm(\?|$)/.test(BASE_URL)) throw new Error('refusing to run against the production database');
const SCHEMA = 'crm_e2e';
const DB_URL = `${BASE_URL}${BASE_URL.includes('?') ? '&' : '?'}options=${encodeURIComponent(`-c search_path=${SCHEMA},public`)}`;
const PORT = 4698, MOCK_PORT = 4697, SECRET = 'whsec_e2e_secret';
let server, mock, pool, docsDir;

// ── mock DocuSeal ──
const ds = { templates: new Map(), submissions: new Map(), nextId: 100, failSubmissions: false, calls: [] };
const signedPdf = Buffer.from('%PDF-1.4 signed by everyone');
function mockDocuSeal() {
  return http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    ds.calls.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/files/')) { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(signedPdf); }
    if (req.headers['x-auth-token'] !== 'test-key') return send(401, { error: 'Not authenticated' });
    let m;
    if (req.method === 'POST' && req.url === '/api/templates/pdf') {
      const id = ds.nextId++; ds.templates.set(id, { id, ...json, layout: null });
      assert.ok(Buffer.from(json.documents[0].file, 'base64').subarray(0, 5).toString() === '%PDF-');
      return send(200, { id, documents: [{ uuid: `att-${id}` }] });
    }
    if (req.method === 'PUT' && (m = req.url.match(/^\/api\/templates\/(\d+)$/))) { ds.templates.get(+m[1]).layout = json; return send(200, { id: +m[1] }); }
    if (req.method === 'POST' && req.url === '/api/submissions') {
      if (ds.failSubmissions) return send(500, { error: 'boom' });
      const id = ds.nextId++;
      const subs = json.submitters.map((s, i) => ({ id: id * 10 + i, submission_id: id, role: s.role, name: s.name, email: s.email, status: 'sent', slug: `slug${id}${i}`, completed_at: null, values: s.values }));
      ds.submissions.set(id, { id, template_id: json.template_id, submitters: subs, status: 'pending', archived_at: null });
      return send(200, subs);
    }
    if (req.method === 'GET' && (m = req.url.match(/^\/api\/submissions\/(\d+)$/))) {
      const s = ds.submissions.get(+m[1]);
      return s ? send(200, { ...s, combined_document_url: s.status === 'completed' ? `http://127.0.0.1:${MOCK_PORT}/files/signed.pdf` : null, audit_log_url: s.status === 'completed' ? `http://127.0.0.1:${MOCK_PORT}/files/audit.pdf` : null }) : send(404, { error: 'nf' });
    }
    if (req.method === 'DELETE' && (m = req.url.match(/^\/api\/submissions\/(\d+)$/))) { ds.submissions.get(+m[1]).archived_at = new Date().toISOString(); return send(200, {}); }
    if (req.method === 'PUT' && req.url.startsWith('/api/submitters/')) return send(200, {});
    send(404, { error: 'unknown mock route' });
  });
}
const sign = (subId, i) => { const s = ds.submissions.get(subId); s.submitters[i].status = 'completed'; s.submitters[i].completed_at = new Date().toISOString(); if (s.submitters.every((x) => x.completed_at)) s.status = 'completed'; };
function webhook(body, { secret = SECRET, ts = Math.floor(Date.now() / 1000) } = {}) {
  const raw = JSON.stringify(body);
  const sig = `${ts}.${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  return fetch(`http://127.0.0.1:${PORT}/api/webhooks/docuseal`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-docuseal-signature': sig }, body: raw });
}

// ── tiny client with a cookie jar ──
function client() {
  let cookie = '';
  const call = async (method, path, body, { csrf = true, raw = false, headers = {} } = {}) => {
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, redirect: 'manual',
      headers: { ...(body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string' ? { 'content-type': 'application/json' } : {}), ...(csrf ? { 'x-fc-csrf': '1' } : {}), cookie, ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body) });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    if (raw) return r;
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data, headers: r.headers };
  };
  return { call, get: (p, o) => call('GET', p, undefined, o), post: (p, b, o) => call('POST', p, b ?? {}, o), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}
const admin = client(), staff = client(), anon = client();

before(async () => {
  pool = new pg.Pool({ connectionString: BASE_URL });
  await pool.query(`drop schema if exists ${SCHEMA} cascade; create schema ${SCHEMA}`);
  await pool.end();
  // like production: the old schema with data in it, THEN the migrations
  pool = new pg.Pool({ connectionString: DB_URL });
  const { readFile } = await import('node:fs/promises');
  await pool.query(await readFile(new URL('../db/schema.sql', import.meta.url), 'utf8'));
  await pool.query(`insert into contacts (id, business, contact_name, email, phone, address, pipeline_stage) values ('00000000-0000-4000-8000-000000000001','Legacy Cafe','Old Owner','legacy@test.local','0161 000 0000','1 Old St, Manchester','contacted')`);
  await pool.query(`insert into tasks (contact_id, title) values ('00000000-0000-4000-8000-000000000001','old task')`);
  const { migrate } = await import('../db/migrate.mjs');
  await migrate(DB_URL, { log: () => {} });
  const { hashPassword } = await import('../lib/auth.mjs');
  await pool.query(`insert into users (email, name, role, pass_hash) values ('admin@test.local','Admin','admin',$1), ('staff@test.local','Staff','staff',$2)`, [hashPassword('admin-pass-123'), hashPassword('staff-pass-123')]);
  await pool.query(`update meta set v = v || '{"signatory_email":"fernando@test.local"}' where k = 'company'`);
  docsDir = await mkdtemp(join(tmpdir(), 'fccrm-docs-'));
  mock = mockDocuSeal(); await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  server = spawn(process.execPath, ['server.mjs'], { cwd: new URL('..', import.meta.url).pathname, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'Europe/London', PORT: String(PORT), DATABASE_URL: DB_URL, DOCS_DIR: docsDir,
      DOCUSEAL_URL: `http://127.0.0.1:${MOCK_PORT}`, DOCUSEAL_API_KEY: 'test-key', DOCUSEAL_WEBHOOK_SECRET: SECRET, DOCUSEAL_UPLOAD: 'api', ENGINE_TICK_MS: '3600000' } });
  let log = '';
  server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; if (process.env.E2E_VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 100 && !log.includes('listening'); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(log.includes('listening'), `server did not start:\n${log}`);
});
after(async () => {
  server?.kill('SIGTERM'); mock?.close();
  await pool?.query(`drop schema if exists ${SCHEMA} cascade`).catch(() => {}); await pool?.end();
  if (docsDir) await rm(docsDir, { recursive: true, force: true });
});

// automations run just after the response is sent: poll a moment for their result
async function eventually(fn, want) { let v; for (let i = 0; i < 40; i++) { v = await fn(); if (JSON.stringify(v) === JSON.stringify(want)) return v; await new Promise((r) => setTimeout(r, 50)); } return v; }
const taskCount = (key) => eventually(async () => (await pool.query(`select count(*)::int n from tasks where auto_key = $1`, [key])).rows[0].n, 1);
const PDF_OK = (b) => typeof b === 'string' && b.startsWith('%PDF-');
let customer, proposal, contract;

test('auth: everything private, CSRF header required, login works', async () => {
  assert.equal((await anon.get('/api/contacts')).status, 401);
  assert.equal((await anon.get('/', { raw: true }).then((r) => r.status)), 302);
  assert.equal((await anon.get('/healthz')).status, 200);
  assert.equal((await anon.get('/login', { raw: true })).status, 200);
  assert.equal((await anon.post('/api/login', { email: 'admin@test.local', password: 'admin-pass-123' }, { csrf: false })).status, 403);
  assert.equal((await anon.post('/api/login', { email: 'admin@test.local', password: 'wrong' })).status, 401);
  assert.equal((await admin.post('/api/login', { email: 'admin@test.local', password: 'admin-pass-123' })).status, 200);
  assert.equal((await staff.post('/api/login', { email: 'staff@test.local', password: 'staff-pass-123' })).status, 200);
  assert.equal((await admin.get('/api/me')).data.role, 'admin');
  // state-changing call without the CSRF header is refused even with a valid session
  assert.equal((await admin.call('POST', '/api/contacts', { business: 'X' }, { csrf: false })).status, 403);
  const h = (await admin.get('/api/me')).headers;
  assert.equal(h.get('x-content-type-options'), 'nosniff');
  assert.ok(h.get('content-security-policy').includes("frame-ancestors 'self'"));
});

test('existing CRM data and endpoints still work after the migration', async () => {
  const list = (await admin.get('/api/contacts')).data;
  const legacy = list.find((c) => c.business === 'Legacy Cafe');
  assert.ok(legacy && legacy.pipeline_stage === 'contacted');
  assert.equal((await admin.get(`/api/contacts/${legacy.id}/tasks`)).data[0].title, 'old task');
  const prof = (await admin.get(`/api/contacts/${legacy.id}/profile`)).data;
  assert.equal(prof.people[0].name, 'Old Owner');           // migration back-filled people + sites
  assert.equal(prof.sites[0].address, '1 Old St, Manchester');
  for (const p of ['/api/campaigns', '/api/drafts', '/api/settings', '/api/suppression', '/api/activity', '/api/booking-settings', `/api/calendar?from=2026-01-01&to=2026-01-08`]) {
    assert.equal((await admin.get(p)).status, 200, p);
  }
  const t = (await admin.post(`/api/contacts/${legacy.id}/tasks`, { title: 'new style task' })).data;
  assert.equal((await admin.patch(`/api/tasks/${t.id}`, { done: true })).data.done, true); // old PATCH {done} shape
});

test('customers: create, duplicate detection, edit, people, sites, archive keeps records', async () => {
  const r = await admin.post('/api/contacts', { business: 'Test Bakery Ltd', contact_name: 'Frankie Baird', email: 'frankie@test.local', phone: '07791 355 363', address: 'Unit 17 Red Bank, Manchester M4 4HF' });
  assert.equal(r.status, 201); customer = r.data;
  const dup = await admin.post('/api/contacts', { business: 'test bakery', email: 'other@test.local' });
  assert.equal(dup.status, 409); assert.equal(dup.data.duplicates[0].id, customer.id);
  assert.equal((await admin.post('/api/contacts', { business: 'Someone', email: 'not-an-email' })).status, 400);
  assert.equal((await admin.patch(`/api/contacts/${customer.id}`, { company_number: '12216286', premises_type: 'Bakery', pipeline_stage: 'bogus' })).status, 400);
  assert.equal((await admin.patch(`/api/contacts/${customer.id}`, { company_number: '12216286', premises_type: 'Bakery' })).data.company_number, '12216286');
  const prof = (await admin.get(`/api/contacts/${customer.id}/profile`)).data;
  assert.equal(prof.people.length, 1); assert.equal(prof.sites.length, 1);
  await admin.patch(`/api/people/${prof.people[0].id}`, { ...prof.people[0], job_title: 'Operations Manager', is_primary: true, is_signer: true });
  assert.equal((await admin.post(`/api/contacts/${customer.id}/sites`, { name: 'Second shop', address: '2 High St' })).status, 201);
  // new-lead automation made one follow-up task, idempotently
  assert.equal(await taskCount(`lead:${customer.id}`), 1);
});

test('proposal: price, preview, placeholders block issue, send, snapshot is immutable, versions', async () => {
  const lib = (await admin.get('/api/library')).data;
  const deep = lib.services.find((s) => s.name === 'One-off deep clean'), daily = lib.services.find((s) => s.name === 'Daily cleaning service');
  const r = await staff.post('/api/proposals', { contact_id: customer.id, service_ids: [deep.id, daily.id] });
  assert.equal(r.status, 201); proposal = r.data;
  assert.match(proposal.number, /^FCC-TB-001$|^FCC-TBX?-001$/);
  let p = (await staff.get(`/api/proposals/${proposal.id}`)).data;
  assert.equal(p.priced.totals.one_off_net, 69500);
  assert.equal(p.priced.totals.monthly_net, 375000);
  assert.equal(p.priced.totals.monthly_vat, 75000);
  assert.ok(p.problems.some((x) => x.includes('[[')), 'executive summary placeholder must be flagged');
  // staff can draft but not issue
  assert.equal((await staff.post(`/api/proposals/${proposal.id}/mark-sent`)).status, 403);
  assert.equal((await admin.post(`/api/proposals/${proposal.id}/mark-sent`)).status, 422);
  // fix the placeholders, change a price, check the server re-prices
  const data = structuredClone(p.data);
  for (const s of data.sections) s.body = s.body.replace(/\[\[[^\]]*\]\]/g, 'Bakery production site, walkaround done 1 Oct.');
  data.lines[1].price_pence = 360000;
  data.lines[0].discount_type = 'percent'; data.lines[0].discount_value = 1000; // 10% off the deep clean
  const saved = await staff.patch(`/api/proposals/${proposal.id}`, { data });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.monthly_net_pence, '360000');
  assert.equal(saved.data.one_off_net_pence, '62550');
  assert.ok(PDF_OK((await staff.get(`/api/proposals/${proposal.id}/pdf`)).data));
  // a bad price is rejected with a readable message
  const bad = structuredClone(data); bad.lines[0].price_pence = -1;
  assert.equal((await staff.patch(`/api/proposals/${proposal.id}`, { data: bad })).status, 400);
  // email not configured in the test env → a clear error, proposal still a draft
  const s = await admin.post(`/api/proposals/${proposal.id}/send`, { to: 'frankie@test.local' });
  assert.equal(s.status, 503);
  assert.equal((await admin.get(`/api/proposals/${proposal.id}`)).data.status, 'draft');
  assert.equal((await admin.post(`/api/proposals/${proposal.id}/mark-sent`)).status, 200);
  p = (await admin.get(`/api/proposals/${proposal.id}`)).data;
  assert.equal(p.status, 'sent'); assert.equal(p.issued_version, 1);
  assert.equal((await admin.get(`/api/contacts/${customer.id}`.replace('contacts/', 'contacts/') + '/profile')).data.pipeline_stage, 'quoted');
  // the sent version can't be edited
  assert.equal((await admin.patch(`/api/proposals/${proposal.id}`, { data })).status, 409);
  // revise → v2 is a new draft; v1's snapshot and PDF are untouched
  const v1 = (await pool.query(`select snapshot from proposal_versions where proposal_id = $1 and version = 1`, [proposal.id])).rows[0].snapshot;
  assert.equal((await admin.post(`/api/proposals/${proposal.id}/revise`)).status, 200);
  const d2 = structuredClone(data); d2.lines[1].price_pence = 350000;
  await admin.patch(`/api/proposals/${proposal.id}`, { data: d2, valid_until: '2099-12-31' });
  const v1after = (await pool.query(`select snapshot from proposal_versions where proposal_id = $1 and version = 1`, [proposal.id])).rows[0].snapshot;
  assert.deepEqual(v1after, v1);
  assert.equal(v1after.totals.monthly_net, 360000);
  assert.ok(PDF_OK((await admin.get(`/api/proposals/${proposal.id}/pdf?version=1`)).data));
  assert.equal((await admin.post(`/api/proposals/${proposal.id}/mark-sent`)).status, 200);
  assert.equal((await pool.query(`select snapshot->'totals'->>'monthly_net' m from proposal_versions where proposal_id = $1 and version = 2`, [proposal.id])).rows[0].m, '350000');
  // follow-up automation for v2 exists once
  assert.equal(await taskCount(`proposal_fu:${proposal.id}:v2`), 1);
  // duplicate + archive
  const dup = await admin.post(`/api/proposals/${proposal.id}/duplicate`);
  assert.equal(dup.status, 201); assert.equal(dup.data.status, 'draft'); assert.notEqual(dup.data.number, proposal.number);
  assert.equal((await admin.post(`/api/proposals/${dup.data.id}/archive`)).status, 200);
});

test('accepted proposal → contract draft (copied snapshot, one per proposal)', async () => {
  assert.equal((await admin.post('/api/contracts', { proposal_id: proposal.id })).status, 409); // not accepted yet
  assert.equal((await admin.post(`/api/proposals/${proposal.id}/accept`)).status, 200);
  assert.equal(await taskCount(`proposal_contract:${proposal.id}`), 1);
  assert.equal((await staff.post('/api/contracts', { proposal_id: proposal.id })).status, 403);
  const r = await admin.post('/api/contracts', { proposal_id: proposal.id });
  assert.equal(r.status, 201); contract = r.data;
  assert.equal(contract.monthly_net_pence, '350000');
  assert.equal(contract.data.proposal_ref, `${proposal.number} v2`);
  const again = await admin.post('/api/contracts', { proposal_id: proposal.id });
  assert.equal(again.status, 409); assert.equal(again.data.error.includes('already exists'), true);
  // the contract doesn't change when the proposal's draft data changes (it was copied)
  await pool.query(`update proposals set data = jsonb_set(data, '{lines,1,price_pence}', '1') where id = $1`, [proposal.id]);
  assert.equal((await admin.get(`/api/contracts/${contract.id}`)).data.priced.totals.monthly_net, 350000);
});

test('contract: missing info blocks “ready”, then send to DocuSeal (once)', async () => {
  let k = (await admin.get(`/api/contracts/${contract.id}`)).data;
  assert.ok(k.problems.some((x) => /start/.test(x)));
  assert.equal((await admin.post(`/api/contracts/${contract.id}/status`, { to: 'review' })).status, 200);
  assert.equal((await admin.post(`/api/contracts/${contract.id}/status`, { to: 'ready' })).status, 422);
  assert.equal((await admin.post(`/api/contracts/${contract.id}/status`, { to: 'active' })).status, 409); // not an allowed move
  assert.equal((await admin.patch(`/api/contracts/${contract.id}`, { start_date: '2026-11-02' })).data.renewal_date, '2027-02-02'); // + 3 months
  assert.ok(PDF_OK((await admin.get(`/api/contracts/${contract.id}/pdf`)).data));
  assert.equal((await staff.get(`/api/contracts/${contract.id}/pdf`)).status, 403);
  assert.equal((await admin.post(`/api/contracts/${contract.id}/status`, { to: 'ready' })).status, 200);
  assert.equal((await admin.patch(`/api/contracts/${contract.id}`, { start_date: '2026-12-01' })).status, 409); // not editable when ready

  // DocuSeal API failing → request failed, contract still "ready", nothing misleading
  ds.failSubmissions = true;
  const fail = await admin.post(`/api/contracts/${contract.id}/signature`);
  assert.equal(fail.status, 502);
  k = (await admin.get(`/api/contracts/${contract.id}`)).data;
  assert.equal(k.status, 'ready'); assert.equal(k.signatures[0].status, 'failed');
  ds.failSubmissions = false;

  // two clicks at once → exactly one live request
  const [a, b] = await Promise.all([admin.post(`/api/contracts/${contract.id}/signature`), admin.post(`/api/contracts/${contract.id}/signature`)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  k = (await admin.get(`/api/contracts/${contract.id}`)).data;
  assert.equal(k.status, 'sent');
  assert.equal(k.signatures.filter((s) => s.status === 'sent').length, 1);
  const sub = ds.submissions.get(Number(k.signatures[0].docuseal_submission_id));
  assert.deepEqual(sub.submitters.map((s) => s.role), ['FC Cleaning', 'Client']);
  assert.equal(sub.submitters[1].email, 'frankie@test.local');
  assert.equal(sub.submitters[1].values['Client Position'], 'Operations Manager');
  const layout = ds.templates.get(sub.template_id).layout;
  assert.equal(layout.fields.length, 6);
  assert.ok(layout.fields.every((f) => f.areas[0].x > 0 && f.areas[0].y < 1));
  contract.submission = sub.id;
});

test('webhooks: bad signatures rejected, payload not trusted, duplicates ignored, completion stores the signed PDF', async () => {
  const id = contract.submission;
  const evt = (type, ts) => ({ event_type: type, timestamp: ts, data: type.startsWith('submission.') ? { id } : { id: id * 10, submission_id: id, status: 'completed' } });
  assert.equal((await webhook(evt('form.completed', 't1'), { secret: 'wrong' })).status, 401);
  assert.equal((await webhook(evt('form.completed', 't1'), { ts: Math.floor(Date.now() / 1000) - 3600 })).status, 401);
  const forged = await fetch(`http://127.0.0.1:${PORT}/api/webhooks/docuseal`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(forged.status, 401);
  // a valid "completed" event while DocuSeal says nobody signed changes nothing
  assert.equal((await webhook(evt('submission.completed', 't0'))).status, 200);
  assert.equal((await admin.get(`/api/contracts/${contract.id}`)).data.status, 'sent');

  sign(id, 0); // Fernando signs
  assert.equal((await webhook(evt('form.completed', 't1'))).status, 200);
  assert.equal((await admin.get(`/api/contracts/${contract.id}`)).data.status, 'partially_signed');
  const dupe = await (await webhook(evt('form.completed', 't1'))).json();
  assert.equal(dupe.duplicate, true);

  sign(id, 1); // client signs
  const done1 = webhook(evt('submission.completed', 't2')), done2 = webhook(evt('form.completed', 't3'));
  assert.deepEqual([(await done1).status, (await done2).status], [200, 200]);
  const k = (await admin.get(`/api/contracts/${contract.id}`)).data;
  assert.equal(k.status, 'signed');
  assert.ok(k.signed_document_id);
  const docs = (await pool.query(`select kind from documents where contract_id = $1 and kind in ('signed_pdf','audit_trail')`, [contract.id])).rows;
  assert.equal(docs.filter((d) => d.kind === 'signed_pdf').length, 1, 'exactly one signed PDF despite repeated events');
  const file = await admin.get(`/api/documents/${k.signed_document_id}/file`);
  assert.equal(file.status, 200); assert.equal(file.data, signedPdf.toString());
  assert.equal(file.headers.get('cache-control'), 'private, no-store');
  assert.equal((await staff.get(`/api/documents/${k.signed_document_id}/file`)).status, 404);
  assert.equal((await anon.get(`/api/documents/${k.signed_document_id}/file`)).status, 401);
  // stored on disk under a generated key, not under any user-supplied name
  const years = await readdir(join(docsDir, 'docs'));
  assert.ok((await readdir(join(docsDir, 'docs', years[0]))).every((f) => /^[0-9a-f-]{36}\.pdf$/.test(f)));
  assert.equal(await taskCount(`activate:${contract.id}`), 1);
});

test('activation creates onboarding + 5 weekly quality follow-ups, once', async () => {
  assert.equal((await admin.post(`/api/contracts/${contract.id}/status`, { to: 'active' })).status, 200);
  const count = async () => (await pool.query(`select kind, count(*)::int n from tasks where contract_id = $1 and kind in ('onboarding','quality') group by kind order by kind`, [contract.id])).rows;
  const first = await eventually(count, [{ kind: 'onboarding', n: 6 }, { kind: 'quality', n: 5 }]);
  assert.deepEqual(first, [{ kind: 'onboarding', n: 6 }, { kind: 'quality', n: 5 }]);
  const { runAutomation } = await import('../lib/automation.mjs');
  await runAutomation(pool, 'contract_active', { contract_id: contract.id });
  assert.deepEqual(await count(), first);
  const qa1 = (await pool.query(`select (due_at at time zone 'Europe/London')::date::text d from tasks where auto_key = $1`, [`qa:${contract.id}:w1`])).rows[0].d;
  assert.equal(qa1, '2026-11-09');
  assert.equal((await admin.get(`/api/contacts/${customer.id}/profile`)).data.pipeline_stage, 'won');
});

test('renewals and proposal expiry are flagged by the scheduler, once', async () => {
  const { scanSchedules } = await import('../lib/automation.mjs');
  await pool.query(`update contracts set renewal_date = current_date + 10 where id = $1`, [contract.id]);
  const old = (await admin.post('/api/proposals', { contact_id: customer.id })).data;
  await pool.query(`update proposals set status = 'sent', issued_version = 1, valid_until = current_date - 1 where id = $1`, [old.id]);
  await scanSchedules(pool); await scanSchedules(pool);
  assert.equal((await admin.get(`/api/contracts/${contract.id}`)).data.status, 'renewal_due');
  assert.equal((await pool.query(`select count(*)::int n from tasks where contract_id = $1 and kind = 'renewal'`, [contract.id])).rows[0].n, 1);
  assert.equal((await admin.get(`/api/proposals/${old.id}`)).data.status, 'expired');
  assert.equal((await pool.query(`select count(*)::int n from tasks where auto_key like $1`, [`expired:${old.id}%`])).rows[0].n, 1);
});

test('documents: upload validation, path traversal, role limits', async () => {
  const up = (name, body, who = admin) => who.call('POST', `/api/documents?contact_id=${customer.id}`, body, { headers: { 'x-filename': encodeURIComponent(name), 'content-type': 'application/octet-stream' } });
  assert.equal((await up('evil.html', Buffer.from('<script>'))).status, 400);
  assert.equal((await up('fake.pdf', Buffer.from('<html>'))).status, 400);
  const ok = await up('../../etc/passwd.pdf', Buffer.from('%PDF-1.4 hello'), staff);
  assert.equal(ok.status, 201); assert.ok(!ok.data.filename.includes('/'));
  assert.equal((await staff.del(`/api/documents/${ok.data.id}`)).status, 403);
  assert.equal((await admin.del(`/api/documents/${ok.data.id}`)).status, 204);
  const signed = (await pool.query(`select id from documents where kind = 'signed_pdf' limit 1`)).rows[0];
  assert.equal((await admin.del(`/api/documents/${signed.id}`)).status, 400); // signed records are permanent
  const staffList = (await staff.get(`/api/documents?contact_id=${customer.id}`)).data;
  assert.ok(staffList.every((d) => !['signed_pdf', 'contract_pdf', 'audit_trail'].includes(d.kind)));
});

test('customer with contracts can only be archived, never hard-deleted', async () => {
  assert.equal((await admin.call('DELETE', `/api/contacts/${customer.id}?permanent=1`)).status, 409);
  assert.equal((await staff.call('DELETE', `/api/contacts/${customer.id}?permanent=1`)).status, 403);
  assert.equal((await admin.del(`/api/contacts/${customer.id}`)).status, 204);
  assert.ok(!(await admin.get('/api/contacts')).data.some((c) => c.id === customer.id));
  assert.equal((await pool.query(`select count(*)::int n from contracts where contact_id = $1`, [customer.id])).rows[0].n, 1);
  assert.equal((await admin.post(`/api/contacts/${customer.id}/restore`)).status, 200);
});

test('CSV import (dry run, duplicates) and export (manager only, formula-safe)', async () => {
  const csv = 'business,email,phone,pipeline_stage\nNew Pub,pub@test.local,0161 111 2222,new\nLegacy Cafe,,,\n=cmd,,,\n';
  const dry = await admin.call('POST', '/api/contacts/import?dry_run=1', csv, { headers: { 'content-type': 'text/csv' } });
  assert.equal(dry.data.created, 2); assert.equal(dry.data.duplicates.length, 1);
  assert.equal((await pool.query(`select count(*)::int n from contacts where business = 'New Pub'`)).rows[0].n, 0);
  const real = await admin.call('POST', '/api/contacts/import', csv, { headers: { 'content-type': 'text/csv' } });
  assert.equal(real.data.created, 2);
  assert.equal((await staff.get('/api/contacts.csv')).status, 403);
  const out = await admin.get('/api/contacts.csv');
  assert.ok(out.data.includes("'=cmd") && out.data.includes('New Pub'));
});

test('reports use real data with definitions; admin-only areas are protected', async () => {
  const r = (await admin.get('/api/reports')).data;
  assert.ok(r.definitions.contracted_monthly.includes('not cash'));
  assert.equal(r.metrics.contracted.monthly_pence, 350000);
  assert.ok(r.metrics.leads_created >= 1);
  assert.equal((await staff.get('/api/audit')).status, 403);
  assert.ok((await admin.get('/api/audit')).data.some((a) => a.action === 'signature_status'));
  assert.equal((await staff.put('/api/automation', {})).status, 403);
  assert.equal((await staff.put('/api/company', { name: 'x' })).status, 403);
  assert.equal((await staff.post('/api/users', { email: 'x@y.z', name: 'X' })).status, 403);
  const u = await admin.post('/api/users', { email: 'new@test.local', name: 'New', role: 'manager' });
  assert.equal(u.status, 201); assert.ok(u.data.password.length >= 12);
  // the last admin can't demote themselves
  const me = (await admin.get('/api/me')).data;
  assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'staff' })).status, 400);
  // audit log can't be tampered with
  await assert.rejects(pool.query(`delete from audit_log`), /append-only/);
});

test('invoices: draft with VAT, numbering, delete draft, issue, payments, PDF', async () => {
  const c = (await admin.post('/api/contacts', { business: 'Northern Gym Ltd', contact_name: 'Sam', email: 'sam@gym.test' })).data;
  const body = { contact_id: c.id, issue_date: '2026-10-01', due_date: '2026-10-15', vat_rate_bp: 2000, lines: [{ description: 'Office clean', quantity: 2, unit_price: 50 }, { description: 'Windows', quantity: 1, unit_price: 25.5 }] };
  assert.equal((await staff.post('/api/invoices', body)).status, 403, 'staff cannot invoice');
  assert.equal((await admin.post('/api/invoices', { ...body, due_date: '2026-09-01' })).status, 400, 'due before issue');
  const a = (await admin.post('/api/invoices', body)).data;
  assert.equal(a.number, 'INV-001-NG');
  assert.deepEqual([a.subtotal_pence, a.vat_pence, a.total_pence].map(Number), [12550, 2510, 15060]);
  assert.equal((await admin.post('/api/invoices', body)).data.number, 'INV-002-NG');
  assert.equal((await admin.del(`/api/invoices/${a.id}`)).status, 204, 'drafts can be deleted');
  const b = (await admin.get('/api/invoices')).data.find((i) => i.number === 'INV-002-NG');
  assert.equal((await admin.post(`/api/invoices/${b.id}/payments`, { amount: 10 })).status, 409, 'no payments on drafts');
  assert.equal((await admin.post(`/api/invoices/${b.id}/issue`)).status, 200);
  assert.equal((await admin.del(`/api/invoices/${b.id}`)).status, 409, 'issued invoices stay');
  assert.equal((await admin.post(`/api/invoices/${b.id}/payments`, { amount: 200 })).status, 400, 'overpayment');
  assert.equal((await admin.post(`/api/invoices/${b.id}/payments`, { amount: 50.6 })).status, 201);
  assert.equal((await admin.get(`/api/invoices/${b.id}`)).data.status, 'part_paid');
  await admin.post(`/api/invoices/${b.id}/payments`, { amount: 100 });
  assert.equal((await admin.get(`/api/invoices/${b.id}`)).data.status, 'paid');
  const pdf = await admin.call('GET', `/api/invoices/${b.id}/pdf`, undefined, { raw: true });
  assert.equal(pdf.status, 200);
  assert.ok(PDF_OK(Buffer.from(await pdf.arrayBuffer()).toString('latin1')));
});

test('logout ends the session', async () => {
  assert.equal((await staff.post('/api/logout')).status, 200);
  assert.equal((await staff.get('/api/contacts')).status, 401);
});
