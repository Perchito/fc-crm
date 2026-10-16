-- Manchester (Fernando) and London (Luis) side by side (2026-10-16). Every customer, campaign and
-- calendar block belongs to one area; everything else follows its customer. users.area = the area a
-- person's screens open on (null = all). Existing rows are Manchester.
alter table contacts  add column if not exists area text not null default 'manchester' check (area in ('manchester','london'));
alter table campaigns add column if not exists area text not null default 'manchester' check (area in ('manchester','london'));
alter table blocks    add column if not exists area text not null default 'manchester' check (area in ('manchester','london'));
alter table users     add column if not exists area text check (area in ('manchester','london'));
create index if not exists contacts_area_idx on contacts (area);
update users set area = 'london' where lower(email) = 'lmateocc99@gmail.com';
update users set area = 'manchester' where lower(email) = 'fernando.c@fccleaningcompany.com';
-- ROLLBACK: alter table contacts drop column area; alter table campaigns drop column area; alter table blocks drop column area; alter table users drop column area;
