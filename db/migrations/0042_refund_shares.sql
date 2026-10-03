-- 0042_refund_shares.sql — refunds as exact shares of what the receipt charged,
-- capped by the money actually received (review item C).
-- Source: push_refund_create copied from 0035_refund_prorata.sql, which matched
-- the live definition (pg_get_functiondef) when this was written. 0035 untouched.
--
-- Two bugs this replaces:
--   * a full refund mirrored receipts.total even when the till had only taken
--     part of it (Rs 1 received, Rs 50 refunded);
--   * by-line refunds rounded each one independently, so the last unit of a
--     line could land one cent over the cap and be refused for good.
--
-- The rule the till must reproduce (refund payments have to match exactly):
--   1. Original receipt lines in order of (ticket_line_id, id).
--   2. Each line owns a share of every receipt component: subtotal, discount,
--      added tax, included tax, service charge, rounding.
--        sub   = line_amount(unit_price, qty) + its modifier prices
--        disc  = discount_total * sub / subtotal            (integer division)
--        svc   = service_charge * sub / subtotal
--        rnd   = rounding       * sub / subtotal
--        tax   = per tax snapshot on (sub - disc):
--                  added:    (base * rate + 5000) / 10000
--                  included: (base * rate + (10000 + rate) / 2) / (10000 + rate)
--      The LAST line takes whatever is left of each component, so the shares
--      add up to the receipt exactly.
--   3. Refunding q of a line's Q units when d are already refunded returns, for
--      each component, alloc(d + q) - alloc(d), with
--        alloc(k) = (share * k + Q / 2) / Q        (sign carried separately)
--      alloc(0) = 0 and alloc(Q) = share, so the units of a line always add up
--      to its share whatever order or size they are refunded in.
--   4. refund total = sub - disc + added tax + service + rounding.
-- Refunding every unit therefore returns receipts.total to the cent, including
-- service charge and rounding (by-line refunds used to drop both).
--
-- Caps: per line, refunded quantity never exceeds the quantity sold; per
-- receipt, refunded money never exceeds the payments received. Both reject
-- with 'bad-qty'. A request with no "lines" refunds everything still
-- unrefunded (it used to be refused once any partial refund existed).
-- Never edit after merge.

create or replace function refund_alloc(p_share bigint, p_k int, p_q int) returns bigint
language sql immutable set search_path = public as $$
  select case
    when p_q <= 0 then 0::bigint
    when p_share < 0 then -((-p_share * p_k + p_q / 2) / p_q)
    else (p_share * p_k + p_q / 2) / p_q
  end
$$;

create or replace function push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record;
  -- receipt-level targets the line shares must add up to
  v_t_tadd bigint; v_t_tincl bigint; v_w bigint; v_n int; v_i int := 0;
  v_a_sub bigint := 0; v_a_disc bigint := 0; v_a_tadd bigint := 0;
  v_a_tincl bigint := 0; v_a_svc bigint := 0; v_a_rnd bigint := 0;
  v_ls bigint; v_ld bigint; v_lta bigint; v_lti bigint; v_lsv bigint; v_lr bigint; v_div bigint;
  oln record; tx record; sh record; rw record;
  -- this refund
  v_sub bigint := 0; v_disc bigint := 0; v_tadd bigint := 0; v_tincl bigint := 0;
  v_svc bigint := 0; v_rnd bigint := 0; v_total bigint;
  sel jsonb; v_line uuid; v_qty int; v_done int; v_seen uuid[] := '{}';
  v_received bigint; v_cum bigint;
  pay jsonb; v_ptype uuid; v_pamt bigint; v_tender bigint; v_change bigint; v_chunk bigint := 0;
  v_nline uuid;
begin
  if not has_perm(p_emp, 'sale.refund') then raise exception 'forbidden'; end if;
  v_id := (p->>'id')::uuid;
  v_orig := (p->>'refund_of')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_number := nullif(p->>'number','');
  if v_id is null or v_orig is null or v_store is null or v_device is null or v_number is null then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store) then
    raise exception 'bad-device'; end if;
  select * into o from receipts
    where id = v_orig and tenant_id = p_tenant and type = 'sale' and deleted_at is null;
  if not found then raise exception 'bad-receipt'; end if;
  if nullif(p->>'reason','') is null then raise exception 'bad-payload'; end if;

  -- one refund of a given receipt at a time: two tills must not both read the
  -- same "already refunded" figures (contention becomes retry, never a wait)
  if not pg_try_advisory_xact_lock(hashtextextended('refund:' || v_orig::text, 0)) then
    raise exception 'lock-busy' using errcode = '55P03';
  end if;

  -- 1+2. line shares of every component; the last line takes the remainder
  v_t_tadd := o.total - (o.subtotal - o.discount_total + o.service_charge + o.rounding);
  v_t_tincl := o.tax_total - v_t_tadd;
  select count(*), coalesce(sum(line_amount(x.unit_price, x.qty) +
      coalesce((select sum(xm.price) from receipt_line_modifiers xm
        where xm.receipt_line_id = x.id and xm.tenant_id = p_tenant), 0)::bigint), 0)
    into v_n, v_w
    from receipt_lines x where x.receipt_id = v_orig and x.tenant_id = p_tenant;

  drop table if exists _rshare;
  create temp table _rshare (
    oline uuid, tlid uuid, s_name text, s_unit bigint, s_qty int,
    s_sub bigint, s_disc bigint, s_tadd bigint, s_tincl bigint, s_svc bigint, s_rnd bigint
  ) on commit drop;
  drop table if exists _rlines;
  create temp table _rlines (oline uuid, r_name text, r_unit bigint, r_qty int) on commit drop;

  for oln in
    select x.id, x.ticket_line_id, x.name_snapshot, x.unit_price, x.qty,
      line_amount(x.unit_price, x.qty) +
        coalesce((select sum(xm.price) from receipt_line_modifiers xm
          where xm.receipt_line_id = x.id and xm.tenant_id = p_tenant), 0)::bigint as base
    from receipt_lines x where x.receipt_id = v_orig and x.tenant_id = p_tenant
    order by x.ticket_line_id, x.id
  loop
    v_i := v_i + 1;
    if v_i < v_n then
      v_ls := oln.base;
      v_ld := case when v_w > 0 then o.discount_total * oln.base / v_w else 0 end;
      v_lsv := case when v_w > 0 then o.service_charge * oln.base / v_w else 0 end;
      v_lr := case when v_w > 0 then o.rounding * oln.base / v_w else 0 end;
      v_lta := 0; v_lti := 0;
      for tx in select rate_bp, type from receipt_line_taxes
          where receipt_line_id = oln.id and tenant_id = p_tenant loop
        if tx.type = 'added' then
          v_lta := v_lta + ((v_ls - v_ld) * tx.rate_bp + 5000) / 10000;
        else
          v_div := 10000 + tx.rate_bp;
          v_lti := v_lti + ((v_ls - v_ld) * tx.rate_bp + v_div / 2) / v_div;
        end if;
      end loop;
    else
      v_ls := o.subtotal - v_a_sub;
      v_ld := o.discount_total - v_a_disc;
      v_lsv := o.service_charge - v_a_svc;
      v_lr := o.rounding - v_a_rnd;
      v_lta := v_t_tadd - v_a_tadd;
      v_lti := v_t_tincl - v_a_tincl;
    end if;
    v_a_sub := v_a_sub + v_ls; v_a_disc := v_a_disc + v_ld; v_a_svc := v_a_svc + v_lsv;
    v_a_rnd := v_a_rnd + v_lr; v_a_tadd := v_a_tadd + v_lta; v_a_tincl := v_a_tincl + v_lti;
    insert into _rshare values (oln.id, oln.ticket_line_id, oln.name_snapshot, oln.unit_price, oln.qty,
      v_ls, v_ld, v_lta, v_lti, v_lsv, v_lr);
  end loop;

  -- what to refund: the named lines, or everything still unrefunded
  if p->'lines' is null then
    for sh in select * from _rshare loop
      select coalesce(sum(rl2.qty), 0) into v_done
        from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
        where r2.refund_of = v_orig and r2.deleted_at is null
          and rl2.ticket_line_id = sh.tlid and rl2.deleted_at is null;
      if sh.s_qty - v_done > 0 then
        insert into _rlines values (sh.oline, sh.s_name, sh.s_unit, sh.s_qty - v_done);
      end if;
    end loop;
    if not exists (select 1 from _rlines) then raise exception 'bad-qty'; end if;
  else
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      v_line := (sel->>'receipt_line_id')::uuid;
      select * into sh from _rshare where oline = v_line;
      if not found then raise exception 'bad-line'; end if;
      if v_line = any (v_seen) then raise exception 'bad-payload'; end if;
      v_seen := v_seen || v_line;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 then raise exception 'bad-qty'; end if;
      select coalesce(sum(rl2.qty), 0) into v_done
        from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
        where r2.refund_of = v_orig and r2.deleted_at is null
          and rl2.ticket_line_id = sh.tlid and rl2.deleted_at is null;
      if v_qty + v_done > sh.s_qty then raise exception 'bad-qty'; end if;
      insert into _rlines values (sh.oline, sh.s_name, sh.s_unit, v_qty);
    end loop;
    if not exists (select 1 from _rlines) then raise exception 'bad-payload'; end if;
  end if;

  -- 3+4. each line returns alloc(done + q) - alloc(done) of its shares
  for rw in select rr.oline, rr.r_qty, sx.tlid, sx.s_qty, sx.s_sub, sx.s_disc, sx.s_tadd,
      sx.s_tincl, sx.s_svc, sx.s_rnd
    from _rlines rr join _rshare sx on sx.oline = rr.oline loop
    select coalesce(sum(rl2.qty), 0) into v_done
      from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
      where r2.refund_of = v_orig and r2.deleted_at is null
        and rl2.ticket_line_id = rw.tlid and rl2.deleted_at is null;
    v_sub := v_sub + refund_alloc(rw.s_sub, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_sub, v_done, rw.s_qty);
    v_disc := v_disc + refund_alloc(rw.s_disc, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_disc, v_done, rw.s_qty);
    v_tadd := v_tadd + refund_alloc(rw.s_tadd, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_tadd, v_done, rw.s_qty);
    v_tincl := v_tincl + refund_alloc(rw.s_tincl, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_tincl, v_done, rw.s_qty);
    v_svc := v_svc + refund_alloc(rw.s_svc, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_svc, v_done, rw.s_qty);
    v_rnd := v_rnd + refund_alloc(rw.s_rnd, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_rnd, v_done, rw.s_qty);
  end loop;
  v_total := v_sub - v_disc + v_tadd + v_svc + v_rnd;
  if v_total < 0 then raise exception 'bad-totals'; end if;

  -- money out never exceeds money in: capped by the payments actually received
  -- on the original (amount is already net of change), not by receipts.total
  select coalesce(sum(amount), 0) into v_received from receipt_payments
    where receipt_id = v_orig and tenant_id = p_tenant;
  select coalesce(sum(total), 0) into v_cum from receipts
    where refund_of = v_orig and tenant_id = p_tenant and deleted_at is null;
  if v_cum + v_total > v_received then raise exception 'bad-qty'; end if;

  -- the money going back: validated like receipt payments, must sum exactly
  for pay in select value from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value loop
    v_ptype := (pay->>'payment_type_id')::uuid;
    v_pamt := coalesce((pay->>'amount')::bigint, 0);
    if v_ptype is null or v_pamt <= 0 then raise exception 'bad-payment'; end if;
    if not exists (select 1 from payment_types
        where id = v_ptype and is_active and deleted_at is null) then raise exception 'bad-payment'; end if;
    if pay->>'tendered' is not null then
      v_tender := (pay->>'tendered')::bigint;
      v_change := coalesce((pay->>'change')::bigint, -1);
      if v_tender < v_pamt or v_change <> v_tender - v_pamt then raise exception 'bad-change'; end if;
    end if;
    v_chunk := v_chunk + v_pamt;
  end loop;
  if v_chunk <> v_total then raise exception 'bad-payment'; end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type, refund_of,
      subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, device_time)
    values (v_id, p_tenant, v_store, v_device, o.ticket_id, v_number, 'refund', v_orig,
      v_sub, v_disc, v_tadd + v_tincl, v_svc, v_rnd, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end);

  for rw in select rr.oline, rr.r_name, rr.r_unit, rr.r_qty, sx.tlid
    from _rlines rr join _rshare sx on sx.oline = rr.oline loop
    v_nline := gen_random_uuid();
    insert into receipt_lines (id, tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      values (v_nline, p_tenant, v_id, rw.tlid, rw.r_name, rw.r_unit, rw.r_qty);
    insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price)
      select p_tenant, v_nline, modifier_id, name_snapshot, price
      from receipt_line_modifiers where receipt_line_id = rw.oline and tenant_id = p_tenant;
    insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
      select p_tenant, v_nline, tax_id, name_snapshot, rate_bp, type
      from receipt_line_taxes where receipt_line_id = rw.oline and tenant_id = p_tenant;
  end loop;
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;

  drop table _rlines;
  drop table _rshare;
  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig, 'total', v_total);
end $fn$;
