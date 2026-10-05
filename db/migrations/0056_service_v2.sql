-- 0056_service_v2.sql — what the redesigned till needs from the server.
-- Source: ensure_pos_basics, push_ticket_create, push_ticket_update_meta,
-- sync_push, sync_pull and purge_transactions are the live definitions
-- (pg_get_functiondef, as last written by 0049 to 0055) with the edits listed
-- here. Earlier migrations untouched.
--
-- What changes:
--   - dining_options.kind: what an order type is, so the till knows where it
--     belongs: dine (on a table), counter (the Quick sale key), takeaway and
--     delivery (the takeaway board), tab (a named tab). Existing types are
--     given a kind from needs_table and their name; a type saved without one
--     gets it the same way. ensure_pos_basics adds a Counter and a Delivery
--     type to a restaurant that has none of that kind.
--   - tickets: order_no (the short number the till gives an order that has no
--     table: C-12, A-7, D-3), phone, address, due_at, stage (new, kitchen,
--     ready, done: where a takeaway or delivery is on the board), rider,
--     source, bill_at (when the bill was printed). ticket.create and
--     ticket.update_meta take them; ticket.stage {ticket_id, stage, rider?}
--     moves an order along the board, paid or not.
--   - kitchen.mark {line_ids, status}: the kitchen display says a line is
--     done, or its ticket was bumped (or recalled): ticket_lines.kitchen_status
--     is unsent, sent, done or bumped.
--   - bookings: a table reserved for a party at a time. Made on the till or in
--     the back office (booking.upsert), sent to every till of its store.
--   - item.set_available {item_id, available}: sold out, or back on sale,
--     from the till. Needs items.availability (or items.edit), or someone who
--     has it to approve.
--   - purge_transactions also clears bookings.
-- Never edit after merge.

alter table dining_options add column if not exists kind text;
update dining_options set kind = case
    when needs_table then 'dine'
    when name ~* '(deliver|livraison)' then 'delivery'
    when name ~* '(take|emport|collect|pick)' then 'takeaway'
    when name ~* '\mtab\M' then 'tab'
    else 'counter' end
  where kind is null;

create or replace function dining_kind_default() returns trigger
language plpgsql as $fn$
begin
  if new.kind is null then
    new.kind := case
      when new.needs_table then 'dine'
      when new.name ~* '(deliver|livraison)' then 'delivery'
      when new.name ~* '(take|emport|collect|pick)' then 'takeaway'
      when new.name ~* '\mtab\M' then 'tab'
      else 'counter' end;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_kind on dining_options;
create trigger trg_kind before insert or update on dining_options
  for each row execute function dining_kind_default();
alter table dining_options alter column kind set not null;
alter table dining_options drop constraint if exists dining_options_kind_check;
alter table dining_options add constraint dining_options_kind_check
  check (kind in ('dine','counter','takeaway','delivery','tab'));

alter table tickets add column if not exists order_no text;
alter table tickets add column if not exists phone text;
alter table tickets add column if not exists address text;
alter table tickets add column if not exists due_at timestamptz;
alter table tickets add column if not exists stage text;
alter table tickets add column if not exists rider text;
alter table tickets add column if not exists source text;
alter table tickets add column if not exists bill_at timestamptz;
alter table tickets drop constraint if exists tickets_stage_check;
alter table tickets add constraint tickets_stage_check
  check (stage is null or stage in ('new','kitchen','ready','done'));

update ticket_lines set kitchen_status = 'sent' where kitchen_status = 'unsent' and sent_to_kitchen_at is not null;
alter table ticket_lines drop constraint if exists ticket_lines_kitchen_status_check;
alter table ticket_lines add constraint ticket_lines_kitchen_status_check
  check (kitchen_status in ('unsent','sent','done','bumped'));

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  booked_for timestamptz not null,
  name text not null check (btrim(name) <> ''),
  size integer not null check (size between 1 and 99),
  phone text,
  area text,
  table_id uuid,
  tags text,
  status text not null default 'confirmed' check (status in ('pending','confirmed','seated','noshow','cancelled')),
  ticket_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
alter table bookings enable row level security;
alter table bookings force row level security;
drop policy if exists tenant_isolation on bookings;
create policy tenant_isolation on bookings
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on bookings;
create trigger trg_touch before insert or update on bookings
  for each row execute function touch_row();
create index if not exists idx_bookings_tenant_seq on bookings (tenant_id, server_seq);
create index if not exists idx_bookings_store_time on bookings (tenant_id, store_id, booked_for);

-- Where a takeaway or delivery is on the board. Unlike update_meta this also
-- takes an order that is already paid: it is paid at the counter and collected
-- later.
create or replace function push_ticket_stage(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_ticket uuid; v_stage text;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  v_stage := p->>'stage';
  if v_ticket is null or (v_stage is not null and v_stage not in ('new','kitchen','ready','done')) then
    raise exception 'bad-payload'; end if;
  update tickets set
      stage = case when p ? 'stage' then v_stage else stage end,
      rider = case when p ? 'rider' then nullif(left(p->>'rider', 80), '') else rider end,
      due_at = case when p ? 'due_at' then (p->>'due_at')::timestamptz else due_at end
    where id = v_ticket and tenant_id = p_tenant;
  if not found then raise exception 'bad-ticket'; end if;
  return jsonb_build_object('ticket_id', v_ticket, 'stage', v_stage);
end $fn$;

-- The kitchen display: a line is done (or not after all), or its ticket was
-- bumped off the screen (or recalled). A line that is gone is skipped, never
-- refused: the kitchen has cooked it either way.
create or replace function push_kitchen_mark(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_status text; v_ids uuid[]; n int;
begin
  v_status := p->>'status';
  if v_status is null or v_status not in ('sent','done','bumped') or jsonb_typeof(p->'line_ids') is distinct from 'array' then
    raise exception 'bad-payload'; end if;
  select array_agg(value::uuid) into v_ids from jsonb_array_elements_text(p->'line_ids') as value;
  if v_ids is null then raise exception 'lines-required'; end if;
  update ticket_lines set kitchen_status = v_status
    where tenant_id = p_tenant and id = any(v_ids) and sent_to_kitchen_at is not null;
  get diagnostics n = row_count;
  return jsonb_build_object('marked', n);
end $fn$;

-- A booking as the till or the back office has it now: the whole row, last
-- one in wins. A table or an order this restaurant does not have is left off,
-- never refused.
create or replace function push_booking_upsert(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_store uuid; v_at timestamptz; v_name text; v_size int; v_status text;
begin
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
      (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant),
      nullif(btrim(left(coalesce(p->>'tags', ''), 240)), ''), v_status,
      (select t.id from tickets t where t.id = (p->>'ticket_id')::uuid and t.tenant_id = p_tenant), p_emp)
    on conflict (id) do update set booked_for = excluded.booked_for, name = excluded.name, size = excluded.size,
      phone = excluded.phone, area = excluded.area, table_id = excluded.table_id, tags = excluded.tags,
      status = excluded.status, ticket_id = coalesce(excluded.ticket_id, bookings.ticket_id), deleted_at = null
    where bookings.tenant_id = p_tenant;
  return jsonb_build_object('id', v_id);
end $fn$;

-- Sold out, or back on sale, from the till.
create or replace function push_item_set_available(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_item uuid; v_on boolean;
begin
  v_item := (p->>'item_id')::uuid;
  v_on := (p->>'available')::boolean;
  if v_item is null or v_on is null then raise exception 'bad-payload'; end if;
  if not (may(p_emp, p, 'items.availability') or may(p_emp, p, 'items.edit')) then raise exception 'forbidden'; end if;
  update items set is_available = v_on where id = v_item and tenant_id = p_tenant and deleted_at is null;
  if not found then raise exception 'bad-item'; end if;
  return jsonb_build_object('item_id', v_item, 'available', v_on);
end $fn$;

CREATE OR REPLACE FUNCTION public.ensure_pos_basics(p_tenant uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
begin
  if not exists (select 1 from payment_types where tenant_id = p_tenant) then
    insert into payment_types (tenant_id, name, kind, opens_drawer, sort_order) values
      (p_tenant, 'Cash', 'cash', true, 0),
      (p_tenant, 'Card', 'card', false, 1),
      (p_tenant, 'Juice by MCB', 'wallet', false, 2),
      (p_tenant, 'my.t money', 'wallet', false, 3),
      (p_tenant, 'Blink', 'wallet', false, 4),
      (p_tenant, 'MauCAS QR', 'qr', false, 5),
      (p_tenant, 'Bank transfer', 'other', false, 6);
  end if;
  if not exists (select 1 from taxes where tenant_id = p_tenant) then
    insert into taxes (tenant_id, name, rate_bp, type, is_default) values (p_tenant, 'VAT', 1500, 'included', true);
  end if;
  insert into taxes (tenant_id, name, rate_bp, type, is_default)
    select p_tenant, n.name, 0, 'included', false from (values ('Zero rated'), ('Exempt')) as n(name)
     where not exists (select 1 from taxes x where x.tenant_id = p_tenant and lower(x.name) = lower(n.name));
  if not exists (select 1 from dining_options where tenant_id = p_tenant) then
    insert into dining_options (tenant_id, name, is_default, sort_order, needs_table, kitchen) values
      (p_tenant, 'Dine-in', true, 0, true, 'save'),
      (p_tenant, 'Takeaway', false, 1, false, 'pay');
  end if;
  -- a counter sale (the Quick sale key) and a delivery (the takeaway board)
  insert into dining_options (tenant_id, name, is_default, sort_order, needs_table, kitchen, kind)
    select p_tenant, n.name, false,
        (select coalesce(max(sort_order), -1) + 1 from dining_options where tenant_id = p_tenant) + n.ord, false, 'pay', n.kind
      from (values ('Counter', 'counter', 0), ('Delivery', 'delivery', 1)) as n(name, kind, ord)
     where not exists (select 1 from dining_options x where x.tenant_id = p_tenant and x.kind = n.kind and x.deleted_at is null);
  insert into pos_settings (tenant_id, data)
    select p_tenant, '{}'::jsonb where not exists (select 1 from pos_settings where tenant_id = p_tenant);
end $function$;

CREATE OR REPLACE FUNCTION public.push_ticket_create(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_store uuid; v_dining uuid;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  if v_id is null or v_store is null then raise exception 'bad-payload'; end if;
  if not exists (select 1 from stores where id = v_store) then raise exception 'bad-store'; end if;
  if p->>'dining_option_id' is not null then
    v_dining := (p->>'dining_option_id')::uuid;
    if not exists (select 1 from dining_options where id = v_dining) then raise exception 'bad-dining'; end if;
  end if;
  if p->>'stage' is not null and p->>'stage' not in ('new','kitchen','ready','done') then raise exception 'bad-payload'; end if;
  insert into tickets (id, tenant_id, store_id, table_id, dining_option_id, name, note, covers, opened_by,
      order_no, phone, address, due_at, stage, source)
    values (v_id, p_tenant,
      v_store,
      -- a table this restaurant does not have is left off, never refused
      (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant),
      v_dining, nullif(p->>'name',''), nullif(p->>'note',''),
      case when p->>'covers' is null then null else (p->>'covers')::int end,
      p_emp,
      nullif(left(p->>'order_no', 24), ''), nullif(left(p->>'phone', 40), ''), nullif(left(p->>'address', 240), ''),
      (p->>'due_at')::timestamptz, p->>'stage', nullif(left(p->>'source', 24), ''));
  return jsonb_build_object('ticket_id', v_id);
end $function$;

CREATE OR REPLACE FUNCTION public.push_ticket_update_meta(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_ticket uuid; v_dining uuid;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  if v_ticket is null then raise exception 'bad-payload'; end if;
  if p->>'opened_by' is not null and not may(p_emp, p, 'ticket.reassign') then raise exception 'forbidden'; end if;
  if p->>'dining_option_id' is not null then
    v_dining := (p->>'dining_option_id')::uuid;
    if not exists (select 1 from dining_options where id = v_dining) then raise exception 'bad-dining'; end if;
  end if;
  update tickets set
    table_id = case when p ? 'table_id' and p->>'table_id' is null then null
      when p->>'table_id' is null then table_id
      -- moving to a table this restaurant does not have takes the order off its table
      else (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant) end,
    dining_option_id = case when p ? 'dining_option_id' and p->>'dining_option_id' is null then null
      when v_dining is null and not (p ? 'dining_option_id') then dining_option_id else v_dining end,
    -- the customer the order is for; one this restaurant does not have leaves it with none
    customer_id = case when p ? 'customer_id' and p->>'customer_id' is null then null
      when p->>'customer_id' is null then customer_id
      else (select cu.id from customers cu where cu.id = (p->>'customer_id')::uuid and cu.tenant_id = p_tenant and cu.deleted_at is null) end,
    note = case when p ? 'note' then nullif(p->>'note','') else note end,
    -- who to ring and where to bring it (takeaway, delivery)
    phone = case when p ? 'phone' then nullif(left(p->>'phone', 40), '') else phone end,
    address = case when p ? 'address' then nullif(left(p->>'address', 240), '') else address end,
    due_at = case when p ? 'due_at' then (p->>'due_at')::timestamptz else due_at end,
    -- when the bill was printed for the table; null when it was added to since
    bill_at = case when p ? 'bill_at' then (p->>'bill_at')::timestamptz else bill_at end,
    covers = case when p ? 'covers' and p->>'covers' is null then null
      when p->>'covers' is null then covers else (p->>'covers')::int end,
    name = case when p ? 'name' then nullif(p->>'name','') else name end,
    -- change waiter: someone of this restaurant, else the order keeps its waiter
    opened_by = coalesce((select e.id from employees e
      where p->>'opened_by' is not null and e.id = (p->>'opened_by')::uuid and e.tenant_id = p_tenant), opened_by)
    where id = v_ticket and tenant_id = p_tenant and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  return jsonb_build_object('ticket_id', v_ticket);
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
    'bad-employee','bad-shift','shift-closed'];
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
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, v_emp, v_payload);
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, v_emp, v_payload);
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
          when 'kitchen.mark' then v_data := push_kitchen_mark(tenant, v_emp, v_payload);
          when 'booking.upsert' then v_data := push_booking_upsert(tenant, v_emp, v_payload);
          when 'item.set_available' then v_data := push_item_set_available(tenant, v_emp, v_payload);
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

CREATE OR REPLACE FUNCTION public.sync_pull(p_store_id uuid, p_cursor bigint, p_lim integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  tbl text;
  cols text;
  r jsonb; m bigint; c int;
  lim int := greatest(least(coalesce(p_lim, 200), 1000), 1);
  cur bigint := coalesce(p_cursor, 0);
  low_cut bigint := null;
  high bigint := null;
  more boolean := false;
  changes jsonb := '{}'::jsonb;
begin
  if current_tenant_id() is null then
    raise exception 'app.tenant_id must be set';
  end if;
  if not exists (select 1 from stores where id = p_store_id) then
    raise exception 'unknown store';
  end if;
  -- one point in the sequence: writers holding touch_row's exclusive lock
  -- finish first, and new writers wait until this txn commits
  perform pg_advisory_xact_lock_shared(hashtextextended(current_tenant_id()::text, 0));

  foreach tbl in array array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items','pos_devices',
    'printers','pos_settings','customers']
  loop
    cols := case tbl when 'employees' then
        'id, tenant_id, name, pin_hash, role_id, auth_user_id, is_active, ' ||
        'created_at, updated_at, deleted_at, server_seq'
      else '*' end;
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from ' ||
      '(select %s from %I where server_seq > %L and tenant_id = current_tenant_id() ' ||
      'order by server_seq limit %s) t',
      cur, cols, tbl, cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tickets + children: this store only; open ones, and ones that changed in
  -- the last 30 days (a ticket changes when it closes, so the close arrives)
  foreach tbl in array array[
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() ' ||
      'order by x.server_seq limit %s) t',
      cur, tbl,
      case tbl
        when 'tickets' then
          format('join stores s on s.tenant_id = x.tenant_id and s.id = x.store_id and s.id = %L ' ||
            'and (x.status = ''open'' or x.updated_at > now() - interval ''30 days'')', p_store_id)
        when 'ticket_lines' then
          format('join tickets t on t.tenant_id = x.tenant_id and t.id = x.ticket_id and t.store_id = %L ' ||
            'and (t.status = ''open'' or t.updated_at > now() - interval ''30 days'')', p_store_id)
        else
          format('join ticket_lines tl on tl.tenant_id = x.tenant_id and tl.id = x.line_id ' ||
            'join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id and t.store_id = %L ' ||
            'and (t.status = ''open'' or t.updated_at > now() - interval ''30 days'')', p_store_id)
      end,
      cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- receipts: this store, last 30 days
  foreach tbl in array array[
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and r.store_id = %L ' ||
      'and r.created_at > now() - interval ''30 days'' order by x.server_seq limit %s) t',
      cur, tbl,
      case tbl
        when 'receipts' then
          'join receipts r on r.tenant_id = x.tenant_id and r.id = x.id'
        when 'receipt_line_modifiers' then
          'join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id ' ||
          'join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id'
        when 'receipt_line_taxes' then
          'join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id ' ||
          'join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id'
        else
          'join receipts r on r.tenant_id = x.tenant_id and r.id = x.receipt_id'
      end,
      cur, p_store_id, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tables, sales periods and clock punches: this store. A till needs the
  -- open period and who is clocked in, not the history, so a week is enough.
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts','bookings']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and x.store_id = %L ' ||
      'and (%s) order by x.server_seq limit %s) t',
      cur, tbl, cur, p_store_id,
      case tbl
        when 'tables' then 'true'
        when 'shifts' then 'x.closed_at is null or x.created_at > now() - interval ''7 days'''
        when 'day_closes' then 'x.created_at > now() - interval ''30 days'''
        when 'bookings' then 'x.booked_for > now() - interval ''7 days'''
        else 'x.created_at > now() - interval ''7 days'''
      end,
      lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  return jsonb_build_object(
    'changes', changes,
    'next_cursor', coalesce(low_cut, high, cur), 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $function$;

CREATE OR REPLACE FUNCTION public.purge_transactions(p_tenant uuid, p_emp uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_auth uuid; v_receipts bigint; v_tickets bigint; t text;
begin
  -- the caller is working in this restaurant, and is its owner
  if p_tenant is null or current_tenant_id() is distinct from p_tenant then raise exception 'forbidden'; end if;
  select e.auth_user_id into v_auth from employees e join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id
    where e.id = p_emp and e.tenant_id = p_tenant and e.deleted_at is null and e.is_active and r.permissions ? '*';
  if not found then raise exception 'forbidden'; end if;

  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_tickets from tickets where tenant_id = p_tenant;
  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach t in array array[
    'bookings','approvals','drawer_counts','stock_movements','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied']
  loop
    execute format('delete from %I where tenant_id = $1', t) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant;

  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;

do $$
declare t record;
begin
  for t in select id from tenants where deleted_at is null loop
    perform ensure_pos_basics(t.id);
  end loop;
end $$;
