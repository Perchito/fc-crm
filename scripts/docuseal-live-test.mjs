// Real DocuSeal round trip against a TEST schema (never production data):
// proposal → accepted → contract → ready → send (no emails) → both parties signed via the
// official API → status re-checked from DocuSeal → signed PDF + audit trail stored → archived.
//   BASE=http://127.0.0.1:4699 DATABASE_URL=<test schema url> node scripts/docuseal-live-test.mjs
import pg from 'pg';
const BASE = process.env.BASE || 'http://127.0.0.1:4699';
const url = process.env.DATABASE_URL || '';
if (!/search_path%3Dcrm_/.test(url)) throw new Error('refusing: needs a crm_* test schema');
const ME = process.env.TEST_EMAIL || 'lmateocc99@gmail.com';
const plus = (tag) => ME.replace('@', `+${tag}@`);
let cookie = '';
async function call(method, path, body) {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-fc-csrf': '1', cookie }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
  const t = await r.text(); let d; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(d)}`);
  return d;
}
const ds = async (method, path, body) => {
  const r = await fetch(`${process.env.DOCUSEAL_URL}/api${path}`, { method, headers: { 'X-Auth-Token': process.env.DOCUSEAL_API_KEY, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error(`docuseal ${path} ${r.status} ${await r.text()}`);
  return r.json();
};
const db = new pg.Client({ connectionString: url }); await db.connect();
await db.query(`update meta set v = v || $1 where k = 'company'`, [{ signatory_email: plus('fc-signer') }]);
await call('POST', '/api/login', { email: 'demo.admin@example.com', password: 'demo-pass-123' });
const c = await call('POST', '/api/contacts', { business: 'DocuSeal Test Ltd', contact_name: 'Test Signer', email: plus(`client-signer-${Date.now().toString(36)}`), address: '1 Test Street, Manchester', force: true });
const lib = await call('GET', '/api/library');
const p = await call('POST', '/api/proposals', { contact_id: c.id, service_ids: [lib.services[0].id] });
const pd = (await call('GET', `/api/proposals/${p.id}`)).data;
for (const s of pd.sections) s.body = s.body.replace(/\[\[[^\]]*\]\]/g, 'test');
await call('PATCH', `/api/proposals/${p.id}`, { data: pd });
await call('POST', `/api/proposals/${p.id}/mark-sent`); await call('POST', `/api/proposals/${p.id}/accept`);
const k = await call('POST', '/api/contracts', { proposal_id: p.id });
await call('PATCH', `/api/contracts/${k.id}`, { start_date: '2026-11-02' });
await call('POST', `/api/contracts/${k.id}/status`, { to: 'review' }); await call('POST', `/api/contracts/${k.id}/status`, { to: 'ready' });
const sent = await call('POST', `/api/contracts/${k.id}/signature`);
console.log('1. sent to DocuSeal, submission', sent.submission_id);
const sub = await ds('GET', `/submissions/${sent.submission_id}`);
console.log('   signers:', sub.submitters.map((s) => `${s.role} ${s.status}`).join(', '), '| template fields:', (await ds('GET', `/templates/${sub.template.id}`)).fields.map((f) => f.name).join(', '));
const sigPng = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const order = sub.submitters.map((s) => s.role);
for (const role of order) {
  const s = sub.submitters.find((x) => x.role === role);
  const values = role === 'Client' ? { 'Client Signature': sigPng, 'Client Date': '02/11/2026' } : { 'FC Cleaning Signature': sigPng, 'FC Cleaning Date': '02/11/2026' };
  await ds('PUT', `/submitters/${s.id}`, { completed: true, send_email: false, values });
  const r = await call('POST', `/api/contracts/${k.id}/signature/refresh`);
  console.log(`2. ${role} signed → CRM contract status: ${r.contract_status}`);
}
let detail;
for (let i = 0; i < 20; i++) {
  detail = await call('GET', `/api/contracts/${k.id}`);
  if (detail.signed_document_id) break;
  await new Promise((r) => setTimeout(r, 3000));
  await call('POST', `/api/contracts/${k.id}/signature/refresh`).catch(() => {});
}
console.log('3. final status:', detail.status, '| signed doc:', !!detail.signed_document_id, '| audit trail:', !!detail.signatures[0].audit_document_id);
const f = await fetch(`${BASE}/api/documents/${detail.signed_document_id}/file`, { headers: { cookie } });
const buf = Buffer.from(await f.arrayBuffer());
console.log('4. signed PDF served to an authorised user:', f.status, buf.subarray(0, 5).toString(), `${buf.length} bytes`);
console.log('5. same file without a session:', (await fetch(`${BASE}/api/documents/${detail.signed_document_id}/file`)).status);
await ds('DELETE', `/submissions/${sent.submission_id}`);           // archive the test submission in DocuSeal
await ds('PUT', `/templates/${sub.template.id}`, { archived: true });  // and its template
console.log('6. test submission + template archived in DocuSeal');
await db.end();
