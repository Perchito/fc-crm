-- Signing emails are sent by fc-crm (branded), not DocuSeal. Records what went out so nothing is sent twice:
-- {"invite:<submitter id>": "<ts>", "completed": "<ts>"}
alter table signature_requests add column if not exists emails jsonb not null default '{}';
-- requests from before this change: DocuSeal already emailed those people
update signature_requests set emails = jsonb_build_object('completed', now()) where status in ('completed','sent','partially_signed');
-- ROLLBACK: alter table signature_requests drop column emails;
