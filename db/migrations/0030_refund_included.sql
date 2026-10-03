-- 0030_refund_included.sql — included-VAT extraction in by-line refunds
-- (the 0026 loop only handled 'added', yielding tax 0 under included taxes).
-- Replaces push_refund_create; 0026 untouched. Never edit after merge.
-- One-refund-per-receipt is gone: each original line may be refunded up to
-- its own quantity, summed across all refunds of the same original
-- (anything more is 'bad-qty'). A full refund is allowed only with no prior
-- partials, so it always mirrors the original total exactly. Every refund
-- records payment rows (type + amount [+ tendered/change/reference]) summing
-- to the refund total, so the drawer reconciles. Snapshots, permission,
-- reason and single-insert behavior unchanged. Never edit after merge.

create or replace function push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record; v_sub bigint := 0; v_tax bigint := 0; v_total bigint;
  v_tax_add bigint := 0; v_tax_incl bigint := 0; v_div bigint;
  v_osub bigint; v_odisc bigint; v_otax bigint; v_osvc bigint; v_ornd bigint; v_otot bigint;
  sel jsonb; rl record; v_qty int; v_lsub bigint; v_share bigint;
  m record; t record; v_msum bigint; v_scaled bigint;
  v_nline uuid; v_oline_tlid uuid; v_oqty int; rw record;
  pay jsonb; v_ptype uuid; v_pamt bigint; v_tender bigint; v_change bigint; v_chunk bigint := 0;
  v_done bigint;
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
  if nullif(p->>'reason','') is null then raise exception 'bad-payload'; end if;
  drop table if exists _rlines;
  create temp table _rlines (
    oline uuid, name_snapshot text, unit_price bigint, qty int, line_sub bigint
  ) on commit drop;

  if p->'lines' is null then
    -- full refund: only when nothing was refunded before, so the mirror is exact
    if exists (select 1 from receipts
        where refund_of = v_orig and tenant_id = p_tenant and deleted_at is null) then
      raise exception 'bad-qty';
    end if;
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
    -- by-line refund: qty capped by what is still unrefunded on each line
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      select * into rl from receipt_lines
        where id = (sel->>'receipt_line_id')::uuid and receipt_id = v_orig and tenant_id = p_tenant;
      if not found then raise exception 'bad-line'; end if;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 then raise exception 'bad-qty'; end if;
      select coalesce(sum(rl2.qty), 0) into v_done
      from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
      where r2.refund_of = v_orig and r2.deleted_at is null
        and rl2.ticket_line_id = rl.ticket_line_id and rl2.deleted_at is null;
      if v_qty + v_done > rl.qty then raise exception 'bad-qty'; end if;
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
    v_tax := 0; v_tax_add := 0; v_tax_incl := 0;
    for rw in select * from _rlines loop
      v_share := case when v_sub > 0 then v_odisc * rw.line_sub / v_sub else 0 end;
      for t in select rate_bp, type from receipt_line_taxes
          where receipt_line_id = rw.oline and tenant_id = p_tenant loop
        if t.type = 'added' then
          v_tax_add := v_tax_add + ((rw.line_sub - v_share) * t.rate_bp + 5000) / 10000;
        else
          v_div := 10000 + t.rate_bp;
          v_tax_incl := v_tax_incl + ((rw.line_sub - v_share) * t.rate_bp + v_div / 2) / v_div;
        end if;
      end loop;
    end loop;
    v_tax := v_tax_add + v_tax_incl;
    v_total := v_sub - v_odisc + v_tax_add;
    v_osub := v_sub; v_odisc := v_odisc; v_otax := v_tax; v_osvc := 0; v_ornd := 0; v_otot := v_total;
  end if;

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
  if v_chunk <> v_otot then raise exception 'bad-payment'; end if;

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
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;

  drop table _rlines;
  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig);
end $fn$;
