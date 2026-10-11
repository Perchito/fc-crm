// Demo data for visual checks. Refuses to touch anything but a *_test database or a crm_* schema.
//   DATABASE_URL=<test db with search_path=crm_ui> node scripts/seed-demo.mjs
import pg from 'pg';
import { hashPassword } from '../lib/auth.mjs';
const url = process.env.DATABASE_URL || '';
if (!/_test(\?|$)/.test(url.split('?')[0] + '?') && !/search_path%3Dcrm_/.test(url)) throw new Error('refusing: not a test database');
const db = new pg.Client({ connectionString: url });
await db.connect();
await db.query(`insert into users (email, name, role, pass_hash) values ('demo.admin@example.com','Demo Admin','admin',$1) on conflict do nothing`, [hashPassword('demo-pass-123')]);
const biz = [['Half Dozen Other Bakery Ltd', 'Frankie Baird', 'quoted', 'Bakery'], ['Moonbeam Coffee House', 'Sam Lee', 'visit_booked', 'Café'], ['The Crown & Anchor', 'Pat Jones', 'contacted', 'Pub'], ['Northern Quarter Tacos', 'Ana Ruiz', 'new', 'Restaurant'], ['Ancoats Office Hub', 'Chris Hall', 'won', 'Office'], ['Peel Street Diner', 'Lou Grant', 'lost', 'Restaurant']];
for (const [i, [b, n, st, pt]] of biz.entries()) {
  const { rows: [c] } = await db.query(`insert into contacts (business, contact_name, email, phone, address, pipeline_stage, premises_type, source) values ($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing returning id`,
    [b, n, `${n.split(' ')[0].toLowerCase()}@example.com`, `0161 000 00${10 + i}`, `${10 + i} Example St, Manchester M4 ${i}AB`, st, pt, i % 2 ? 'ai-discovery' : 'referral']);
  if (!c) continue;
  await db.query(`insert into contact_people (contact_id, name, job_title, email, is_primary, is_signer) values ($1,$2,'Manager',$3,true,true)`, [c.id, n, `${n.split(' ')[0].toLowerCase()}@example.com`]);
  await db.query(`insert into sites (contact_id, name, address) values ($1,'Main site',$2)`, [c.id, `${10 + i} Example St, Manchester M4 ${i}AB`]);
  await db.query(`insert into tasks (contact_id, title, due_at) values ($1,$2, now() + ($3 || ' days')::interval)`, [c.id, `Call ${n.split(' ')[0]} about the quote`, i - 2]);
  await db.query(`insert into events (contact_id, type, body) values ($1,'stage_change',$2)`, [c.id, st]);
}
await db.end();
console.log('demo seeded: demo.admin@example.com / demo-pass-123');
