-- 0099: a tablet is set up with a code. One code, one tablet.
--
-- A business that runs on its tablet (the plan "offline") bought the till
-- once, for one tablet. Until now any tablet could be set up with the
-- business's login, as often as anyone liked. Now the platform admin makes a
-- code for each tablet sold, and the tablet is set up with it:
--
--   - tablet_codes holds a code's SHA-256, never the code, the store it is
--     for, the till it became and the tablet that used it. Like device_keys
--     it is no tenant's to read: only the functions below touch it, on the
--     API's owner connection, and no till pulls it;
--   - platform.tablet_code_add(admin, store) makes a code and returns it,
--     once: twelve letters and digits, shown in three groups of four;
--   - redeem_tablet_code(code, device, tablet, name, app) is the tablet
--     using it: the till is registered in the code's store (under the id the
--     tablet made, with the first of T1, T2, ... the store does not have),
--     and given its key for syncing, which stands for the business's own
--     owner, as a till set up with that login would. A code is used once.
--     The tablet that used it may ask again (its answer was lost on the
--     way) and is given a new key; any other tablet is refused;
--   - platform.tablet_code_move(admin, device) is a tablet being replaced:
--     the till's key ends at once, the code it was set up with ends, and a
--     new code is made for that same till. The new tablet that uses it IS
--     that till: its id, its receipt numbers, and what a backup of the old
--     tablet holds stay one till's. The old tablet, which works on its own,
--     is not stopped by this: it never asks;
--   - platform.tablet_code_end(admin, code) takes back a code nobody used;
--   - platform.tablet_codes(tenant) is the list /admin shows.
--
-- The API refuses to set up a tablet with a login where the plan is offline
-- (hello.ts): that is what makes the code the only way in. A cloud business
-- sets its tills up with its login as before, and may be given codes too.
-- Never edit after merge.

create table if not exists tablet_codes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  code_hash bytea not null unique,
  -- the code's last four characters, to tell one from another in /admin
  hint text not null,
  -- the till it is for: none until it is used; set from the start for a till that is being moved
  device_id uuid,
  -- the tablet that used it, by the id it made for itself
  tablet text,
  used_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);
create index if not exists idx_tablet_codes_tenant on tablet_codes (tenant_id, created_at desc);
create index if not exists idx_tablet_codes_device on tablet_codes (device_id) where device_id is not null;
alter table tablet_codes enable row level security;
alter table tablet_codes force row level security;
-- nothing of this table is for a tenant's own queries, not even its own rows
drop policy if exists tenant_isolation on tablet_codes;
create policy tenant_isolation on tablet_codes using (false) with check (false);
drop trigger if exists trg_touch on tablet_codes;
create trigger trg_touch before insert or update on tablet_codes
  for each row execute function touch_row();

-- A code as it is compared: capitals and digits only, whatever was typed between them.
create or replace function tablet_code_plain(p_code text) returns text
language sql immutable as $fn$
  select upper(regexp_replace(coalesce(p_code, ''), '[^0-9A-Za-z]', '', 'g'));
$fn$;

-- Makes a code for a store, or for a till that is being moved, and returns
-- {id, code}. Twelve characters out of thirty that are not taken for one
-- another when read aloud or typed (no I, L, O or U, no 0 or 1).
create or replace function tablet_code_make(p_tenant uuid, p_store uuid, p_device uuid) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_abc constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_bytes bytea;
  v_code text;
  v_id uuid;
  i int;
begin
  loop
    v_bytes := gen_random_bytes(12);
    v_code := '';
    for i in 0..11 loop
      v_code := v_code || substr(v_abc, get_byte(v_bytes, i) % 30 + 1, 1);
    end loop;
    begin
      insert into tablet_codes (tenant_id, store_id, code_hash, hint, device_id)
        values (p_tenant, p_store, digest(v_code, 'sha256'), right(v_code, 4), p_device)
        returning id into v_id;
      exit;
    exception when unique_violation then
      -- the same twelve characters twice: another is drawn
    end;
  end loop;
  return jsonb_build_object('id', v_id,
    'code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4));
end $fn$;

create or replace function platform.tablet_code_add(p_admin uuid, p_store uuid) returns jsonb
language plpgsql set search_path = public as $fn$
declare v_tenant uuid; v_out jsonb;
begin
  perform platform.require_admin(p_admin);
  select tenant_id into v_tenant from stores where id = p_store and deleted_at is null;
  if not found then raise exception 'unknown-store'; end if;
  perform set_config('app.tenant_id', v_tenant::text, true);
  v_out := tablet_code_make(v_tenant, p_store, null);
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tablet.add', v_tenant, jsonb_build_object('store_id', p_store, 'code_id', v_out->>'id'));
  return v_out;
end $fn$;

create or replace function platform.tablet_code_move(p_admin uuid, p_device uuid) returns jsonb
language plpgsql set search_path = public as $fn$
declare d record; v_out jsonb;
begin
  perform platform.require_admin(p_admin);
  select tenant_id, store_id, code, deleted_at into d from pos_devices where id = p_device;
  if not found then raise exception 'unknown-till'; end if;
  -- a till that was deactivated is reactivated first: a code must not bring it back by the side door
  if d.deleted_at is not null then raise exception 'till-off'; end if;
  perform set_config('app.tenant_id', d.tenant_id::text, true);
  -- the tablet that was this till can no longer send or fetch
  perform revoke_device_key(p_device);
  -- the code it was set up with, and one made for a move that never happened
  update tablet_codes set ended_at = now() where device_id = p_device and ended_at is null;
  v_out := tablet_code_make(d.tenant_id, d.store_id, p_device);
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tablet.move', d.tenant_id, jsonb_build_object('device_id', p_device, 'code', d.code, 'code_id', v_out->>'id'));
  return v_out;
end $fn$;

create or replace function platform.tablet_code_end(p_admin uuid, p_code uuid) returns void
language plpgsql set search_path = public as $fn$
declare c record;
begin
  perform platform.require_admin(p_admin);
  select tenant_id, used_at, ended_at into c from tablet_codes where id = p_code for update;
  if not found then raise exception 'unknown-code'; end if;
  -- a code that was used is a tablet at work: that one is moved, not taken back
  if c.used_at is not null then raise exception 'code-used'; end if;
  if c.ended_at is not null then return; end if;
  perform set_config('app.tenant_id', c.tenant_id::text, true);
  update tablet_codes set ended_at = now() where id = p_code;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tablet.code_end', c.tenant_id, jsonb_build_object('code_id', p_code));
end $fn$;

-- What /admin shows of a client's codes, the newest first. state: 'waiting'
-- (made, not used), 'used' (a tablet at work), 'ended' (taken back, or the
-- tablet was replaced).
create or replace function platform.tablet_codes(p_tenant uuid) returns jsonb
language sql stable set search_path = public as $fn$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', c.id, 'hint', c.hint, 'store_id', c.store_id, 'store', s.name,
      'device_id', c.device_id, 'till', d.name, 'till_code', d.code,
      'state', case when c.ended_at is not null then 'ended' when c.used_at is not null then 'used' else 'waiting' end,
      'made_at', c.created_at, 'used_at', c.used_at, 'ended_at', c.ended_at
    ) order by c.created_at desc, c.id), '[]'::jsonb)
    from tablet_codes c
    join stores s on s.tenant_id = c.tenant_id and s.id = c.store_id
    left join pos_devices d on d.tenant_id = c.tenant_id and d.id = c.device_id
   where c.tenant_id = p_tenant;
$fn$;

-- The tablet using its code. Answers {ok: true, tenant_id, business,
-- store_id, device_id, key, last_receipt_seq, name, code, moved}, or
-- {ok: false, why}: 'bad-code' (not a code, or none like it), 'ended' (taken
-- back, or the tablet was replaced), 'used' (another tablet has it),
-- 'suspended' (the business is), 'no-owner' (nobody of the business may set
-- up tills: its owner login was removed), 'till-off' (the till it moves was
-- deactivated), 'bad-device' (the id the tablet made is another till's).
create or replace function redeem_tablet_code(p_code text, p_device uuid, p_tablet text, p_name text, p_app text)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_code text := tablet_code_plain(p_code);
  v_tablet text := btrim(coalesce(p_tablet, ''));
  c record; t record; d record;
  v_emp uuid; v_device uuid; v_key text; v_n int; v_moved boolean;
begin
  if length(v_code) <> 12 or p_device is null or v_tablet = '' or length(v_tablet) > 80 then
    return jsonb_build_object('ok', false, 'why', 'bad-code');
  end if;
  -- held to the end: two tablets typing the same code take their turn
  select * into c from tablet_codes where code_hash = digest(v_code, 'sha256') for update;
  if not found then return jsonb_build_object('ok', false, 'why', 'bad-code'); end if;
  if c.ended_at is not null then return jsonb_build_object('ok', false, 'why', 'ended'); end if;
  -- used: only the tablet that used it may ask again
  if c.used_at is not null and c.tablet is distinct from v_tablet then
    return jsonb_build_object('ok', false, 'why', 'used');
  end if;
  select id, name, status into t from tenants where id = c.tenant_id;
  if t.status is distinct from 'active' then return jsonb_build_object('ok', false, 'why', 'suspended'); end if;
  perform set_config('app.tenant_id', c.tenant_id::text, true);
  -- whom the till's key stands for: the business's own login that may set up
  -- tills (the owner's), as if that login had set this tablet up
  select e.id into v_emp from employees e
   where e.tenant_id = c.tenant_id and e.deleted_at is null and e.is_active and has_perm(e.id, 'settings.device')
   order by (e.auth_user_id is not null) desc, e.created_at, e.id
   limit 1;
  if v_emp is null then return jsonb_build_object('ok', false, 'why', 'no-owner'); end if;

  v_moved := c.device_id is not null and c.used_at is null;
  if c.device_id is not null then
    -- a till moved to this tablet, or this tablet asking again
    v_device := c.device_id;
    select deleted_at into d from pos_devices where id = v_device and tenant_id = c.tenant_id;
    if not found or d.deleted_at is not null then return jsonb_build_object('ok', false, 'why', 'till-off'); end if;
    update pos_devices set app_version = coalesce(p_app, app_version), last_seen_at = now() where id = v_device;
  else
    v_device := p_device;
    if exists (select 1 from pos_devices where id = v_device) then
      return jsonb_build_object('ok', false, 'why', 'bad-device');
    end if;
    -- the first of T1, T2, ... the store does not have, deactivated tills counted
    select min(n) into v_n from generate_series(1, 999) n
     where not exists (select 1 from pos_devices p
       where p.tenant_id = c.tenant_id and p.store_id = c.store_id and p.code = 'T' || n);
    insert into pos_devices (id, tenant_id, store_id, name, code, app_version, last_seen_at)
      values (v_device, c.tenant_id, c.store_id,
        coalesce(nullif(btrim(left(btrim(coalesce(p_name, '')), 40)), ''), 'Till ' || v_n), 'T' || v_n, p_app, now());
  end if;
  v_key := issue_device_key(v_emp, v_device);
  update tablet_codes set used_at = coalesce(used_at, now()), tablet = v_tablet, device_id = v_device where id = c.id;
  select name, code, last_receipt_seq into d from pos_devices where id = v_device;
  return jsonb_build_object('ok', true, 'tenant_id', c.tenant_id, 'business', t.name, 'store_id', c.store_id,
    'device_id', v_device, 'key', v_key, 'last_receipt_seq', d.last_receipt_seq, 'name', d.name, 'code', d.code,
    'moved', v_moved);
end $fn$;

-- For the API's owner connection only, like the till keys.
revoke all on function tablet_code_make(uuid, uuid, uuid) from public;
revoke all on function redeem_tablet_code(text, uuid, text, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    revoke all on function tablet_code_make(uuid, uuid, uuid) from app_user;
    revoke all on function redeem_tablet_code(text, uuid, text, text, text) from app_user;
    revoke all on table tablet_codes from app_user;
  end if;
end $$;
