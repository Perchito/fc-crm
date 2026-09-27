-- fc-crm — Postgres schema. Self-hosted on perchito (see homeserver install.sh
-- for the pattern this follows). Idempotent: IF NOT EXISTS everywhere.

create extension if not exists pgcrypto;

create table if not exists contacts (
  id             uuid primary key default gen_random_uuid(),
  business       text,
  contact_name   text,
  email          text,
  phone          text,
  address        text,
  website        text,
  source         text,
  tags           text[] not null default '{}',
  notes          text not null default '',
  pipeline_stage text not null default 'new',  -- new|contacted|quoted|won|lost
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index if not exists contacts_stage_idx on contacts (pipeline_stage);

create table if not exists tasks (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  title      text not null,
  due_at     timestamptz,
  done       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists tasks_contact_idx on tasks (contact_id, done, due_at);

-- one row per timeline event (stage change, note, call, email, sms, task done...)
create table if not exists events (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  type       text not null,
  body       text,
  meta       jsonb not null default '{}',
  at         timestamptz not null default now()
);
create index if not exists events_contact_idx on events (contact_id, at desc);

create table if not exists meta (k text primary key, v jsonb not null);
