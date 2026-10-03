-- 0020_refund_snapshots.sql — refunds use line tax/discount/modifier snapshots.
-- Full refunds copy receipt lines + their mod/tax snapshot rows and mirror
-- totals. Partial refunds scale modifier money by qty ratio, allocate the
-- original discount pro-rata by refunded subtotal, and compute tax from the
-- copied snapshot rates (a later VAT rate change never moves a refund).
-- Replaces the 0017 definition; 0017 untouched. Never edit after merge.

create or replace function push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record; v_sub bigint := 0; v_tax bigint := 0; v_total bigint;
  v_osub bigint; v_odisc bigint; v_otax bigint; v_osvc bigint; v_ornd bigint; v_otot bigint;
  sel jsonb; rl record; v_qty int; v_lsub bigint; v_share bigint;
  m record; t record; v_msum bigint; v_scaled bigint;
  v_nline uuid; v_oline_tlid uuid; v_oqty int; rw record;
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
  create temp table _rlines (
    oline uuid, name_snapshot text, unit_price bigint, qty int, line_sub bigint
  ) on commit drop;

  if p->'lines' is null then
    -- full refund: mirror lines verbatim (mods + taxes copied below)
    insert into _rlines
      select id, name_snapshot, unit_price, qty,
        (unit_price * qty + 500) / 1000 +
        coalesce((select sum(x.price) from receipt_line_modifiers x
          where x.receipt_line_id = receipt_lines.id and x.tenant_id = p_tenant), 0)
      from receipt_lines where receipt_id = v_orig and tenant_id = p_tenant;
    v_osub := o.subtotal; v_odisc := o.discount_total; v_otax := o.tax_total;
    v_osvc := o.service_charge; v_ornd := o.rounding; v_otot := o.total;
  else
    -- by-line refund: qty capped, mods scaled, discount shared pro-rata,
    -- tax from the line's snapshot rates
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      select * into rl from receipt_lines
        where id = (sel->>'receipt_line_id')::uuid and receipt_id = v_orig and tenant_id = p_tenant;
      if not found then raise exception 'bad-line'; end if;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 or v_qty > rl.qty then raise exception 'bad-qty'; end if;
      v_msum := 0;
      for m in select price from receipt_line_modifiers
          where receipt_line_id = rl.id and tenant_id = p_tenant loop
        v_scaled := (m.price * v_qty + rl.qty / 2) / rl.qty;
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

  -- copy lines + their mod/tax snapshots row by row (mapped by id, not name)
  for rw in select * from _rlines loop
    select ticket_line_id, qty into v_oline_tlid, v_oqty from receipt_lines
      where id = rw.oline and tenant_id = p_tenant;
    v_nline := gen_random_uuid();
    insert into receipt_lines (id, tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      values (v_nline, p_tenant, v_id, v_oline_tlid, rw.name_snapshot, rw.unit_price, rw.qty);
    insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price)
      select p_tenant, v_nline, modifier_id, name_snapshot,
        case when p->'lines' is null then price
          else (price * rw.qty + v_oqty / 2) / v_oqty end
      from receipt_line_modifiers where receipt_line_id = rw.oline and tenant_id = p_tenant;
    insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
      select p_tenant, v_nline, tax_id, name_snapshot, rate_bp, type
      from receipt_line_taxes where receipt_line_id = rw.oline and tenant_id = p_tenant;
  end loop;

  drop table _rlines;
  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig);
end $fn$;
