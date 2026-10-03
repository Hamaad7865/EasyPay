-- 0017_refund_noupdate.sql — push_refund_create computed totals BEFORE insert.
-- The 0012 version inserted a zero row then UPDATEed it, tripping the
-- insert-only trigger on receipts. Same behavior, single insert. Replaces the
-- 0012 definition; 0012 untouched. Never edit after merge.

create or replace function push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record; v_sub bigint := 0; v_tax bigint := 0; v_total bigint;
  v_osub bigint; v_odisc bigint; v_otax bigint; v_osvc bigint; v_ornd bigint; v_otot bigint;
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
  create temp table _refund_lines (
    ticket_line_id uuid, name_snapshot text, unit_price bigint, qty int
  ) on commit drop;

  if p->'lines' is null then
    -- full refund: mirror the original totals into the single insert
    v_osub := o.subtotal; v_odisc := o.discount_total; v_otax := o.tax_total;
    v_osvc := o.service_charge; v_ornd := o.rounding; v_otot := o.total;
  else
    -- by-line refund: qty capped at the original line qty
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      select * into rl from receipt_lines
        where id = (sel->>'receipt_line_id')::uuid and receipt_id = v_orig and tenant_id = p_tenant;
      if not found then raise exception 'bad-line'; end if;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 or v_qty > rl.qty then raise exception 'bad-qty'; end if;
      insert into _refund_lines (ticket_line_id, name_snapshot, unit_price, qty)
        values (rl.ticket_line_id, rl.name_snapshot, rl.unit_price, v_qty);
      v_sub := v_sub + (rl.unit_price * v_qty + 500) / 1000;
    end loop;
    v_tax := (v_sub * 1500 + 5000) / 10000;
    v_total := v_sub + v_tax;
    v_osub := v_sub; v_odisc := 0; v_otax := v_tax; v_osvc := 0; v_ornd := 0; v_otot := v_total;
  end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type, refund_of,
      subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, device_time)
    values (v_id, p_tenant, v_store, v_device, o.ticket_id, v_number, 'refund', v_orig,
      v_osub, v_odisc, v_otax, v_osvc, v_ornd, v_otot, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end);

  if p->'lines' is null then
    insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      select p_tenant, v_id, ticket_line_id, name_snapshot, unit_price, qty
      from receipt_lines where receipt_id = v_orig and tenant_id = p_tenant;
  else
    insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      select p_tenant, v_id, ticket_line_id, name_snapshot, unit_price, qty from _refund_lines;
  end if;

  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig);
end $fn$;
