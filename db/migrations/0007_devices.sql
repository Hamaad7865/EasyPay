-- 0007_devices.sql — pos_devices for store/device selection (Phase 1).
-- Receipt sequencing (last_receipt_seq) and the LAN hub flag live here;
-- shifts/tickets use them in Phase 2/3/4/7. Never edit after merge.

create table if not exists pos_devices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  name text not null,
  code text not null,
  last_receipt_seq bigint not null default 0,
  last_seen_at timestamptz,
  app_version text,
  is_hub boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, store_id, code),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);

alter table pos_devices enable row level security;
alter table pos_devices force row level security;
drop policy if exists tenant_isolation on pos_devices;
create policy tenant_isolation on pos_devices
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on pos_devices;
create trigger trg_touch before insert or update on pos_devices
  for each row execute function touch_row();
create index if not exists idx_pos_devices_tenant_seq on pos_devices (tenant_id, server_seq);
