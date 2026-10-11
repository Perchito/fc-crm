// Creates a CRM login and prints a one-time password.
//   node scripts/create-user.mjs <email> "<name>" [admin|manager|staff]
// Refuses to touch an existing user (use Settings → Users → Reset password instead).
import pg from 'pg';
import { hashPassword, newPassword, ROLES } from '../lib/auth.mjs';
const [email, name, role = 'staff'] = process.argv.slice(2);
if (!email || !name || !ROLES.includes(role)) { console.error('usage: create-user.mjs <email> "<name>" [admin|manager|staff]'); process.exit(1); }
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
await db.connect();
const pass = newPassword();
const { rowCount } = await db.query(`insert into users (email, name, role, pass_hash) values (lower($1),$2,$3,$4) on conflict do nothing`, [email, name, role, hashPassword(pass)]);
await db.end();
if (!rowCount) { console.error(`${email} already exists — not changed`); process.exit(1); }
console.log(`created ${role} ${email}  password: ${pass}`);
