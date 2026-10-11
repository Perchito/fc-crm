// DocuSeal e-signature (self-hosted 3.3.0 at sign.fccleaningcompany.com).
//
// The open-source edition's API can't create a template from a PDF (that endpoint is
// DocuSeal Pro), so step 1 runs DocuSeal's own Templates::CreateAttachments inside its
// container (`rails runner`, same code its upload page uses). Everything else is the
// official REST API with the X-Auth-Token key: field placement (PUT /api/templates/:id),
// the signature request (POST /api/submissions), status (GET /api/submissions/:id),
// resend (PUT /api/submitters/:id), cancel (DELETE /api/submissions/:id).
//
// Webhooks are verified exactly like DocuSeal's WebhookUrls::Signatures.verify:
// X-Docuseal-Signature = "<unix ts>.<hex HMAC-SHA256(secret, "<ts>.<raw body>")>", 5 min tolerance.
// A webhook only says "go and look": the status is always re-read from the API before
// anything changes here, and every delivery is de-duplicated.
import { execFile } from 'node:child_process';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { readDocument, saveDocument } from './documents.mjs';
import { audit, requireRole } from './auth.mjs';
import { httpError, logEvent, tx, str } from './biz.mjs';
import { getCompany } from './proposals.mjs';
import { issueContract, contractProblems, contractSnapshot } from './contracts.mjs';
import { runAutomation } from './automation.mjs';

const cfg = () => ({
  url: (process.env.DOCUSEAL_URL || 'https://sign.fccleaningcompany.com').replace(/\/$/, ''),
  key: process.env.DOCUSEAL_API_KEY,
  secret: process.env.DOCUSEAL_WEBHOOK_SECRET,
  composeDir: process.env.DOCUSEAL_COMPOSE_DIR || `${process.env.HOME || '/home/perchito'}/docuseal`,
});
export const docusealConfigured = () => !!(cfg().key && cfg().secret);
const TOLERANCE_S = 5 * 60;

/** Same algorithm as DocuSeal's WebhookUrls::Signatures.verify. Returns true or a reason string. */
export function verifySignature(secret, rawBody, header, now = Math.floor(Date.now() / 1000)) {
  if (!secret) return 'webhook secret not configured';
  const [tsStr, sig] = String(header || '').split(/\.(.*)/s);
  const ts = /^\d+$/.test(tsStr || '') ? Number(tsStr) : NaN;
  if (!Number.isFinite(ts) || !sig) return 'malformed signature header';
  if (ts < now - TOLERANCE_S) return 'timestamp too old';
  if (ts > now + TOLERANCE_S) return 'timestamp in the future';
  const expected = createHmac('sha256', secret).update(`${ts}.`).update(rawBody).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b) ? true : 'signature mismatch';
}

async function api(method, path, body) {
  const { url, key } = cfg();
  if (!key) throw httpError(503, 'DocuSeal isn’t connected yet (DOCUSEAL_API_KEY missing on the server).');
  const r = await fetch(`${url}/api${path}`, { method, headers: { 'X-Auth-Token': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  if (!r.ok) throw httpError(502, `DocuSeal ${method} ${path.split('?')[0]} failed (${r.status}): ${String(json.error || json.raw || '').slice(0, 200)}`);
  return json;
}

const run = (args, input) => new Promise((resolve, reject) => {
  const p = execFile('docker', ['compose', ...args], { cwd: cfg().composeDir, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
    (err ? reject(new Error(`${err.message}\n${String(stderr).slice(-500)}`)) : resolve(stdout)));
  if (input != null) { p.stdin.end(input); }
});

const RUBY = (path, name, ext) => `
require 'json'
path = ${JSON.stringify(path)}
begin
  user = User.active.where(role: 'admin').order(:id).first || User.active.order(:id).first
  template = Template.new(account: user.account, author: user, name: ${JSON.stringify(name)}, external_id: ${JSON.stringify(ext)}, source: :api)
  template.folder = TemplateFolders.find_or_create_by_name(user, 'FC CRM contracts')
  template.save!
  file = ActionDispatch::Http::UploadedFile.new(tempfile: File.open(path, 'rb'), filename: ${JSON.stringify(`${name}.pdf`)}, type: 'application/pdf')
  documents, = Templates::CreateAttachments.call(template, { files: [file] }, extract_fields: false)
  template.update!(schema: documents.map { |d| { 'attachment_uuid' => d.uuid, 'name' => d.filename.base } })
  puts 'FCCRM_RESULT ' + { id: template.id, attachment_uuid: documents.first.uuid }.to_json
ensure
  File.delete(path) if File.exist?(path)
end
`;

/** Uploads a PDF as a new DocuSeal template. Returns { id, attachment_uuid }. */
export async function createTemplateFromPdf(pdf, name, externalId) {
  // DocuSeal Pro / cloud have this as an API call; DOCUSEAL_UPLOAD=api uses it (and the test mock does)
  if (process.env.DOCUSEAL_UPLOAD === 'api') {
    const t = await api('POST', '/templates/pdf', { name, external_id: externalId, documents: [{ name, file: pdf.toString('base64') }] });
    return { id: t.id, attachment_uuid: t.documents?.[0]?.uuid || t.schema?.[0]?.attachment_uuid };
  }
  const path = `/tmp/fc-crm-${randomUUID()}.pdf`;
  await run(['exec', '-T', 'docuseal', 'sh', '-c', `umask 077; cat > ${path}`], pdf);
  const out = await run(['exec', '-T', '-w', '/app', 'docuseal', './bin/rails', 'runner', '-'], RUBY(path, name, externalId));
  const line = out.split('\n').find((l) => l.startsWith('FCCRM_RESULT '));
  if (!line) throw new Error(`DocuSeal template upload gave no result: ${out.slice(-300)}`);
  return JSON.parse(line.slice('FCCRM_RESULT '.length));
}

const ROLE_FC = 'FC Cleaning', ROLE_CLIENT = 'Client';

/** Builds template submitters + fields from the positions the PDF renderer recorded. */
export function templateLayout(fields, attachmentUuid) {
  const roles = { [ROLE_FC]: randomUUID(), [ROLE_CLIENT]: randomUUID() };
  return {
    submitters: [{ name: ROLE_FC, uuid: roles[ROLE_FC] }, { name: ROLE_CLIENT, uuid: roles[ROLE_CLIENT] }],
    fields: fields.map((f) => ({
      uuid: randomUUID(), submitter_uuid: roles[f.role], name: f.name, type: f.type, required: true,
      ...(f.type === 'date' ? { preferences: { format: 'DD/MM/YYYY' } } : {}),
      areas: [{ x: f.x, y: f.y, w: f.w, h: f.h, page: f.page, attachment_uuid: attachmentUuid }],
    })),
  };
}

/** Status of a DocuSeal submission, worked out from the submitters (not from a webhook). */
export function submissionState(sub) {
  const ss = sub.submitters || [];
  const signers = ss.map((s) => ({ id: s.id, role: s.role, name: s.name, email: s.email, status: s.status, slug: s.slug, completed_at: s.completed_at, declined_at: s.declined_at }));
  let status;
  if (sub.archived_at) status = 'cancelled';
  else if (ss.some((s) => s.status === 'declined' || s.declined_at)) status = 'declined';
  else if (ss.length && ss.every((s) => s.status === 'completed' || s.completed_at)) status = 'completed';
  else if (sub.status === 'expired' || (sub.expire_at && new Date(sub.expire_at) < new Date())) status = 'expired';
  else if (ss.some((s) => s.status === 'completed' || s.completed_at)) status = 'partially_signed';
  else status = 'sent';
  return { status, signers };
}

async function download(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`download failed (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

/**
 * Re-reads a submission from DocuSeal and applies it to the signature request and its
 * contract. Safe to call any number of times (webhook, retries, the hourly reconcile).
 */
export async function syncSubmission(pool, submissionId, { fetchSubmission = (id) => api('GET', `/submissions/${id}`), fetchFile = download } = {}) {
  const sub = await fetchSubmission(submissionId);
  const { status, signers } = submissionState(sub);
  // fetch files outside the transaction (slow), only when they'll be needed
  const { rows: [pre] } = await pool.query(`select * from signature_requests where docuseal_submission_id = $1`, [submissionId]);
  if (!pre) return { ignored: 'unknown submission' };
  let signedPdf = null, auditPdf = null;
  if (status === 'completed' && !pre.signed_document_id) {
    const docUrl = sub.combined_document_url || sub.documents?.[0]?.url;
    if (!docUrl) throw new Error('completed submission has no document URL yet');
    signedPdf = await fetchFile(docUrl);
    if (signedPdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('signed document is not a PDF');
    if (sub.audit_log_url) auditPdf = await fetchFile(sub.audit_log_url).catch(() => null);
  }
  const result = await tx(pool, async (db) => {
    const { rows: [req] } = await db.query(`select * from signature_requests where id = $1 for update`, [pre.id]);
    const { rows: [k] } = await db.query(`select * from contracts where id = $1 for update`, [req.contract_id]);
    const final = ['completed', 'declined', 'cancelled', 'expired', 'failed'];
    if (final.includes(req.status) && req.status !== status) return { unchanged: req.status }; // terminal states never move back
    let signedId = req.signed_document_id, auditId = req.audit_document_id;
    if (status === 'completed' && !signedId) {
      const d = await saveDocument(db, { buffer: signedPdf, mime: 'application/pdf', filename: `${k.number}-v${req.contract_version}-signed.pdf`,
        title: `Signed agreement ${k.number} v${req.contract_version}`, kind: 'signed_pdf', contact_id: k.contact_id, contract_id: k.id });
      signedId = d.id;
      if (auditPdf?.subarray(0, 5).toString('latin1') === '%PDF-') {
        auditId = (await saveDocument(db, { buffer: auditPdf, mime: 'application/pdf', filename: `${k.number}-v${req.contract_version}-audit-trail.pdf`,
          title: `Signing audit trail ${k.number}`, kind: 'audit_trail', contact_id: k.contact_id, contract_id: k.id })).id;
      }
    }
    if (req.status === status && signedId === req.signed_document_id) {
      await db.query(`update signature_requests set signers = $2, updated_at = now() where id = $1`, [req.id, JSON.stringify(signers)]);
      return { unchanged: status };
    }
    await db.query(`update signature_requests set status = $2, signers = $3, signed_document_id = $4, audit_document_id = $5, updated_at = now(),
      completed_at = case when $2 = 'completed' then coalesce(completed_at, now()) else completed_at end where id = $1`, [req.id, status, JSON.stringify(signers), signedId, auditId]);
    const live = ['sent', 'partially_signed'].includes(k.status);
    let to = null;
    if (status === 'partially_signed' && k.status === 'sent') to = 'partially_signed';
    if (status === 'completed' && live) to = 'signed';
    if (status === 'declined' && live) to = 'declined';
    if (['expired', 'cancelled'].includes(status) && live) to = 'ready'; // can be sent again
    if (to) {
      await db.query(`update contracts set status = $2, updated_at = now() ${to === 'signed' ? ', signed_at = now(), signed_document_id = $3' : ''} where id = $1`,
        to === 'signed' ? [k.id, to, signedId] : [k.id, to]);
      const who = signers.filter((s) => s.completed_at).map((s) => s.name || s.email).join(', ');
      await logEvent(db, k.contact_id, 'contract', `Contract ${k.number}: ${{ partially_signed: `signed by ${who}`, signed: 'fully signed — signed PDF saved', declined: 'signature declined', ready: `signature request ${status}` }[to]}`,
        { contract_id: k.id, signature_request_id: req.id, to });
    }
    await audit(db, null, 'signature_status', 'contract', k.id, { submission: submissionId, from: req.status, to: status });
    return { status, contract_status: to || k.status, contract_id: k.id };
  });
  if (result.contract_status === 'signed' && !result.unchanged) runAutomation(pool, 'contract_signed', { contract_id: result.contract_id }).catch((e) => console.error('[automation]', e));
  return result;
}

export function docusealRoutes(app, pool) {
  /** Sends the contract's current version for signature. Double clicks hit the "one live request" index. */
  app.post('/api/contracts/:id/signature', requireRole('manager'), async (req, res) => {
    if (!docusealConfigured()) throw httpError(503, 'DocuSeal isn’t connected yet — see Settings → Integrations.');
    const company = await getCompany(pool);
    // 1. issue the version + reserve the request (fast, transactional)
    const { k, v, request } = await tx(pool, async (db) => {
      const { rows: [k] } = await db.query(`select * from contracts where id = $1 for update`, [req.params.id]);
      if (!k) throw httpError(404, 'Contract not found');
      if (k.status !== 'ready') throw httpError(409, k.status === 'sent' || k.status === 'partially_signed' ? 'It’s already out for signature.' : 'Mark the contract “ready to sign” first.');
      // a request stuck in "creating" (server died mid-send) is released after 10 minutes
      await db.query(`update signature_requests set status = 'failed', error = 'interrupted', updated_at = now() where contract_id = $1 and status = 'creating' and created_at < now() - interval '10 minutes'`, [k.id]);
      const v = await issueContract(db, k, req);
      const s = v.snapshot;
      const problems = contractProblems(s);
      if (problems.length) throw httpError(422, 'Sort these out first:', { problems });
      const signers = [{ role: ROLE_FC, name: company.signatory_name, email: company.signatory_email }, { role: ROLE_CLIENT, name: s.signer.name, email: s.signer.email }];
      if (company.sign_order === 'client_first') signers.reverse();
      let request;
      try {
        ({ rows: [request] } = await db.query(`insert into signature_requests (contract_id, contract_version, idempotency_key, signers, created_by) values ($1,$2,$3,$4,$5) returning *`,
          [k.id, v.version, `${k.id}:v${v.version}:${randomUUID()}`, JSON.stringify(signers), req.user.id]));
      } catch (e) {
        if (e.code === '23505') throw httpError(409, 'A signature request for this contract is already in progress.');
        throw e;
      }
      return { k, v, request };
    });
    // 2. talk to DocuSeal; on any failure the request is marked failed and the contract stays "ready"
    let templateId = null;
    try {
      const { rows: [d] } = await pool.query(`select * from documents where id = $1`, [v.document_id]);
      const pdf = await readDocument(d);
      const tpl = await createTemplateFromPdf(pdf, `${k.number} v${v.version} — ${v.snapshot.customer.business}`, `fc-crm:${k.id}:v${v.version}`);
      templateId = tpl.id;
      await pool.query(`update signature_requests set docuseal_template_id = $2 where id = $1`, [request.id, templateId]);
      await api('PUT', `/templates/${templateId}`, templateLayout(v.snapshot.signature_fields, tpl.attachment_uuid));
      const s = v.snapshot;
      const subs = request.signers.map((x) => ({ role: x.role, name: x.name, email: x.email, external_id: `fc-crm:${k.id}`,
        ...(x.role === ROLE_CLIENT ? { values: { 'Client Name': s.signer.name, ...(s.signer.job_title ? { 'Client Position': s.signer.job_title } : {}) } } : {}) }));
      const created = await api('POST', '/submissions', {
        template_id: templateId, send_email: true, order: company.sign_order === 'together' ? 'random' : 'preserved', submitters: subs,
        message: { subject: `Please sign: ${s.company.name} service agreement ${k.number}`,
          body: `Hello {{submitter.name}},\n\nPlease review and sign the service agreement ${k.number} for ${s.customer.business}.\n\n{{submitter.link}}\n\nThank you,\n${s.company.signatory_name}\n${s.company.name}` },
      });
      const arr = Array.isArray(created) ? created : created.submitters || [];
      const submissionId = arr[0]?.submission_id || created.id;
      if (!submissionId) throw new Error('DocuSeal did not return a submission id');
      const signers = arr.map((x) => ({ id: x.id, role: x.role, name: x.name, email: x.email, status: x.status, slug: x.slug }));
      await tx(pool, async (db) => {
        await db.query(`update signature_requests set status = 'sent', docuseal_submission_id = $2, signers = $3, updated_at = now() where id = $1`, [request.id, submissionId, JSON.stringify(signers)]);
        await db.query(`update contracts set status = 'sent', updated_at = now() where id = $1`, [k.id]);
        await logEvent(db, k.contact_id, 'contract', `Contract ${k.number} v${v.version} sent for signature (${signers.map((x) => `${x.role}: ${x.email}`).join(', ')})`, { contract_id: k.id, signature_request_id: request.id });
        await audit(db, req, 'signature_requested', 'contract', k.id, { submission: submissionId, template: templateId, version: v.version });
      });
      runAutomation(pool, 'contract_sent', { contract_id: k.id }).catch((e) => console.error('[automation]', e));
      res.json({ ok: true, submission_id: submissionId });
    } catch (e) {
      console.error('[docuseal] send failed:', e);
      await pool.query(`update signature_requests set status = 'failed', error = $2, updated_at = now() where id = $1`, [request.id, String(e.message).slice(0, 500)]);
      await audit(pool, req, 'signature_request_failed', 'contract', k.id, { error: String(e.message).slice(0, 300) });
      if (templateId) api('PUT', `/templates/${templateId}`, { archived: true }).catch(() => {});
      throw httpError(502, `Couldn’t send it for signature: ${String(e.message).slice(0, 200)}. Nothing was sent; the contract is still ready to sign.`);
    }
  });

  const liveRequest = async (contractId) => {
    const { rows: [r] } = await pool.query(`select * from signature_requests where contract_id = $1 and status in ('sent','partially_signed') order by created_at desc limit 1`, [contractId]);
    if (!r) throw httpError(404, 'No signature request is in progress.');
    return r;
  };

  app.post('/api/contracts/:id/signature/refresh', requireRole('manager'), async (req, res) => {
    const { rows: [r] } = await pool.query(`select * from signature_requests where contract_id = $1 and docuseal_submission_id is not null order by created_at desc limit 1`, [req.params.id]);
    if (!r) throw httpError(404, 'No signature request yet.');
    res.json(await syncSubmission(pool, r.docuseal_submission_id));
  });

  // re-sends the invitation email to everyone who hasn't signed yet
  app.post('/api/contracts/:id/signature/resend', requireRole('manager'), async (req, res) => {
    const r = await liveRequest(req.params.id);
    const sub = await api('GET', `/submissions/${r.docuseal_submission_id}`);
    const pending = (sub.submitters || []).filter((s) => !s.completed_at && !s.declined_at);
    for (const s of pending) await api('PUT', `/submitters/${s.id}`, { send_email: true });
    await audit(pool, req, 'signature_resent', 'contract', r.contract_id, { to: pending.map((s) => s.email) });
    res.json({ ok: true, resent_to: pending.map((s) => s.email) });
  });

  // cancels (archives) the DocuSeal submission; the contract goes back to "ready" so it can be fixed or resent
  app.post('/api/contracts/:id/signature/cancel', requireRole('manager'), async (req, res) => {
    const r = await liveRequest(req.params.id);
    await api('DELETE', `/submissions/${r.docuseal_submission_id}`);
    const out = await syncSubmission(pool, r.docuseal_submission_id);
    await audit(pool, req, 'signature_cancelled', 'contract', r.contract_id, { reason: str(req.body?.reason, 300) || undefined });
    res.json(out);
  });

  // signing link for a signer (e.g. so Fernando can sign straight away)
  app.get('/api/contracts/:id/signature/link', requireRole('manager'), async (req, res) => {
    const r = await liveRequest(req.params.id);
    const s = (r.signers || []).find((x) => x.role === req.query.role);
    if (!s?.slug) throw httpError(404, 'No link for that signer.');
    await audit(pool, req, 'signature_link_opened', 'contract', r.contract_id, { role: s.role });
    res.json({ url: `${cfg().url}/s/${s.slug}` });
  });

  app.get('/api/integrations', requireRole('manager'), (req, res) =>
    res.json({ docuseal: { configured: docusealConfigured(), url: cfg().url } }));
}

/** Public webhook. Must be registered BEFORE express.json() so the raw body is intact. */
export function docusealWebhook(app, pool) {
  app.post('/api/webhooks/docuseal', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const ok = verifySignature(cfg().secret, raw, req.get('x-docuseal-signature'));
    if (ok !== true) {
      console.warn(`[docuseal] webhook rejected: ${ok} from ${req.ip}`);
      await audit(pool, req, 'webhook_rejected', 'docuseal', null, { reason: ok });
      return res.status(401).json({ error: 'invalid signature' });
    }
    let body;
    try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'bad json' }); }
    const type = String(body.event_type || ''), data = body.data || {};
    const submissionId = Number(type.startsWith('submission.') ? data.id : data.submission_id || data.submission?.id) || null;
    const key = createHash('sha256').update(`${type}:${data.id}:${body.timestamp}`).digest('hex');
    const { rows: [seen] } = await pool.query(
      `insert into webhook_events (dedup_key, source, event_type, submission_id) values ($1,'docuseal',$2,$3)
       on conflict (dedup_key) do update set dedup_key = excluded.dedup_key returning processed_at, (xmax <> 0) as duplicate`, [key, type, submissionId]);
    if (seen.duplicate && seen.processed_at) return res.json({ ok: true, duplicate: true });
    if (!submissionId || !/^(form|submission)\./.test(type)) {
      await pool.query(`update webhook_events set processed_at = now(), result = 'ignored' where dedup_key = $1`, [key]);
      return res.json({ ok: true, ignored: true });
    }
    try {
      const r = await syncSubmission(pool, submissionId);
      await pool.query(`update webhook_events set processed_at = now(), result = $2 where dedup_key = $1`, [key, JSON.stringify(r).slice(0, 300)]);
      res.json({ ok: true });
    } catch (e) {
      console.error('[docuseal] webhook processing failed:', e);
      await pool.query(`update webhook_events set result = $2 where dedup_key = $1`, [key, `error: ${String(e.message).slice(0, 250)}`]);
      res.status(500).json({ error: 'processing failed, retry' }); // DocuSeal retries; the dedup row lets the retry through
    }
  });
}

/** Catches anything a missed webhook would have told us. */
export async function reconcileSignatures(pool) {
  if (!docusealConfigured()) return;
  const { rows } = await pool.query(`select docuseal_submission_id from signature_requests where status in ('sent','partially_signed') and docuseal_submission_id is not null`);
  for (const r of rows) await syncSubmission(pool, r.docuseal_submission_id).catch((e) => console.error(`[docuseal] reconcile ${r.docuseal_submission_id}:`, e.message));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  const secret = 'whsec_test', body = Buffer.from('{"event_type":"form.completed","data":{"id":1}}'), ts = 1_760_000_000;
  const good = `${ts}.${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
  assert.equal(verifySignature(secret, body, good, ts), true);
  assert.equal(verifySignature(secret, Buffer.from(`${body} `), good, ts), 'signature mismatch');
  assert.equal(verifySignature('other', body, good, ts), 'signature mismatch');
  assert.equal(verifySignature(secret, body, good, ts + 301), 'timestamp too old');
  assert.equal(verifySignature(secret, body, good, ts - 301), 'timestamp in the future');
  assert.equal(verifySignature(secret, body, 'garbage', ts), 'malformed signature header');
  assert.equal(verifySignature(undefined, body, good, ts), 'webhook secret not configured');
  const st = (ss, extra = {}) => submissionState({ submitters: ss, ...extra }).status;
  assert.equal(st([{ status: 'sent' }, { status: 'awaiting' }]), 'sent');
  assert.equal(st([{ status: 'completed', completed_at: 'x' }, { status: 'sent' }]), 'partially_signed');
  assert.equal(st([{ status: 'completed', completed_at: 'x' }, { status: 'completed', completed_at: 'y' }]), 'completed');
  assert.equal(st([{ status: 'completed' }, { status: 'declined' }]), 'declined');
  assert.equal(st([{ status: 'sent' }], { archived_at: 'x' }), 'cancelled');
  assert.equal(st([{ status: 'sent' }], { expire_at: '2000-01-01' }), 'expired');
  const lay = templateLayout([{ role: 'Client', type: 'signature', name: 'Client Signature', page: 3, x: 0.2, y: 0.3, w: 0.3, h: 0.05 }], 'att');
  assert.equal(lay.fields[0].submitter_uuid, lay.submitters[1].uuid);
  assert.equal(lay.fields[0].areas[0].attachment_uuid, 'att');
  console.log('docuseal ok');
}
