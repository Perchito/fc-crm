// Small shared helpers for the business modules.
import pg from 'pg';

// DATE columns come back as 'YYYY-MM-DD' strings: pg's default (local-midnight Date) shifts
// a day when converted to UTC during British Summer Time.
pg.types.setTypeParser(1082, (v) => v);

/** Error with an HTTP status; the error handler shows its message to the user. */
export const httpError = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });

/**
 * Express 4 doesn't catch rejected promises from async handlers (Node then crashes the
 * process). Wrap every route registered on the app so errors reach the error handler.
 */
export function asyncSafe(app) {
  for (const m of ['get', 'post', 'put', 'patch', 'delete', 'use', 'all']) {
    const orig = app[m].bind(app);
    app[m] = (...args) => orig(...args.map((a) => (typeof a === 'function' && a.length < 4
      ? (req, res, next) => { try { const r = a(req, res, next); if (r?.catch) r.catch(next); } catch (e) { next(e); } }
      : a)));
  }
}

/** Last middleware: JSON errors, no stack traces or SQL leaked to the browser. */
export function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (res.headersSent) return;
  let status = err.status || err.statusCode || 500, message = err.expose || status < 500 ? err.message : 'Something went wrong — it has been logged.';
  if (err.name === 'PricingError') { status = 400; message = err.message; }
  if (err.code === '22P02') { status = 404; message = 'Not found'; }          // malformed uuid in the URL
  if (err.code === '23503' && status === 500) { status = 409; message = 'That record is linked to other records and can’t be changed this way.'; }
  if (status >= 500 && !err.expose) console.error(`[error] ${req.method} ${req.path}:`, err);
  res.status(status).json({ error: message, ...(err.problems ? { problems: err.problems } : {}) });
}

/** Customer timeline entry (the existing events table). */
export const logEvent = (db, contactId, type, body, meta = {}) =>
  db.query(`insert into events (contact_id, type, body, meta) values ($1,$2,$3,$4)`, [contactId, type, body, meta]);

/** "Half Dozen Other Bakery Ltd" → "HDO" (first letters of the first three real words). */
export function initials(name) {
  const skip = new Set(['the', 'and', 'of', 'ltd', 'limited', 'llp', 'plc', 'co', '&']);
  const words = String(name || '').replace(/[^A-Za-z0-9 &]/g, ' ').split(/\s+/).filter((w) => w && !skip.has(w.toLowerCase()));
  const s = words.slice(0, 3).map((w) => w[0].toUpperCase()).join('');
  return s.length >= 2 ? s : (words[0] || 'CUS').slice(0, 3).toUpperCase().padEnd(3, 'X');
}

/** Next free reference like FCC-HDO-002 (unique index is the real guard; caller retries). */
export async function nextNumber(db, table, prefix) {
  const { rows } = await db.query(`select number from ${table} where number like $1`, [`${prefix}-%`]);
  const max = rows.reduce((m, r) => Math.max(m, Number(r.number.slice(prefix.length + 1)) || 0), 0);
  return `${prefix}-${String(max + 1).padStart(3, '0')}`;
}

/** Runs fn(client) in a transaction. */
export async function tx(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const r = await fn(client);
    await client.query('commit');
    return r;
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
export const addDaysIso = (d, n) => { const x = new Date(`${String(d).slice(0, 10)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const addMonthsIso = (d, n) => {
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + n, 1, 12)), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
  t.setUTCDate(Math.min(day, last)); // 31 Jan + 1 month = 28/29 Feb, not 3 Mar
  return t.toISOString().slice(0, 10);
};
export const todayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
export const str = (v, n = 500) => String(v ?? '').trim().slice(0, n);
export const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || ''));

// Manchester = Fernando, London = Luis. The browser sends the area being viewed as X-FC-Area
// or ?area= on plain links (none = all); everything that isn't a customer, campaign or block follows its customer.
export const AREAS = ['manchester', 'london'];
export const areaOf = (req) => { const a = req.get?.('X-FC-Area') || req.query?.area; return AREAS.includes(a) ? a : null; };
/** SQL condition: `col` (a contact id) belongs to the area. Safe to inline — area is one of AREAS or nothing. */
export const inArea = (area, col) => (AREAS.includes(area) ? `${col} in (select id from contacts where area = '${area}')` : 'true');

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  assert.equal(initials('Half Dozen Other Bakery Ltd'), 'HDO');
  assert.equal(initials('The Moonbeam Coffee House'), 'MCH');
  assert.equal(initials('Zed'), 'ZED');
  assert.equal(initials(''), 'CUS');
  assert.equal(addMonthsIso('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsIso('2026-11-15', 3), '2027-02-15');
  assert.equal(addDaysIso('2026-10-11', 30), '2026-11-10');
  assert.equal(inArea("london'; drop table x;--", 'c.id'), 'true');
  assert.equal(inArea('london', 'c.id'), "c.id in (select id from contacts where area = 'london')");
  console.log('biz ok');
}
