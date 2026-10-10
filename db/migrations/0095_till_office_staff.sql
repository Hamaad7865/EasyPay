-- 0095: roles, staff and discounts, from a till.
--
-- A business on the offline plan has no back office
-- (docs/superpowers/specs/2026-10-11-tablet-alone-design.md): what it sets up,
-- it sets up on its tablet, and the day it goes Premium the tablet sends each
-- change here, where the handler below takes it as it takes a linked till's.
--
--   role.save       a role's name and what it may do. The sheet sends its
--                   ticks and the list it offered: what the role held outside
--                   that list is kept (the other kind of business's
--                   permissions, one added since), as the back office's page
--                   keeps it. "*" is never taken: the owner's role is made
--                   by EasyPay and cannot be changed or copied.
--   role.remove     refused for the owner's role and while staff hold it.
--                   The name is freed, as a removed discount's is.
--   staff.update    the name, the role, and whether they may use the tills,
--                   of a member of staff who has no login. One with a login
--                   is EasyPay's to change, as on the back office's page.
--   discount.save   a name, a percentage (1 to 100) or an amount, and whether
--   discount.remove it needs a manager; removed by renaming, so receipts keep
--                   it and the name is free again.
--
-- Sent twice, written once: each takes a lock on the id the tablet made and
-- then looks for its row; a removal that finds the row removed answers done.
--
-- New refusals: owner-role, role-in-use, has-login, bad-value.
-- Source: sync_push is its live definition on the dev branch with the lines
-- this migration adds.

create or replace function push_role_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_name text; v_was record; v_offered text[]; v_ticked text[]; v_perms jsonb;
begin
  begin
    v_id := (p->>'id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'permissions') is distinct from 'array' or jsonb_typeof(p->'offered') is distinct from 'array' then
    raise exception 'bad-payload';
  end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 30);
  if v_name = '' then raise exception 'name-required'; end if;
  if not may(p_emp, p, 'employees.edit') then raise exception 'forbidden'; end if;
  -- "*" is the owner's alone: it is neither offered nor ticked, whatever was sent
  select coalesce(array_agg(distinct x), '{}') into v_offered
    from jsonb_array_elements_text(p->'offered') x where x <> '*' and length(x) between 1 and 60;
  select coalesce(array_agg(distinct x), '{}') into v_ticked
    from jsonb_array_elements_text(p->'permissions') x where x = any (v_offered);
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  -- the table keeps one role to a name
  if exists (select 1 from roles where tenant_id = p_tenant and id <> v_id and lower(name) = lower(v_name)) then
    raise exception 'name-taken';
  end if;
  select permissions, deleted_at into v_was from roles where tenant_id = p_tenant and id = v_id for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-role'; end if;
    if v_was.permissions ? '*' then raise exception 'owner-role'; end if;
    -- of what the sheet offered, the ticks; what the role held besides is kept
    select coalesce(jsonb_agg(t.x order by t.x), '[]'::jsonb) into v_perms from (
      select x from jsonb_array_elements_text(v_was.permissions) x where not (x = any (v_offered))
      union
      select x from unnest(v_ticked) x) t;
    update roles set name = v_name, permissions = v_perms where tenant_id = p_tenant and id = v_id;
    return jsonb_build_object('role_id', v_id, 'created', false);
  end if;
  -- an id that is another client's role stops here on the primary key, and is answered 'conflict'
  insert into roles (id, tenant_id, name, permissions)
    values (v_id, p_tenant, v_name, (select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from unnest(v_ticked) x));
  return jsonb_build_object('role_id', v_id, 'created', true);
end $fn$;

create or replace function push_role_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_was record;
begin
  begin
    v_id := (p->>'role_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'employees.edit') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select permissions, deleted_at into v_was from roles where tenant_id = p_tenant and id = v_id for update;
  if not found then raise exception 'bad-role'; end if;
  -- removed already is removed
  if v_was.deleted_at is not null then return jsonb_build_object('role_id', v_id); end if;
  if v_was.permissions ? '*' then raise exception 'owner-role'; end if;
  if exists (select 1 from employees where tenant_id = p_tenant and role_id = v_id and deleted_at is null) then
    raise exception 'role-in-use';
  end if;
  update roles set deleted_at = now(), name = left(name, 30) || ' (removed ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')'
   where tenant_id = p_tenant and id = v_id;
  return jsonb_build_object('role_id', v_id);
end $fn$;

create or replace function push_staff_update(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_role uuid; v_name text; v_active boolean; v_was record;
begin
  begin
    v_id := (p->>'employee_id')::uuid;
    v_role := nullif(p->>'role_id', '')::uuid;
    v_active := (p->>'active')::boolean;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 80);
  if p ? 'name' and v_name = '' then raise exception 'name-required'; end if;
  if p ? 'role_id' and v_role is null then raise exception 'bad-role'; end if;
  if not may(p_emp, p, 'employees.edit') then raise exception 'forbidden'; end if;
  select auth_user_id, deleted_at into v_was from employees where tenant_id = p_tenant and id = v_id for update;
  if not found or v_was.deleted_at is not null then raise exception 'unknown-staff'; end if;
  -- someone with a login of their own is EasyPay's to change: switching off your own would lock the business out
  if v_was.auth_user_id is not null then raise exception 'has-login'; end if;
  if v_role is not null and not exists (select 1 from roles where tenant_id = p_tenant and id = v_role and deleted_at is null) then
    raise exception 'bad-role';
  end if;
  update employees set
      name = case when p ? 'name' then v_name else name end,
      role_id = case when p ? 'role_id' then v_role else role_id end,
      is_active = case when p ? 'active' and v_active is not null then v_active else is_active end
   where tenant_id = p_tenant and id = v_id;
  return jsonb_build_object('employee_id', v_id);
end $fn$;

create or replace function push_discount_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_name text; v_type text; v_value bigint; v_appr boolean; v_was record;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_value := (p->>'value')::bigint;
    v_appr := coalesce((p->>'requires_approval')::boolean, false);
  exception when others then
    raise exception 'bad-payload';
  end;
  v_type := p->>'type';
  if v_id is null or v_type is null or v_type not in ('percent', 'amount') then raise exception 'bad-payload'; end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 40);
  if v_name = '' then raise exception 'name-required'; end if;
  -- a percentage is a whole number from 1 to 100; an amount is cents, up to Rs 1,000,000
  if v_value is null or v_value < 1 or (v_type = 'percent' and v_value > 100) or v_value > 100000000 then
    raise exception 'bad-value';
  end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  if exists (select 1 from discounts where tenant_id = p_tenant and id <> v_id and lower(name) = lower(v_name)) then
    raise exception 'name-taken';
  end if;
  select deleted_at into v_was from discounts where tenant_id = p_tenant and id = v_id for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-discount'; end if;
    update discounts set name = v_name, type = v_type, value = v_value, requires_approval = v_appr where tenant_id = p_tenant and id = v_id;
    return jsonb_build_object('discount_id', v_id, 'created', false);
  end if;
  insert into discounts (id, tenant_id, name, type, value, requires_approval) values (v_id, p_tenant, v_name, v_type, v_value, v_appr);
  return jsonb_build_object('discount_id', v_id, 'created', true);
end $fn$;

create or replace function push_discount_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid;
begin
  begin
    v_id := (p->>'discount_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  update discounts set deleted_at = now(), name = left(name, 40) || ' (removed ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')'
   where tenant_id = p_tenant and id = v_id and deleted_at is null;
  -- removed already is removed; one that was never this client's is refused
  if not found and not exists (select 1 from discounts where tenant_id = p_tenant and id = v_id) then raise exception 'bad-discount'; end if;
  return jsonb_build_object('discount_id', v_id);
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
    'owner-role','role-in-use','has-login','bad-value'];
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
