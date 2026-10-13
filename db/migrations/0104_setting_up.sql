-- 0104: a client is set up before it is live, and what it was tried with can
-- be taken away from /admin.
--
-- EasyPay sets each business up on the real system: its menu, its stock, its
-- staff and logins. Then tablets are set up and things are tried: sales rung
-- up, days opened and closed. Before the business opens for real, the trying
-- has to go and the set-up has to stay. Until now a till could only be
-- deactivated and a code only taken back; nothing of a client could be
-- removed from /admin, and each time it took a script.
--
--   - platform.setting_up: a row for each client that is being set up. No
--     row: the client is live. Every client made from now on starts with one
--     (a trigger on tenants, so whichever way a client is made it has it). Of
--     the clients there are today, those that sync and have no receipt yet
--     are being set up: with no receipt there is no book to lose. Every other
--     is live.
--   - platform.go_live(admin, tenant): the client is live from now on.
--   - platform.back_to_setting_up(admin, tenant): for a client that was put
--     live too early. Refused once it has a receipt: from its first sale its
--     receipts are its books.
--   - platform.remove_till(admin, till): a till that has nothing recorded (no
--     receipt, no day, no cash, no clock-in) is removed, with its key and the
--     codes it was set up with. Its code (T1, T2, ...) is free again. For a
--     client that runs on its tablet the server never sees a sale, so there
--     it is allowed only while the client is being set up.
--   - platform.remove_code(admin, code): a code that waits or is over is
--     removed from the list. One in use goes with its till.
--   - platform.clear_test_activity(admin, tenant): only while the client is
--     being set up, and only for one that syncs. Removes its orders,
--     receipts, refunds, payments, days, cash, clock-ins, approvals,
--     bookings, and its tills with their keys and the codes they were set up
--     with (a code for a new tablet that nobody used yet stays). What the
--     sales and refunds moved on the shelves is put back first (see
--     platform.test_sales_on_stock). The menu, the stock and its deliveries,
--     orders and counts, suppliers, customers, tables, staff, logins,
--     printers and settings stay.
--   - platform.removed_tills: the ids of the tills that were removed. A
--     tablet that was one still holds what it sold, and would send it again
--     if it were set up as it is; till_removed() lets the till service
--     refuse it until its app's data is cleared (a tablet makes a new id
--     then).
--
-- Deleting a receipt is let through by the guards' one way out, the same that
-- "Delete all transactions" uses (app.purge_tenant, 0051): these functions
-- run on the owner's connection, never as app_user.
-- Nothing here is pulled by a till. Never edit after merge.

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'platform' and tablename = 'setting_up') then
    create table platform.setting_up (
      tenant_id uuid primary key references public.tenants (id) on delete cascade,
      since timestamptz not null default now()
    );
    -- the clients there are today: see the head of this file
    insert into platform.setting_up (tenant_id)
      select t.id from public.tenants t
       where t.deleted_at is null
         and lower(btrim(coalesce(t.plan, ''))) <> 'offline'
         and not exists (select 1 from public.receipts r where r.tenant_id = t.id);
  end if;
end $$;

create table if not exists platform.removed_tills (
  device_id uuid primary key,
  tenant_id uuid, -- no foreign key: it outlives the client, as the log does
  removed_at timestamptz not null default now()
);

-- A client that is made starts as one being set up. It runs as its owner: the
-- platform schema is nobody else's.
create or replace function platform.client_starts() returns trigger
language plpgsql security definer set search_path = public as $fn$
begin
  insert into platform.setting_up (tenant_id) values (new.id) on conflict do nothing;
  return null;
end $fn$;
drop trigger if exists trg_setting_up on tenants;
create trigger trg_setting_up after insert on tenants
  for each row execute function platform.client_starts();

create or replace function platform.is_setting_up(p_tenant uuid) returns boolean
language sql stable set search_path = public as $fn$
  select exists (select 1 from platform.setting_up where tenant_id = p_tenant);
$fn$;

create or replace function platform.go_live(p_admin uuid, p_tenant uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  perform platform.require_admin(p_admin);
  if not exists (select 1 from tenants where id = p_tenant and deleted_at is null) then raise exception 'unknown-tenant'; end if;
  delete from platform.setting_up where tenant_id = p_tenant;
  if not found then raise exception 'already-live'; end if;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.live', p_tenant, '{}'::jsonb);
end $fn$;

create or replace function platform.back_to_setting_up(p_admin uuid, p_tenant uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  perform platform.require_admin(p_admin);
  if not exists (select 1 from tenants where id = p_tenant and deleted_at is null) then raise exception 'unknown-tenant'; end if;
  if platform.is_setting_up(p_tenant) then raise exception 'already-setting-up'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  -- from its first sale a live client's receipts are its books
  if exists (select 1 from receipts where tenant_id = p_tenant) then raise exception 'has-receipts'; end if;
  insert into platform.setting_up (tenant_id) values (p_tenant);
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.setting_up', p_tenant, '{}'::jsonb);
end $fn$;

-- Has this till anything recorded? A sale, a day, cash, a count of the
-- drawer, a clock-in: any of them and it is a till that worked.
create or replace function platform.till_is_bare(p_tenant uuid, p_device uuid) returns boolean
language sql stable set search_path = public as $fn$
  select not (
       exists (select 1 from receipts where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from shifts where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from cash_movements where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from day_closes where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from drawer_counts where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from timeclock_punches where tenant_id = p_tenant and device_id = p_device));
$fn$;

create or replace function platform.remove_till(p_admin uuid, p_device uuid) returns void
language plpgsql set search_path = public as $fn$
declare d record;
begin
  perform platform.require_admin(p_admin);
  select p.tenant_id, p.code, p.name, lower(btrim(coalesce(t.plan, ''))) = 'offline' as offline
    into d from pos_devices p join tenants t on t.id = p.tenant_id
   where p.id = p_device for update of p;
  if not found then raise exception 'unknown-till'; end if;
  perform set_config('app.tenant_id', d.tenant_id::text, true);
  -- a tablet that works on its own keeps its sales to itself: nothing here
  -- says whether it has sold, so only a client being set up loses one
  if d.offline and not platform.is_setting_up(d.tenant_id) then raise exception 'till-of-live-offline'; end if;
  if not platform.till_is_bare(d.tenant_id, p_device) then raise exception 'till-has-records'; end if;
  delete from till_requests where tenant_id = d.tenant_id and device_id = p_device;
  delete from tablet_codes where tenant_id = d.tenant_id and device_id = p_device;
  -- its key, and when it was last heard from, go with it
  delete from pos_devices where id = p_device;
  insert into platform.removed_tills (device_id, tenant_id) values (p_device, d.tenant_id) on conflict do nothing;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'till.remove', d.tenant_id, jsonb_build_object('device_id', p_device, 'code', d.code, 'name', d.name));
end $fn$;

create or replace function platform.remove_code(p_admin uuid, p_code uuid) returns void
language plpgsql set search_path = public as $fn$
declare c record;
begin
  perform platform.require_admin(p_admin);
  select tenant_id, hint, used_at, ended_at into c from tablet_codes where id = p_code for update;
  if not found then raise exception 'unknown-code'; end if;
  -- in use: a tablet at work. It goes with its till, or is ended by a replacement.
  if c.used_at is not null and c.ended_at is null then raise exception 'code-in-use'; end if;
  perform set_config('app.tenant_id', c.tenant_id::text, true);
  delete from tablet_codes where id = p_code;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tablet.code_remove', c.tenant_id, jsonb_build_object('code_id', p_code, 'hint', c.hint));
end $fn$;

-- What a client's sales and refunds have taken off its shelves, for each line
-- of stock (a product, or one variant of it, in one shop), as it has to be
-- put back when those sales are cleared: the sum of their movements.
--
-- A sale rung up before the shelf was last counted is left out. The count
-- found what was really there, with nothing really sold, and set the level to
-- that: the sale is no longer in the level, and putting it back would count
-- it twice. Which came first is judged as a count judges it (0075): a sale by
-- when it was rung up on the till, a count by when its line was counted. A
-- completed count's lines say that themselves, also where the count found
-- nothing to change and so wrote no movement; a count of one item on a
-- restaurant's Stock page (stock_count_item, 0067) has no lines, and is
-- judged by when its movement was saved.
create or replace function platform.test_sales_on_stock(p_tenant uuid)
returns table (store_id uuid, item_id uuid, variant_id uuid, qty bigint)
language sql stable set search_path = public as $fn$
  with counted as (
    select x.store_id, x.item_id, x.variant_id, max(x.at) as at from (
      select k.store_id, l.item_id, l.variant_id, l.counted_at as at
        from stock_count_lines l
        join stock_counts k on k.tenant_id = l.tenant_id and k.id = l.count_id
       where l.tenant_id = p_tenant and k.status = 'completed' and not l.left_out
         and l.counted is not null and l.counted_at is not null
      union all
      select m.store_id, m.item_id, m.variant_id, m.created_at
        from stock_movements m
       where m.tenant_id = p_tenant and m.reason = 'count' and m.ref_id is null and m.deleted_at is null) x
     group by 1, 2, 3)
  select m.store_id, m.item_id, m.variant_id, sum(m.qty)::bigint
    from stock_movements m
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
    left join counted c on c.store_id is not distinct from m.store_id and c.item_id = m.item_id
         and c.variant_id is not distinct from m.variant_id
   where m.tenant_id = p_tenant and m.reason in ('sale', 'refund') and m.deleted_at is null
     and (c.at is null or coalesce(r.device_time, m.created_at) > c.at)
   group by 1, 2, 3
  having sum(m.qty) <> 0;
$fn$;

create or replace function platform.clear_test_activity(p_admin uuid, p_tenant uuid) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  t record;
  v_receipts bigint; v_orders bigint; v_tills bigint; v_codes bigint;
  tbl text;
begin
  perform platform.require_admin(p_admin);
  select id, lower(btrim(coalesce(plan, ''))) = 'offline' as offline into t
    from tenants where id = p_tenant and deleted_at is null;
  if not found then raise exception 'unknown-tenant'; end if;
  if not platform.is_setting_up(p_tenant) then raise exception 'client-live'; end if;
  -- a client that runs on its tablet has nothing of its trying here: its
  -- sales are on the tablet, and its tills are removed one by one
  if t.offline then raise exception 'client-offline'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  -- a till that is sending at this moment makes this wait; not for long
  perform set_config('lock_timeout', '8s', true);

  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_orders from tickets where tenant_id = p_tenant;
  select count(*) into v_tills from pos_devices where tenant_id = p_tenant;
  -- a code made for a new tablet that nobody has used yet stays: it may be in
  -- someone's hand for the day the tablets are set up again
  select count(*) into v_codes from tablet_codes
   where tenant_id = p_tenant and not (device_id is null and used_at is null and ended_at is null);

  -- the shelves first: the level, then the item's total, in the order the
  -- stock engine locks them (0067)
  update stock_levels s set qty = s.qty - b.qty
    from platform.test_sales_on_stock(p_tenant) b
   where s.tenant_id = p_tenant and s.store_id = b.store_id and s.item_id = b.item_id
     and s.variant_id is not distinct from b.variant_id;
  update items i set stock_qty = coalesce(i.stock_qty, 0) - b.qty
    from (select x.item_id, sum(x.qty) as qty from platform.test_sales_on_stock(p_tenant) x group by 1) b
   where i.tenant_id = p_tenant and i.id = b.item_id;
  delete from stock_movements where tenant_id = p_tenant and reason in ('sale', 'refund');

  insert into platform.removed_tills (device_id, tenant_id)
    select id, p_tenant from pos_devices where tenant_id = p_tenant
  on conflict do nothing;

  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach tbl in array array[
    'bookings','approvals','drawer_counts','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied',
    'till_requests','device_activity','device_keys','pos_devices']
  loop
    execute format('delete from %I where tenant_id = $1', tbl) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  delete from tablet_codes
   where tenant_id = p_tenant and not (device_id is null and used_at is null and ended_at is null);

  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.clear_test', p_tenant,
      jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'tills', v_tills, 'codes', v_codes));
  return jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'tills', v_tills, 'codes', v_codes);
end $fn$;

-- For the till service: was this id a till that was removed?
create or replace function till_removed(p_device uuid) returns boolean
language sql stable set search_path = public as $fn$
  select exists (select 1 from platform.removed_tills where device_id = p_device);
$fn$;
revoke all on function till_removed(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'app_user') then
    revoke all on function till_removed(uuid) from app_user;
  end if;
end $$;
