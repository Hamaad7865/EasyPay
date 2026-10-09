-- 0090: what the admin area's Usage page is drawn from.
--
-- The owner asked to see "how much compute used, how much left, how much used
-- per client". Neon says the first two for a project and for each branch, and
-- nothing per client: it meters a compute, not who woke it. So this keeps two
-- things of our own, in the `platform` schema, which no client's connection
-- can see:
--
--   platform.usage_hours  which five minutes each client was active in. Neon
--                         puts a compute to sleep after five idle minutes, so
--                         one request keeps it awake about one such slot. One
--                         row for each hour a client was active in; `slots`
--                         has a bit for each of the hour's twelve slots (bit 0
--                         is minutes 0 to 4). Written when a till syncs
--                         (device_heard, below) and after a back office page
--                         (web/lib/db.ts).
--   platform.usage_days   Neon's totals as the hourly job read them
--                         (db/scripts/read-usage.cjs): one row a day for each
--                         project, each reading replacing its day's. The free
--                         plan keeps no history, so these rows are the only
--                         one there is. A day is the day in Mauritius.
--
-- And platform.storage_by_tenant(): how much of the database each client's
-- rows take, counted when it is asked. Postgres keeps no size per client
-- either, so a client is given its part of each table's size (with its
-- indexes) by its part of the table's rows. It reads every table that has a
-- tenant_id: quick at 50 MB, slower as the data grows.
-- Never edit after merge.

create table if not exists platform.usage_hours (
  tenant_id uuid not null references public.tenants (id) on delete cascade,
  hour timestamptz not null,
  slots integer not null default 0 check (slots between 0 and 4095),
  primary key (tenant_id, hour)
);

-- A client was active: the bit of that five minutes is set. Asked on every
-- sync and after back office pages, so it reads first and writes only when
-- the bit is not there yet: twelve small writes an hour at most for a client.
-- A client that does not exist is not marked, and nothing stops.
create or replace function platform.usage_mark(p_tenant uuid, p_at timestamptz default now())
returns void language plpgsql set search_path = public as $fn$
declare
  v_hour timestamptz := date_trunc('hour', p_at, 'UTC');
  v_bit integer := 1 << (extract(minute from (p_at at time zone 'UTC'))::integer / 5);
begin
  if p_tenant is null or p_at is null then return; end if;
  if exists (select 1 from platform.usage_hours where tenant_id = p_tenant and hour = v_hour and slots & v_bit <> 0) then
    return;
  end if;
  begin
    insert into platform.usage_hours (tenant_id, hour, slots) values (p_tenant, v_hour, v_bit)
    on conflict (tenant_id, hour) do update set slots = platform.usage_hours.slots | excluded.slots;
  exception when foreign_key_violation then
    null;
  end;
end $fn$;

create table if not exists platform.usage_days (
  project_id text not null,
  day date not null,
  read_at timestamptz not null,
  period_start timestamptz not null,
  period_end timestamptz,
  plan text,
  compute_seconds bigint not null,
  active_seconds bigint not null,
  storage_limit_bytes bigint,
  branches_limit integer,
  -- each branch as Neon named it: name, default, compute_seconds, active_seconds, logical_size
  branches jsonb not null,
  primary key (project_id, day)
);

-- A reading, as the job hands it over. It becomes its day's row; a later
-- reading the same day replaces it, an earlier one that arrives late does not.
create or replace function platform.usage_read(p jsonb)
returns void language plpgsql set search_path = public as $fn$
declare
  v_project text := nullif(p->>'project_id', '');
  v_at timestamptz := (p->>'read_at')::timestamptz;
begin
  if v_project is null or v_at is null or (p->>'period_start') is null or (p->>'compute_seconds') is null
     or (p->>'active_seconds') is null or jsonb_typeof(p->'branches') is distinct from 'array' then
    raise exception 'a reading needs project_id, read_at, period_start, compute_seconds, active_seconds and branches';
  end if;
  insert into platform.usage_days (project_id, day, read_at, period_start, period_end, plan, compute_seconds, active_seconds,
                                   storage_limit_bytes, branches_limit, branches)
  values (v_project, (v_at at time zone 'Indian/Mauritius')::date, v_at, (p->>'period_start')::timestamptz, (p->>'period_end')::timestamptz,
          p->>'plan', (p->>'compute_seconds')::bigint, (p->>'active_seconds')::bigint,
          (p->>'storage_limit_bytes')::bigint, (p->>'branches_limit')::integer, p->'branches')
  on conflict (project_id, day) do update set
      read_at = excluded.read_at, period_start = excluded.period_start, period_end = excluded.period_end, plan = excluded.plan,
      compute_seconds = excluded.compute_seconds, active_seconds = excluded.active_seconds,
      storage_limit_bytes = excluded.storage_limit_bytes, branches_limit = excluded.branches_limit, branches = excluded.branches
    where platform.usage_days.read_at < excluded.read_at;
end $fn$;

-- Each client's part of the database: for every table that has a tenant_id,
-- its rows over all the table's rows, times the table's size with its indexes.
create or replace function platform.storage_by_tenant()
returns table (tenant_id uuid, bytes bigint) language plpgsql set search_path = public as $fn$
declare
  v_sql text;
begin
  select string_agg(format(
           'select tenant_id, count(*) * %s::numeric / nullif(sum(count(*)) over (), 0) as b from %I.%I group by tenant_id',
           pg_total_relation_size(c.oid), n.nspname, c.relname), ' union all ')
    into v_sql
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
   where n.nspname = 'public' and c.relkind = 'r';
  if v_sql is null then return; end if;
  return query execute 'select t.tenant_id, round(sum(t.b))::bigint from (' || v_sql || ') t where t.tenant_id is not null group by t.tenant_id';
end $fn$;

-- A till that syncs is its client being active. The function is 0064's, with
-- the one line that says so.
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
  perform platform.usage_mark(v_tenant);
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

-- All of it is for the owner's connection only: the schema is already closed
-- to a client's, and these say so again for each function.
revoke all on function platform.usage_mark(uuid, timestamptz) from public;
revoke all on function platform.usage_read(jsonb) from public;
revoke all on function platform.storage_by_tenant() from public;
revoke all on function device_heard(uuid, text, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    revoke all on function platform.usage_mark(uuid, timestamptz) from app_user;
    revoke all on function platform.usage_read(jsonb) from app_user;
    revoke all on function platform.storage_by_tenant() from app_user;
    revoke all on function device_heard(uuid, text, integer) from app_user;
    revoke all on table platform.usage_hours, platform.usage_days from app_user;
  end if;
end $$;
