-- Payment reminders: per-invoice on/off switch + a log of what was sent (one row per scheduled stage).
alter table invoices add column if not exists reminders boolean not null default true;
create table if not exists invoice_reminders (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  stage text not null,          -- before | due | overdue_7 | overdue_14 | overdue_30 | manual
  to_email text not null,
  sent_at timestamptz not null default now()
);
create unique index if not exists invoice_reminders_stage_uq on invoice_reminders(invoice_id, stage) where stage <> 'manual';
-- ROLLBACK: drop table invoice_reminders; alter table invoices drop column reminders;
