-- 0084: an item made, changed or removed from a till.
--
-- The owner asked to "be able to CRUD on items products for both retail and
-- restaurant", and, asked where, said "On the tablet too". A till could change
-- an item's price (item.set_price) and take it off sale (item.set_available);
-- everything else about the menu was the back office's.
--
--   item.save    makes an item, or changes one: its name, its price or that
--                its price is typed at the sale (0083), its category, its
--                barcode, whether it is on sale. The till gives a new item
--                its id.
--   item.remove  takes an item off the menu. Receipts that sold it keep its
--                name; a till's order that still holds it is taken as before
--                and its receipt says the item was unavailable.
--
-- Both take the right to edit the menu (items.edit), the person's own or that
-- of whoever approved, as item.set_price does.
--
-- An item made on a till is a whole item, the one the back office would have
-- made from the same answers:
--   - it carries the client's default tax (else its first): the tax the back
--     office's panel starts a new item on. Without one its receipts would
--     carry no VAT.
--   - in a shop its stock is counted, as a product made on the product page
--     is unless told otherwise, and it is given a barcode when the shop has
--     them made automatically (0080); one whose price is typed at the sale is
--     a service, and has no stock to count
--   - in a restaurant its stock is not counted unless its category's is
-- Its variants, add-ons, cost, supplier and stock are the back office's still.
--
-- What is refused, in the till's own words once it is told which:
--   name-required        no name
--   bad-category         a category that is not this client's, or is gone
--   barcode-taken        another item or variant carries the barcode (the
--                        guard on items raises it, as it does for the back office)
--   open-price-not-here  a price typed at the sale, on a product with variants
--                        or one sold by weight
--   bad-item             the item is gone
--   conflict             the id is another client's item
--   forbidden            neither the person nor the approver may edit the menu
--   bad-payload          a price below nothing or above Rs 1,000,000
--
-- A till sends these while it has a connection and waits for the answer
-- before showing the item: an item that was queued and then refused would
-- take every sale that named it down with it. That is the till's rule, not
-- the server's: the ops are ordinary ops.
--
-- sync_push is as it was on dev (as 0082 left it), with its list of codes and
-- its list of ops each longer by these. Never edit after merge.

create or replace function push_item_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_name text; v_price bigint; v_open boolean; v_cat uuid; v_code text; v_avail boolean;
  v_was record; v_tax uuid; v_shop boolean; v_appr uuid;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_price := coalesce((p->>'price')::bigint, 0);
    v_cat := nullif(p->>'category_id', '')::uuid;
    v_open := coalesce((p->>'open_price')::boolean, false);
    v_avail := coalesce((p->>'available')::boolean, true);
  exception when others then
    raise exception 'bad-payload';
  end;
  v_name := left(btrim(coalesce(p->>'name', '')), 80);
  v_code := nullif(regexp_replace(coalesce(p->>'barcode', ''), '\s+', '', 'g'), '');
  -- Rs 1,000,000 for one item is a slip of the finger, not a price
  if v_id is null or v_price < 0 or v_price > 100000000 or length(coalesce(v_code, '')) > 64 then raise exception 'bad-payload'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- one whose price is typed at the sale has none of its own
  if v_open then v_price := 0; end if;
  if v_cat is not null and not exists (select 1 from categories where tenant_id = p_tenant and id = v_cat and deleted_at is null) then
    raise exception 'bad-category';
  end if;
  -- the approver is named only when it was the approval that allowed it
  if not has_perm(p_emp, 'items.edit') then
    begin v_appr := nullif(p->>'approved_by', '')::uuid; exception when others then v_appr := null; end;
  end if;

  select id, deleted_at, sold_by into v_was from items where id = v_id and tenant_id = p_tenant for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-item'; end if;
    if v_open and (v_was.sold_by = 'weight'
        or exists (select 1 from item_variants where tenant_id = p_tenant and item_id = v_id and deleted_at is null)) then
      raise exception 'open-price-not-here';
    end if;
    -- a change of price is written down with who made it, as one from item.set_price is
    perform set_config('app.price_by', p_emp::text, true);
    perform set_config('app.price_approver', coalesce(v_appr::text, ''), true);
    update items set name = v_name, price = v_price, open_price = v_open, category_id = v_cat, barcode = v_code, is_available = v_avail
      where id = v_id and tenant_id = p_tenant;
    perform set_config('app.price_by', '', true);
    perform set_config('app.price_approver', '', true);
    return jsonb_build_object('item_id', v_id, 'created', false);
  end if;

  select business_type = 'retail' into v_shop from tenants where id = p_tenant;
  v_shop := coalesce(v_shop, false);
  -- an id that is another client's item stops here on the primary key, and is answered 'conflict'
  insert into items (id, tenant_id, category_id, name, price, open_price, is_available, barcode, track_stock)
    values (v_id, p_tenant, v_cat, v_name, v_price, v_open, v_avail, v_code, v_shop and not v_open);
  select id into v_tax from taxes where tenant_id = p_tenant and deleted_at is null order by is_default desc, created_at, id limit 1;
  if v_tax is not null then
    insert into item_taxes (tenant_id, item_id, tax_id) values (p_tenant, v_id, v_tax)
      on conflict (item_id, tax_id) do update set deleted_at = null;
  end if;
  if v_shop then perform barcodes_auto(p_tenant, v_id); end if;
  return jsonb_build_object('item_id', v_id, 'created', true);
end $fn$;

create or replace function push_item_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid;
begin
  begin
    v_id := (p->>'item_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  update items set deleted_at = now() where id = v_id and tenant_id = p_tenant and deleted_at is null;
  -- removed already is removed; one that was never this client's is refused
  if not found and not exists (select 1 from items where id = v_id and tenant_id = p_tenant) then raise exception 'bad-item'; end if;
  return jsonb_build_object('item_id', v_id);
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
    'name-required','bad-category','barcode-taken','sku-taken','open-price-not-here'];
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
          when 'cash.move' then v_data := push_cash_move(tenant, v_emp, v_payload);
          when 'drawer.count' then v_data := push_drawer_count(tenant, v_emp, v_payload);
          when 'day.close' then v_data := push_day_close(tenant, v_emp, v_payload);
          when 'payment.correct' then v_data := push_payment_correct(tenant, v_emp, v_payload);
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
end $function$;
