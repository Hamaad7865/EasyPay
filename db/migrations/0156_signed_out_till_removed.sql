-- 0156_signed_out_till_removed.sql — a till whose tablet was signed out can be removed from /admin, also for a
-- client that once ran on its tablet.
--
-- 2026-11-06, Sunwave Laundry (offline, made Premium): its tablet, till T1, was signed out and in again. Sign-out
-- forgets the till on the tablet, so it came back as a new till, T2, and T1 was left behind with nothing on it.
-- Remove on T1 was refused as 'till-not-connected' (0153), although no tablet holds anything of T1 any more, and
-- the owner could only deactivate it: two tills where there is one.
--
-- 0153's rule is right for a tablet that still works as that till: what it sold may be on it alone. It is wrong
-- for one that was signed out. A tablet is signed out only once nothing waits on it (nothing to send, nothing
-- refused, nothing unpaid, no stock count open: MainActivity), and the sign-out ends the till's key
-- (DELETE /devices/key, revoke_device_key). So a key that was ended says the tablet let go of the till, with one
-- exception: moving a till to another tablet ends its key as well (platform.tablet_code_move, 0099), and then
-- what it sold may still be on the old tablet or in its backup. A move is written down ('tablet.move'), at the
-- moment its key ends; a move at or after the key ended keeps the till refused.
--
-- What changes: remove_till, 0153's rule only, gives way for a till whose key was ended with no move since.
-- A tablet signed out without a connection could not end its key: its till stays refused, and is deactivated.
--
-- Source: platform.remove_till as it is on dev (db/scripts/dump-function.cjs, 2026-11-06), which is 0153's.
-- One addition, marked. Never edit after merge.

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
          and lower(btrim(coalesce(a.detail->>'from', ''))) = 'offline')
    -- 0156: unless its tablet was signed out: its key was ended, and not by a move to another tablet
    and not exists (select 1 from device_keys k
        where k.device_id = p_device and k.revoked_at is not null
          and not exists (select 1 from platform.audit m
                where m.tenant_id = d.tenant_id and m.action = 'tablet.move'
                  and m.detail->>'device_id' = p_device::text and m.created_at >= k.revoked_at)) then
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
