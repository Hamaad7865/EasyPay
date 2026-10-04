-- 0055_seats_and_customers.sql — who at the table an item is for, and who
-- the order is for.
-- Source: push_ticket_add_line, push_ticket_split_line,
-- push_ticket_update_meta, sync_push and sync_pull are the live definitions
-- (pg_get_functiondef, as last written by 0049 to 0054) with the edits listed
-- here. Earlier migrations untouched.
--
-- What changes:
--   - ticket_lines.seat: the seat an item is for (1 to 99), or none when it
--     is for the table. ticket.add_line takes it; ticket.split_line keeps it
--     on both halves.
--   - ticket.place_lines {ticket_id, line_ids, seat?, course?}: moves lines
--     that are not paid or voided to another seat and/or course. A key that
--     is absent leaves that as it is; seat null puts the lines back on the
--     table.
--   - customers: name, phone, email and a note. Made and edited on the till
--     (customer.upsert) or in the back office, and sent to every till.
--   - ticket.update_meta takes customer_id, the same way it takes table_id:
--     null takes the customer off the order.
-- Never edit after merge.

alter table ticket_lines add column if not exists seat integer check (seat is null or seat between 1 and 99);

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  phone text,
  email text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
alter table customers enable row level security;
alter table customers force row level security;
drop policy if exists tenant_isolation on customers;
create policy tenant_isolation on customers
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on customers;
create trigger trg_touch before insert or update on customers
  for each row execute function touch_row();
create index if not exists idx_customers_tenant_seq on customers (tenant_id, server_seq);
create index if not exists idx_customers_tenant_name on customers (tenant_id, lower(name));
create index if not exists idx_tickets_customer on tickets (tenant_id, customer_id) where customer_id is not null;

create or replace function push_ticket_place_lines(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_ticket uuid; v_ids uuid[]; v_seat int; v_course int; n int;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  if v_ticket is null or jsonb_typeof(p->'line_ids') is distinct from 'array' or not (p ? 'seat' or p ? 'course') then
    raise exception 'bad-payload'; end if;
  select array_agg(value::uuid) into v_ids from jsonb_array_elements_text(p->'line_ids') as value;
  if v_ids is null then raise exception 'lines-required'; end if;
  if p->>'seat' is not null then
    v_seat := (p->>'seat')::int;
    if v_seat not between 1 and 99 then raise exception 'bad-payload'; end if;
  end if;
  if p->>'course' is not null then
    v_course := (p->>'course')::int;
    if v_course not between 1 and 99 then raise exception 'bad-payload'; end if;
  end if;
  if not exists (select 1 from tickets where id = v_ticket and tenant_id = p_tenant and status = 'open') then
    raise exception 'bad-ticket'; end if;
  update ticket_lines set
      seat = case when p ? 'seat' then v_seat else seat end,
      course = case when p ? 'course' then v_course else course end
    where tenant_id = p_tenant and ticket_id = v_ticket and id = any(v_ids)
      and voided_at is null and deleted_at is null and not paid;
  get diagnostics n = row_count;
  return jsonb_build_object('ticket_id', v_ticket, 'placed', n);
end $fn$;

create or replace function push_customer_upsert(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_name text;
begin
  v_id := (p->>'id')::uuid;
  v_name := btrim(coalesce(p->>'name', ''));
  if v_id is null or v_name = '' or length(v_name) > 120 then raise exception 'bad-payload'; end if;
  insert into customers (id, tenant_id, name, phone, email, note)
    values (v_id, p_tenant, v_name, nullif(btrim(coalesce(p->>'phone', '')), ''), nullif(btrim(coalesce(p->>'email', '')), ''),
      nullif(btrim(coalesce(p->>'note', '')), ''))
    on conflict (id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email, note = excluded.note,
      deleted_at = null
    where customers.tenant_id = p_tenant;
  return jsonb_build_object('id', v_id);
end $fn$;

CREATE OR REPLACE FUNCTION public.push_ticket_add_line(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_ticket uuid; v_item uuid; v_variant uuid; v_qty int;
  v_price bigint; v_name text; m jsonb; v_mod uuid; v_grp uuid;
  v_cat record; v_var record; v_tstore uuid;
  v_mrec record; v_mprice bigint;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_item := (p->>'item_id')::uuid;
  v_qty := coalesce((p->>'qty')::int, 0);
  if v_id is null or v_ticket is null or v_item is null or v_qty <= 0 then raise exception 'bad-payload'; end if;
  select store_id into v_tstore from tickets where id = v_ticket and status = 'open';
  if not found then raise exception 'ticket-closed'; end if;
  -- the row must exist for snapshots, but an offline sale is never rejected
  -- for price/availability drift: payload wins, then store override, then
  -- variant, then item. Drift is flagged at receipt time, not here.
  select price, name into v_cat from items where id = v_item;
  if not found then raise exception 'unknown-item'; end if;
  v_price := (p->>'unit_price')::bigint;
  v_name := nullif(p->>'name_snapshot','');
  if p->>'variant_id' is not null then
    v_variant := (p->>'variant_id')::uuid;
    select price, name into v_var from item_variants
      where id = v_variant and item_id = v_item and deleted_at is null;
    if not found then raise exception 'unknown-variant'; end if;
    v_name := coalesce(v_name, v_var.name);
    if v_price is null then v_price := v_var.price; end if;
  end if;
  if v_price is null then
    select price into v_price from store_item_overrides
      where tenant_id = p_tenant and store_id = v_tstore and item_id = v_item
        and deleted_at is null and price is not null;
  end if;
  if v_price is null then v_price := v_cat.price; end if;
  if v_name is null then v_name := v_cat.name; end if;
  if v_price < 0 then raise exception 'bad-payload'; end if;
  if p->>'seat' is not null and (p->>'seat')::int not between 1 and 99 then raise exception 'bad-payload'; end if;
  insert into ticket_lines (id, tenant_id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty, note, course, seat)
    values (v_id, p_tenant, v_ticket, v_item, v_variant, v_name, v_price, v_qty,
      nullif(p->>'note',''),
      case when p->>'course' is null then null else (p->>'course')::int end,
      case when p->>'seat' is null then null else (p->>'seat')::int end);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_id, t.id, t.name, t.rate_bp, t.type
    from item_taxes it join taxes t on t.tenant_id = p_tenant and t.id = it.tax_id
    where it.tenant_id = p_tenant and it.item_id = v_item and it.deleted_at is null;
  if jsonb_typeof(p->'modifiers') = 'array' then
    -- till-priced modifiers: [{modifier_id, price, name}]. What the till charged
    -- is stored. The modifier only has to exist: one that was re-priced or
    -- deleted while the till was offline is flagged at receipt time, never
    -- rejected here (the sale already happened).
    for m in select value from jsonb_array_elements(p->'modifiers') as value loop
      v_mod := (m->>'modifier_id')::uuid;
      select mo.name, mo.price into v_mrec from modifiers mo where mo.id = v_mod;
      if not found then raise exception 'bad-modifier'; end if;
      v_mprice := coalesce((m->>'price')::bigint, v_mrec.price);
      if v_mprice < 0 then raise exception 'bad-payload'; end if;
      insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
        values (p_tenant, v_id, v_mod, coalesce(nullif(m->>'name',''), v_mrec.name), v_mprice);
    end loop;
  else
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
  end if;
  return jsonb_build_object('line_id', v_id);
end $function$;

CREATE OR REPLACE FUNCTION public.push_ticket_split_line(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_line uuid; v_new uuid; v_qty int; l record;
begin
  v_line := (p->>'line_id')::uuid;
  v_new := (p->>'new_id')::uuid;
  v_qty := coalesce((p->>'qty')::int, 0);
  if v_line is null or v_new is null then raise exception 'bad-payload'; end if;
  select tl.* into l from ticket_lines tl
    join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id
   where tl.id = v_line and tl.tenant_id = p_tenant and t.status = 'open'
     and tl.voided_at is null and tl.deleted_at is null
   for update of tl;
  if not found then raise exception 'bad-line'; end if;
  if l.paid then raise exception 'paid-line'; end if;
  -- whole units, and something has to stay on the line
  if v_qty <= 0 or v_qty % 1000 <> 0 or l.qty % 1000 <> 0 or v_qty >= l.qty then raise exception 'bad-qty'; end if;
  if exists (select 1 from ticket_line_modifiers m
      where m.tenant_id = p_tenant and m.line_id = v_line and m.deleted_at is null and m.price <> 0) then
    raise exception 'bad-modifier';
  end if;
  update ticket_lines set qty = qty - v_qty where id = v_line and tenant_id = p_tenant;
  insert into ticket_lines (id, tenant_id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty,
      note, course, seat, paid, sent_to_kitchen_at, kitchen_status)
    values (v_new, p_tenant, l.ticket_id, l.item_id, l.variant_id, l.name_snapshot, l.unit_price, v_qty,
      l.note, l.course, l.seat, false, l.sent_to_kitchen_at, l.kitchen_status);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_new, tax_id, name_snapshot, rate_bp, type from ticket_line_taxes
     where tenant_id = p_tenant and line_id = v_line and deleted_at is null;
  insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
    select p_tenant, v_new, modifier_id, name_snapshot, price from ticket_line_modifiers
     where tenant_id = p_tenant and line_id = v_line and deleted_at is null;
  return jsonb_build_object('line_id', v_line, 'new_id', v_new, 'qty', v_qty);
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
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts']
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

