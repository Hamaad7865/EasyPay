-- 0102: tables set at an angle, booths and bar stools, and the room itself.
--
-- The owner chose three things for the floor plan, each drawn in the back
-- office and on the tablets alike:
--
--   - a table set at an angle: tables.rotation, whole degrees from 0 to 359.
--     A table's place and size (x, y, w, h) are still its rectangle before it
--     is turned, and that rectangle is what has to be whole on the 100 by 60
--     plan: the angle turns the drawing about the rectangle's middle and
--     changes no rule;
--   - booths and bar stools: two more values of tables.shape. They seat
--     guests and take orders, so they are tables: a number of their own, the
--     same 300 to a store. A tablet built before this draws either as a
--     square table, and seats and serves it as one;
--   - walls, doors, windows and a bar counter: floor_elements, a table of
--     their own, because nothing of theirs is a table's (no number, no
--     covers, no order, and a wall is one unit thick where a table is four at
--     least). A tablet built before this reads past them.
--
-- floor.save (0101) takes them: a table may carry `rotation` (left as it is
-- when not sent, so a plan saved by a till built before this turns nothing
-- back), and the room's elements come as `elements` and `removed_elements`,
-- both left alone when not sent. A room renamed or removed takes its elements
-- with it. 200 elements to a store. No new refusal: bad-payload, too-many and
-- conflict are words sync_push already lets through, so it is not redefined.
--
-- Source: push_floor_save, push_room_rename, push_room_remove and sync_pull
-- are their live definitions on the dev branch (db/scripts/dump-function.cjs)
-- with what this migration adds; of sync_pull only the list of a store's own
-- tables changes.

alter table tables add column if not exists rotation int not null default 0;
alter table tables drop constraint if exists tables_rotation_check;
alter table tables add constraint tables_rotation_check check (rotation between 0 and 359);
alter table tables drop constraint if exists tables_shape_check;
alter table tables add constraint tables_shape_check check (shape in ('square', 'round', 'booth', 'stool'));

create table if not exists floor_elements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  -- the room it stands in: the name the room's tables share
  area text not null default 'Main' check (btrim(area) <> ''),
  kind text not null check (kind in ('wall', 'door', 'window', 'bar')),
  -- its rectangle before it is turned, whole on the 100 by 60 plan
  x int not null default 0 check (x between 0 and 100),
  y int not null default 0 check (y between 0 and 60),
  w int not null default 10 check (w between 1 and 100),
  h int not null default 1 check (h between 1 and 60),
  rotation int not null default 0 check (rotation between 0 and 359),
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict,
  check (x + w <= 100 and y + h <= 60)
);
alter table floor_elements enable row level security;
alter table floor_elements force row level security;
drop policy if exists tenant_isolation on floor_elements;
create policy tenant_isolation on floor_elements
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on floor_elements;
create trigger trg_touch before insert or update on floor_elements
  for each row execute function touch_row();
create index if not exists idx_floor_elements_tenant_seq on floor_elements (tenant_id, server_seq);
create index if not exists idx_floor_elements_store on floor_elements (tenant_id, store_id) where deleted_at is null;
grant select, insert, update, delete on floor_elements to app_user;

create or replace function push_floor_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_store uuid; v_area text; t jsonb; v_id uuid; v_name text;
  v_seats int; v_shape text; v_x int; v_y int; v_w int; v_h int; v_rot int;
  v_ids uuid[] := '{}'; v_names text[] := '{}'; v_gone uuid[] := '{}';
  v_rows jsonb := '[]'::jsonb; v_others int; v_sort int; v_n int; v_removed int := 0;
  e jsonb; v_kind text; v_eids uuid[] := '{}'; v_egone uuid[] := '{}'; v_eothers int; v_esaved int := 0; v_eremoved int := 0;
begin
  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_area := left(btrim(coalesce(p->>'area', '')), 30);
  if v_store is null or v_area = '' or jsonb_typeof(p->'tables') is distinct from 'array'
     or jsonb_array_length(p->'tables') > 300
     or (p ? 'removed' and jsonb_typeof(p->'removed') <> 'array')
     or (p ? 'elements' and jsonb_typeof(p->'elements') <> 'array')
     or (p ? 'removed_elements' and jsonb_typeof(p->'removed_elements') <> 'array') then raise exception 'bad-payload'; end if;
  if p ? 'elements' and jsonb_array_length(p->'elements') > 200 then raise exception 'bad-payload'; end if;
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
      -- the angle it is set at (0102); not sent, it is left as it is
      v_rot := (t->>'rotation')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    v_name := left(btrim(coalesce(t->>'name', '')), 30);
    v_shape := coalesce(t->>'shape', 'square');
    if v_id is null or v_name = '' or v_seats is null or v_seats not between 1 and 99
       or v_shape not in ('square', 'round', 'booth', 'stool')
       or v_w is null or v_w not between 4 and 100 or v_h is null or v_h not between 4 and 60
       or v_x is null or v_x < 0 or v_x + v_w > 100 or v_y is null or v_y < 0 or v_y + v_h > 60
       or (v_rot is not null and v_rot not between 0 and 359)
       or v_id = any (v_ids) then
      raise exception 'bad-payload';
    end if;
    if lower(v_name) = any (v_names) then raise exception 'name-taken'; end if;
    v_ids := v_ids || v_id;
    v_names := v_names || lower(v_name);
    v_rows := v_rows || jsonb_build_object('id', v_id, 'name', v_name, 'seats', v_seats, 'shape', v_shape,
      'x', v_x, 'y', v_y, 'w', v_w, 'h', v_h, 'rotation', v_rot);
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

  -- the room's walls, doors, windows and bar (0102), read before anything is written
  if p ? 'removed_elements' then
    begin
      select coalesce(array_agg(x::uuid), '{}') into v_egone from jsonb_array_elements_text(p->'removed_elements') x;
    exception when others then
      raise exception 'bad-payload';
    end;
  end if;
  if p ? 'elements' then
    for e in select * from jsonb_array_elements(p->'elements') loop
      begin
        v_id := (e->>'id')::uuid;
        v_x := (e->>'x')::int; v_y := (e->>'y')::int; v_w := (e->>'w')::int; v_h := (e->>'h')::int;
        v_rot := coalesce((e->>'rotation')::int, 0);
      exception when others then
        raise exception 'bad-payload';
      end;
      v_kind := coalesce(e->>'kind', '');
      -- an element is one unit thick at least, and whole on the plan before it is turned
      if v_id is null or v_kind not in ('wall', 'door', 'window', 'bar')
         or v_w is null or v_w not between 1 and 100 or v_h is null or v_h not between 1 and 60
         or v_x is null or v_x < 0 or v_x + v_w > 100 or v_y is null or v_y < 0 or v_y + v_h > 60
         or v_rot not between 0 and 359
         or v_id = any (v_eids) or v_id = any (v_egone) then
        raise exception 'bad-payload';
      end if;
      v_eids := v_eids || v_id;
    end loop;
  end if;

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
    -- a table that is there keeps its place in the order, and its angle when none is sent; a new one goes after the last
    insert into tables (id, tenant_id, store_id, name, area, seats, shape, x, y, w, h, rotation, sort_order)
      values ((t->>'id')::uuid, p_tenant, v_store, t->>'name', v_area, (t->>'seats')::int, t->>'shape',
        (t->>'x')::int, (t->>'y')::int, (t->>'w')::int, (t->>'h')::int, coalesce((t->>'rotation')::int, 0), v_sort + 1)
    on conflict (id) do update set name = excluded.name, area = excluded.area, seats = excluded.seats,
      shape = excluded.shape, x = excluded.x, y = excluded.y, w = excluded.w, h = excluded.h,
      rotation = coalesce((t->>'rotation')::int, tables.rotation)
      where tables.tenant_id = excluded.tenant_id and tables.store_id = excluded.store_id and tables.deleted_at is null;
    get diagnostics v_n = row_count;
    -- the id is another client's table, another store's, or one that was removed
    if v_n = 0 then raise exception 'conflict'; end if;
    select coalesce(max(sort_order), -1) into v_sort from tables
      where tenant_id = p_tenant and store_id = v_store and deleted_at is null;
  end loop;

  -- the elements: the ones taken off removed, the ones sent written as they stand; any other is left alone
  update floor_elements set deleted_at = now()
    where tenant_id = p_tenant and store_id = v_store and id = any (v_egone) and deleted_at is null;
  get diagnostics v_eremoved = row_count;
  if p ? 'elements' then
    select count(*) into v_eothers from floor_elements
      where tenant_id = p_tenant and store_id = v_store and deleted_at is null and not (id = any (v_eids));
    if v_eothers + coalesce(array_length(v_eids, 1), 0) > 200 then raise exception 'too-many'; end if;
    for e in select * from jsonb_array_elements(p->'elements') loop
      insert into floor_elements (id, tenant_id, store_id, area, kind, x, y, w, h, rotation, sort_order)
        values ((e->>'id')::uuid, p_tenant, v_store, v_area, e->>'kind',
          (e->>'x')::int, (e->>'y')::int, (e->>'w')::int, (e->>'h')::int, coalesce((e->>'rotation')::int, 0), v_esaved)
      on conflict (id) do update set area = excluded.area, kind = excluded.kind, x = excluded.x, y = excluded.y,
        w = excluded.w, h = excluded.h, rotation = excluded.rotation, sort_order = excluded.sort_order
        where floor_elements.tenant_id = excluded.tenant_id and floor_elements.store_id = excluded.store_id
          and floor_elements.deleted_at is null;
      get diagnostics v_n = row_count;
      if v_n = 0 then raise exception 'conflict'; end if;
      v_esaved := v_esaved + 1;
    end loop;
  end if;
  return jsonb_build_object('saved', jsonb_array_length(v_rows), 'removed', v_removed,
    'elements', v_esaved, 'elements_removed', v_eremoved);
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
  -- its walls, doors, windows and bar go with it (0102)
  update floor_elements set area = v_to
    where tenant_id = p_tenant and store_id = v_store and deleted_at is null and area = v_from;
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
  -- and what stood in it (0102)
  update floor_elements set deleted_at = now()
    where tenant_id = p_tenant and store_id = v_store and deleted_at is null and area = v_area;
  return jsonb_build_object('removed', v_n);
end $fn$;

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
  -- and what the shop holds of each product (0077): a till that does not know
  -- the table reads past it. And what the back office asked of the store's
  -- tills (0091): each till acts on its own, and one too old to reads past it
  -- and what stands in its rooms beside the tables (0102): walls, doors,
  -- windows, a bar. A till that does not know the table reads past it
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts','bookings','stock_levels','till_requests','floor_elements']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and x.store_id = %L ' ||
      'and (%s) order by x.server_seq limit %s) t',
      cur, tbl, cur, p_store_id,
      case tbl
        when 'tables' then 'true'
        when 'stock_levels' then 'true'
        when 'floor_elements' then 'true'
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

  -- A shop's stock papers (0092): its suppliers, and this store's orders,
  -- deliveries, counts and movements. An order and a delivery arrive with
  -- their lines inside the row, as they stand when the pull runs: a draft's
  -- lines are deleted outright when it is saved again, which rows sent by
  -- sequence would never tell a till. A restaurant is sent none of this, and
  -- a till that does not know these tables reads past them.
  if exists (select 1 from pos_settings where tenant_id = current_tenant_id() and data->>'businessType' = 'retail') then
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from suppliers x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('suppliers', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'qty', l.qty, 'unit_cost', l.unit_cost,
                             'received', (select coalesce(sum(d.qty), 0)::integer from delivery_lines d where d.tenant_id = l.tenant_id and d.order_line_id = l.id))
                             order by l.item_id, l.variant_id nulls first), '[]'::jsonb)
                      from purchase_order_lines l where l.tenant_id = x.tenant_id and l.order_id = x.id and l.deleted_at is null) as lines
              from purchase_orders x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and (x.status in ('draft', 'sent', 'part') or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('purchase_orders', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'qty', l.qty, 'unit_cost', l.unit_cost)
                             order by l.item_id, l.variant_id nulls first), '[]'::jsonb)
                      from delivery_lines l where l.tenant_id = x.tenant_id and l.delivery_id = x.id) as lines
              from deliveries x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and x.created_at > now() - interval '30 days'
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('deliveries', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_counts x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and (x.status = 'open' or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_counts', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_count_lines x
              join stock_counts k on k.tenant_id = x.tenant_id and k.id = x.count_id and k.store_id = p_store_id
               and k.status <> 'open' and k.updated_at > now() - interval '30 days'
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_count_lines', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_movements x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and x.created_at > now() - interval '30 days'
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_movements', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end if;

  return jsonb_build_object(
    'changes', changes,
    'next_cursor', coalesce(low_cut, high, cur), 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $function$
;
