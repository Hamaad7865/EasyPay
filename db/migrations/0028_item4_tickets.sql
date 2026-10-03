-- 0028_item4_receipt.sql — item 4 receipt + ticket-guard rework.
-- Owner decisions applied: menu prices INCLUDE VAT (tax_total extracts the
-- portion, never adds); modifiers are flat per line as entered — the UI
-- splits multi-unit picks with differing mods into per-unit lines.
-- Split model (spec 7.4/7.5/5.6/5.8): one receipt per chunk with explicit
-- line attribution. Whole bill (default), by-item selection, or equal shares
-- computed client-side to the cent. Ticket closes when no unpaid lines
-- remain. Double-pay is stored + flagged, never rejected.
-- Also: paid lines refuse void/move/merge ('paid-line'); offline prices
-- (payload unit_price/name, fallback catalog) are accepted and flag the
-- receipt when they differ from the catalog; number collisions disambiguate
-- with a flag; rounding bounded +-500c; service derived from service_pct;
-- every discount needs sale.apply_discount, restricted ones an approver with
-- sale.apply_restricted_discount; _disc temp replaced by a jsonb variable.
-- Replaces push_receipt_create, push_ticket_void_line, push_ticket_move_lines,
-- push_ticket_merge, and sync_push (allowlist + 'paid-line'); older files
-- untouched. Never edit after merge.

create or replace function push_ticket_void_line(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_line uuid; v_reason text; v_paid boolean;
begin
  v_line := (p->>'line_id')::uuid;
  v_reason := nullif(p->>'reason','');
  if v_line is null or v_reason is null then raise exception 'bad-payload'; end if;
  select paid into v_paid from ticket_lines where id = v_line and tenant_id = p_tenant;
  if not found then raise exception 'bad-line'; end if;
  if v_paid then raise exception 'paid-line'; end if;
  update ticket_lines l set voided_at = now(), voided_by = p_emp, void_reason = v_reason
    from tickets t
    where l.id = v_line and l.tenant_id = p_tenant
      and t.tenant_id = p_tenant and t.id = l.ticket_id and t.status = 'open'
      and l.voided_at is null;
  if not found then raise exception 'bad-line'; end if;
  return jsonb_build_object('line_id', v_line);
end $fn$;

create or replace function push_ticket_move_lines(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_to uuid; v_store uuid; lid jsonb; v_id uuid;
begin
  v_to := (p->>'to_ticket_id')::uuid;
  if v_to is null then raise exception 'bad-payload'; end if;
  select store_id into v_store from tickets where id = v_to and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  for lid in select value from jsonb_array_elements(coalesce(p->'line_ids', '[]'::jsonb)) as value loop
    v_id := (lid->>0)::uuid;
    if exists (select 1 from ticket_lines where id = v_id and tenant_id = p_tenant and paid) then
      raise exception 'paid-line';
    end if;
    update ticket_lines l set ticket_id = v_to
      from tickets t
      where l.id = v_id and l.tenant_id = p_tenant and l.voided_at is null
        and t.tenant_id = p_tenant and t.id = l.ticket_id and t.status = 'open'
        and t.store_id = v_store;
    if not found then raise exception 'bad-line'; end if;
  end loop;
  return jsonb_build_object('to_ticket_id', v_to);
end $fn$;

create or replace function push_ticket_merge(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_into uuid; v_store uuid; fid jsonb; v_from uuid;
begin
  v_into := (p->>'into_ticket_id')::uuid;
  if v_into is null then raise exception 'bad-payload'; end if;
  select store_id into v_store from tickets where id = v_into and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  for fid in select value from jsonb_array_elements(coalesce(p->'from_ticket_ids', '[]'::jsonb)) as value loop
    v_from := (fid->>0)::uuid;
    if v_from = v_into then raise exception 'bad-payload'; end if;
    if not exists (select 1 from tickets where id = v_from and tenant_id = p_tenant and status = 'open' and store_id = v_store) then
      raise exception 'bad-ticket';
    end if;
    if exists (select 1 from ticket_lines
        where ticket_id = v_from and tenant_id = p_tenant and voided_at is null and paid) then
      raise exception 'paid-line';
    end if;
    update ticket_lines set ticket_id = v_into
      where ticket_id = v_from and tenant_id = p_tenant and voided_at is null;
    update tickets set status = 'cancelled' where id = v_from;
  end loop;
  return jsonb_build_object('into_ticket_id', v_into);
end $fn$;

create or replace function push_ticket_add_line(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_ticket uuid; v_item uuid; v_variant uuid; v_qty int;
  v_price bigint; v_name text; m jsonb; v_mod uuid; v_grp uuid;
  v_cat record;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_item := (p->>'item_id')::uuid;
  v_qty := coalesce((p->>'qty')::int, 0);
  if v_id is null or v_ticket is null or v_item is null or v_qty <= 0 then raise exception 'bad-payload'; end if;
  if not exists (select 1 from tickets where id = v_ticket and status = 'open') then raise exception 'ticket-closed'; end if;
  -- the row must exist for snapshots, but an offline sale is never rejected
  -- for price/availability drift: payload wins, receipt flags the drift
  select price, name into v_cat from items where id = v_item;
  if not found then raise exception 'unknown-item'; end if;
  v_price := coalesce((p->>'unit_price')::bigint, v_cat.price);
  v_name := coalesce(nullif(p->>'name_snapshot',''), v_cat.name);
  if v_price < 0 then raise exception 'bad-payload'; end if;
  if p->>'variant_id' is not null then
    v_variant := (p->>'variant_id')::uuid;
    select price, name into v_cat from item_variants
      where id = v_variant and item_id = v_item and deleted_at is null;
    if not found then raise exception 'unknown-variant'; end if;
    v_price := coalesce((p->>'unit_price')::bigint, v_cat.price);
    v_name := coalesce(nullif(p->>'name_snapshot',''), v_cat.name);
  end if;
  insert into ticket_lines (id, tenant_id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty, note, course)
    values (v_id, p_tenant, v_ticket, v_item, v_variant, v_name, v_price, v_qty,
      nullif(p->>'note',''),
      case when p->>'course' is null then null else (p->>'course')::int end);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_id, t.id, t.name, t.rate_bp, t.type
    from item_taxes it join taxes t on t.tenant_id = p_tenant and t.id = it.tax_id
    where it.tenant_id = p_tenant and it.item_id = v_item and it.deleted_at is null;
  for m in select value from jsonb_array_elements(coalesce(p->'modifier_ids', '[]'::jsonb)) as value loop
    v_mod := (m->>0)::uuid;
    select group_id into v_grp from modifiers where id = v_mod and deleted_at is null;
    if not found then raise exception 'bad-modifier'; end if;
    if not exists (select 1 from item_modifier_groups
        where tenant_id = p_tenant and item_id = v_item and group_id = v_grp and deleted_at is null) then
      raise exception 'bad-modifier';
    end if;
    insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
      select p_tenant, v_id, mo.id, mo.name, mo.price from modifiers mo where mo.id = v_mod;
  end loop;
  return jsonb_build_object('line_id', v_id);
end $fn$;

create or replace function sync_push(p_employee_id uuid, p_ops jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  tenant uuid;
  n int;
  i int;
  j int;
  op jsonb;
  rop jsonb;
  v_op_id uuid;
  v_type text;
  v_logtype text;
  v_stored jsonb;
  v_data jsonb;
  v_code text;
  v_envelope jsonb;
  res jsonb := '[]'::jsonb;
  codes text[] := array[
    'bad-op-id','bad-payload','unknown-op','bad-store','bad-ticket',
    'ticket-closed','bad-line','bad-item','bad-variant','bad-modifier',
    'bad-dining','bad-discount','bad-payment','bad-change','bad-totals',
    'bad-device','bad-receipt','bad-qty','overpayment','lines-required',
    'empty-ticket','already-refunded','forbidden','conflict',
    'bad-rounding','approval-required','paid-line'];
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no-tenant-context'; end if;
  if not exists (select 1 from employees where id = p_employee_id and deleted_at is null and is_active) then
    raise exception 'unknown-employee';
  end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad-batch'; end if;

  n := jsonb_array_length(p_ops);
  for i in 0..n - 1 loop
    op := p_ops->i;
    begin
      begin
        v_op_id := (op->>'op_id')::uuid;
      exception when others then
        res := res || jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'code', 'bad-op-id');
        continue;
      end;
      if v_op_id is null then
        res := res || jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'code', 'bad-op-id');
        continue;
      end if;
      v_type := op->>'type';
      v_logtype := coalesce(v_type, 'unknown');

      select result into v_stored from sync_ops_applied where op_id = v_op_id;
      if found then
        res := res || (v_stored || jsonb_build_object('replayed', true));
        continue;
      end if;

      begin
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, p_employee_id, op->'payload');
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, p_employee_id, op->'payload');
          when 'ticket.void_line' then v_data := push_ticket_void_line(tenant, p_employee_id, op->'payload');
          when 'ticket.update_meta' then v_data := push_ticket_update_meta(tenant, p_employee_id, op->'payload');
          when 'ticket.move_lines' then v_data := push_ticket_move_lines(tenant, p_employee_id, op->'payload');
          when 'ticket.merge' then v_data := push_ticket_merge(tenant, p_employee_id, op->'payload');
          when 'receipt.create' then v_data := push_receipt_create(tenant, p_employee_id, op->'payload');
          when 'refund.create' then v_data := push_refund_create(tenant, p_employee_id, op->'payload');
          else raise exception 'unknown-op';
        end case;
        v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'data', v_data);
        insert into sync_ops_applied (op_id, tenant_id, type, result)
          values (v_op_id, tenant, v_logtype, v_envelope);
        res := res || v_envelope;
      exception when others then
        if sqlstate = '23505' then
          select result into v_stored from sync_ops_applied where op_id = v_op_id;
          if found then
            res := res || (v_stored || jsonb_build_object('replayed', true));
          else
            v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', 'conflict');
            insert into sync_ops_applied (op_id, tenant_id, type, result)
              values (v_op_id, tenant, v_logtype, v_envelope);
            res := res || v_envelope;
          end if;
        elsif sqlstate like '40%' or sqlstate like '53%' or sqlstate in ('55P03', '57014') then
          for j in i..n - 1 loop
            rop := p_ops->j;
            res := res || jsonb_build_object('op_id', rop->>'op_id', 'status', 'retry', 'code', 'transient');
          end loop;
          return res;
        else
          v_code := case when sqlerrm ~ '^[a-z0-9-]+$' then sqlerrm else 'error' end;
          if not (v_code = any (codes)) then
            raise warning 'sync_push unexpected op %: %', v_op_id, sqlerrm;
            v_code := 'error';
          end if;
          v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', v_code);
          insert into sync_ops_applied (op_id, tenant_id, type, result)
            values (v_op_id, tenant, v_logtype, v_envelope);
          res := res || v_envelope;
        end if;
      end;
    end;
  end loop;
  return res;
end $fn$;
