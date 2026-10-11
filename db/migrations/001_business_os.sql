-- 001 — FC Cleaning business system: users/auth/audit, richer customers (people + sites),
-- tasks/appointments upgrades, service catalogue + clause library, proposals (+ immutable
-- versions), contracts (+ immutable versions), private documents, DocuSeal signature
-- requests + webhook de-duplication. Purely additive: no existing column is dropped or
-- rewritten, existing rows keep their values (new columns are nullable or defaulted).

-- ── users, sessions, audit ────────────────────────────────────────────────────────────
create table users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  name          text not null,
  role          text not null default 'staff' check (role in ('admin', 'manager', 'staff')),
  pass_hash     text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_email_idx on users (lower(email));

create table sessions (
  token_hash text primary key,              -- sha256 of the cookie value; the raw token is never stored
  user_id    uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ip         text,
  user_agent text
);
create index sessions_user_idx on sessions (user_id);

create table audit_log (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  user_id   uuid references users(id) on delete set null,
  action    text not null,
  entity    text,
  entity_id text,
  detail    jsonb not null default '{}',
  ip        text
);
create index audit_entity_idx on audit_log (entity, entity_id, at desc);
create index audit_at_idx on audit_log (at desc);
-- append-only: the log can't be edited or trimmed from the app role
create function audit_log_immutable() returns trigger language plpgsql as $$
begin
  if current_setting('app.purge', true) = 'on' then return old; end if;
  raise exception 'audit_log is append-only';
end $$;
create trigger audit_log_no_change before update or delete on audit_log for each row execute function audit_log_immutable();

-- ── customers (the existing contacts table is the customer record) ────────────────────
alter table contacts
  add column trading_name   text,
  add column company_number text,
  add column vat_number     text,
  add column billing_address text,
  add column billing_email  text,
  add column premises_type  text,
  add column requirements   text not null default '',
  add column comm_prefs     text not null default '',
  add column payment_terms  text,
  add column owner_id       uuid references users(id) on delete set null,
  add column archived_at    timestamptz;
create index contacts_archived_idx on contacts (archived_at);
create index contacts_business_idx on contacts (lower(business));

create table contact_people (
  id         uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  name       text not null,
  job_title  text,
  email      text,
  phone      text,
  is_primary boolean not null default false,
  is_signer  boolean not null default false,
  notes      text not null default '',
  created_at timestamptz not null default now()
);
create index contact_people_contact_idx on contact_people (contact_id);

create table sites (
  id           uuid primary key default gen_random_uuid(),
  contact_id   uuid not null references contacts(id) on delete cascade,
  name         text not null,
  address      text not null,
  access_notes text not null default '',
  created_at   timestamptz not null default now(),
  archived_at  timestamptz
);
create index sites_contact_idx on sites (contact_id);

-- every existing contact's own name/email/phone becomes its primary person, and its
-- address its first site, so proposals can pick them straight away
insert into contact_people (contact_id, name, email, phone, is_primary, is_signer)
  select id, coalesce(nullif(contact_name, ''), business, 'Main contact'), email, phone, true, true
  from contacts where coalesce(contact_name, email, phone) is not null;
insert into sites (contact_id, name, address)
  select id, 'Main site', address from contacts where nullif(trim(address), '') is not null;

-- ── tasks + appointments (upgrade in place) ───────────────────────────────────────────
alter table tasks
  alter column contact_id drop not null,
  add column assigned_to  uuid references users(id) on delete set null,
  add column created_by   uuid references users(id) on delete set null,
  add column priority     text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  add column kind         text not null default 'task',      -- task|follow_up|onboarding|quality|renewal|internal
  add column notes        text not null default '',
  add column completed_at timestamptz,
  add column recur_days   int check (recur_days is null or recur_days > 0),
  add column auto_key     text,                                -- set by automations: makes them idempotent
  add column proposal_id  uuid,
  add column contract_id  uuid;
create unique index tasks_auto_key_idx on tasks (auto_key) where auto_key is not null;
create index tasks_open_due_idx on tasks (done, due_at);
create index tasks_assigned_idx on tasks (assigned_to, done);

alter table appointments
  add column kind        text not null default 'site_visit',  -- site_visit|quality_check|meeting|other
  add column assigned_to uuid references users(id) on delete set null;

-- ── reusable content ──────────────────────────────────────────────────────────────────
create table service_templates (
  id              uuid primary key default gen_random_uuid(),
  name            text not null,
  billing         text not null check (billing in ('hourly', 'fixed')),
  frequency       text not null check (frequency in ('one_off', 'weekly', 'monthly')),
  visits_per_week numeric(4,1),
  hours_per_visit numeric(6,2),
  staff           int,
  rate_pence      int check (rate_pence is null or rate_pence >= 0),
  price_pence     int check (price_pence is null or price_pence >= 0),
  scope           text not null default '',
  active          boolean not null default true,
  sort            int not null default 0,
  created_at      timestamptz not null default now()
);

create table content_blocks (
  id         uuid primary key default gen_random_uuid(),
  doc_type   text not null check (doc_type in ('proposal', 'contract')),
  key        text not null,
  title      text not null,
  body       text not null default '',
  sort       int not null default 0,
  active     boolean not null default true,
  required   boolean not null default false,
  updated_at timestamptz not null default now(),
  unique (doc_type, key)
);

-- ── documents (private files; bytes live in perchito-storage, never in /public) ───────
create table documents (
  id          uuid primary key default gen_random_uuid(),
  contact_id  uuid references contacts(id) on delete restrict,
  proposal_id uuid,
  contract_id uuid,
  kind        text not null check (kind in ('proposal_pdf', 'contract_pdf', 'signed_pdf', 'audit_trail', 'upload')),
  title       text not null,
  filename    text not null,
  mime        text not null,
  size        int not null check (size >= 0),
  sha256      text not null,
  storage_key text not null unique,
  notes       text not null default '',
  created_by  uuid references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  deleted_by  uuid references users(id) on delete set null
);
create index documents_contact_idx on documents (contact_id, created_at desc);
create index documents_contract_idx on documents (contract_id);
create index documents_proposal_idx on documents (proposal_id);

-- ── proposals ─────────────────────────────────────────────────────────────────────────
create table proposals (
  id                 uuid primary key default gen_random_uuid(),
  number             text not null unique,
  contact_id         uuid not null references contacts(id) on delete restrict,
  person_id          uuid references contact_people(id) on delete set null,
  site_id            uuid references sites(id) on delete set null,
  title              text not null default 'Commercial Cleaning Proposal',
  status             text not null default 'draft'
                     check (status in ('draft', 'sent', 'accepted', 'rejected', 'expired')),
  version            int not null default 1,         -- the version the draft will become when issued
  issued_version     int,                            -- latest immutable version (proposal_versions)
  issue_date         date,
  valid_until        date,
  data               jsonb not null default '{}',    -- editable draft: lines, schedule, sections, options
  totals             jsonb not null default '{}',    -- server-computed from data.lines
  monthly_net_pence  bigint not null default 0,
  one_off_net_pence  bigint not null default 0,
  annual_net_pence   bigint not null default 0,
  created_by         uuid references users(id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  sent_at            timestamptz,
  accepted_at        timestamptz,
  rejected_at        timestamptz,
  expired_at         timestamptz,
  archived_at        timestamptz,
  duplicated_from    uuid references proposals(id) on delete set null
);
create index proposals_contact_idx on proposals (contact_id);
create index proposals_status_idx on proposals (status, valid_until);

create table proposal_versions (
  id          uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references proposals(id) on delete restrict,
  version     int not null,
  snapshot    jsonb not null,                        -- everything printed: company, customer, site, lines, totals, sections
  document_id uuid references documents(id) on delete restrict,
  issued_at   timestamptz not null default now(),
  issued_by   uuid references users(id) on delete set null,
  unique (proposal_id, version)
);

-- ── contracts ─────────────────────────────────────────────────────────────────────────
create table contracts (
  id                  uuid primary key default gen_random_uuid(),
  number              text not null unique,
  contact_id          uuid not null references contacts(id) on delete restrict,
  proposal_id         uuid references proposals(id) on delete restrict,
  proposal_version_id uuid references proposal_versions(id) on delete restrict,
  site_id             uuid references sites(id) on delete set null,
  person_id           uuid references contact_people(id) on delete set null,
  status              text not null default 'draft' check (status in (
                        'draft', 'review', 'ready', 'sent', 'partially_signed', 'signed', 'active',
                        'renewal_due', 'expired', 'terminated', 'cancelled', 'declined')),
  version             int not null default 1,
  issued_version      int,
  data                jsonb not null default '{}',   -- snapshot of agreed terms (copied, never linked live)
  totals              jsonb not null default '{}',
  monthly_net_pence   bigint not null default 0,
  one_off_net_pence   bigint not null default 0,
  annual_net_pence    bigint not null default 0,
  start_date          date,
  end_date            date,
  renewal_date        date,
  signed_document_id  uuid references documents(id) on delete restrict,
  created_by          uuid references users(id) on delete set null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  signed_at           timestamptz,
  activated_at        timestamptz,
  ended_at            timestamptz,
  archived_at         timestamptz
);
create index contracts_contact_idx on contracts (contact_id);
create index contracts_status_idx on contracts (status, renewal_date);
-- one contract per accepted proposal (a retry or double click can't make two)
create unique index contracts_one_per_proposal_idx on contracts (proposal_id) where proposal_id is not null and status not in ('cancelled', 'declined');

create table contract_versions (
  id          uuid primary key default gen_random_uuid(),
  contract_id uuid not null references contracts(id) on delete restrict,
  version     int not null,
  snapshot    jsonb not null,
  document_id uuid references documents(id) on delete restrict,
  issued_at   timestamptz not null default now(),
  issued_by   uuid references users(id) on delete set null,
  unique (contract_id, version)
);

alter table documents
  add constraint documents_proposal_fk foreign key (proposal_id) references proposals(id) on delete restrict,
  add constraint documents_contract_fk foreign key (contract_id) references contracts(id) on delete restrict;
alter table tasks
  add constraint tasks_proposal_fk foreign key (proposal_id) references proposals(id) on delete set null,
  add constraint tasks_contract_fk foreign key (contract_id) references contracts(id) on delete set null;

-- ── e-signature (DocuSeal) ────────────────────────────────────────────────────────────
create table signature_requests (
  id                     uuid primary key default gen_random_uuid(),
  contract_id            uuid not null references contracts(id) on delete restrict,
  contract_version       int not null,
  idempotency_key        text not null unique,      -- contract id + version: a repeat click can't send twice
  status                 text not null default 'creating' check (status in (
                           'creating', 'sent', 'partially_signed', 'completed', 'declined', 'expired', 'cancelled', 'failed')),
  docuseal_template_id   bigint,
  docuseal_submission_id bigint unique,
  signers                jsonb not null default '[]', -- [{role, name, email, order, status, signed_at, slug}]
  error                  text,
  created_by             uuid references users(id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  completed_at           timestamptz,
  signed_document_id     uuid references documents(id) on delete restrict,
  audit_document_id      uuid references documents(id) on delete restrict
);
create index signature_requests_contract_idx on signature_requests (contract_id, created_at desc);
-- at most one live request per contract
create unique index signature_requests_live_idx on signature_requests (contract_id) where status in ('creating', 'sent', 'partially_signed');

create table webhook_events (
  dedup_key     text primary key,
  source        text not null,
  event_type    text not null,
  submission_id bigint,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  result        text
);

-- ROLLBACK (only before any proposal/contract data exists worth keeping — take a pg_dump first):
--   drop table webhook_events, signature_requests, contract_versions, proposal_versions cascade;
--   drop table documents, contracts, proposals, content_blocks, service_templates cascade;
--   drop table sites, contact_people, audit_log, sessions cascade; drop table users cascade;
--   drop function audit_log_immutable;
--   alter table tasks drop column assigned_to, drop column created_by, drop column priority, drop column kind,
--     drop column notes, drop column completed_at, drop column recur_days, drop column auto_key,
--     drop column proposal_id, drop column contract_id;   -- (contact_id stays nullable; harmless)
--   alter table appointments drop column kind, drop column assigned_to;
--   alter table contacts drop column trading_name, drop column company_number, drop column vat_number,
--     drop column billing_address, drop column billing_email, drop column premises_type, drop column requirements,
--     drop column comm_prefs, drop column payment_terms, drop column owner_id, drop column archived_at;
--   delete from schema_migrations where name = '001_business_os.sql';
