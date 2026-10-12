-- Reminders are sent by hand only (Luis, 2026-10-12): drop the auto-reminder switch.
alter table invoices drop column if exists reminders;
-- ROLLBACK: alter table invoices add column reminders boolean not null default true;
