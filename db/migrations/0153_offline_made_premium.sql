-- 0153_offline_made_premium.sql — an offline client made Premium (or a trial): /admin no longer offers the
-- two buttons that would throw away what its tablets kept (docs/superpowers/reviews/2026-11-03-bug-sweep.md,
-- finding 6).
--
-- An offline client's tablets keep every sale to themselves until someone taps "Connect to the cloud" on
-- each. Until then the server holds nothing of them, so:
--   - Remove (remove_till): till_is_bare judged the till by what the server holds, found it bare, and
--     removed it. Its key went, the tablet was told to clear its data, and months of sales could never
--     go up. An offline till is refused while the client is live (0104, 'till-of-live-offline'), but
--     once the plan was Premium that rule no longer applied.
--   - Clear test activity: every client starts out being set up (0104). The tablet's own Go live does
--     not tell the server, so an offline client in use for months was still "being set up" here. Made
--     Premium, it was offered Clear test activity, which after Connect deleted the real receipts that
--     had just gone up, and removed every till.
--
-- set_tenant_plan: a client that was offline and is given another plan is live from then on. What it
-- tried was on its tablets, and each one cleared it with its own Go live (till 0.9.36 waits for that
-- before it connects). Written down as tenant.live, by 'plan'.
-- remove_till: a till that is bare here, of a client that was once offline, and made before the plan
-- left offline, is refused as 'till-not-connected' until its tablet has sent something up.
--
-- Source: set_tenant_plan and remove_till, the live definitions on dev (db/scripts/dump-function.cjs,
-- 2026-11-03), from 0136 and 0104. One addition each, marked. Earlier migrations untouched.
-- Never edit after merge.

CREATE OR REPLACE FUNCTION platform.set_tenant_plan(p_admin uuid, p_tenant uuid, p_plan text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_plan text := lower(nullif(btrim(coalesce(p_plan, '')), ''));
  v_old text;
begin
  perform platform.require_admin(p_admin);
  if v_plan is null then raise exception 'plan-required'; end if;
  -- the three plans (0115), and nothing else (0121)
  if v_plan not in ('trial', 'offline', 'premium') then raise exception 'bad-plan'; end if;
  select plan into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  -- the offline plan runs one tablet's branch (0136)
  if v_plan = 'offline' and (select count(*) from stores where tenant_id = p_tenant and deleted_at is null) > 1 then
    raise exception 'offline-one-branch';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set plan = v_plan where id = p_tenant;
  -- the tills learn the plan through the settings they already pull
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('plan', v_plan))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.plan', p_tenant, jsonb_build_object('from', v_old, 'to', v_plan));
  -- 0153: off the offline plan, the client is live. Its trying was on its tablets, which cleared it
  -- themselves; what they send up from now is its books, and Clear test activity would delete it.
  if lower(btrim(coalesce(v_old, ''))) = 'offline' and v_plan <> 'offline' then
    delete from platform.setting_up where tenant_id = p_tenant;
    if found then
      insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
        values (p_admin, 'tenant.live', p_tenant, jsonb_build_object('by', 'plan'));
    end if;
  end if;
end $function$
;

CREATE OR REPLACE FUNCTION platform.remove_till(p_admin uuid, p_device uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare d record;
begin
  perform platform.require_admin(p_admin);
  select p.tenant_id, p.code, p.name, p.created_at, lower(btrim(coalesce(t.plan, ''))) = 'offline' as offline
    into d from pos_devices p join tenants t on t.id = p.tenant_id
   where p.id = p_device for update of p;
  if not found then raise exception 'unknown-till'; end if;
  perform set_config('app.tenant_id', d.tenant_id::text, true);
  -- a tablet that works on its own keeps its sales to itself: nothing here
  -- says whether it has sold, so only a client being set up loses one
  if d.offline and not platform.is_setting_up(d.tenant_id) then raise exception 'till-of-live-offline'; end if;
  if not platform.till_is_bare(d.tenant_id, p_device) then raise exception 'till-has-records'; end if;
  -- 0153: a till of a client that was offline when it was made, bare here because its tablet has not
  -- connected yet: what it sold is on it alone
  if not d.offline and exists (select 1 from platform.audit a
        where a.tenant_id = d.tenant_id and a.action = 'tenant.plan' and a.created_at > d.created_at
          and lower(btrim(coalesce(a.detail->>'from', ''))) = 'offline') then
    raise exception 'till-not-connected';
  end if;
  delete from till_requests where tenant_id = d.tenant_id and device_id = p_device;
  delete from tablet_codes where tenant_id = d.tenant_id and device_id = p_device;
  -- its key, and when it was last heard from, go with it
  delete from pos_devices where id = p_device;
  insert into platform.removed_tills (device_id, tenant_id) values (p_device, d.tenant_id) on conflict do nothing;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'till.remove', d.tenant_id, jsonb_build_object('device_id', p_device, 'code', d.code, 'name', d.name));
end $function$
;
