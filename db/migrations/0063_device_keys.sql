-- 0063: a till that has been set up syncs for good.
--
-- A till synced with the session of the login that set it up. That session
-- lasts seven days from the last time it was used, so a till that had been
-- without a connection for more than a week kept selling but could not send
-- its sales until someone signed in on it again.
--
-- Now a till that is set up is given a key of its own, which does not lapse:
--   - device_keys holds one key per till: only its SHA-256, never the key,
--     and the login that set the till up (the key acts as that login, so
--     sync_push's rules about who may name staff stay exactly as they are).
--     The table is not in sync_pull's list, and its policy lets app_user see
--     nothing: it is read and written only through the three functions
--     below, by the API's owner connection, before a tenant is even known;
--   - issue_device_key(employee, device) makes a key (32 random bytes, hex)
--     and returns it once. Issuing again replaces the one before;
--   - device_login(device, key) says who a key is: {ok, employee_id,
--     tenant_id, store_id, status}, or {ok: false, why}: 'bad-key' (no such
--     till, or not its key), 'revoked', 'till-off' (the till was
--     deactivated), 'login-off' (the login that set it up was switched off
--     or removed);
--   - revoke_device_key(device) ends a key: the tablet was signed out.
-- Deactivating a till, or switching off the login that set it up, stops its
-- key at once. Never edit after merge.

create table if not exists device_keys (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  device_id uuid not null unique,
  key_hash bytea not null,
  employee_id uuid not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, device_id) references pos_devices (tenant_id, id) on delete cascade
);
alter table device_keys enable row level security;
alter table device_keys force row level security;
-- nothing of this table is for a tenant's own queries, not even its own rows
drop policy if exists tenant_isolation on device_keys;
create policy tenant_isolation on device_keys using (false) with check (false);
drop trigger if exists trg_touch on device_keys;
create trigger trg_touch before insert or update on device_keys
  for each row execute function touch_row();

create or replace function issue_device_key(p_emp uuid, p_device uuid)
returns text language plpgsql set search_path = public as $fn$
declare v_tenant uuid; v_key text;
begin
  select e.tenant_id into v_tenant from employees e
    where e.id = p_emp and e.deleted_at is null and e.is_active;
  if not found then raise exception 'bad-employee'; end if;
  if not exists (select 1 from pos_devices d
      where d.id = p_device and d.tenant_id = v_tenant and d.deleted_at is null) then
    raise exception 'bad-device';
  end if;
  v_key := encode(gen_random_bytes(32), 'hex');
  insert into device_keys (tenant_id, device_id, key_hash, employee_id)
    values (v_tenant, p_device, digest(v_key, 'sha256'), p_emp)
  on conflict (device_id) do update
    set key_hash = excluded.key_hash, employee_id = excluded.employee_id,
      tenant_id = excluded.tenant_id, revoked_at = null, created_at = now();
  return v_key;
end $fn$;

create or replace function device_login(p_device uuid, p_key text)
returns jsonb language plpgsql stable set search_path = public as $fn$
declare k record; d record; e record;
begin
  select * into k from device_keys where device_id = p_device;
  if not found or p_key is null or k.key_hash <> digest(p_key, 'sha256') then
    return jsonb_build_object('ok', false, 'why', 'bad-key');
  end if;
  if k.revoked_at is not null then return jsonb_build_object('ok', false, 'why', 'revoked'); end if;
  select store_id, deleted_at into d from pos_devices where id = p_device and tenant_id = k.tenant_id;
  if not found or d.deleted_at is not null then return jsonb_build_object('ok', false, 'why', 'till-off'); end if;
  select em.id, t.status into e from employees em join tenants t on t.id = em.tenant_id
    where em.id = k.employee_id and em.tenant_id = k.tenant_id and em.deleted_at is null and em.is_active;
  if not found then return jsonb_build_object('ok', false, 'why', 'login-off'); end if;
  return jsonb_build_object('ok', true, 'employee_id', e.id, 'tenant_id', k.tenant_id,
    'store_id', d.store_id, 'status', e.status);
end $fn$;

create or replace function revoke_device_key(p_device uuid)
returns boolean language plpgsql set search_path = public as $fn$
begin
  update device_keys set revoked_at = now() where device_id = p_device and revoked_at is null;
  return found;
end $fn$;

-- These are for the API's owner connection only. A tenant's own connection
-- has no business making, checking or ending keys.
revoke all on function issue_device_key(uuid, uuid) from public;
revoke all on function device_login(uuid, text) from public;
revoke all on function revoke_device_key(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    revoke all on function issue_device_key(uuid, uuid) from app_user;
    revoke all on function device_login(uuid, text) from app_user;
    revoke all on function revoke_device_key(uuid) from app_user;
    revoke all on table device_keys from app_user;
  end if;
end $$;
