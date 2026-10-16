// Document library: generated proposal/contract PDFs, signed PDFs, audit trails and uploads.
// Bytes live in private storage (lib/storage.mjs); every read goes through an authenticated,
// role-checked route here and is written to the audit log. No public URLs exist.
import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { storage } from './storage.mjs';
import { audit, atLeast, requireRole } from './auth.mjs';
import { areaOf, inArea } from './biz.mjs';

// contracts and anything signed are manager+; staff see proposals and general uploads
export const RESTRICTED_KINDS = ['contract_pdf', 'signed_pdf', 'audit_trail'];
export const canSee = (user, doc) => atLeast(user, 'manager') || !RESTRICTED_KINDS.includes(doc.kind);

const TYPES = {
  pdf: { mime: 'application/pdf', ok: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', ok: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  jpg: { mime: 'image/jpeg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  jpeg: { mime: 'image/jpeg', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  webp: { mime: 'image/webp', ok: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ok: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ok: (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) },
  txt: { mime: 'text/plain', ok: (b) => !b.includes(0) },
  csv: { mime: 'text/csv', ok: (b) => !b.includes(0) },
};
export const MAX_UPLOAD = 15 * 1024 * 1024;

/** Validates an upload by extension AND content. Returns { ext, mime } or throws. */
export function sniff(filename, buf) {
  const ext = String(filename).toLowerCase().match(/\.([a-z0-9]{2,5})$/)?.[1];
  const t = ext && TYPES[ext];
  if (!t) throw Object.assign(new Error(`Allowed file types: ${Object.keys(TYPES).join(', ')}`), { status: 400 });
  if (!buf?.length) throw Object.assign(new Error('The file is empty.'), { status: 400 });
  if (buf.length > MAX_UPLOAD) throw Object.assign(new Error('Files can be at most 15 MB.'), { status: 413 });
  if (!t.ok(buf)) throw Object.assign(new Error(`That file isn’t a real .${ext} file.`), { status: 400 });
  return { ext, mime: t.mime };
}
// display name only — never used as a path
export const safeName = (n) => String(n || 'file').normalize('NFKC').replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';

/** Stores bytes then inserts the row (use the caller's transaction client as db). */
export async function saveDocument(db, { buffer, mime, ext = 'pdf', filename, title, kind, contact_id = null, proposal_id = null, contract_id = null, user_id = null, notes = '' }) {
  const id = randomUUID();
  const key = `docs/${new Date().getUTCFullYear()}/${id}.${ext}`;
  await storage().put(key, buffer, mime);
  const { rows: [d] } = await db.query(
    `insert into documents (id, contact_id, proposal_id, contract_id, kind, title, filename, mime, size, sha256, storage_key, notes, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [id, contact_id, proposal_id, contract_id, kind, title, safeName(filename), mime, buffer.length, createHash('sha256').update(buffer).digest('hex'), key, notes, user_id]);
  return d;
}
export const readDocument = (doc) => storage().get(doc.storage_key);

export function documentRoutes(app, pool) {
  app.get('/api/documents', async (req, res) => {
    const p = [], w = ['d.deleted_at is null'];
    for (const k of ['contact_id', 'contract_id', 'proposal_id']) if (req.query[k]) { p.push(String(req.query[k])); w.push(`d.${k} = $${p.length}`); }
    if (req.query.kind) { p.push(String(req.query.kind)); w.push(`d.kind = $${p.length}`); }
    if (req.query.q) { p.push(`%${String(req.query.q).toLowerCase()}%`); w.push(`(lower(d.title) like $${p.length} or lower(d.filename) like $${p.length} or lower(c.business) like $${p.length})`); }
    if (areaOf(req)) w.push(`(d.contact_id is null or ${inArea(areaOf(req), 'd.contact_id')})`);
    if (!atLeast(req.user, 'manager')) { p.push(RESTRICTED_KINDS); w.push(`not (d.kind = any($${p.length}))`); }
    const { rows } = await pool.query(
      `select d.id, d.contact_id, d.proposal_id, d.contract_id, d.kind, d.title, d.filename, d.mime, d.size, d.created_at, d.notes,
              c.business, u.name as created_by_name
       from documents d left join contacts c on c.id = d.contact_id left join users u on u.id = d.created_by
       where ${w.join(' and ')} order by d.created_at desc limit 500`, p);
    res.json(rows);
  });

  app.get('/api/documents/:id/file', async (req, res) => {
    const { rows: [d] } = await pool.query(`select * from documents where id = $1 and deleted_at is null`, [req.params.id]).catch(() => ({ rows: [] }));
    if (!d || !canSee(req.user, d)) return res.status(404).json({ error: 'Not found' });
    const buf = await readDocument(d);
    await audit(pool, req, req.query.download ? 'document_downloaded' : 'document_viewed', 'document', d.id, { kind: d.kind });
    // only PDFs and images render inline; everything else downloads
    const inline = !req.query.download && /^(application\/pdf|image\/(png|jpeg|webp))$/.test(d.mime);
    res.set({
      'Content-Type': d.mime, 'Content-Length': buf.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName(d.filename).replace(/"/g, '')}"`,
      'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    }).send(buf);
  });

  app.post('/api/documents', express.raw({ type: () => true, limit: MAX_UPLOAD + 1024 }), async (req, res) => {
    const filename = decodeURIComponent(String(req.get('x-filename') || ''));
    const { ext, mime } = sniff(filename, Buffer.isBuffer(req.body) ? req.body : null);
    const contact_id = req.query.contact_id || null, contract_id = req.query.contract_id || null;
    if (!contact_id && !contract_id) return res.status(400).json({ error: 'Attach the file to a customer or contract.' });
    if (contract_id && !atLeast(req.user, 'manager')) return res.status(403).json({ error: 'Only managers can add files to contracts.' });
    let cid = contact_id;
    if (contract_id) {
      const { rows: [c] } = await pool.query(`select contact_id from contracts where id = $1`, [contract_id]);
      if (!c) return res.status(404).json({ error: 'Contract not found' });
      cid = c.contact_id;
    } else {
      const { rows: [c] } = await pool.query(`select id from contacts where id = $1`, [contact_id]).catch(() => ({ rows: [] }));
      if (!c) return res.status(404).json({ error: 'Customer not found' });
    }
    const d = await saveDocument(pool, { buffer: req.body, mime, ext, filename, title: String(req.query.title || filename).slice(0, 200), kind: 'upload',
      contact_id: cid, contract_id, user_id: req.user.id, notes: String(req.query.notes || '').slice(0, 1000) });
    await audit(pool, req, 'document_uploaded', 'document', d.id, { filename: d.filename, size: d.size });
    await pool.query(`insert into events (contact_id, type, body, meta) values ($1,'document',$2,$3)`, [cid, `File added: ${d.title}`, { document_id: d.id }]);
    res.status(201).json({ id: d.id, title: d.title, filename: d.filename, size: d.size, kind: d.kind });
  });

  // only uploads can be removed; issued and signed documents are permanent records
  app.delete('/api/documents/:id', requireRole('manager'), async (req, res) => {
    const { rows: [d] } = await pool.query(`update documents set deleted_at = now(), deleted_by = $2 where id = $1 and kind = 'upload' and deleted_at is null returning id, contact_id, title`, [req.params.id, req.user.id]);
    if (!d) return res.status(400).json({ error: 'Only uploaded files can be removed — issued and signed documents are kept as records.' });
    await audit(pool, req, 'document_removed', 'document', d.id, { title: d.title });
    res.status(204).end();
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  assert.equal(sniff('a.PDF', Buffer.from('%PDF-1.7 x')).mime, 'application/pdf');
  assert.throws(() => sniff('a.pdf', Buffer.from('<html>')), /real/);
  assert.throws(() => sniff('a.html', Buffer.from('<html>')), /Allowed/);
  assert.throws(() => sniff('x.txt', Buffer.from([0x61, 0x00])), /real/);
  assert.equal(safeName('../../etc/passwd'), '_.._etc_passwd');
  assert.ok(!canSee({ role: 'staff' }, { kind: 'signed_pdf' }) && canSee({ role: 'staff' }, { kind: 'proposal_pdf' }) && canSee({ role: 'manager' }, { kind: 'signed_pdf' }));
  console.log('documents ok');
}
