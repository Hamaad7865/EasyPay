-- 0085: the kitchen display and bookings are part of the premium tier.
--
-- The owner: "the kitchen and the bookings will be on the premium tier for
-- restaurant customers". Asked what a Standard restaurant keeps, they chose
-- printed kitchen tickets only: Send to kitchen and the kitchen printers are
-- everyone's; the Kitchen tab on the till, a kitchen screen on another tablet
-- and Bookings are premium.
--
-- tenants.plan, which the platform admin sets and which until now was a label
-- with nothing behind it, is the switch. It stays the one source of truth.
--
--   has_premium(tenant)   true for the plans that carry the premium features:
--                         premium, and trial, so that a restaurant trying
--                         EasyPay sees all of it
--
-- How a till learns its restaurant's plan: as it learns the business type
-- (0066). tenants is not in a pull; pos_settings is, and a till reads its JSON
-- loosely. So the two functions that set a plan write pos_settings.data.plan
-- in the same transaction, beside what the settings hold, and the row's
-- server_seq goes up, so the till has it at its next pull:
--   platform.set_tenant_plan   as it was, with that write
--   platform.create_tenant     as it was, with that write after the basics
-- and every tenant that exists is given its plan in its settings below. A till
-- that finds no plan there shows no premium screen.
--
-- Hiding a screen is not the guard. A booking sent by a till of a restaurant
-- that is not premium is refused:
--   push_booking_upsert   as it was, refusing first with not-premium
--   sync_push             as it was on dev (as 0084 left it), with that code
--                         in the list it hands back, so the till can say why
-- The bookings a restaurant already has are kept and come back with the plan.
--
-- Each function below is its definition as it was on dev, generated from the
-- live function, with only the lines named above changed.
--
-- A till older than the build that reads the plan still shows Bookings, and a
-- booking it makes for a Standard restaurant comes back refused. In production
-- this migration therefore goes out with that build required
-- (MIN_TILL_VERSION), and after the restaurants that keep Bookings have been
-- set to premium.

-- true for the plans that carry the premium features
create or replace function has_premium(p_tenant uuid) returns boolean
language sql stable set search_path = public as $fn$
  select coalesce((select lower(btrim(plan)) in ('premium', 'trial') from tenants where id = p_tenant), false)
$fn$;

CREATE OR REPLACE FUNCTION platform.set_tenant_plan(p_admin uuid, p_tenant uuid, p_plan text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_plan text := nullif(btrim(coalesce(p_plan, '')), '');
  v_old text;
begin
  perform platform.require_admin(p_admin);
  if v_plan is null then raise exception 'plan-required'; end if;
  select plan into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set plan = v_plan where id = p_tenant;
  -- the tills learn the plan through the settings they already pull
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('plan', v_plan))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.plan', p_tenant, jsonb_build_object('from', v_old, 'to', v_plan));
end $function$;

CREATE OR REPLACE FUNCTION platform.create_tenant(p_admin uuid, p_name text, p_store_name text, p_store_code text, p_owner_name text, p_owner_auth uuid, p_plan text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := gen_random_uuid();
  v_store uuid; v_role uuid; v_emp uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_store_name text := coalesce(nullif(btrim(coalesce(p_store_name, '')), ''), 'Main store');
  v_code text := upper(btrim(coalesce(p_store_code, '')));
  v_owner text := coalesce(nullif(btrim(coalesce(p_owner_name, '')), ''), 'Owner');
  v_plan text := coalesce(nullif(btrim(coalesce(p_plan, '')), ''), 'standard');
begin
  perform platform.require_admin(p_admin);
  if v_name = '' then raise exception 'name-required'; end if;
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'bad-store-code'; end if;
  if p_owner_auth is null then raise exception 'owner-login-required'; end if;
  -- one login belongs to one tenant (employees.auth_user_id is unique)
  if exists (select 1 from employees where auth_user_id = p_owner_auth) then
    raise exception 'login-already-linked';
  end if;
  -- a platform admin belongs to no restaurant
  if exists (select 1 from platform.admins where auth_user_id = p_owner_auth and revoked_at is null) then
    raise exception 'login-is-platform-admin';
  end if;
  -- the tenant context is stamped so the same statements also pass RLS for a
  -- caller that does not bypass it
  perform set_config('app.tenant_id', v_tenant::text, true);
  insert into tenants (id, tenant_id, name, plan) values (v_tenant, v_tenant, v_name, v_plan);
  insert into stores (tenant_id, name, code) values (v_tenant, v_store_name, v_code) returning id into v_store;
  insert into roles (tenant_id, name, permissions) values (v_tenant, 'Owner', '["*"]') returning id into v_role;
  insert into roles (tenant_id, name, permissions) values
    (v_tenant, 'Manager', '["sale.create","sale.apply_discount","sale.apply_restricted_discount",
      "sale.void_line","sale.void_sent_line","sale.refund","ticket.view_all","ticket.reassign",
      "ticket.split_merge","payment.take","drawer.open_no_sale","shift.open_close",
      "shift.view_report","cash.pay_in_out","items.edit","settings.device","receipts.view_all",
      "receipts.reprint","backoffice.access","reports.view","payment.correct",
      "stock.view","stock.receive","stock.adjust","stock.count","suppliers.edit","costs.view","sale.change_price"]'),
    (v_tenant, 'Cashier', '["sale.create","sale.apply_discount","sale.void_line","ticket.view_all",
      "ticket.split_merge","payment.take","shift.open_close","cash.pay_in_out",
      "receipts.view_all","receipts.reprint"]'),
    (v_tenant, 'Waiter', '["sale.create","sale.void_line"]');
  insert into employees (tenant_id, name, role_id, auth_user_id)
    values (v_tenant, v_owner, v_role, p_owner_auth) returning id into v_emp;
  insert into employee_stores (tenant_id, employee_id, store_id) values (v_tenant, v_emp, v_store);
  -- what a restaurant needs before its first sale
  perform ensure_pos_basics(v_tenant);
  -- its tills learn the plan through the settings they pull
  insert into pos_settings (tenant_id, data) values (v_tenant, jsonb_build_object('plan', v_plan))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.create', v_tenant,
      jsonb_build_object('name', v_name, 'store', v_store_name, 'store_code', v_code,
        'plan', v_plan, 'owner', v_owner, 'owner_auth_user_id', p_owner_auth));
  return jsonb_build_object('tenant_id', v_tenant, 'store_id', v_store, 'employee_id', v_emp);
end $function$;

CREATE OR REPLACE FUNCTION public.push_booking_upsert(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_store uuid; v_at timestamptz; v_name text; v_size int; v_status text;
begin
  -- bookings are part of the premium tier
  if not has_premium(p_tenant) then raise exception 'not-premium'; end if;
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_at := (p->>'booked_for')::timestamptz;
  v_name := btrim(coalesce(p->>'name', ''));
  v_size := (p->>'size')::int;
  v_status := coalesce(p->>'status', 'confirmed');
  if v_id is null or v_store is null or v_at is null or v_name = '' or length(v_name) > 120
     or v_size is null or v_size not between 1 and 99
     or v_status not in ('pending','confirmed','seated','noshow','cancelled') then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant) then raise exception 'bad-store'; end if;
  insert into bookings (id, tenant_id, store_id, booked_for, name, size, phone, area, table_id, tags, status, ticket_id, created_by)
    values (v_id, p_tenant, v_store, v_at, v_name, v_size,
      nullif(btrim(left(coalesce(p->>'phone', ''), 40)), ''), nullif(btrim(left(coalesce(p->>'area', ''), 80)), ''),
      (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant and tb.store_id = v_store),
      nullif(btrim(left(coalesce(p->>'tags', ''), 240)), ''), v_status,
      (select t.id from tickets t where t.id = (p->>'ticket_id')::uuid and t.tenant_id = p_tenant), p_emp)
    on conflict (id) do update set booked_for = excluded.booked_for, name = excluded.name, size = excluded.size,
      phone = excluded.phone, area = excluded.area,
      -- the table is one of the booking's own store, whatever store this op named
      table_id = (select tb.id from tables tb
                   where tb.id = (p->>'table_id')::uuid and tb.tenant_id = bookings.tenant_id and tb.store_id = bookings.store_id),
      tags = excluded.tags,
      status = excluded.status, ticket_id = coalesce(excluded.ticket_id, bookings.ticket_id), deleted_at = null
    where bookings.tenant_id = p_tenant;
  return jsonb_build_object('id', v_id);
end $function$;

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
    'not-premium'];
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

-- Every tenant that exists is told its plan, beside what its settings hold.
do $$
declare r record;
begin
  for r in select id, plan from tenants loop
    perform set_config('app.tenant_id', r.id::text, true);
    insert into pos_settings (tenant_id, data) values (r.id, jsonb_build_object('plan', r.plan))
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end loop;
end $$;
