-- 0004_catalog.sql — tenant catalog: taxes, items, modifiers, discounts,
-- dining options, payment types, overrides, grid pages.
-- Money: bigint cents. Tables/printers/stations arrive in Phase 3.
-- Never edit after merge.

create table if not exists taxes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  rate_bp integer not null,
  type text not null check (type in ('included', 'added')),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table if not exists items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  category_id uuid,
  name text not null,
  price bigint not null check (price >= 0),
  cost bigint,
  sku text,
  barcode text,
  sold_by text not null default 'each' check (sold_by in ('each', 'weight')),
  tile_color text,
  tile_shape text,
  image_path text,
  is_available boolean not null default true,
  track_stock boolean not null default false,
  dietary_tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, category_id) references categories (tenant_id, id) on delete set null
);

create table if not exists item_variants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  item_id uuid not null,
  name text not null,
  price bigint not null check (price >= 0),
  sku text,
  barcode text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete cascade
);

create table if not exists modifier_groups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  min_select integer not null default 0,
  max_select integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table if not exists modifiers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  group_id uuid not null,
  name text not null,
  price bigint not null default 0 check (price >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, group_id) references modifier_groups (tenant_id, id) on delete cascade
);

create table if not exists item_modifier_groups (
  tenant_id uuid not null references tenants (id) on delete cascade,
  item_id uuid not null,
  group_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (item_id, group_id),
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, group_id) references modifier_groups (tenant_id, id) on delete cascade
);

create table if not exists item_taxes (
  tenant_id uuid not null references tenants (id) on delete cascade,
  item_id uuid not null,
  tax_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (item_id, tax_id),
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, tax_id) references taxes (tenant_id, id) on delete cascade
);

create table if not exists discounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  type text not null check (type in ('percent', 'amount')),
  value bigint not null check (value >= 0),
  requires_approval boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table if not exists store_item_overrides (
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  item_id uuid not null,
  price bigint check (price is null or price >= 0),
  is_available boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (store_id, item_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete cascade
);

create table if not exists dining_options (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  is_default boolean not null default false,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table if not exists payment_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('cash', 'card', 'wallet', 'qr', 'other')),
  opens_drawer boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table if not exists grid_pages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);

create table if not exists grid_page_items (
  tenant_id uuid not null references tenants (id) on delete cascade,
  page_id uuid not null,
  item_id uuid not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (page_id, item_id),
  foreign key (tenant_id, page_id) references grid_pages (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete cascade
);

-- RLS + FORCE + tenant_isolation + touch + (tenant_id, server_seq), for each table.
do $$
declare t text;
begin
  foreach t in array array[
    'taxes','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','discounts','store_item_overrides',
    'dining_options','payment_types','grid_pages','grid_page_items']
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
