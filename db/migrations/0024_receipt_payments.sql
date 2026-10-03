-- 0024_receipt_payments.sql — restore the receipt_payments insert dropped in
-- the 0021 rewrite (receipts applied with zero payment rows), and make temp
-- tables batch-safe (drop-if-exists first: two receipt/refund ops in one
-- batch must not collide on _rdisc/_rlines). Replaces push_receipt_create and
-- push_refund_create; 0021 untouched. Never edit after merge.
-- (0021 semantics retained: ticket-scoped close, per-unit mods, bounded
-- rounding, derived service, approval enforcement, skip-paid partials.)

-- per-unit line base shared by receipt + refund
create or replace function line_base(p_unit bigint, p_mods bigint, p_qty int) returns bigint
language sql immutable set search_path = public as $$
  select ((p_unit + p_mods) * p_qty + 500) / 1000
$$;

create or replace function push_receipt_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_ticket uuid; v_store uuid; v_device uuid;
  v_tstatus text; v_sub bigint := 0; v_disc bigint := 0; v_tax bigint := 0;
  v_service bigint := 0; v_round bigint := 0; v_total bigint;
  v_chunk bigint := 0; v_prior bigint := 0; v_review boolean;
  v_number text; v_seq int; v_lock text; v_pct int;
  d jsonb; v_dtype text; v_dval bigint; v_dname text; v_did uuid; v_amt bigint;
  pay jsonb; v_ptype uuid; v_pamt bigint; v_tender bigint; v_change bigint;
  lid jsonb; v_lid uuid; covered uuid[] := '{}';
  r_line record; r_tax record; v_pl bigint;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_number := nullif(p->>'number','');
  v_seq := coalesce((p->>'device_seq')::int, 0);
  if v_id is null or v_ticket is null or v_store is null or v_device is null or v_number is null then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store) then
    raise exception 'bad-device'; end if;
  select status into v_tstatus from tickets where id = v_ticket and store_id = v_store;
  if not found then raise exception 'bad-ticket'; end if;
  if v_tstatus = 'cancelled' then raise exception 'ticket-closed'; end if;

  v_lock := 'receipt:' || v_ticket::text;
  perform pg_advisory_xact_lock(hashtextextended(v_lock, 0));

  -- unpaid lines decide open vs already-paid (per-ticket accounting)
  if not exists (select 1 from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null and not paid) then
    v_review := true;
  else
    v_review := false;
  end if;

  -- covered: named lines minus already-paid, else all unpaid non-void lines
  if p->'line_ids' is not null and jsonb_array_length(p->'line_ids') > 0 then
    for lid in select value from jsonb_array_elements(p->'line_ids') as value loop
      v_lid := (lid->>0)::uuid;
      if not exists (select 1 from ticket_lines
          where id = v_lid and ticket_id = v_ticket and tenant_id = p_tenant and voided_at is null) then
        raise exception 'bad-line';
      end if;
      covered := covered || v_lid;
    end loop;
    select array_agg(x) into covered from unnest(covered) x
      where x in (select id from ticket_lines where ticket_id = v_ticket and not paid);
    if covered is null then covered := '{}'; end if;
  else
    select array_agg(id) into covered from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null and not paid;
    if covered is null then covered := '{}'; end if;
  end if;

  -- subtotal from snapshots, modifiers per unit
  select coalesce(sum(line_base(l.unit_price,
      coalesce((select sum(m.price) from ticket_line_modifiers m
        where m.line_id = l.id and m.tenant_id = p_tenant and m.deleted_at is null), 0)::bigint,
      l.qty)), 0)
    into v_sub from ticket_lines l where l.id = any(covered);

  -- prior chunks exist: no new discounts/service/rounding mid-ticket
  select coalesce(sum(total), 0) into v_prior from receipts
    where ticket_id = v_ticket and tenant_id = p_tenant and type = 'sale' and deleted_at is null;
  if v_prior > 0 and (coalesce(jsonb_array_length(p->'discounts'), 0) > 0
      or coalesce((p->>'service_pct')::int, 0) <> 0
      or coalesce((p->>'rounding')::bigint, 0) <> 0) then
    raise exception 'bad-payload';
  end if;
  if p ? 'service_charge' then raise exception 'bad-payload'; end if;

  -- discounts validated; restricted ones need a permited approver.
  -- computed rows staged in _rdisc for the receipt_discounts insert below.
  -- dropped first: two receipt ops in one batch share the session.
  drop table if exists _rdisc;
  create temp table _rdisc(name text, amount bigint, did uuid, approver uuid) on commit drop;
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
    if v_did is not null and exists (select 1 from discounts where id = v_did and requires_approval) then
      if d->>'approved_by' is null then raise exception 'approval-required'; end if;
      if not has_perm((d->>'approved_by')::uuid, 'sale.apply_restricted_discount') then
        raise exception 'approval-required';
      end if;
    end if;
    v_amt := case when v_dtype = 'percent' then (v_sub * v_dval + 50) / 100 else least(v_dval, v_sub - v_disc) end;
    if v_amt < 0 then v_amt := 0; end if;
    v_disc := v_disc + v_amt;
    insert into _rdisc values (v_dname, v_amt, v_did,
      case when d->>'approved_by' is null then null else (d->>'approved_by')::uuid end);
  end loop;

  -- tax from line snapshots, discount allocated pro-rata per line
  for r_line in
    select l.id,
      line_base(l.unit_price,
        coalesce((select sum(m.price) from ticket_line_modifiers m
          where m.line_id = l.id and m.tenant_id = p_tenant and m.deleted_at is null), 0)::bigint,
        l.qty) as base
    from ticket_lines l where l.id = any(covered) loop
    v_pl := case when v_sub > 0 then v_disc * r_line.base / v_sub else 0 end;
    for r_tax in select rate_bp, type from ticket_line_taxes
        where line_id = r_line.id and tenant_id = p_tenant and deleted_at is null loop
      if r_tax.type = 'added' then
        v_tax := v_tax + ((r_line.base::bigint - v_pl) * r_tax.rate_bp + 5000) / 10000;
      end if;
    end loop;
  end loop;

  -- service derived from bps; rounding bounded (Phase 5 owns the real rule)
  v_pct := coalesce((p->>'service_pct')::int, 0);
  if v_pct < 0 or v_pct > 2000 then raise exception 'bad-payload'; end if;
  v_service := ((v_sub - v_disc) * v_pct + 5000) / 10000;
  v_round := coalesce((p->>'rounding')::bigint, 0);
  if v_round < -500 or v_round > 500 then raise exception 'bad-rounding'; end if;
  v_total := v_sub - v_disc + v_tax + v_service + v_round;
  if v_total < 0 then raise exception 'bad-totals'; end if;

  -- payments validated; chunk must equal this chunk's total exactly
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
  if not v_review and v_chunk <> v_total then
    raise exception 'overpayment';
  end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type,
      subtotal, discount_total, tax_total, service_charge, rounding, total,
      employee_id, device_time, needs_review)
    values (v_id, p_tenant, v_store, v_device, v_ticket, v_number, 'sale',
      v_sub, v_disc, v_tax, v_service, v_round, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end,
      v_review);

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
  insert into receipt_discounts (tenant_id, receipt_id, discount_id, name_snapshot, amount, approved_by)
    select p_tenant, v_id, did, name, amount, approver from _rdisc;
  drop table _rdisc;
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;
  update ticket_lines set paid = true where id = any(covered) and tenant_id = p_tenant;
  update pos_devices set last_receipt_seq = greatest(last_receipt_seq, v_seq)
    where id = v_device and tenant_id = p_tenant;
  if not v_review and not exists (select 1 from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null and not paid) then
    update tickets set status = 'paid' where id = v_ticket;
  end if;

  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'total', v_total, 'needs_review', v_review);
end $fn$;

-- push_refund_create with per-unit modifier scaling (matches the per-unit
-- semantics above; supersedes the ratio-based 0020 version, which is
-- equivalent for full-qty refunds and within 1c otherwise).
create or replace function push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record; v_sub bigint := 0; v_tax bigint := 0; v_total bigint;
  v_osub bigint; v_odisc bigint; v_otax bigint; v_osvc bigint; v_ornd bigint; v_otot bigint;
  sel jsonb; rl record; v_qty int; v_lsub bigint; v_share bigint;
  m record; t record; v_msum bigint; v_scaled bigint;
  v_nline uuid; v_oline_tlid uuid; rw record;
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
  drop table if exists _rlines;
  create temp table _rlines (
    oline uuid, name_snapshot text, unit_price bigint, qty int, line_sub bigint
  ) on commit drop;

  if p->'lines' is null then
    insert into _rlines
      select id, name_snapshot, unit_price, qty,
        line_base(unit_price,
          coalesce((select sum(x.price) from receipt_line_modifiers x
            where x.receipt_line_id = receipt_lines.id and x.tenant_id = p_tenant), 0)::bigint,
          qty)
      from receipt_lines where receipt_id = v_orig and tenant_id = p_tenant;
    v_osub := o.subtotal; v_odisc := o.discount_total; v_otax := o.tax_total;
    v_osvc := o.service_charge; v_ornd := o.rounding; v_otot := o.total;
  else
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      select * into rl from receipt_lines
        where id = (sel->>'receipt_line_id')::uuid and receipt_id = v_orig and tenant_id = p_tenant;
      if not found then raise exception 'bad-line'; end if;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 or v_qty > rl.qty then raise exception 'bad-qty'; end if;
      v_msum := 0;
      for m in select price from receipt_line_modifiers
          where receipt_line_id = rl.id and tenant_id = p_tenant loop
        v_scaled := (m.price * v_qty + 500) / 1000;
        v_msum := v_msum + v_scaled;
      end loop;
      v_lsub := (rl.unit_price * v_qty + 500) / 1000 + v_msum;
      insert into _rlines values (rl.id, rl.name_snapshot, rl.unit_price, v_qty, v_lsub);
      v_sub := v_sub + v_lsub;
    end loop;
    v_odisc := case when o.subtotal > 0 then o.discount_total * v_sub / o.subtotal else 0 end;
    v_tax := 0;
    for rw in select * from _rlines loop
      v_share := case when v_sub > 0 then v_odisc * rw.line_sub / v_sub else 0 end;
      for t in select rate_bp, type from receipt_line_taxes
          where receipt_line_id = rw.oline and tenant_id = p_tenant loop
        if t.type = 'added' then
          v_tax := v_tax + ((rw.line_sub - v_share) * t.rate_bp + 5000) / 10000;
        end if;
      end loop;
    end loop;
    v_total := v_sub - v_odisc + v_tax;
    v_osub := v_sub; v_odisc := v_odisc; v_otax := v_tax; v_osvc := 0; v_ornd := 0; v_otot := v_total;
  end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type, refund_of,
      subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, device_time)
    values (v_id, p_tenant, v_store, v_device, o.ticket_id, v_number, 'refund', v_orig,
      v_osub, v_odisc, v_otax, v_osvc, v_ornd, v_otot, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end);

  for rw in select * from _rlines loop
    select ticket_line_id into v_oline_tlid from receipt_lines
      where id = rw.oline and tenant_id = p_tenant;
    v_nline := gen_random_uuid();
    insert into receipt_lines (id, tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      values (v_nline, p_tenant, v_id, v_oline_tlid, rw.name_snapshot, rw.unit_price, rw.qty);
    insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price)
      select p_tenant, v_nline, modifier_id, name_snapshot, price
      from receipt_line_modifiers where receipt_line_id = rw.oline and tenant_id = p_tenant;
    insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
      select p_tenant, v_nline, tax_id, name_snapshot, rate_bp, type
      from receipt_line_taxes where receipt_line_id = rw.oline and tenant_id = p_tenant;
  end loop;

  drop table _rlines;
  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig);
end $fn$;
