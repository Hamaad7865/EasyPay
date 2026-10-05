-- 0059: a till that crashes says so.
--
-- When the till stops unexpectedly it writes down what it was doing (the
-- stack trace, its version, the tablet). The next time it runs it sends that
-- here, so RestoPOS hears of a crash before the restaurant has to call. No
-- third-party service is involved: the report goes to the restaurant's own
-- rows, under the same tenant rule as everything else, and the platform
-- admin reads them across restaurants.
--
-- A report holds no sale and no customer: only where in the program it
-- stopped. It is insert-only from the till's side and is never synced back.

create table if not exists crash_reports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid,
  employee_id uuid,
  app_version text,
  android text,
  model text,
  happened_at timestamptz not null default now(),
  thread text,
  summary text not null,
  trace text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
alter table crash_reports enable row level security;
alter table crash_reports force row level security;
drop policy if exists tenant_isolation on crash_reports;
create policy tenant_isolation on crash_reports
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on crash_reports;
create trigger trg_touch before insert or update on crash_reports
  for each row execute function touch_row();
create index if not exists idx_crash_reports_recent on crash_reports (created_at desc);
create index if not exists idx_crash_reports_tenant_seq on crash_reports (tenant_id, server_seq);

-- What the API calls with the reports a till sends: at most ten at a time,
-- each cut to a size that cannot fill the database, and the same crash sent
-- twice (the till died again before it could delete the file) kept once.
create or replace function report_crashes(p_employee_id uuid, p_reports jsonb)
returns integer language plpgsql set search_path = public as $fn$
declare tenant uuid; r jsonb; n integer := 0; v_at timestamptz; v_trace text; v_device uuid;
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no-tenant-context'; end if;
  if jsonb_typeof(p_reports) is distinct from 'array' then raise exception 'bad-batch'; end if;
  for r in select value from jsonb_array_elements(p_reports) as value limit 10 loop
    v_trace := left(coalesce(r->>'trace', ''), 20000);
    if btrim(v_trace) = '' then continue; end if;
    begin v_at := (r->>'at')::timestamptz; exception when others then v_at := null; end;
    begin
      v_device := (r->>'device_id')::uuid;
      if not exists (select 1 from pos_devices d where d.tenant_id = tenant and d.id = v_device) then v_device := null; end if;
    exception when others then v_device := null; end;
    if exists (select 1 from crash_reports c
                where c.tenant_id = tenant and c.happened_at = coalesce(v_at, c.happened_at) and v_at is not null
                  and c.device_id is not distinct from v_device and c.trace = v_trace) then
      continue;
    end if;
    insert into crash_reports (tenant_id, device_id, employee_id, app_version, android, model, happened_at, thread, summary, trace)
      values (tenant, v_device, p_employee_id, left(r->>'app_version', 40), left(r->>'android', 40), left(r->>'model', 80),
        coalesce(v_at, now()), left(r->>'thread', 80), left(split_part(v_trace, E'\n', 1), 300), v_trace);
    n := n + 1;
  end loop;
  return n;
end $fn$;
