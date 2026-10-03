-- 0015_receipt_varfix.sql — fix plpgsql variable/alias collisions in
-- push_receipt_create (record vars l/t shadowed table aliases l/t, raising
-- "record is not assigned yet"). Records renamed r_line/r_tax; logic identical.
-- create or replace; 0012 untouched. Never edit after merge.
--
-- (line_amount + push_refund_create below are re-stated unchanged so this file
-- is self-contained; they are idempotent create-or-replace.)
-- Server recomputes every cent: subtotal from non-void lines (price snapshots
-- + modifiers), discounts validated against the discounts table, tax from line
-- tax snapshots with pro-rata discount allocation, total assembled by the
-- server (lines + added tax + service + rounding - discounts, spec 14.12).
-- First receipt.create closes the ticket; a second is accepted and flagged
-- needs_review (spec 5.6/5.8: payments are never discarded). Refunds need the
-- sale.refund permission (waiter refund is rejected, spec Phase 4 exit).
-- By-line refunds recompute tax at the default VAT rate (line-level tax
-- attribution is exact only on full refunds, which mirror the original).
-- Never edit after merge.

-- Line amount in cents from thousandths qty, half-up.
create or replace function line_amount(p_price bigint, p_qty int) returns bigint
language sql immutable set search_path = public as $$
  select (p_price * p_qty + 500) / 1000
$$;

create or replace function push_receipt_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_ticket uuid; v_store uuid; v_device uuid;
  v_tstatus text; v_sub bigint := 0; v_disc bigint := 0; v_tax bigint := 0;
  v_service bigint := 0; v_round bigint := 0; v_total bigint;
  v_chunk bigint := 0; v_prior bigint := 0; v_review boolean;
  v_number text; v_seq int; v_lock text;
  d jsonb; v_dtype text; v_dval bigint; v_dname text; v_did uuid; v_amt bigint;
  pay jsonb; v_ptype uuid; v_pamt bigint; v_tender bigint; v_change bigint;
  lid jsonb; v_lid uuid; covered uuid[] := '{}';
  r_line record; r_tax record; v_pl bigint; v_remaining bigint;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_number := nullif(p->>'number','');
  v_seq := coalesce((p->>'device_seq')::int, 0);
  if v_id is null or v_ticket is null or v_store is null or v_device is null or v_number is null then
    raise exception 'bad-payload';
  end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store) then
    raise exception 'bad-device';
  end if;
  select status into v_tstatus from tickets where id = v_ticket and store_id = v_store;
  if not found then raise exception 'bad-ticket'; end if;
  if v_tstatus = 'cancelled' then raise exception 'ticket-closed'; end if;

  -- Serialize concurrent pays on one ticket (double-pay offline, spec 14.6).
  v_lock := 'receipt:' || v_ticket::text;
  perform pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  -- Covered lines: explicit list for partial chunks, else all non-void lines.
  if p->'line_ids' is not null and jsonb_array_length(p->'line_ids') > 0 then
    for lid in select value from jsonb_array_elements(p->'line_ids') as value loop
      v_lid := (lid->>0)::uuid;
      if not exists (select 1 from ticket_lines
          where id = v_lid and ticket_id = v_ticket and tenant_id = p_tenant and voided_at is null) then
        raise exception 'bad-line';
      end if;
      covered := covered || v_lid;
    end loop;
  else
    select array_agg(id) into covered from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant and voided_at is null and deleted_at is null;
    if covered is null then raise exception 'empty-ticket'; end if;
  end if;

  -- Subtotal from snapshots (catalog edits after the sale cannot move it, 14.7).
  select coalesce(sum(line_amount(l.unit_price, l.qty) +
      coalesce((select sum(m.price) from ticket_line_modifiers m
        where m.line_id = l.id and m.tenant_id = p_tenant and m.deleted_at is null), 0)), 0)
    into v_sub from ticket_lines l where l.id = any(covered);

  -- Discounts validated against the table (percent of subtotal; fixed capped).
  create temp table _disc(name text, amount bigint, did uuid) on commit drop;
  for d in select value from jsonb_array_elements(coalesce(p->'discounts', '[]'::jsonb)) as value loop
    v_did := case when d->>'discount_id' is null then null else (d->>'discount_id')::uuid end;
    if v_did is not null then
      select type, value, name into v_dtype, v_dval, v_dname from discounts
        where id = v_did and deleted_at is null;
      if not found then raise exception 'bad-discount'; end if;
    else
      v_dtype := coalesce(d->>'type', 'amount');
      v_dval := coalesce((d->>'value')::bigint, 0);
      v_dname := coalesce(nullif(d->>'name',''), 'Discount');
      if v_dtype not in ('percent','amount') or v_dval < 0 then raise exception 'bad-discount'; end if;
    end if;
    v_amt := case when v_dtype = 'percent' then (v_sub * v_dval + 50) / 100 else least(v_dval, v_sub - v_disc) end;
    if v_amt < 0 then v_amt := 0; end if;
    v_disc := v_disc + v_amt;
    insert into _disc values (v_dname, v_amt, v_did);
  end loop;

  -- Tax from line snapshots, discount allocated pro-rata per line.
  for r_line in select l.id, line_amount(l.unit_price, l.qty) +
      coalesce((select sum(m.price) from ticket_line_modifiers m
        where m.line_id = l.id and m.tenant_id = p_tenant and m.deleted_at is null), 0) as base
    from ticket_lines l where l.id = any(covered) loop
    v_pl := case when v_sub > 0 then v_disc * r_line.base / v_sub else 0 end;
    for r_tax in select rate_bp, type from ticket_line_taxes
        where line_id = r_line.id and tenant_id = p_tenant and deleted_at is null loop
      if r_tax.type = 'added' then
        v_tax := v_tax + ((r_line.base - v_pl) * r_tax.rate_bp + 5000) / 10000;
      end if;
    end loop;
  end loop;

  v_service := coalesce((p->>'service_charge')::bigint, 0);
  v_round := coalesce((p->>'rounding')::bigint, 0);
  if v_service < 0 then raise exception 'bad-totals'; end if;
  v_total := v_sub - v_disc + v_tax + v_service + v_round;
  if v_total < 0 then raise exception 'bad-totals'; end if;

  -- Payments validated (types active in-tenant; cash change arithmetic exact).
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

  select coalesce(sum(total), 0) into v_prior from receipts
    where ticket_id = v_ticket and tenant_id = p_tenant and type = 'sale' and deleted_at is null;
  v_review := v_prior >= v_total and v_total > 0;

  if not v_review then
    v_remaining := v_total - v_prior;
    if v_total = 0 then
      if v_chunk <> 0 then raise exception 'overpayment'; end if;
    elsif v_chunk > v_remaining then
      raise exception 'overpayment';
    elsif v_chunk < v_remaining then
      -- partial chunk: allowed, keeps the ticket open (spec 7.5), but the
      -- covered lines must be named so paid flags stay exact
      if v_chunk <= 0 then raise exception 'bad-payment'; end if;
      if p->'line_ids' is null then raise exception 'lines-required'; end if;
    end if;
  end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type,
      subtotal, discount_total, tax_total, service_charge, rounding, total,
      employee_id, device_time, needs_review)
    values (v_id, p_tenant, v_store, v_device, v_ticket, v_number, 'sale',
      v_sub, v_disc, v_tax, v_service, v_round, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end,
      v_review);

  -- Snapshot lines + mods + taxes + discounts + payments (frozen forever).
  insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
    select p_tenant, v_id, l.id, l.name_snapshot, l.unit_price, l.qty
    from ticket_lines l where l.id = any(covered);
  insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price)
    select p_tenant, rl.id, m.modifier_id, m.name_snapshot, m.price
    from receipt_lines rl join ticket_line_modifiers m
      on m.tenant_id = p_tenant and m.line_id = rl.ticket_line_id
    where rl.receipt_id = v_id and rl.tenant_id = p_tenant;
  insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, rl.id, t.tax_id, t.name_snapshot, t.rate_bp, t.type
    from receipt_lines rl join ticket_line_taxes t
      on t.tenant_id = p_tenant and t.line_id = rl.ticket_line_id
    where rl.receipt_id = v_id and rl.tenant_id = p_tenant;
  insert into receipt_discounts (tenant_id, receipt_id, discount_id, name_snapshot, amount)
    select p_tenant, v_id, did, name, amount from _disc;
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;

  update ticket_lines set paid = true where id = any(covered) and tenant_id = p_tenant;
  update pos_devices set last_receipt_seq = greatest(last_receipt_seq, v_seq)
    where id = v_device and tenant_id = p_tenant;
  if not v_review and v_prior + v_chunk >= v_total then
    update tickets set status = 'paid' where id = v_ticket;
  end if;
  drop table _disc;

  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'total', v_total, 'needs_review', v_review);
end $fn$;

create or replace function push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record; v_sub bigint := 0; v_tax bigint := 0; v_total bigint;
  sel jsonb; rl record; v_qty int;
begin
  if not has_perm(p_emp, 'sale.refund') then raise exception 'forbidden'; end if;
  v_id := (p->>'id')::uuid;
  v_orig := (p->>'refund_of')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_number := nullif(p->>'number','');
  if v_id is null or v_orig is null or v_store is null or v_device is null or v_number is null then
    raise exception 'bad-payload'; end if;
  select * into o from receipts
    where id = v_orig and tenant_id = p_tenant and type = 'sale' and deleted_at is null;
  if not found then raise exception 'bad-receipt'; end if;
  if exists (select 1 from receipts where refund_of = v_orig and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'already-refunded';
  end if;
  if nullif(p->>'reason','') is null then raise exception 'bad-payload'; end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type, refund_of,
      subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, device_time)
    values (v_id, p_tenant, v_store, v_device, o.ticket_id, v_number, 'refund', v_orig,
      0, 0, 0, 0, 0, 0, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end);

  if p->'lines' is null then
    -- full refund: mirror every original line
    insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      select p_tenant, v_id, ticket_line_id, name_snapshot, unit_price, qty
      from receipt_lines where receipt_id = v_orig and tenant_id = p_tenant;
    v_sub := o.subtotal; v_tax := o.tax_total;
    update receipts set subtotal = o.subtotal, discount_total = o.discount_total,
      tax_total = o.tax_total, service_charge = o.service_charge, rounding = o.rounding, total = o.total
      where id = v_id;
  else
    -- by-line refund: qty capped at the original line qty
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      select * into rl from receipt_lines
        where id = (sel->>'receipt_line_id')::uuid and receipt_id = v_orig and tenant_id = p_tenant;
      if not found then raise exception 'bad-line'; end if;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 or v_qty > rl.qty then raise exception 'bad-qty'; end if;
      insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
        values (p_tenant, v_id, rl.ticket_line_id, rl.name_snapshot, rl.unit_price, v_qty);
      v_sub := v_sub + (rl.unit_price * v_qty + 500) / 1000;
    end loop;
    v_tax := (v_sub * 1500 + 5000) / 10000;
    v_total := v_sub + v_tax;
    update receipts set subtotal = v_sub, tax_total = v_tax, total = v_total where id = v_id;
  end if;

  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig);
end $fn$;
