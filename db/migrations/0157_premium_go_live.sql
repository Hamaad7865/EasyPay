-- 0157_premium_go_live.sql — a business in the cloud goes live as an offline tablet does
--
-- The owner, 2026-11-06: "Premium plan needs to have the go live like how offline is. Say x customer, we imported
-- his stocks 100 y. He made 2 test sales. When going live we need to remove the sales and add back the stocks ...
-- and remember everything should be in sync with the server."
--
-- Until now a Premium (or trial) client went live in /admin only, with two buttons that each did half of it:
-- Clear test activity deleted the trying but also removed every till (each tablet then had to have its data
-- cleared and be set up again), and Go live only took the client off the list of those being set up. No till
-- knew the business was being set up (platform.setting_up is not pulled), so none could offer Go live, and
-- neither button told the tills to empty what they held.
--
-- Now:
--   - The tills read it: while a client is being set up its settings say settingUp: true (a trigger on
--     platform.setting_up keeps it so, for Go live, Back to setting up and every client that is made). A till
--     of 0.9.38 or later marks its papers TEST and offers Go live, as an offline tablet that is setting up does.
--   - platform.go_live_clear: what Go live does for a client in the cloud. What its sales, refunds and
--     deposits took off the shelves is put back (platform.test_sales_on_stock: a sale from before the shelf
--     was counted stays out), and its orders, receipts, days, cash, clock-ins, approvals, bookings, credit
--     notes, deposits and bills on account go, as with Clear test activity. Unlike it, the tills stay: their
--     keys, codes, when they were heard from, the back office's requests to them, and the changes already
--     taken (sync_ops_applied: a till sending one again is answered, never given it twice). Bills number
--     from 1 again. The settings are marked, cleared (as Delete all transactions marks them, 0155: a till
--     empties what it holds and pulls again from nothing) and live (when, in ms). The client is live.
--   - From a till: the change business.go_live, through sync_push, by the owner (a role holding '*'), or by
--     someone else with the owner's PIN typed (approved_by), of a client that is being set up and is not
--     offline (an offline tablet goes live by itself).
--   - From /admin: platform.go_live does the same for a client in the cloud. For an offline client it only
--     says it is live, as before. Clear test activity is left as it is, and /admin no longer offers it.
--   - sync_push: a change of a kind that was rung up (db/tests/fixtures/go-live/rung-up.json, the till's
--     GoLiveRules.RUNG_UP), made before the business went live (the op's `at`, which a till of 0.9.38 or later
--     sends), is answered applied and dropped: a tablet that was off at Go live sends its test sales when it
--     is back, and they must not land on the live books. A change that says nothing of when it was made (an
--     older till) is taken as before: the till service holds such a till back until it is updated (hello.ts).
--     `at` is the tablet's clock: the op's `sent` (the tablet's clock as it sent it) moves it onto the
--     server's, so a tablet an hour slow does not lose its real sales, nor an hour fast keep its test ones.
--     What is dropped is kept whole in sync_ops_applied (dropped_op), should it turn out to have been a sale.
--
-- Source: sync_push, platform.go_live and the clearing in platform.clear_test_activity as they are on dev
-- (db/scripts/dump-function.cjs, 2026-11-06; sync_push is 0134's, clear_test_activity 0128's). sync_push has
-- four additions, each marked 0157. Earlier migrations untouched. Never edit after merge.

-- ---- the tills read whether the business is being set up ----
create or replace function platform.setting_up_told() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    insert into pos_settings (tenant_id, data) values (new.tenant_id, jsonb_build_object('settingUp', true))
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  else
    update pos_settings set data = data - 'settingUp' where tenant_id = old.tenant_id and data ? 'settingUp';
  end if;
  return null;
end $fn$;
revoke all on function platform.setting_up_told() from public;

drop trigger if exists setting_up_told on platform.setting_up;
create trigger setting_up_told after insert or delete on platform.setting_up
  for each row execute function platform.setting_up_told();

-- the clients being set up today
insert into pos_settings (tenant_id, data)
  select s.tenant_id, jsonb_build_object('settingUp', true)
    from platform.setting_up s join tenants t on t.id = s.tenant_id
  on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;

-- ---- what Go live does for a client in the cloud ----
-- p_by: who, written down with it ({by: admin} or {employee_id, device_id}); p_admin: the login it is written
-- down as (the platform admin, or the owner's login from a till).
create or replace function platform.go_live_clear(p_tenant uuid, p_admin uuid, p_by jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_receipts bigint; v_orders bigint;
  v_mark jsonb := to_jsonb(clock_timestamp());
  v_live bigint;
  tbl text;
begin
  perform set_config('app.tenant_id', p_tenant::text, true);
  -- a till that is sending at this moment makes this wait; not for long
  perform set_config('lock_timeout', '8s', true);
  v_live := floor(extract(epoch from (v_mark #>> '{}')::timestamptz) * 1000)::bigint;

  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_orders from tickets where tenant_id = p_tenant;

  -- the shelves first: the level, then the item's total, in the order the stock engine locks them (0067)
  update stock_levels s set qty = s.qty - b.qty
    from platform.test_sales_on_stock(p_tenant) b
   where s.tenant_id = p_tenant and s.store_id = b.store_id and s.item_id = b.item_id
     and s.variant_id is not distinct from b.variant_id;
  update items i set stock_qty = coalesce(i.stock_qty, 0) - b.qty
    from (select x.item_id, sum(x.qty) as qty from platform.test_sales_on_stock(p_tenant) x group by 1) b
   where i.tenant_id = p_tenant and i.id = b.item_id;
  delete from stock_movements where tenant_id = p_tenant and reason in ('sale', 'refund', 'deposit', 'deposit_release');

  -- what was rung up, children first; the tills, their keys and what they were asked stay
  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach tbl in array array[
    'account_payment_lines','account_payments','account_bills',
    'credit_notes','deposit_payments','deposit_lines','deposits',
    'bookings','approvals','drawer_counts','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts']
  loop
    execute format('delete from %I where tenant_id = $1', tbl) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  -- a customer's points are the sum of their receipts (0128): none are left
  update customers c set points = coalesce((select sum(r.points_earned - r.points_used) from receipts r
      where r.tenant_id = c.tenant_id and r.customer_id = c.id and r.deleted_at is null), 0)
   where c.tenant_id = p_tenant and c.points <> 0;
  -- the bills number from 1 again
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant and last_receipt_seq <> 0;

  -- the tills: empty what you hold (0155), and the business is live from this moment
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('cleared', v_mark, 'live', v_live))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  delete from platform.setting_up where tenant_id = p_tenant;

  -- the log holds a login: from a till, the owner's (push_business_go_live); a business with none is not written down
  if p_admin is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (p_admin, 'tenant.live', p_tenant,
        coalesce(p_by, '{}'::jsonb) || jsonb_build_object('cleared', true, 'receipts', v_receipts, 'orders', v_orders));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'cleared', v_mark, 'live', v_live);
end $fn$;
revoke all on function platform.go_live_clear(uuid, uuid, jsonb) from public;

-- ---- from a till: the owner's Go live ----
create or replace function public.push_business_go_live(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_offline boolean;
  v_device uuid;
  v_auth uuid;
  v_appr uuid;
  v_owner uuid;
begin
  -- the till's own business, as sync_push named it
  if p_tenant is null or current_tenant_id() is distinct from p_tenant then raise exception 'forbidden'; end if;
  -- the owner, or someone else with the owner's PIN typed at the till (approved_by, which sync_push keeps
  -- only from a login that may set up tills)
  begin
    v_appr := nullif(p->>'approved_by', '')::uuid;
  exception when others then
    v_appr := null;
  end;
  select e.id, e.auth_user_id into v_owner, v_auth from employees e join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id
   where e.id in (p_emp, v_appr) and e.tenant_id = p_tenant and e.deleted_at is null and e.is_active and r.permissions ? '*'
   order by e.id = p_emp desc limit 1;
  if not found then raise exception 'forbidden'; end if;
  -- written down as the owner's login, as Delete all transactions is (0155); an owner with no login of their
  -- own (signed in at the till with a PIN only) by the business's first login that holds every permission
  if v_auth is null then
    select e.auth_user_id into v_auth from employees e join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id
     where e.tenant_id = p_tenant and e.deleted_at is null and e.auth_user_id is not null and r.permissions ? '*'
     order by e.created_at limit 1;
  end if;
  select lower(btrim(coalesce(plan, ''))) = 'offline' into v_offline from tenants where id = p_tenant and deleted_at is null;
  if not found then raise exception 'forbidden'; end if;
  -- an offline tablet goes live by itself: its sales are on no server
  if v_offline then raise exception 'client-offline'; end if;
  if not platform.is_setting_up(p_tenant) then raise exception 'already-live'; end if;
  begin
    v_device := nullif(p->>'device_id', '')::uuid;
  exception when others then
    v_device := null;
  end;
  return platform.go_live_clear(p_tenant, v_auth, jsonb_build_object('employee_id', p_emp, 'device_id', v_device)
    || case when v_owner is distinct from p_emp then jsonb_build_object('approved_by', v_owner) else '{}'::jsonb end);
end $fn$;

-- ---- from /admin ----
create or replace function platform.go_live(p_admin uuid, p_tenant uuid) returns void
language plpgsql set search_path = public as $fn$
declare
  v_offline boolean;
begin
  perform platform.require_admin(p_admin);
  select lower(btrim(coalesce(plan, ''))) = 'offline' into v_offline from tenants where id = p_tenant and deleted_at is null;
  if not found then raise exception 'unknown-tenant'; end if;
  if not platform.is_setting_up(p_tenant) then raise exception 'already-live'; end if;
  -- 0157: a client in the cloud is cleared as its till's Go live clears it, and keeps its tills
  if not v_offline then
    perform platform.go_live_clear(p_tenant, p_admin, jsonb_build_object('by', 'admin'));
    return;
  end if;
  -- an offline client's trying is on its tablets, each cleared by its own Go live
  delete from platform.setting_up where tenant_id = p_tenant;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.live', p_tenant, '{}'::jsonb);
end $fn$;

-- ---- sync_push: the change business.go_live, and test sales that arrive after it ----
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
  -- 0157: when the business went live from being set up, and the kinds of change that were rung up
  -- (db/tests/fixtures/go-live/rung-up.json): one of those made before then is dropped
  v_live timestamptz;
  v_at timestamptz;
  v_drop boolean;
  rung text[] := array[
    'ticket.create','ticket.add_line','ticket.edit_line','ticket.void_line','ticket.send','ticket.stage',
    'ticket.place_lines','ticket.split_line','ticket.merge','ticket.move_lines','ticket.update_meta','ticket.cancel',
    'receipt.create','refund.create','payment.correct','shift.open','shift.close','day.close',
    'drawer.count','cash.move','timeclock.punch','kitchen.mark','booking.upsert','request.answer',
    'deposit.create','deposit.pay','deposit.cancel','deposit.give_back','account.pay'];
  res jsonb := '[]'::jsonb;
  codes text[] := array[
    'bad-op-id','bad-payload','unknown-op','bad-store','bad-ticket',
    'ticket-closed','bad-line','bad-item','bad-variant','bad-modifier',
    'bad-dining','bad-discount','bad-payment','bad-change','bad-totals',
    'bad-device','bad-receipt','bad-qty','overpayment','lines-required',
    'empty-ticket','already-refunded','forbidden','conflict',
    -- a shop's return policy (0109)
    'refund-policy',
    -- a shop's promotions (0110)
    'below-cost','not-lower','on-promotion','not-active','no-cost','pick-variant',
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
    'bad-options','too-many-variants','has-stock',
    -- an item made of others, from a till (0112)
    'bad-part','part-has-parts','is-a-part',
    -- a shop's deposits (0113)
    'not-entitled','bad-deposit',
    -- a shop's customer accounts (0114)
    'bad-account',
    -- MRA e-invoicing: a payment not corrected on a live client (0116), what a till sent the MRA (0132)
    'mra-no-correction','bad-mra-record','mra-record-fixed',
    -- how a shop's product is sold: a change of unit refused while it holds stock (0131)
    'unit-has-stock',
    -- a business in the cloud going live from its till (0157)
    'already-live','client-offline'];
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
  -- 0157: since when the business is live, as Go live wrote it (ms)
  select to_timestamp((data->>'live')::numeric / 1000) into v_live
    from pos_settings where tenant_id = tenant and data->>'live' ~ '^[0-9]{1,15}$';
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
        -- 0157: a change rung up before the business went live, sent by a till that was off at Go live:
        -- answered, so it leaves the till's queue, and not taken. A change that does not say when it was
        -- made is taken as before. When it was made is the till's clock; how far that clock is off is
        -- told by the till's clock as it sent it (sent), so a till an hour slow or fast is read right.
        v_drop := false;
        if v_live is not null and v_type = any (rung) and op ? 'at' then
          begin
            v_at := to_timestamp((op->>'at')::numeric / 1000);
          exception when others then
            v_at := null;
          end;
          if v_at is not null and op ? 'sent' then
            begin
              v_at := coalesce(v_at + (clock_timestamp() - to_timestamp((op->>'sent')::numeric / 1000)), v_at);
            exception when others then
              null;
            end;
          end if;
          v_drop := v_at is not null and v_at < v_live;
        end if;
        if v_drop then
          v_data := jsonb_build_object('dropped', 'before-go-live');
          v_appr := null;
        else
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
          -- a shop's promotions (0110)
          when 'promotion.apply' then v_data := push_promotion_apply(tenant, v_emp, v_payload);
          when 'promotion.reduce' then v_data := push_promotion_reduce(tenant, v_emp, v_payload);
          when 'promotion.lift' then v_data := push_promotion_lift(tenant, v_emp, v_payload);
          -- a shop's deposits (0113)
          when 'deposit.create' then v_data := push_deposit_create(tenant, v_emp, v_payload);
          when 'deposit.pay' then v_data := push_deposit_pay(tenant, v_emp, v_payload);
          when 'deposit.cancel' then v_data := push_deposit_cancel(tenant, v_emp, v_payload);
          when 'deposit.give_back' then v_data := push_deposit_give_back(tenant, v_emp, v_payload);
          -- a shop's customer accounts (0114)
          when 'account.pay' then v_data := push_account_pay(tenant, v_emp, v_payload);
          -- MRA e-invoicing: what a till sent the MRA, and its connection (0132)
          when 'mra.record' then v_data := push_mra_record(tenant, v_emp, v_payload);
          when 'mra.status' then v_data := push_mra_status(tenant, v_emp, v_payload);
          -- 0157: the owner's Go live, from a till of a business in the cloud
          when 'business.go_live' then
            v_data := push_business_go_live(tenant, v_emp, v_payload);
            v_live := to_timestamp((v_data->>'live')::numeric / 1000);
          else raise exception 'unknown-op';
        end case;
        end if;
        v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'data', v_data);
        -- 0157: a dropped change is kept here whole, should it turn out to have been a sale
        insert into sync_ops_applied (op_id, tenant_id, type, result)
          values (v_op_id, tenant, v_logtype, case when v_drop then v_envelope || jsonb_build_object('dropped_op', op) else v_envelope end);
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
