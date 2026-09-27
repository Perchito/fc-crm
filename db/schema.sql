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
create unique index if not exists contacts_email_idx on contacts (lower(email)) where email is not null;

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

-- ─────────────────────────────── sequences (Phase 2) ───────────────────────────────
create table if not exists campaigns (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  status        text not null default 'active',   -- active|paused
  trigger_stage text,                              -- pipeline_stage that auto-enrolls a contact; null = manual only
  daily_cap     int  not null default 50,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists campaign_steps (
  id           uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns(id) on delete cascade,
  step_index   int  not null,
  channel      text not null default 'email',      -- email|sms
  wait_days    int  not null default 0,             -- days after previous step (step 0 = immediately on enrol)
  subject_tmpl text,                                 -- email only
  body_tmpl    text not null default '',
  active       boolean not null default true,
  unique (campaign_id, step_index)
);

create table if not exists enrollments (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  contact_id     uuid not null references contacts(id) on delete cascade,
  status         text not null default 'active',   -- active|completed|stopped
  current_step   int  not null default 0,
  next_due_at    timestamptz,
  stopped_reason text,
  enrolled_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (campaign_id, contact_id)
);
create index if not exists enrollments_due_idx on enrollments (status, next_due_at);

create table if not exists sends (
  id            uuid primary key default gen_random_uuid(),
  enrollment_id uuid references enrollments(id) on delete set null,
  contact_id    uuid not null references contacts(id) on delete cascade,
  campaign_id   uuid references campaigns(id) on delete set null,
  step_index    int,
  channel       text not null,
  subject       text,
  body          text not null,
  status        text not null default 'sent',      -- sent|failed
  error         text,
  sent_at       timestamptz not null default now()
);
create index if not exists sends_contact_idx on sends (contact_id, sent_at desc);
create index if not exists sends_campaign_day_idx on sends (campaign_id, sent_at);

-- ─────────────────────────────── appointments (Phase 2) ───────────────────────────────
create table if not exists appointments (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  title      text not null,
  starts_at  timestamptz not null,
  ends_at    timestamptz,
  notes      text,
  status     text not null default 'scheduled',    -- scheduled|done|cancelled
  created_at timestamptz not null default now()
);
create index if not exists appointments_starts_idx on appointments (starts_at);

-- ─────────────────────────────── suppression ───────────────────────────────
create table if not exists suppression (
  email      text primary key,
  reason     text not null default '',
  created_at timestamptz not null default now()
);
