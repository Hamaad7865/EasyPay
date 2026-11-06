-- 0158_rename_till.sql — /admin gives a till another name and code.
--
-- 2026-11-06, Sunwave Laundry: its tablet came back from a sign-out as a new till, "Terminal 02" (T2), and the
-- old T1 was removed (0156). The owner: "I need the ability to rename also. I want to make it till1 and T1".
-- The back office renames a till (Point of sale, the till, Settings) but never touched its code.
--
-- platform.rename_till(admin, till, name, code):
--   - name: trimmed, 1 to 40 characters, as the back office's rename takes it ('till-name').
--   - code: trimmed and in capitals, letters and digits, 1 to 12, as a till is registered with ('till-code');
--     not another till's of the same store, a deactivated one's included ('till-code-taken'), as the unique
--     key (tenant, store, code) says.
--   - The code is in every number a till gives: receipts and refunds (S1-T1-R000001), credit notes, deposits,
--     bills on account, and the MRA's counter. Numbers are unique per business, so a code is changed only while
--     nothing carries it: else the old code, free again, could be taken by another till and give the same
--     numbers twice ('till-code-numbered').
--   - A tablet that works on its own numbers by itself and is told of no change: its till keeps its code
--     ('till-code-offline'). So does a till of a client that was offline when it was made, until its tablet has
--     sent something up (0153's rule, seen by its last push).
--   - The change is written on the till's row, so its tablet takes the new name and code at its next pull
--     (PullApplier, pos_devices), and its next receipt carries the new code.
--   - Written down as 'till.rename', with what it was.
-- Never edit after merge.

CREATE OR REPLACE FUNCTION platform.rename_till(p_admin uuid, p_device uuid, p_name text, p_code text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare d record; v_name text; v_code text;
begin
  perform platform.require_admin(p_admin);
  select p.tenant_id, p.store_id, p.code, p.name, p.created_at, lower(btrim(coalesce(t.plan, ''))) = 'offline' as offline
    into d from pos_devices p join tenants t on t.id = p.tenant_id
   where p.id = p_device for update of p;
  if not found then raise exception 'unknown-till'; end if;
  perform set_config('app.tenant_id', d.tenant_id::text, true);
  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' or length(v_name) > 40 then raise exception 'till-name'; end if;
  v_code := upper(btrim(coalesce(p_code, '')));
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'till-code'; end if;
  if v_code <> d.code then
    if d.offline then raise exception 'till-code-offline'; end if;
    -- made while the client was offline, and its tablet has sent nothing up since it left that plan
    if exists (select 1 from platform.audit a
        where a.tenant_id = d.tenant_id and a.action = 'tenant.plan' and a.created_at > d.created_at
          and lower(btrim(coalesce(a.detail->>'from', ''))) = 'offline'
          and not exists (select 1 from device_activity x where x.device_id = p_device and x.last_push_at > a.created_at)) then
      raise exception 'till-code-offline';
    end if;
    if exists (select 1 from receipts where tenant_id = d.tenant_id and device_id = p_device)
       or exists (select 1 from credit_notes where tenant_id = d.tenant_id and device_id = p_device)
       or exists (select 1 from deposits where tenant_id = d.tenant_id and device_id = p_device)
       or exists (select 1 from account_bills where tenant_id = d.tenant_id and device_id = p_device)
       or exists (select 1 from mra_records where tenant_id = d.tenant_id and device_id = p_device) then
      raise exception 'till-code-numbered';
    end if;
    if exists (select 1 from pos_devices where tenant_id = d.tenant_id and store_id = d.store_id and code = v_code and id <> p_device) then
      raise exception 'till-code-taken';
    end if;
  end if;
  if v_name = d.name and v_code = d.code then return; end if;
  update pos_devices set name = v_name, code = v_code where id = p_device;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'till.rename', d.tenant_id, jsonb_build_object('device_id', p_device,
      'from_name', d.name, 'from_code', d.code, 'name', v_name, 'code', v_code));
end $function$
;
