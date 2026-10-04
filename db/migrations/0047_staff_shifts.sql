-- 0047_staff_shifts.sql — staff at the till: who rang it up, sales periods,
-- clock in and out (spec 5.4, 7.2, 7.7).
-- Source: sync_push copied from 0041_push_codes_restore.sql and sync_pull from
-- 0039_pull_cursor.sql; each matched the live definition (pg_get_functiondef)
-- when this was written. 0039 and 0041 untouched.
--
-- What changes:
--   - An op may name the member of staff who did it ("employee_id" on the
--     op). The push functions then act as that employee: permissions, and the
--     receipt's employee, are theirs. See the comment in sync_push.
--   - shifts: a sales period on one till. One open per till (unique index, so
--     a second open comes back as 'conflict'). Opened with the cash in the
--     drawer, closed with what was counted; the server works out what should
--     have been there from the till's cash payments in between.
--   - timeclock_punches: clock in and clock out, one row each, never updated.
--     "Clocked in" is "the last punch was in". A row per punch (not a row per
--     stay) means two tablets punching the same person offline cannot clash.
--   - receipts are NOT tied to a shift by a key. A shift.open that is refused
--     must never take a paid receipt down with it; a shift's receipts are the
--     ones its till issued while it was open.
--   - sync_pull sends this store's shifts and punches.
-- Never edit after merge.

create table if not exists shifts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid not null,
  opened_by uuid,
  opened_at timestamptz not null,
  opening_float bigint not null default 0 check (opening_float >= 0),
  closed_by uuid,
  closed_at timestamptz,
  expected_cash bigint,
  counted_cash bigint check (counted_cash is null or counted_cash >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict,
  foreign key (tenant_id, device_id) references pos_devices (tenant_id, id) on delete restrict,
  foreign key (tenant_id, opened_by) references employees (tenant_id, id) on delete set null (opened_by),
  foreign key (tenant_id, closed_by) references employees (tenant_id, id) on delete set null (closed_by)
);

alter table shifts enable row level security;
alter table shifts force row level security;
drop policy if exists tenant_isolation on shifts;
create policy tenant_isolation on shifts
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on shifts;
create trigger trg_touch before insert or update on shifts
  for each row execute function touch_row();
create index if not exists idx_shifts_tenant_seq on shifts (tenant_id, server_seq);
create unique index if not exists uq_shifts_one_open on shifts (tenant_id, device_id)
  where closed_at is null and deleted_at is null;

create table if not exists timeclock_punches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid,
  employee_id uuid not null,
  kind text not null check (kind in ('in', 'out')),
  device_time timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict,
  foreign key (tenant_id, employee_id) references employees (tenant_id, id) on delete cascade
);

alter table timeclock_punches enable row level security;
alter table timeclock_punches force row level security;
drop policy if exists tenant_isolation on timeclock_punches;
create policy tenant_isolation on timeclock_punches
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on timeclock_punches;
create trigger trg_touch before insert or update on timeclock_punches
  for each row execute function touch_row();
create index if not exists idx_timeclock_punches_tenant_seq on timeclock_punches (tenant_id, server_seq);
create index if not exists idx_timeclock_punches_employee on timeclock_punches (tenant_id, employee_id, device_time);

-- Open a sales period on a till, with the cash that is in its drawer.
create or replace function push_shift_open(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_device uuid; v_store uuid; v_float bigint; v_at timestamptz;
begin
  v_id := (p->>'id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_float := coalesce((p->>'opening_float')::bigint, 0);
  v_at := coalesce((p->>'opened_at')::timestamptz, now());
  if v_id is null or v_device is null or v_float < 0 then raise exception 'bad-payload'; end if;
  if not has_perm(p_emp, 'shift.open_close') then raise exception 'forbidden'; end if;
  -- a till that was deactivated but is still signed in keeps working (0045)
  select store_id into v_store from pos_devices where id = v_device and tenant_id = p_tenant;
  if not found then raise exception 'bad-device'; end if;
  -- a second open period on the same till breaks uq_shifts_one_open: 'conflict'
  insert into shifts (id, tenant_id, store_id, device_id, opened_by, opened_at, opening_float)
    values (v_id, p_tenant, v_store, v_device, p_emp, v_at, v_float);
  return jsonb_build_object('shift_id', v_id);
end $fn$;

-- Close it with the cash that was counted. Expected = what it opened with
-- plus the cash this till took (less cash it refunded) while it was open.
create or replace function push_shift_close(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_counted bigint; v_at timestamptz;
  v_device uuid; v_opened timestamptz; v_float bigint; v_closed timestamptz; v_cash bigint;
begin
  v_id := (p->>'id')::uuid;
  v_counted := (p->>'counted_cash')::bigint;
  v_at := coalesce((p->>'closed_at')::timestamptz, now());
  if v_id is null or v_counted is null or v_counted < 0 then raise exception 'bad-payload'; end if;
  if not has_perm(p_emp, 'shift.open_close') then raise exception 'forbidden'; end if;
  select device_id, opened_at, opening_float, closed_at into v_device, v_opened, v_float, v_closed
    from shifts where id = v_id and tenant_id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'bad-shift'; end if;
  if v_closed is not null then raise exception 'shift-closed'; end if;
  select coalesce(sum(case when r.type = 'refund' then -rp.amount else rp.amount end), 0) into v_cash
    from receipt_payments rp
    join receipts r on r.tenant_id = rp.tenant_id and r.id = rp.receipt_id
    join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id
   where r.tenant_id = p_tenant and r.device_id = v_device and r.deleted_at is null
     and pt.kind = 'cash'
     and coalesce(r.device_time, r.created_at) >= v_opened
     and coalesce(r.device_time, r.created_at) <= v_at;
  update shifts set closed_by = p_emp, closed_at = v_at, counted_cash = v_counted,
      expected_cash = v_float + v_cash
    where id = v_id and tenant_id = p_tenant;
  return jsonb_build_object('shift_id', v_id, 'expected_cash', v_float + v_cash, 'counted_cash', v_counted);
end $fn$;

-- One clock punch, for the member of staff who entered their PIN.
create or replace function push_timeclock_punch(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_store uuid; v_device uuid; v_kind text; v_at timestamptz;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_kind := p->>'kind';
  v_at := coalesce((p->>'device_time')::timestamptz, now());
  if v_id is null or v_store is null or v_kind is null or v_kind not in ('in', 'out') then
    raise exception 'bad-payload';
  end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant) then
    raise exception 'bad-store';
  end if;
  insert into timeclock_punches (id, tenant_id, store_id, device_id, employee_id, kind, device_time)
    values (v_id, p_tenant, v_store, v_device, p_emp, v_kind, v_at);
  return jsonb_build_object('punch_id', v_id);
end $fn$;

create or replace function sync_push(p_employee_id uuid, p_ops jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
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
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, v_emp, op->'payload');
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, v_emp, op->'payload');
          when 'ticket.void_line' then v_data := push_ticket_void_line(tenant, v_emp, op->'payload');
          when 'ticket.update_meta' then v_data := push_ticket_update_meta(tenant, v_emp, op->'payload');
          when 'ticket.move_lines' then v_data := push_ticket_move_lines(tenant, v_emp, op->'payload');
          when 'ticket.merge' then v_data := push_ticket_merge(tenant, v_emp, op->'payload');
          when 'receipt.create' then v_data := push_receipt_create(tenant, v_emp, op->'payload');
          when 'refund.create' then v_data := push_refund_create(tenant, v_emp, op->'payload');
          when 'shift.open' then v_data := push_shift_open(tenant, v_emp, op->'payload');
          when 'shift.close' then v_data := push_shift_close(tenant, v_emp, op->'payload');
          when 'timeclock.punch' then v_data := push_timeclock_punch(tenant, v_emp, op->'payload');
          else raise exception 'unknown-op';
        end case;
        v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'data', v_data);
        insert into sync_ops_applied (op_id, tenant_id, type, result)
          values (v_op_id, tenant, v_logtype, v_envelope);
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
end $fn$;

create or replace function sync_pull(p_store_id uuid, p_cursor bigint, p_lim int)
returns jsonb language plpgsql set search_path = public as $fn$
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
    'store_item_overrides','grid_pages','grid_page_items','pos_devices']
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

  -- tickets + children: this store only
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
          format('join stores s on s.tenant_id = x.tenant_id and s.id = x.store_id and s.id = %L', p_store_id)
        when 'ticket_lines' then
          format('join tickets t on t.tenant_id = x.tenant_id and t.id = x.ticket_id and t.store_id = %L', p_store_id)
        else
          format('join ticket_lines tl on tl.tenant_id = x.tenant_id and tl.id = x.line_id ' ||
            'join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id and t.store_id = %L', p_store_id)
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

  -- sales periods and clock punches: this store. A till needs the open
  -- period and who is clocked in, not the history, so a week is enough.
  foreach tbl in array array['shifts','timeclock_punches']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and x.store_id = %L ' ||
      'and (%s) order by x.server_seq limit %s) t',
      cur, tbl, cur, p_store_id,
      case tbl
        when 'shifts' then 'x.closed_at is null or x.created_at > now() - interval ''7 days'''
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
end $fn$;
