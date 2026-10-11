-- 0100: a tablet filled from a backup says which till it has to be.
--
-- A backup is a till: its id is in every row it holds. A tablet filled from
-- one must become that till and no other, so the code it is given has to be
-- the one made for that till's replacement (platform.tablet_code_move). With
-- any other code, a new tablet's or another till's, it would be set up as a
-- till its own rows do not belong to, and the code would be spent.
--
-- redeem_tablet_code takes a sixth word, p_must: the till the tablet has to
-- be. Given, a code that is not that till's is refused 'other-till' and stays
-- unused. Not given (null), everything is as in 0099.
-- Never edit after merge.

drop function if exists redeem_tablet_code(text, uuid, text, text, text);

create or replace function redeem_tablet_code(p_code text, p_device uuid, p_tablet text, p_name text, p_app text, p_must uuid)
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
  -- a tablet filled from a backup: only the code made for that till's replacement
  if p_must is not null and c.device_id is distinct from p_must then
    return jsonb_build_object('ok', false, 'why', 'other-till');
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

revoke all on function redeem_tablet_code(text, uuid, text, text, text, uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    revoke all on function redeem_tablet_code(text, uuid, text, text, text, uuid) from app_user;
  end if;
end $$;
