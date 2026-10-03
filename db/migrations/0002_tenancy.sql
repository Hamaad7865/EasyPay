-- 0002_tenancy.sql — tenants, stores, roles, employees, proof catalog table
-- Never edit after merge. Money: bigint cents. Qty: integer thousandths (later tables).

-- Tenants (merchant account). tenant_id mirrors id (see sync_tenant_pk trigger).
create table if not exists tenants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  brn text,
  vat_number text,
  country text not null default 'MU',
  currency text not null default 'MUR',
  plan text not null default 'free',
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  check (tenant_id = id)
);
drop trigger if exists trg_tenants_sync_pk on tenants;
create trigger trg_tenants_sync_pk before insert on tenants
  for each row execute function sync_tenant_pk();

-- Stores (branches).
create table if not exists stores (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete restrict,
  name text not null,
  code text not null,
  address text,
  phone text,
  timezone text not null default 'Indian/Mauritius',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, code)
);

-- Roles with JSON permission sets (spec section 12).
create table if not exists roles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  permissions jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- Employees (PIN users). auth_user_id links to neon_auth."user".id (uuid).
create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  pin_hash text,
  role_id uuid,
  auth_user_id uuid unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, role_id) references roles (tenant_id, id) on delete set null
);

create table if not exists employee_stores (
  tenant_id uuid not null references tenants (id) on delete cascade,
  employee_id uuid not null,
  store_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  primary key (employee_id, store_id),
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade,
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);

-- Minimal catalog table for Phase 0 isolation proof (full catalog is Phase 1).
create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null,
  color text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);

-- Idempotency log for sync_push op_ids (spec 5.4). Insert-only.
create table if not exists sync_ops_applied (
  op_id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  type text not null,
  result jsonb,
  applied_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, op_id)
);

-- RLS: enable + force (so even the table owner / Functions must set app.tenant_id).
alter table tenants enable row level security;
alter table tenants force row level security;
alter table stores enable row level security;
alter table stores force row level security;
alter table roles enable row level security;
alter table roles force row level security;
alter table employees enable row level security;
alter table employees force row level security;
alter table employee_stores enable row level security;
alter table employee_stores force row level security;
alter table categories enable row level security;
alter table categories force row level security;
alter table sync_ops_applied enable row level security;
alter table sync_ops_applied force row level security;

drop policy if exists tenant_isolation on tenants;
create policy tenant_isolation on tenants
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop policy if exists tenant_isolation on stores;
create policy tenant_isolation on stores
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop policy if exists tenant_isolation on roles;
create policy tenant_isolation on roles
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop policy if exists tenant_isolation on employees;
create policy tenant_isolation on employees
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop policy if exists tenant_isolation on employee_stores;
create policy tenant_isolation on employee_stores
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop policy if exists tenant_isolation on categories;
create policy tenant_isolation on categories
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop policy if exists tenant_isolation on sync_ops_applied;
create policy tenant_isolation on sync_ops_applied
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());

-- touch_row on every synced table (spec 15).
drop trigger if exists trg_touch on tenants;
create trigger trg_touch before insert or update on tenants
  for each row execute function touch_row();
drop trigger if exists trg_touch on stores;
create trigger trg_touch before insert or update on stores
  for each row execute function touch_row();
drop trigger if exists trg_touch on roles;
create trigger trg_touch before insert or update on roles
  for each row execute function touch_row();
drop trigger if exists trg_touch on employees;
create trigger trg_touch before insert or update on employees
  for each row execute function touch_row();
drop trigger if exists trg_touch on employee_stores;
create trigger trg_touch before insert or update on employee_stores
  for each row execute function touch_row();
drop trigger if exists trg_touch on categories;
create trigger trg_touch before insert or update on categories
  for each row execute function touch_row();
drop trigger if exists trg_touch on sync_ops_applied;
create trigger trg_touch before insert or update on sync_ops_applied
  for each row execute function touch_row();

-- Insert-only guard.
drop trigger if exists trg_no_update on sync_ops_applied;
create trigger trg_no_update before update or delete on sync_ops_applied
  for each row execute function block_update();

-- Sync pull ordering (spec 5.3).
create index if not exists idx_tenants_tenant_seq on tenants (tenant_id, server_seq);
create index if not exists idx_stores_tenant_seq on stores (tenant_id, server_seq);
create index if not exists idx_roles_tenant_seq on roles (tenant_id, server_seq);
create index if not exists idx_employees_tenant_seq on employees (tenant_id, server_seq);
create index if not exists idx_employee_stores_tenant_seq on employee_stores (tenant_id, server_seq);
create index if not exists idx_categories_tenant_seq on categories (tenant_id, server_seq);
create index if not exists idx_sync_ops_tenant on sync_ops_applied (tenant_id, applied_at);
create index if not exists idx_employees_auth_user on employees (auth_user_id) where auth_user_id is not null;
