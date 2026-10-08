-- 0064: when each till was last heard from.
--
-- The back office could not say whether a till was syncing. pos_devices has
-- a last_seen_at, but it is written when a till is set up and never again.
-- Writing it on every sync would be worse than not having it: pos_devices is
-- sent to every till with each pull, and every change to a row gives it a new
-- place in that queue, so each till's sync would hand every other till a row
-- to fetch, without end. So the times live in a table of their own, which no
-- till pulls.
--
-- One row per till: when it last synced at all, when it last sent what it
-- had (a push), when it last fetched (a pull), and the build it said it was.
-- The API writes it, as owner, each time a till syncs with its own key, and
-- when a till is set up. The restaurant's back office reads it and cannot
-- write it. Never edit after merge.

create table if not exists device_activity (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null unique,
  last_seen_at timestamptz,
  last_push_at timestamptz,
  last_pull_at timestamptz,
  till_version integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, device_id) references pos_devices (tenant_id, id) on delete cascade
);
alter table device_activity enable row level security;
alter table device_activity force row level security;
-- a restaurant reads its own rows; nothing is written through its connection
drop policy if exists tenant_isolation on device_activity;
create policy tenant_isolation on device_activity
  using (tenant_id = current_tenant_id())
  with check (false);
drop trigger if exists trg_touch on device_activity;
create trigger trg_touch before insert or update on device_activity
  for each row execute function touch_row();

-- A till was heard from: 'push' when it sent what it had, 'pull' when it
-- fetched, anything else when it was only seen (set up, given a key, a crash
-- report). Asked on every sync, so a row is written again only when what it
-- says has gone stale: ten seconds on, or a different build. False for a
-- till that does not exist.
create or replace function device_heard(p_device uuid, p_what text, p_version integer default null)
returns boolean language plpgsql set search_path = public as $fn$
declare
  v_tenant uuid;
  v_push boolean := coalesce(p_what = 'push', false);
  v_pull boolean := coalesce(p_what = 'pull', false);
  v_version integer := case when p_version between 1 and 999999999 then p_version end;
begin
  select tenant_id into v_tenant from pos_devices where id = p_device;
  if not found then return false; end if;
  insert into device_activity (tenant_id, device_id, last_seen_at, last_push_at, last_pull_at, till_version)
    values (v_tenant, p_device, now(), case when v_push then now() end, case when v_pull then now() end, v_version)
  on conflict (device_id) do update set
      last_seen_at = now(),
      last_push_at = case when v_push then now() else device_activity.last_push_at end,
      last_pull_at = case when v_pull then now() else device_activity.last_pull_at end,
      till_version = coalesce(excluded.till_version, device_activity.till_version)
    where device_activity.last_seen_at is null
       or device_activity.last_seen_at < now() - interval '10 seconds'
       or (v_push and (device_activity.last_push_at is null or device_activity.last_push_at < now() - interval '10 seconds'))
       or (v_pull and (device_activity.last_pull_at is null or device_activity.last_pull_at < now() - interval '10 seconds'))
       or (excluded.till_version is not null and excluded.till_version is distinct from device_activity.till_version);
  return true;
end $fn$;

-- The function is for the API's owner connection only, and the table is
-- read-only to a tenant's own connection.
revoke all on function device_heard(uuid, text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    revoke all on function device_heard(uuid, text, integer) from app_user;
    revoke insert, update, delete, truncate on table device_activity from app_user;
    grant select on table device_activity to app_user;
  end if;
end $$;
