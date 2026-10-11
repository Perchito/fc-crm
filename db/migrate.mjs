// Applies db/schema.sql (idempotent baseline), then every db/migrations/NNN_*.sql
// not yet recorded in schema_migrations, each in its own transaction.
//   node db/migrate.mjs            apply pending
//   node db/migrate.mjs --status   list applied / pending
// Rollback notes live at the bottom of each migration file (-- ROLLBACK: ...).
import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';

export async function migrate(databaseUrl, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8'));
    await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    const files = (await readdir(new URL('./migrations/', import.meta.url))).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
    if (process.argv.includes('--status')) {
      for (const f of files) log(`${done.has(f) ? 'applied' : 'PENDING'}  ${f}`);
      return;
    }
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = await readFile(new URL(`./migrations/${f}`, import.meta.url), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
        log(`applied ${f}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`${f}: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  await migrate(process.env.DATABASE_URL);
}
