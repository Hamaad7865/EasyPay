-- 0009_transactions.sql — tickets, lines, receipts, payments (Phase 2).
-- Money bigint cents, qty integer thousandths. Receipts/payments insert-only
-- (block_update). Snapshots (name/price/tax) freeze catalog at sale time so
-- later price edits never rewrite history (spec 14.7). table_id/shift_id/
-- customer_id stay free UUIDs until Phase 3/4/9 add their tables + FKs.
-- Never edit after merge.

create table if not exists tickets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  table_id uuid,
  dining_option_id uuid,
  name text,
  status text not null default 'open' check (status in ('open', 'paid', 'cancelled')),
  opened_by uuid,
  customer_id uuid,
  note text,
  covers integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict,
  foreign key (tenant_id, dining_option_id) references dining_options (tenant_id, id) on delete set null,
  foreign key (tenant_id, opened_by) references employees (tenant_id, id) on delete set null
);

create table if not exists ticket_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  ticket_id uuid not null,
  item_id uuid,
  variant_id uuid,
  name_snapshot text not null,
  unit_price bigint not null check (unit_price >= 0),
  qty integer not null check (qty > 0),
  note text,
  course integer,
  paid boolean not null default false,
  sent_to_kitchen_at timestamptz,
  voided_at timestamptz,
  voided_by uuid,
  void_reason text,
  kitchen_status text not null default 'unsent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete set null,
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id) on delete set null,
  foreign key (tenant_id, voided_by) references employees (tenant_id, id) on delete set null
);

create table if not exists ticket_line_modifiers (
  tenant_id uuid not null references tenants (id) on delete cascade,
  line_id uuid not null,
  modifier_id uuid,
  name_snapshot text not null,
  price bigint not null default 0 check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (line_id, modifier_id),
  foreign key (tenant_id, line_id) references ticket_lines (tenant_id, id) on delete cascade,
  foreign key (tenant_id, modifier_id) references modifiers (tenant_id, id) on delete set null
);

create table if not exists ticket_line_taxes (
  tenant_id uuid not null references tenants (id) on delete cascade,
  line_id uuid not null,
  tax_id uuid,
  name_snapshot text not null,
  rate_bp integer not null,
  type text not null check (type in ('included', 'added')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (line_id, tax_id),
  foreign key (tenant_id, line_id) references ticket_lines (tenant_id, id) on delete cascade,
  foreign key (tenant_id, tax_id) references taxes (tenant_id, id) on delete set null
);

create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid not null,
  shift_id uuid,
  ticket_id uuid not null,
  number text not null,
  type text not null default 'sale' check (type in ('sale', 'refund')),
  refund_of uuid,
  subtotal bigint not null default 0,
  discount_total bigint not null default 0,
  tax_total bigint not null default 0,
  service_charge bigint not null default 0,
  rounding bigint not null default 0,
  total bigint not null,
  employee_id uuid,
  customer_id uuid,
  device_time timestamptz,
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict,
  foreign key (tenant_id, device_id) references pos_devices (tenant_id, id) on delete restrict,
  foreign key (tenant_id, ticket_id) references tickets (tenant_id, id) on delete restrict,
  foreign key (tenant_id, refund_of) references receipts (tenant_id, id) on delete set null,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete set null
);

create table if not exists receipt_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  receipt_id uuid not null,
  ticket_line_id uuid,
  name_snapshot text not null,
  unit_price bigint not null,
  qty integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, receipt_id) references receipts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, ticket_line_id) references ticket_lines (tenant_id, id) on delete set null
);

create table if not exists receipt_line_modifiers (
  tenant_id uuid not null references tenants (id) on delete cascade,
  receipt_line_id uuid not null,
  modifier_id uuid,
  name_snapshot text not null,
  price bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (receipt_line_id, modifier_id),
  foreign key (tenant_id, receipt_line_id) references receipt_lines (tenant_id, id) on delete cascade,
  foreign key (tenant_id, modifier_id) references modifiers (tenant_id, id) on delete set null
);

create table if not exists receipt_line_taxes (
  tenant_id uuid not null references tenants (id) on delete cascade,
  receipt_line_id uuid not null,
  tax_id uuid,
  name_snapshot text not null,
  rate_bp integer not null,
  type text not null check (type in ('included', 'added')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (receipt_line_id, tax_id),
  foreign key (tenant_id, receipt_line_id) references receipt_lines (tenant_id, id) on delete cascade,
  foreign key (tenant_id, tax_id) references taxes (tenant_id, id) on delete set null
);

create table if not exists receipt_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  receipt_id uuid not null,
  payment_type_id uuid not null,
  amount bigint not null check (amount > 0),
  tendered bigint,
  change bigint not null default 0 check (change >= 0),
  reference text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, receipt_id) references receipts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, payment_type_id) references payment_types (tenant_id, id) on delete restrict
);

create table if not exists receipt_discounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  receipt_id uuid not null,
  line_id uuid,
  discount_id uuid,
  name_snapshot text not null,
  amount bigint not null check (amount >= 0),
  approved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, receipt_id) references receipts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, line_id) references receipt_lines (tenant_id, id) on delete set null,
  foreign key (tenant_id, discount_id) references discounts (tenant_id, id) on delete set null,
  foreign key (tenant_id, approved_by) references employees (tenant_id, id) on delete set null
);

do $$
declare t text;
begin
  foreach t in array array[
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes',
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('drop trigger if exists trg_touch on %I', t);
    execute format('create trigger trg_touch before insert or update on %I for each row execute function touch_row()', t);
    execute format('create index if not exists idx_%I_tenant_seq on %I (tenant_id, server_seq)', t, t);
  end loop;
end $$;

-- Insert-only: receipts, payments, and their snapshots (spec 15).
do $$
declare t text;
begin
  foreach t in array array[
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts']
  loop
    execute format('drop trigger if exists trg_no_update on %I', t);
    execute format('create trigger trg_no_update before update or delete on %I for each row execute function block_update()', t);
  end loop;
end $$;

create index if not exists idx_tickets_store_status on tickets (tenant_id, store_id, status) where deleted_at is null;
create index if not exists idx_ticket_lines_ticket on ticket_lines (tenant_id, ticket_id) where deleted_at is null;
create index if not exists idx_receipts_ticket on receipts (tenant_id, ticket_id);
create index if not exists idx_receipts_device_time on receipts (tenant_id, store_id, device_time);
