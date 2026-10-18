-- 0122: a deposit cancelled "by its date" is taken as that only when it is.
--
-- A tablet working alone cancels by itself, at its day opening, a deposit
-- past its date and grace when the shop says so (0113), and sends the cancel
-- marked auto: the right to refund is not asked of whoever opened the day.
-- push_deposit_cancel took the mark from the payload as it came, so any
-- login, on any till, could cancel any deposit, keep its money or hand it
-- back in cash, without that right, by sending auto: true.
--
-- Now auto is taken only when the deposit is past its date and grace by the
-- server's own day, as deposits_expire reads them (collect_by + grace before
-- today in the store's time zone; the tablet's rule is the same,
-- DepositRules.expired). Sent before that, it is an ordinary cancel: the
-- right to refund is asked, from a till that vouches for its staff it is kept
-- and flagged as before, from any other it is refused; and it carries the
-- flag 'auto-early' (said on the Deposits page), so a tablet whose clock or
-- settings are off is seen. A late send is never early: the server's day only
-- moves on.
--
-- Source: push_deposit_cancel is its live definition on dev on 2026-10-18
-- (db/scripts/dump-function.cjs; as 0113 left it), with only the lines named
-- above added. Never edit after merge.

CREATE OR REPLACE FUNCTION public.push_deposit_cancel(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  d deposits; v_outcome text := p->>'outcome'; v_auto boolean := coalesce((p->>'auto')::boolean, false);
  v_free bigint; v_back bigint := 0; b jsonb; v_dev uuid; v_time timestamptz; v_flags jsonb := '[]'::jsonb;
  v_note uuid; v_namt bigint; v_valid date; v_left boolean; v_owed bigint := 0; v_kept bigint := 0;
  v_vouched boolean := coalesce(current_setting('app.till_vouched', true), '') = '1';
  v_set jsonb; v_grace int;
begin
  begin
    v_dev := (p->>'device_id')::uuid;
    v_time := coalesce((p->>'device_time')::timestamptz, now());
    select * into d from deposits where tenant_id = p_tenant and id = (p->>'deposit_id')::uuid and deleted_at is null for update;
  exception when others then raise exception 'bad-payload';
  end;
  if not found then raise exception 'bad-deposit'; end if;
  if v_outcome is null or v_outcome not in ('refund', 'credit', 'keep') then raise exception 'bad-payload'; end if;
  if d.cancel_outcome is not null then
    -- cancelled already (the server's own expiry, or another till): money a
    -- till paid out since was paid, so it is recorded and said
    for b in select value from jsonb_array_elements(coalesce(p->'back', '[]'::jsonb)) loop
      v_back := v_back + deposit_money(p_tenant, p_emp, d.id, d.store_id, coalesce(v_dev, d.device_id), b, 'back', d.number, v_time);
    end loop;
    if v_back > 0 then
      update deposits set given_back = given_back + v_back, owed = greatest(owed - v_back, 0),
          flags = flags || jsonb_build_object('why', 'cancelled-twice', 'given_back', v_back)
        where tenant_id = p_tenant and id = d.id;
    end if;
    return jsonb_build_object('deposit_id', d.id, 'already', true);
  end if;
  -- by its date only when it is past its date and grace by the server's own day (0122)
  if v_auto then
    select data into v_set from pos_settings where tenant_id = p_tenant;
    v_grace := coalesce(case when (v_set->>'depositGrace') ~ '^[0-9]+$' then (v_set->>'depositGrace')::int end, 7);
    if not (d.collect_by + v_grace < deposit_today(p_tenant, d.store_id)) then
      v_auto := false;
      v_flags := v_flags || jsonb_build_object('why', 'auto-early', 'collect_by', d.collect_by, 'grace', v_grace);
    end if;
  end if;
  if not v_auto and not may(p_emp, p, 'sale.refund') then
    if not v_vouched then raise exception 'forbidden'; end if;
    v_flags := v_flags || jsonb_build_object('why', 'cancel-unapproved');
  end if;
  v_free := deposit_free(d);
  v_left := exists (select 1 from deposit_lines where tenant_id = p_tenant and deposit_id = d.id and qty > qty_collected);
  perform deposit_release(p_tenant, p_emp, d);

  if v_outcome = 'refund' then
    for b in select value from jsonb_array_elements(coalesce(p->'back', '[]'::jsonb)) loop
      v_back := v_back + deposit_money(p_tenant, p_emp, d.id, d.store_id, coalesce(v_dev, d.device_id), b, 'back', d.number, v_time);
    end loop;
    if v_back > v_free then v_flags := v_flags || jsonb_build_object('why', 'over-given', 'free', v_free, 'given', v_back); end if;
    -- what was not handed over yet is owed (a tablet alone cancelling by date)
    v_owed := greatest(v_free - v_back, 0);
  elsif v_outcome = 'credit' then
    v_namt := coalesce((p->'credit_note'->>'amount')::bigint, v_free);
    if v_namt <> v_free then v_flags := v_flags || jsonb_build_object('why', 'note-differs', 'free', v_free, 'note', v_namt); end if;
    if v_namt > 0 then
      begin v_valid := nullif(p->'credit_note'->>'valid_to', '')::date; exception when others then v_valid := null; end;
      v_note := deposit_note(p_tenant, p_emp, d, nullif(p->'credit_note'->>'id', '')::uuid, v_namt, v_valid, v_dev);
    end if;
    v_kept := 0;
  else
    v_kept := greatest(v_free, 0);
  end if;

  update deposits set
      status = case when v_left then 'cancelled' else 'collected' end,
      cancel_outcome = v_outcome, cancel_reason = left(nullif(btrim(coalesce(p->>'reason', '')), ''), 200),
      auto_cancelled = v_auto, cancelled_by = p_emp, approved_by = nullif(p->>'approved_by', '')::uuid, cancelled_at = v_time,
      given_back = given_back + v_back, owed = v_owed,
      kept = kept + v_kept, noted = noted + case when v_outcome = 'credit' then greatest(coalesce(v_namt, 0), 0) else 0 end,
      credit_note_id = v_note, flags = flags || v_flags
    where tenant_id = p_tenant and id = d.id;
  return jsonb_build_object('deposit_id', d.id, 'credit_note_id', v_note, 'owed', v_owed);
end $function$;
