-- 0101: a restaurant's floor plan, changed from a till.
--
-- A restaurant on the offline plan has no back office: its tables were added
-- from its tablet, a room at a time (tables.add, 0089), and then could not be
-- moved, made bigger, renumbered or taken away. Three changes do on a till
-- what the back office's floor plan page does (web/app/backoffice/tables):
--
--   floor.save   {store_id, area, tables: [{id, name, seats, shape, x, y, w, h}], removed: [id], approved_by?}
--                One room as the tablet's plan holds it when Save is pressed:
--                every table in it written as it stands (moved, sized,
--                renumbered, added), and the ones taken off removed. Other
--                rooms are not touched. It is the whole room, so sent twice
--                it leaves what one sending left: a till that lost the answer
--                sends it again under a new change id.
--   room.rename  {store_id, from, to}   every table of the room takes the new name.
--   room.remove  {store_id, area}       every table of the room is removed.
--
-- The rules are the back office's (actions.ts: saveFloor, renameFloor,
-- deleteFloor): whoever may change settings (settings.device), a table whole
-- on the 100 by 60 plan (the bounds of 0048, as tables.add checks them), a
-- table's number its own in the whole store, 300 tables to a store. A table
-- with an order open on it can be removed, as there: the order stays open
-- under Orders, without a table. Two tables may swap numbers in one save.
--
-- Refusals: bad-payload, forbidden, bad-store, name-taken, room-exists,
-- too-many, conflict (an id that is not this store's table). All are words
-- sync_push already lets through.
--
-- Source: the three functions are new. sync_push is its live definition on
-- the dev branch (db/scripts/dump-function.cjs) with three lines added to its
-- case: nothing else of it changes.

create or replace function push_floor_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_store uuid; v_area text; t jsonb; v_id uuid; v_name text;
  v_seats int; v_shape text; v_x int; v_y int; v_w int; v_h int;
  v_ids uuid[] := '{}'; v_names text[] := '{}'; v_gone uuid[] := '{}';
  v_rows jsonb := '[]'::jsonb; v_others int; v_sort int; v_n int; v_removed int := 0;
begin
  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_area := left(btrim(coalesce(p->>'area', '')), 30);
  if v_store is null or v_area = '' or jsonb_typeof(p->'tables') is distinct from 'array'
     or jsonb_array_length(p->'tables') > 300
     or (p ? 'removed' and jsonb_typeof(p->'removed') <> 'array') then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-store';
  end if;
  -- one change to a store's tables at a time: the lock tables.add takes
  perform pg_advisory_xact_lock(hashtextextended('tables.add:' || v_store::text, 0));
  for t in select * from jsonb_array_elements(p->'tables') loop
    begin
      v_id := (t->>'id')::uuid; v_seats := (t->>'seats')::int;
      v_x := (t->>'x')::int; v_y := (t->>'y')::int; v_w := (t->>'w')::int; v_h := (t->>'h')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    v_name := left(btrim(coalesce(t->>'name', '')), 30);
    v_shape := coalesce(t->>'shape', 'square');
    if v_id is null or v_name = '' or v_seats is null or v_seats not between 1 and 99
       or v_shape not in ('square', 'round')
       or v_w is null or v_w not between 4 and 100 or v_h is null or v_h not between 4 and 60
       or v_x is null or v_x < 0 or v_x + v_w > 100 or v_y is null or v_y < 0 or v_y + v_h > 60
       or v_id = any (v_ids) then
      raise exception 'bad-payload';
    end if;
    if lower(v_name) = any (v_names) then raise exception 'name-taken'; end if;
    v_ids := v_ids || v_id;
    v_names := v_names || lower(v_name);
    v_rows := v_rows || jsonb_build_object('id', v_id, 'name', v_name, 'seats', v_seats, 'shape', v_shape,
      'x', v_x, 'y', v_y, 'w', v_w, 'h', v_h);
  end loop;
  if p ? 'removed' then
    begin
      select coalesce(array_agg(x::uuid), '{}') into v_gone from jsonb_array_elements_text(p->'removed') x;
    exception when others then
      raise exception 'bad-payload';
    end;
  end if;
  -- a table cannot be both on the plan and taken off it
  if v_gone && v_ids then raise exception 'bad-payload'; end if;

  update tables set deleted_at = now()
    where tenant_id = p_tenant and store_id = v_store and id = any (v_gone) and deleted_at is null;
  get diagnostics v_removed = row_count;

  -- a table's number is its own in the whole store (uq_tables_store_name): the other tables', here
  if exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null
             and not (id = any (v_ids)) and lower(name) = any (v_names)) then raise exception 'name-taken'; end if;
  select count(*) into v_others from tables
    where tenant_id = p_tenant and store_id = v_store and deleted_at is null and not (id = any (v_ids));
  -- the back office's limit for a store
  if v_others + jsonb_array_length(v_rows) > 300 then raise exception 'too-many'; end if;
  -- two tables swapping numbers would trip the unique name halfway through:
  -- the ones already there first take a placeholder, as the back office does it
  update tables set name = '~' || id::text
    where tenant_id = p_tenant and store_id = v_store and id = any (v_ids) and deleted_at is null;
  select coalesce(max(sort_order), -1) into v_sort from tables
    where tenant_id = p_tenant and store_id = v_store and deleted_at is null;
  for t in select * from jsonb_array_elements(v_rows) loop
    -- a table that is there keeps its place in the order; a new one goes after the last
    insert into tables (id, tenant_id, store_id, name, area, seats, shape, x, y, w, h, sort_order)
      values ((t->>'id')::uuid, p_tenant, v_store, t->>'name', v_area, (t->>'seats')::int, t->>'shape',
        (t->>'x')::int, (t->>'y')::int, (t->>'w')::int, (t->>'h')::int, v_sort + 1)
    on conflict (id) do update set name = excluded.name, area = excluded.area, seats = excluded.seats,
      shape = excluded.shape, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h
      where tables.tenant_id = excluded.tenant_id and tables.store_id = excluded.store_id and tables.deleted_at is null;
    get diagnostics v_n = row_count;
    -- the id is another client's table, another store's, or one that was removed
    if v_n = 0 then raise exception 'conflict'; end if;
    select coalesce(max(sort_order), -1) into v_sort from tables
      where tenant_id = p_tenant and store_id = v_store and deleted_at is null;
  end loop;
  return jsonb_build_object('saved', jsonb_array_length(v_rows), 'removed', v_removed);
end $fn$;

create or replace function push_room_rename(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_store uuid; v_from text; v_to text; v_n int;
begin
  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_from := coalesce(p->>'from', '');
  v_to := left(btrim(coalesce(p->>'to', '')), 30);
  if v_store is null or v_from = '' or v_to = '' then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-store';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tables.add:' || v_store::text, 0));
  -- sent again after a lost answer (the room has its new name), or a room that is gone: nothing to do
  if v_to = v_from or not exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store
                                  and deleted_at is null and area = v_from) then
    return jsonb_build_object('renamed', 0);
  end if;
  if exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null
             and lower(area) = lower(v_to) and area <> v_from) then raise exception 'room-exists'; end if;
  update tables set area = v_to
    where tenant_id = p_tenant and store_id = v_store and deleted_at is null and area = v_from;
  get diagnostics v_n = row_count;
  return jsonb_build_object('renamed', v_n);
end $fn$;

create or replace function push_room_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_store uuid; v_area text; v_n int;
begin
  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_area := coalesce(p->>'area', '');
  if v_store is null or v_area = '' then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-store';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tables.add:' || v_store::text, 0));
  -- an order open on one of its tables stays open on the tills, under Orders, without a table
  update tables set deleted_at = now()
    where tenant_id = p_tenant and store_id = v_store and deleted_at is null and area = v_area;
  get diagnostics v_n = row_count;
  return jsonb_build_object('removed', v_n);
end $fn$;

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
          when 'floor.save' then v_data := push_floor_save(tenant, v_emp, v_payload);
          when 'room.rename' then v_data := push_room_rename(tenant, v_emp, v_payload);
          when 'room.remove' then v_data := push_room_remove(tenant, v_emp, v_payload);
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
