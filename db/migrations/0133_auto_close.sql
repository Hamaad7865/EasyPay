-- 0133_auto_close.sql — a till closes its own day at a time the business sets
-- (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
-- Source: push_settings_save (last written by 0128_loyalty_points.sql),
-- push_shift_close and push_day_close (0054_approval_and_drawer_count.sql)
-- are the live definitions on dev (pg_get_functiondef) with the edits listed
-- here. Earlier migrations untouched.
--
-- What changes:
--   - settings.save takes autoClose: "HH:MM" from 00:00 to 23:59, the time
--     each till closes a day nobody closed; null switches it off. Anything
--     else is bad-value.
--   - A closing the till made by itself is marked: shift.close with
--     "auto": true, day.close with totals.auto = true. Nobody closed it, so
--     closed_by is left empty; nobody counted the drawer, so the shift keeps
--     no count (counted_cash null), whatever count the op carries (a till
--     sends what it expected, for a server without this migration). Every
--     page already reads a shift with no count as not counted.
--   - The till sends those two ops with no employee: they are its login's.
--     A login that may close a day (shift.open_close) may, as before, and so
--     may one that may set up tills (settings.device): it is the till doing
--     what its business set, not a person.
--   - sync_pull sends whole rows already: no change.
-- Never edit after merge.

CREATE OR REPLACE FUNCTION public.push_settings_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_patch jsonb := '{}'::jsonb; v_receipt jsonb; v_pct int; v_now jsonb; v_notes jsonb; v_int int;
begin
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if p ? 'receipt' then
    if jsonb_typeof(p->'receipt') <> 'object' then raise exception 'bad-payload'; end if;
    -- the two notes only: the logo and whether it shows are left as they are
    select data->'receipt' into v_now from pos_settings where tenant_id = p_tenant;
    v_receipt := coalesce(case when jsonb_typeof(v_now) = 'object' then v_now end, '{}'::jsonb);
    if p->'receipt' ? 'header' then v_receipt := v_receipt || jsonb_build_object('header', left(replace(coalesce(p->'receipt'->>'header', ''), E'\r', ''), 300)); end if;
    if p->'receipt' ? 'footer' then v_receipt := v_receipt || jsonb_build_object('footer', left(replace(coalesce(p->'receipt'->>'footer', ''), E'\r', ''), 300)); end if;
    v_patch := v_patch || jsonb_build_object('receipt', v_receipt);
  end if;
  if p ? 'servicePct' then
    begin
      v_pct := (p->>'servicePct')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_pct is null or v_pct not between 0 and 30 then raise exception 'bad-value'; end if;
    v_patch := v_patch || jsonb_build_object('servicePct', v_pct);
  end if;
  -- the notes offered when an item is added (0108): the list whole, as the
  -- back office's Settings saves it. Twelve of forty letters at most; what is
  -- empty or not words is left out; a list saved empty stays empty.
  if p ? 'kitchenNotes' then
    if jsonb_typeof(p->'kitchenNotes') <> 'array' then raise exception 'bad-payload'; end if;
    select coalesce(jsonb_agg(x.note order by x.n), '[]'::jsonb) into v_notes
      from (select left(btrim(e.v #>> '{}'), 40) as note, e.n
              from jsonb_array_elements(p->'kitchenNotes') with ordinality as e(v, n)
             where jsonb_typeof(e.v) = 'string' and btrim(e.v #>> '{}') <> ''
             order by e.n limit 12) x;
    v_patch := v_patch || jsonb_build_object('kitchenNotes', v_notes);
  end if;
  -- a shop's return policy (0109): each key is taken when sent and left as
  -- it was when not; a value nobody knows is refused
  if p ? 'returns' then
    if p->>'returns' not in ('exchange', 'credit', 'refund') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('returns', p->>'returns');
  end if;
  if p ? 'returnDays' then
    begin v_int := (p->>'returnDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('returnDays', v_int);
  end if;
  if p ? 'noteMonths' then
    begin v_int := (p->>'noteMonths')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 36 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('noteMonths', v_int);
  end if;
  -- a shop's promotions (0110): the two thresholds, in days
  if p ? 'slowMoverDays' then
    begin v_int := (p->>'slowMoverDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('slowMoverDays', v_int);
  end if;
  if p ? 'promoStillDays' then
    begin v_int := (p->>'promoStillDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('promoStillDays', v_int);
  end if;
  -- minutes before an order for later is due that the tills ring (0111); 0 is off
  if p ? 'dueReminderMinutes' then
    begin v_int := (p->>'dueReminderMinutes')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 120 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('dueReminderMinutes', v_int);
  end if;
  -- a shop's deposits (0113): each key taken when sent, refused out of range
  if p ? 'deposits' then
    if p->>'deposits' not in ('on', 'off') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('deposits', p->>'deposits');
  end if;
  if p ? 'depositCancel' then
    if p->>'depositCancel' not in ('refund', 'credit', 'keep') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositCancel', p->>'depositCancel');
  end if;
  if p ? 'depositOverdue' then
    if p->>'depositOverdue' not in ('show', 'cancel') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositOverdue', p->>'depositOverdue');
  end if;
  if p ? 'depositCustomer' then
    if p->>'depositCustomer' not in ('required', 'optional') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositCustomer', p->>'depositCustomer');
  end if;
  if p ? 'depositDays' then
    begin v_int := (p->>'depositDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositDays', v_int);
  end if;
  if p ? 'depositGrace' then
    begin v_int := (p->>'depositGrace')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositGrace', v_int);
  end if;
  -- a shop's customer accounts (0114)
  if p ? 'accounts' then
    if p->>'accounts' not in ('on', 'off') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('accounts', p->>'accounts');
  end if;
  if p ? 'accountDays' then
    begin v_int := (p->>'accountDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('accountDays', v_int);
  end if;
  -- loyalty points, for every business (0128)
  if p ? 'loyalty' then
    if p->>'loyalty' not in ('on', 'off') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('loyalty', p->>'loyalty');
  end if;
  if p ? 'loyaltyBp' then
    begin v_int := (p->>'loyaltyBp')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 10000 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('loyaltyBp', v_int);
  end if;
  -- the time each till closes a day nobody closed (0133): "HH:MM", or null for off
  if p ? 'autoClose' then
    if jsonb_typeof(p->'autoClose') = 'null' then
      v_patch := v_patch || jsonb_build_object('autoClose', null);
    elsif jsonb_typeof(p->'autoClose') <> 'string' or (p->>'autoClose') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'bad-value';
    else
      v_patch := v_patch || jsonb_build_object('autoClose', p->>'autoClose');
    end if;
  end if;
  if v_patch <> '{}'::jsonb then
    insert into pos_settings (tenant_id, data) values (p_tenant, v_patch)
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('saved', (select count(*) from jsonb_object_keys(v_patch)));
end $function$
;

CREATE OR REPLACE FUNCTION public.push_shift_close(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_counted bigint; v_at timestamptz; v_auto boolean;
  v_device uuid; v_opened timestamptz; v_float bigint; v_closed timestamptz; v_cash bigint;
begin
  v_id := (p->>'id')::uuid;
  -- closed by the till itself (0133): no count is kept, and nobody closed it
  v_auto := coalesce(p->>'auto', '') = 'true';
  v_counted := case when v_auto then null else (p->>'counted_cash')::bigint end;
  v_at := coalesce((p->>'closed_at')::timestamptz, now());
  if v_id is null or (not v_auto and (v_counted is null or v_counted < 0)) then raise exception 'bad-payload'; end if;
  if not (may(p_emp, p, 'shift.open_close') or (v_auto and has_perm(p_emp, 'settings.device'))) then raise exception 'forbidden'; end if;
  select device_id, opened_at, opening_float, closed_at into v_device, v_opened, v_float, v_closed
    from shifts where id = v_id and tenant_id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'bad-shift'; end if;
  if v_closed is not null then raise exception 'shift-closed'; end if;
  select coalesce(sum(case when r.type = 'refund' then -rp.amount else rp.amount end), 0) into v_cash
    from receipt_payments_effective rp
    join receipts r on r.tenant_id = rp.tenant_id and r.id = rp.receipt_id
    join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id
   where r.tenant_id = p_tenant and r.device_id = v_device and r.deleted_at is null
     and pt.kind = 'cash'
     and coalesce(r.device_time, r.created_at) >= v_opened
     and coalesce(r.device_time, r.created_at) <= v_at;
  -- cash put into and taken out of the drawer during the period
  select v_cash + coalesce(sum(case m.type when 'in' then m.amount when 'out' then -m.amount else 0 end), 0) into v_cash
    from cash_movements m
   where m.tenant_id = p_tenant and m.device_id = v_device and m.deleted_at is null
     and coalesce(m.device_time, m.created_at) >= v_opened
     and coalesce(m.device_time, m.created_at) <= v_at;
  update shifts set closed_by = case when v_auto then null else p_emp end, closed_at = v_at, counted_cash = v_counted,
      expected_cash = v_float + v_cash
    where id = v_id and tenant_id = p_tenant;
  return jsonb_build_object('shift_id', v_id, 'expected_cash', v_float + v_cash, 'counted_cash', v_counted);
end $function$
;

CREATE OR REPLACE FUNCTION public.push_day_close(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_store uuid; v_device uuid; v_at timestamptz; v_from timestamptz; v_no int; v_auto boolean;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  if v_id is null or v_store is null or v_device is null then raise exception 'bad-payload'; end if;
  -- closed by the till itself (0133): nobody closed it
  v_auto := coalesce(p->'totals'->>'auto', '') = 'true';
  if not (may(p_emp, p, 'shift.open_close') or (v_auto and has_perm(p_emp, 'settings.device'))) then raise exception 'forbidden'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store and tenant_id = p_tenant) then
    raise exception 'bad-device'; end if;
  v_at := coalesce((p->>'closed_at')::timestamptz, now());
  -- one closing of a store at a time (contention becomes retry, never a wait)
  if not pg_try_advisory_xact_lock(hashtextextended('dayclose:' || v_store::text, 0)) then
    raise exception 'lock-busy' using errcode = '55P03';
  end if;
  select max(closed_at) into v_from from day_closes
    where tenant_id = p_tenant and device_id = v_device and deleted_at is null;
  select coalesce(max(number), 0) + 1 into v_no from day_closes where tenant_id = p_tenant and store_id = v_store;
  insert into day_closes (id, tenant_id, store_id, device_id, number, closed_by, from_time, closed_at, totals)
    values (v_id, p_tenant, v_store, v_device, v_no, case when v_auto then null else p_emp end, v_from, v_at, coalesce(p->'totals', '{}'::jsonb));
  return jsonb_build_object('id', v_id, 'number', v_no);
end $function$
;

