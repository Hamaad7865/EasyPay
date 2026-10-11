-- 0097: a product's variants, from a shop's till.
--
-- The last of what a shop on the offline plan sets up on its tablet
-- (docs/superpowers/specs/2026-10-11-tablet-alone-design.md).
--
--   variants.make    the product's options (Size, Colour) and the lines to
--                    make, each under the id the tablet made. The back
--                    office's variants_generate makes its own ids, which a
--                    tablet that works on its own cannot use: it sells a
--                    variant before the server has heard of it, and the
--                    sale names the variant by the tablet's id. So this
--                    takes the ids. Its rules are variants_generate's: one
--                    to three options, no line twice, a product with stock
--                    of its own is not given variants, 200 lines at most. A
--                    line the product already has is left as it is.
--   variants.save    a line's barcode, SKU and cost. Not its price: that is
--                    item.set_price's, which writes the change down.
--   variant.remove   variant_archive: not while the line holds stock.
--
-- New refusals: bad-options, too-many-variants, has-stock.
-- Source: sync_push is its live definition on the dev branch with the lines
-- this migration adds.

create or replace function push_variants_make(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_item items%rowtype; v_id uuid; v_n int; v_names text[] := '{}'; v_name text;
  v_live int; v_created int := 0; v_existing int := 0;
  l jsonb; v_vid uuid; v_vals text[]; v_seen text[] := '{}'; v_key text; i int;
begin
  begin
    v_id := (p->>'item_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'names') is distinct from 'array' or jsonb_typeof(p->'lines') is distinct from 'array' then
    raise exception 'bad-payload';
  end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- two sends for one product wait their turn here
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select * into v_item from items where tenant_id = p_tenant and id = v_id and deleted_at is null for update;
  if not found then raise exception 'unknown-item'; end if;
  v_n := jsonb_array_length(p->'names');
  if v_n < 1 or v_n > 3 or jsonb_array_length(p->'lines') < 1 then raise exception 'bad-options'; end if;
  for i in 0..v_n - 1 loop
    v_name := btrim(coalesce(p->'names'->>i, ''));
    if v_name = '' or length(v_name) > 30 or exists (select 1 from unnest(v_names) x where lower(x) = lower(v_name)) then
      raise exception 'bad-options';
    end if;
    v_names := v_names || v_name;
  end loop;
  select count(*) into v_live from item_variants where tenant_id = p_tenant and item_id = v_id and deleted_at is null;
  -- a product that has variants keeps its number of options
  if v_live > 0 and coalesce(array_length(v_item.option_names, 1), 0) <> v_n then raise exception 'bad-options'; end if;
  -- stock held by the product itself would belong to no line once it has lines
  if v_live = 0 and (coalesce(v_item.stock_qty, 0) <> 0
      or exists (select 1 from stock_levels where tenant_id = p_tenant and item_id = v_id and qty <> 0)) then
    raise exception 'has-stock';
  end if;
  update items set option_names = v_names where tenant_id = p_tenant and id = v_id;
  for l in select * from jsonb_array_elements(p->'lines') loop
    begin
      v_vid := (l->>'id')::uuid;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_vid is null or jsonb_typeof(l->'values') is distinct from 'array' or jsonb_array_length(l->'values') <> v_n then
      raise exception 'bad-options';
    end if;
    select array_agg(btrim(x) order by ord) into v_vals from jsonb_array_elements_text(l->'values') with ordinality as t(x, ord);
    if exists (select 1 from unnest(v_vals) x where x = '' or length(x) > 30) then raise exception 'bad-options'; end if;
    v_key := lower(array_to_string(v_vals, chr(31)));
    -- the same line twice in one send
    if v_key = any (v_seen) then raise exception 'bad-options'; end if;
    v_seen := v_seen || v_key;
    -- a line the product has already, by its values or by this id, is left as it is
    if exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.item_id = v_id and v.deleted_at is null
                and lower(array_to_string(v.option_values, chr(31))) = v_key)
       or exists (select 1 from item_variants v where v.tenant_id = p_tenant and v.id = v_vid) then
      v_existing := v_existing + 1;
      continue;
    end if;
    insert into item_variants (id, tenant_id, item_id, name, price, cost, option_values)
      values (v_vid, p_tenant, v_id, array_to_string(v_vals, ' / '), v_item.price, v_item.cost, v_vals);
    v_created := v_created + 1;
  end loop;
  if v_live + v_created > 200 then raise exception 'too-many-variants'; end if;
  -- a shop that has its barcodes made automatically: the new lines get theirs (0080; nothing otherwise)
  perform barcodes_auto(p_tenant, v_id);
  return jsonb_build_object('created', v_created, 'existing', v_existing);
end $fn$;

create or replace function push_variants_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; l jsonb; v_vid uuid; v_cost bigint; v_may boolean; v_n int := 0;
begin
  begin
    v_id := (p->>'item_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'lines') is distinct from 'array' or jsonb_array_length(p->'lines') > 200 then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- a cost is written only for someone who may see cost, or with the word of someone who may
  v_may := may(p_emp, p, 'costs.view');
  for l in select * from jsonb_array_elements(p->'lines') loop
    begin
      v_vid := (l->>'id')::uuid;
      v_cost := (l->>'cost')::bigint;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_vid is null or v_cost < 0 or v_cost > 100000000 or length(coalesce(l->>'barcode', '')) > 64 then raise exception 'bad-payload'; end if;
    update item_variants v set
        barcode = case when l ? 'barcode' then nullif(regexp_replace(coalesce(l->>'barcode', ''), '\s+', '', 'g'), '') else v.barcode end,
        sku = case when l ? 'sku' then nullif(left(btrim(coalesce(l->>'sku', '')), 60), '') else v.sku end,
        cost = case when l ? 'cost' and v_may then v_cost else v.cost end
     where v.tenant_id = p_tenant and v.item_id = v_id and v.id = v_vid and v.deleted_at is null;
    if not found then raise exception 'unknown-variant'; end if;
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('saved', v_n);
end $fn$;

create or replace function push_variant_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid;
begin
  begin
    v_id := (p->>'variant_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- removed already is removed
  if exists (select 1 from item_variants where tenant_id = p_tenant and id = v_id and deleted_at is not null) then
    return jsonb_build_object('variant_id', v_id);
  end if;
  perform variant_archive(p_tenant, v_id);
  return jsonb_build_object('variant_id', v_id);
end $fn$;

-- ---- as it was on dev, with the lines this migration adds ----

CREATE OR REPLACE FUNCTION public.sync_push(p_employee_id uuid, p_ops jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  v_emp uuid;
  v_payload jsonb;
  v_appr uuid;
  res jsonb := '[]'::jsonb;
  codes text[] := array[
    'bad-op-id','bad-payload','unknown-op','bad-store','bad-ticket',
    'ticket-closed','bad-line','bad-item','bad-variant','bad-modifier',
    'bad-dining','bad-discount','bad-payment','bad-change','bad-totals',
    'bad-device','bad-receipt','bad-qty','overpayment','lines-required',
    'empty-ticket','already-refunded','forbidden','conflict',
    'bad-rounding','approval-required','paid-line',
    'unknown-item','unknown-variant',
    'bad-employee','bad-shift','shift-closed',
    -- an item made or changed from a till (0084)
    'name-required','bad-category','barcode-taken','sku-taken','open-price-not-here',
    -- a premium feature asked of a restaurant whose plan does not carry it (0085)
    'not-premium',
    -- a category, and stock, changed from a till (0087)
    'has-items','bad-reason','not-counted','pick-variant','not-enough-stock',
    -- a tablet's first-run set-up (0089)
    'too-many','room-exists','name-taken','bad-address','bad-printer','bad-role','bad-pin','unknown-staff',
    -- a till's answer to what the back office asked of it (0091)
    'bad-request',
    -- a shop's stock tools on its till (0092)
    'unknown-supplier','unknown-store','unknown-order','not-draft','no-lines','already-received','not-open','not-part',
    'bad-delivery','nothing-received','unknown-line','bad-scope','nothing-to-count','bad-uncounted','bad-quantity',
    -- taxes and the fuller product sheet from a till (0094)
    'bad-rate','bad-tax',
    -- roles, staff and discounts from a till (0095)
    'owner-role','role-in-use','has-login','bad-value',
    -- add-ons and settings from a till (0096)
    'bad-limits','bad-group',
    -- a product's variants from a till (0097)
    'bad-options','too-many-variants','has-stock'];
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no-tenant-context'; end if;
  if not exists (select 1 from employees where id = p_employee_id and deleted_at is null and is_active) then
    raise exception 'unknown-employee';
  end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad-batch'; end if;
  -- Whether the login pushing may vouch for staff: it may set up tills, so
  -- its word is taken for who did each thing and who approved it. The
  -- functions that store a refund and a bill ask this (0082): a refund or a
  -- discount the roles do not allow is stored and flagged when it comes from
  -- such a login, and refused, as it always was, from any other.
  perform set_config('app.till_vouched', case when has_perm(p_employee_id, 'settings.device') then '1' else '' end, true);

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
        -- Who did it. The op names the member of staff who was signed in at
        -- the till with their PIN. An op that names nobody (a till with no
        -- staff PINs, or an older build) is the signed-in login's own.
        -- The login vouches for its staff only if it is allowed to set up
        -- tills; otherwise the op stays the login's own, so a lesser login
        -- cannot borrow someone else's permissions. Nothing is rejected for
        -- that: a sale must not be lost over who rang it up.
        v_emp := p_employee_id;
        if op->>'employee_id' is not null and has_perm(p_employee_id, 'settings.device') then
          begin
            v_emp := (op->>'employee_id')::uuid;
          exception when others then
            raise exception 'bad-employee';
          end;
          -- switched off or removed since is fine (the sale happened); an id
          -- that was never this restaurant's is not
          if not exists (select 1 from employees where id = v_emp and tenant_id = tenant) then
            raise exception 'bad-employee';
          end if;
        end if;
        -- Who approved it. When the person at the till may not do something,
        -- someone who may enters their own PIN there, and the op names them
        -- in its payload as approved_by. The same rule as for employee_id:
        -- it counts only from a login allowed to set up tills. From any other
        -- login it is dropped, and the op stands or falls on who sent it.
        v_payload := op->'payload';
        v_appr := null;
        if v_payload ? 'approved_by' then
          if has_perm(p_employee_id, 'settings.device') then
            begin
              v_appr := nullif(v_payload->>'approved_by', '')::uuid;
            exception when others then
              raise exception 'bad-employee';
            end;
            if v_appr is not null and not exists (select 1 from employees where id = v_appr and tenant_id = tenant) then
              raise exception 'bad-employee';
            end if;
          else
            v_payload := v_payload - 'approved_by';
          end if;
        end if;
        -- A discount that needs a manager names who approved it inside the
        -- discount itself. The same rule holds there (0082): from a login
        -- that may not set up tills it is dropped, and the discount stands
        -- or falls on who sent it.
        if jsonb_typeof(v_payload->'discounts') = 'array' and not has_perm(p_employee_id, 'settings.device') then
          v_payload := jsonb_set(v_payload, '{discounts}', (
            select coalesce(jsonb_agg(case when jsonb_typeof(x.d) = 'object' then x.d - 'approved_by' else x.d end order by x.n), '[]'::jsonb)
              from jsonb_array_elements(v_payload->'discounts') with ordinality as x(d, n)));
        end if;
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, v_emp, v_payload);
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, v_emp, v_payload);
          when 'ticket.edit_line' then v_data := push_ticket_edit_line(tenant, v_emp, v_payload);
          when 'ticket.void_line' then v_data := push_ticket_void_line(tenant, v_emp, v_payload);
          when 'ticket.update_meta' then v_data := push_ticket_update_meta(tenant, v_emp, v_payload);
          when 'ticket.move_lines' then v_data := push_ticket_move_lines(tenant, v_emp, v_payload);
          when 'ticket.merge' then v_data := push_ticket_merge(tenant, v_emp, v_payload);
          when 'receipt.create' then v_data := push_receipt_create(tenant, v_emp, v_payload);
          when 'refund.create' then v_data := push_refund_create(tenant, v_emp, v_payload);
          when 'shift.open' then v_data := push_shift_open(tenant, v_emp, v_payload);
          when 'shift.close' then v_data := push_shift_close(tenant, v_emp, v_payload);
          when 'timeclock.punch' then v_data := push_timeclock_punch(tenant, v_emp, v_payload);
          when 'ticket.send' then v_data := push_ticket_send(tenant, v_emp, v_payload);
          when 'ticket.split_line' then v_data := push_ticket_split_line(tenant, v_emp, v_payload);
          when 'ticket.place_lines' then v_data := push_ticket_place_lines(tenant, v_emp, v_payload);
          when 'customer.upsert' then v_data := push_customer_upsert(tenant, v_emp, v_payload);
          when 'ticket.stage' then v_data := push_ticket_stage(tenant, v_emp, v_payload);
          when 'ticket.cancel' then v_data := push_ticket_cancel(tenant, v_emp, v_payload);
          when 'kitchen.mark' then v_data := push_kitchen_mark(tenant, v_emp, v_payload);
          when 'booking.upsert' then v_data := push_booking_upsert(tenant, v_emp, v_payload);
          when 'item.set_available' then v_data := push_item_set_available(tenant, v_emp, v_payload);
          when 'item.set_price' then v_data := push_item_set_price(tenant, v_emp, v_payload);
          when 'item.save' then v_data := push_item_save(tenant, v_emp, v_payload);
          when 'item.remove' then v_data := push_item_remove(tenant, v_emp, v_payload);
          when 'category.save' then v_data := push_category_save(tenant, v_emp, v_payload);
          when 'category.remove' then v_data := push_category_remove(tenant, v_emp, v_payload);
          when 'stock.adjust' then v_data := push_stock_adjust(tenant, v_emp, v_payload);
          when 'tables.add' then v_data := push_tables_add(tenant, v_emp, v_payload);
          when 'printer.save' then v_data := push_printer_save(tenant, v_emp, v_payload);
          when 'company.save' then v_data := push_company_save(tenant, v_emp, v_payload);
          when 'staff.save' then v_data := push_staff_save(tenant, v_emp, v_payload);
          when 'staff.set_pin' then v_data := push_staff_set_pin(tenant, v_emp, v_payload);
          when 'setup.finish' then v_data := push_setup_finish(tenant, v_emp, v_payload);
          when 'cash.move' then v_data := push_cash_move(tenant, v_emp, v_payload);
          when 'drawer.count' then v_data := push_drawer_count(tenant, v_emp, v_payload);
          when 'day.close' then v_data := push_day_close(tenant, v_emp, v_payload);
          when 'payment.correct' then v_data := push_payment_correct(tenant, v_emp, v_payload);
          when 'request.answer' then v_data := push_request_answer(tenant, v_emp, v_payload);
          when 'supplier.save' then v_data := push_supplier_save(tenant, v_emp, v_payload);
          when 'supplier.remove' then v_data := push_supplier_remove(tenant, v_emp, v_payload);
          when 'po.save' then v_data := push_po_save(tenant, v_emp, v_payload);
          when 'po.send' then v_data := push_po_state(tenant, v_emp, v_payload, 'send');
          when 'po.cancel' then v_data := push_po_state(tenant, v_emp, v_payload, 'cancel');
          when 'po.close' then v_data := push_po_state(tenant, v_emp, v_payload, 'close');
          when 'delivery.receive' then v_data := push_delivery_receive(tenant, v_emp, v_payload);
          when 'count.complete' then v_data := push_count_complete(tenant, v_emp, v_payload);
          when 'tax.save' then v_data := push_tax_save(tenant, v_emp, v_payload);
          when 'role.save' then v_data := push_role_save(tenant, v_emp, v_payload);
          when 'role.remove' then v_data := push_role_remove(tenant, v_emp, v_payload);
          when 'staff.update' then v_data := push_staff_update(tenant, v_emp, v_payload);
          when 'discount.save' then v_data := push_discount_save(tenant, v_emp, v_payload);
          when 'discount.remove' then v_data := push_discount_remove(tenant, v_emp, v_payload);
          when 'addon.save' then v_data := push_addon_save(tenant, v_emp, v_payload);
          when 'addon.remove' then v_data := push_addon_remove(tenant, v_emp, v_payload);
          when 'settings.save' then v_data := push_settings_save(tenant, v_emp, v_payload);
          when 'variants.make' then v_data := push_variants_make(tenant, v_emp, v_payload);
          when 'variants.save' then v_data := push_variants_save(tenant, v_emp, v_payload);
          when 'variant.remove' then v_data := push_variant_remove(tenant, v_emp, v_payload);
          else raise exception 'unknown-op';
        end case;
        v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'data', v_data);
        insert into sync_ops_applied (op_id, tenant_id, type, result)
          values (v_op_id, tenant, v_logtype, v_envelope);
        if v_appr is not null then
          insert into approvals (tenant_id, op_id, op_type, employee_id, approved_by)
            values (tenant, v_op_id, v_logtype, v_emp, v_appr);
        end if;
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
          -- transient: stop here; this op and every later one retries.
          -- earlier ops keep their stored results.
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
end $function$
;
