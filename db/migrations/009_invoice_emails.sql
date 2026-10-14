-- Issuing an invoice now emails it (Luis, 2026-10-14); the card shows when and to whom.
alter table invoices add column if not exists emailed_at timestamptz, add column if not exists emailed_to text;
-- ROLLBACK: alter table invoices drop column emailed_at, drop column emailed_to;
