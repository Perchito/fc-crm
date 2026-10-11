// Logins, sessions, roles, CSRF guard, rate limits and the audit log.
// Password hashing is the same scrypt scheme as FC Inspect / Staff Hub.
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export const COOKIE = 'fccrm_session';
const SESSION_DAYS = 14;

export function hashPassword(pass) {
  const salt = randomBytes(16);
  return `${salt.toString('hex')}:${scryptSync(String(pass), salt, 64).toString('hex')}`;
}
export function verifyPassword(pass, stored) {
  const [salt, hash] = String(stored || '').split(':');
  const want = Buffer.from(hash || '', 'hex');
  if (!salt || want.length !== 64) return false;
  return timingSafeEqual(want, scryptSync(String(pass), Buffer.from(salt, 'hex'), 64));
}
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (t) => createHash('sha256').update(String(t)).digest('hex');
export const newPassword = () => randomBytes(12).toString('base64url');

export function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) { try { return decodeURIComponent(v.join('=')); } catch { return null; } }
  }
  return null;
}

// ── roles ────────────────────────────────────────────────────────────────────
// staff:   customers, tasks, visits, notes, draft proposals, proposal PDFs
// manager: + issue/send/accept proposals, contracts, e-signature, all documents, exports, library
// admin:   + users, company settings, automations, audit log, permanent deletes
export const ROLES = ['staff', 'manager', 'admin'];
const RANK = { staff: 1, manager: 2, admin: 3 };
export const atLeast = (user, role) => !!user && RANK[user.role] >= RANK[role];
export const requireRole = (role) => (req, res, next) =>
  atLeast(req.user, role) ? next() : res.status(403).json({ error: `Only ${role === 'admin' ? 'an administrator' : 'a manager or administrator'} can do that.` });

// ── rate limiting (in memory: one process, a handful of users) ──────────────────
export function limiter({ windowMs, max, key = (req) => req.ip, message = 'Too many requests — please wait a minute and try again.' }) {
  const hits = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.since > windowMs) hits.delete(k); }, windowMs).unref();
  return (req, res, next) => {
    const k = key(req), now = Date.now();
    let h = hits.get(k);
    if (!h || now - h.since > windowMs) hits.set(k, (h = { since: now, n: 0 }));
    if (++h.n > max) { res.set('Retry-After', String(Math.ceil((h.since + windowMs - now) / 1000))); return res.status(429).json({ error: message }); }
    next();
  };
}

// failed logins: 8 misses per IP or per email per 15 minutes
const fails = new Map();
const FAIL_WINDOW = 15 * 60_000, MAX_FAILS = 8;
const failCount = (k) => { const f = fails.get(k); if (f && Date.now() - f.since > FAIL_WINDOW) { fails.delete(k); return 0; } return f?.n || 0; };
const failed = (k) => { const f = fails.get(k) || { n: 0, since: Date.now() }; f.n++; fails.set(k, f); };

export async function audit(db, req, action, entity = null, entityId = null, detail = {}) {
  await db.query(`insert into audit_log (user_id, action, entity, entity_id, detail, ip) values ($1,$2,$3,$4,$5,$6)`,
    [req?.user?.id || null, action, entity, entityId == null ? null : String(entityId), detail, req?.ip || null]);
}

const isHttps = (req) => req.secure || req.get('x-forwarded-proto') === 'https';
function setSessionCookie(req, res, token, maxAgeSec) {
  res.append('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${isHttps(req) ? '; Secure' : ''}`);
}

/**
 * Registers /api/login, /api/logout, /api/me, /api/me/password and returns the gate
 * middleware: every request after it needs a valid session. State-changing API calls
 * must also carry the X-FC-CSRF header — browsers can't add a custom header to a
 * cross-site request without a CORS preflight, which this server never allows.
 */
export function mountAuth(app, pool) {
  const csrf = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-fc-csrf') === '1') return next();
    res.status(403).json({ error: 'Missing CSRF header' });
  };

  app.post('/api/login', csrf, limiter({ windowMs: 60_000, max: 20 }), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 200), pass = String(req.body?.password || '').slice(0, 500);
    if (failCount(`ip:${req.ip}`) >= MAX_FAILS || failCount(`em:${email}`) >= MAX_FAILS) {
      return res.status(429).json({ error: 'Too many wrong passwords. Wait 15 minutes and try again.' });
    }
    const { rows: [u] } = await pool.query(`select * from users where lower(email) = $1 and active`, [email]);
    if (!u || !verifyPassword(pass, u.pass_hash)) {
      failed(`ip:${req.ip}`); failed(`em:${email}`);
      await audit(pool, req, 'login_failed', 'user', u?.id || null, { email });
      return res.status(401).json({ error: 'Wrong email or password.' });
    }
    fails.delete(`em:${email}`);
    const token = newToken();
    await pool.query(`insert into sessions (token_hash, user_id, expires_at, ip, user_agent) values ($1,$2, now() + interval '${SESSION_DAYS} days', $3, $4)`,
      [tokenHash(token), u.id, req.ip, String(req.get('user-agent') || '').slice(0, 300)]);
    await pool.query(`update users set last_login_at = now() where id = $1`, [u.id]);
    await pool.query(`delete from sessions where expires_at < now()`);
    req.user = u;
    await audit(pool, req, 'login', 'user', u.id);
    setSessionCookie(req, res, token, SESSION_DAYS * 86400);
    res.json({ id: u.id, name: u.name, email: u.email, role: u.role });
  });

  // session lookup for everything below
  const gate = async (req, res, next) => {
    const token = readCookie(req, COOKIE);
    if (token) {
      const { rows: [u] } = await pool.query(
        `select u.id, u.email, u.name, u.role, s.token_hash, s.expires_at from sessions s join users u on u.id = s.user_id
         where s.token_hash = $1 and s.expires_at > now() and u.active`, [tokenHash(token)]);
      if (u) {
        req.user = u;
        // sliding expiry, refreshed at most once a day
        if (new Date(u.expires_at) - Date.now() < (SESSION_DAYS - 1) * 86400_000) {
          await pool.query(`update sessions set expires_at = now() + interval '${SESSION_DAYS} days' where token_hash = $1`, [u.token_hash]);
          setSessionCookie(req, res, token, SESSION_DAYS * 86400);
        }
        return csrf(req, res, next);
      }
    }
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please sign in again.' });
    if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) return res.redirect('/login');
    return res.status(401).send('Sign in required');
  };

  app.post('/api/logout', csrf, async (req, res) => {
    const token = readCookie(req, COOKIE);
    if (token) await pool.query(`delete from sessions where token_hash = $1`, [tokenHash(token)]);
    setSessionCookie(req, res, '', 0);
    res.json({ ok: true });
  });

  return {
    gate,
    routes() {
      app.get('/api/me', (req, res) => res.json({ id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }));
      app.post('/api/me/password', limiter({ windowMs: 15 * 60_000, max: 10, key: (r) => r.user.id }), async (req, res) => {
        const { current, next: np } = req.body || {};
        const { rows: [u] } = await pool.query(`select * from users where id = $1`, [req.user.id]);
        if (!verifyPassword(String(current || ''), u.pass_hash)) return res.status(400).json({ error: 'Your current password is wrong.' });
        if (String(np || '').length < 10) return res.status(400).json({ error: 'Use at least 10 characters.' });
        await pool.query(`update users set pass_hash = $2 where id = $1`, [u.id, hashPassword(np)]);
        // sign out every other device
        await pool.query(`delete from sessions where user_id = $1 and token_hash <> $2`, [u.id, req.user.token_hash]);
        await audit(pool, req, 'password_changed', 'user', u.id);
        res.json({ ok: true });
      });

      // ── user management (admin) ──
      app.get('/api/users', async (req, res) => {
        const { rows } = await pool.query(`select id, email, name, role, active, created_at, last_login_at from users order by active desc, name`);
        res.json(atLeast(req.user, 'admin') ? rows : rows.filter((u) => u.active).map(({ id, name, role }) => ({ id, name, role })));
      });
      app.post('/api/users', requireRole('admin'), async (req, res) => {
        const email = String(req.body?.email || '').trim().toLowerCase(), name = String(req.body?.name || '').trim().slice(0, 120);
        const role = ROLES.includes(req.body?.role) ? req.body.role : 'staff';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) return res.status(400).json({ error: 'Name and a valid email are required.' });
        const password = newPassword();
        try {
          const { rows: [u] } = await pool.query(`insert into users (email, name, role, pass_hash) values ($1,$2,$3,$4) returning id, email, name, role, active`,
            [email, name, role, hashPassword(password)]);
          await audit(pool, req, 'user_created', 'user', u.id, { email, role });
          res.status(201).json({ ...u, password }); // shown once, to the admin who created it
        } catch (e) {
          if (e.code === '23505') return res.status(409).json({ error: 'A user with that email already exists.' });
          throw e;
        }
      });
      app.patch('/api/users/:id', requireRole('admin'), async (req, res) => {
        const { rows: [u] } = await pool.query(`select * from users where id = $1`, [req.params.id]);
        if (!u) return res.status(404).json({ error: 'Not found' });
        const role = req.body.role !== undefined ? (ROLES.includes(req.body.role) ? req.body.role : null) : u.role;
        const active = req.body.active !== undefined ? !!req.body.active : u.active;
        if (!role) return res.status(400).json({ error: 'Unknown role' });
        // never leave the system without an active admin (and never lock yourself out)
        if (u.id === req.user.id && (role !== 'admin' || !active)) return res.status(400).json({ error: 'You can’t remove your own admin access.' });
        const { rows: [updated] } = await pool.query(`update users set role = $2, active = $3, name = coalesce(nullif($4,''), name) where id = $1 returning id, email, name, role, active`,
          [u.id, role, active, String(req.body.name || '').trim().slice(0, 120)]);
        if (!active) await pool.query(`delete from sessions where user_id = $1`, [u.id]);
        let password;
        if (req.body.reset_password) {
          password = newPassword();
          await pool.query(`update users set pass_hash = $2 where id = $1`, [u.id, hashPassword(password)]);
          await pool.query(`delete from sessions where user_id = $1`, [u.id]);
        }
        await audit(pool, req, 'user_updated', 'user', u.id, { role, active, reset_password: !!password });
        res.json({ ...updated, ...(password ? { password } : {}) });
      });
      app.get('/api/audit', requireRole('admin'), async (req, res) => {
        const limit = Math.min(500, Number(req.query.limit) || 200);
        const params = [limit], where = [];
        if (req.query.entity) { params.push(String(req.query.entity)); where.push(`a.entity = $${params.length}`); }
        if (req.query.entity_id) { params.push(String(req.query.entity_id)); where.push(`a.entity_id = $${params.length}`); }
        const { rows } = await pool.query(`select a.*, u.name as user_name from audit_log a left join users u on u.id = a.user_id
          ${where.length ? `where ${where.join(' and ')}` : ''} order by a.at desc limit $1`, params);
        res.json(rows);
      });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const assert = (await import('node:assert')).strict;
  const h = hashPassword('correct horse');
  assert.ok(verifyPassword('correct horse', h) && !verifyPassword('nope', h) && !verifyPassword('x', 'garbage'));
  assert.equal(readCookie({ headers: { cookie: `a=1; ${COOKIE}=abc%3D` } }, COOKIE), 'abc=');
  assert.ok(atLeast({ role: 'admin' }, 'manager') && !atLeast({ role: 'staff' }, 'manager') && !atLeast(null, 'staff'));
  console.log('auth ok');
}
