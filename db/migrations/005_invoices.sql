-- Native invoices. Issued invoice content and PDF are immutable snapshots.
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete restrict,
  number text not null unique,
  status text not null default 'draft' check (status in ('draft','issued','part_paid','paid','void')),
  issue_date date not null default current_date,
  due_date date not null,
  currency char(3) not null default 'GBP' check (currency = 'GBP'),
  vat_rate_bp integer not null default 2000 check (vat_rate_bp between 0 and 10000),
  subtotal_pence bigint not null default 0 check (subtotal_pence >= 0),
  vat_pence bigint not null default 0 check (vat_pence >= 0),
  total_pence bigint not null default 0 check (total_pence >= 0),
  contract_total_pence bigint check (contract_total_pence is null or contract_total_pence >= total_pence),
  deposit_pence bigint check (deposit_pence is null or deposit_pence >= 0),
  customer_note text not null default '',
  terms text not null default '',
  snapshot jsonb not null default '{}',
  created_by uuid references users(id) on delete set null,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists invoices_contact_idx on invoices(contact_id, created_at desc);
create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete cascade,
  position integer not null,
  description text not null,
  quantity numeric(12,3) not null default 1 check (quantity > 0),
  unit_price_pence bigint not null check (unit_price_pence >= 0),
  line_total_pence bigint not null check (line_total_pence >= 0),
  unique(invoice_id, position)
);
create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  invoice_id uuid not null references invoices(id) on delete restrict,
  amount_pence bigint not null check (amount_pence > 0),
  paid_on date not null default current_date,
  reference text not null default '',
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_invoice_idx on invoice_payments(invoice_id, paid_on);
-- ROLLBACK: drop table invoice_payments; drop table invoice_lines; drop table invoices;
