-- 0091: what the back office asks of a till.
--
-- The owner wanted Carfection's "power off" (close a till's day from the back
-- office) and its cash out, and chose how: "the back office asks and the
-- tablet closes at its next sync". A till works with no connection and owns
-- its day: it works out what its drawer should hold from what it holds
-- itself, numbers the closing and prints the Z. A day closed on the server
-- alone would not be known to the tablet until it pulled, and what it sold
-- meanwhile would belong to no day. So nothing is closed here. A request is
-- left, tills are sent the requests of their store in a pull (as they are
-- sent its shifts and cash movements), and a till carries out its own with
-- its own figures, then answers.
--
--   till_requests            one row for each thing asked of a till: which
--                            till and which of its days (the shift open when
--                            it was asked), close_day or cash_out, the count
--                            (empty: close at what the till expects) or the
--                            amount and what for, who asked and when, and how
--                            it ended: waiting, done, refused (with why), or
--                            cancelled.
--   till_request(...)        asks. Refuses what a till could not do or the
--                            person may not do on a till either.
--   till_request_cancel(...) cancels one that still waits.
--   request.answer           the till's op: done, or refused and why. An
--                            answer to a request that no longer waits changes
--                            nothing: the owner cancelled it meanwhile.
--
-- A till carries requests out from build 12 on. An older build is sent the
-- table and reads past it, so nothing is asked of it: till_request refuses.
--
-- sync_pull and sync_push are the live definitions (dumped from dev, which
-- has every migration up to 0090) with one addition each: the table in the
-- store's own list, and the op with its refusal code.
-- Never edit after merge.

create table if not exists till_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid not null,
  shift_id uuid not null,
  kind text not null check (kind in ('close_day', 'cash_out')),
  -- close_day: what was counted in the drawer; null closes at what the till expects
  counted_cash bigint check (counted_cash is null or counted_cash >= 0),
  -- cash_out: how much, and what for
  amount bigint check (amount is null or amount > 0),
  reason text,
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  status text not null default 'waiting' check (status in ('waiting', 'done', 'refused', 'cancelled')),
  answered_at timestamptz,
  -- why the till refused, in words the owner reads
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict,
  check ((kind = 'close_day' and amount is null) or (kind = 'cash_out' and amount is not null and counted_cash is null))
);
alter table till_requests enable row level security;
alter table till_requests force row level security;
drop policy if exists tenant_isolation on till_requests;
create policy tenant_isolation on till_requests
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on till_requests;
create trigger trg_touch before insert or update on till_requests
  for each row execute function touch_row();
create index if not exists idx_till_requests_tenant_seq on till_requests (tenant_id, server_seq);
create index if not exists idx_till_requests_device on till_requests (tenant_id, device_id, requested_at desc);
-- one closing waits for a till at a time
create unique index if not exists uq_till_requests_one_close on till_requests (tenant_id, device_id)
  where kind = 'close_day' and status = 'waiting' and deleted_at is null;

-- The first build of the till that carries requests out.
create or replace function till_request_build() returns integer language sql immutable as $$ select 12 $$;

-- Asks a till to close its day or to record cash taken out. Returns the
-- request's id. Refused, with a code the back office puts into words:
--   forbidden       this person may not do it on a till either
--   bad-kind        not something a till is asked
--   bad-device      not a till of this business, or deactivated
--   till-too-old    its build does not carry requests out (or never said its build)
--   no-day-open     the till has no day open, as far as it has synced
--   already-asked   a closing already waits for it
--   bad-amount      a count below nothing, or a cash out of nothing
--   reason-required a cash out that does not say what for
create or replace function till_request(
  p_emp uuid, p_device uuid, p_kind text, p_counted bigint, p_amount bigint, p_reason text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_tenant uuid := current_tenant_id();
  v_store uuid;
  v_shift uuid;
  v_id uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if v_tenant is null then raise exception 'no-tenant-context'; end if;
  if p_kind is null or p_kind not in ('close_day', 'cash_out') then raise exception 'bad-kind'; end if;
  if not has_perm(p_emp, case p_kind when 'close_day' then 'shift.open_close' else 'cash.pay_in_out' end) then
    raise exception 'forbidden';
  end if;
  select store_id into v_store from pos_devices where tenant_id = v_tenant and id = p_device and deleted_at is null;
  if not found then raise exception 'bad-device'; end if;
  if coalesce((select till_version from device_activity where tenant_id = v_tenant and device_id = p_device), 0) < till_request_build() then
    raise exception 'till-too-old';
  end if;
  select id into v_shift from shifts
   where tenant_id = v_tenant and device_id = p_device and deleted_at is null and closed_at is null
   order by opened_at desc limit 1;
  if not found then raise exception 'no-day-open'; end if;
  if p_kind = 'close_day' then
    if p_counted is not null and p_counted < 0 then raise exception 'bad-amount'; end if;
    if exists (select 1 from till_requests where tenant_id = v_tenant and device_id = p_device
                and kind = 'close_day' and status = 'waiting' and deleted_at is null) then
      raise exception 'already-asked';
    end if;
    insert into till_requests (tenant_id, store_id, device_id, shift_id, kind, counted_cash, requested_by)
      values (v_tenant, v_store, p_device, v_shift, 'close_day', p_counted, p_emp) returning id into v_id;
  else
    if p_amount is null or p_amount <= 0 then raise exception 'bad-amount'; end if;
    if v_reason is null then raise exception 'reason-required'; end if;
    insert into till_requests (tenant_id, store_id, device_id, shift_id, kind, amount, reason, requested_by)
      values (v_tenant, v_store, p_device, v_shift, 'cash_out', p_amount, v_reason, p_emp) returning id into v_id;
  end if;
  return v_id;
end $fn$;

-- Cancels a request that still waits, by anyone who could have made it.
--   bad-request  no such request of this business
--   forbidden    this person may not ask for such a thing
--   not-waiting  the till has answered it, or it was cancelled already
create or replace function till_request_cancel(p_emp uuid, p_id uuid) returns void
language plpgsql set search_path = public as $fn$
declare
  v_kind text;
  v_status text;
begin
  select kind, status into v_kind, v_status from till_requests
   where tenant_id = current_tenant_id() and id = p_id and deleted_at is null for update;
  if not found then raise exception 'bad-request'; end if;
  if not has_perm(p_emp, case v_kind when 'close_day' then 'shift.open_close' else 'cash.pay_in_out' end) then
    raise exception 'forbidden';
  end if;
  if v_status <> 'waiting' then raise exception 'not-waiting'; end if;
  update till_requests set status = 'cancelled', answered_at = now() where tenant_id = current_tenant_id() and id = p_id;
end $fn$;

-- The till's answer to a request: {id, status: done | refused, note}. What
-- it did (the closing, the cash out) came in the ops before this one. An
-- answer to a request that no longer waits is taken and changes nothing.
--
-- A till says "done" to a closing after closing its own day, and its closing
-- came just before in the same push. If the server did not take that closing
-- (the till was set up under a login that may not vouch for who did it, say),
-- the day is still open here: the request is then written down as refused,
-- with where to look, and not as done.
create or replace function push_request_answer(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_id uuid;
  v_status text := p->>'status';
  v_note text := nullif(left(btrim(coalesce(p->>'note', '')), 300), '');
  v_was text;
  v_kind text;
  v_shift uuid;
begin
  begin v_id := (p->>'id')::uuid; exception when others then raise exception 'bad-payload'; end;
  if v_id is null or v_status is null or v_status not in ('done', 'refused') then raise exception 'bad-payload'; end if;
  select status, kind, shift_id into v_was, v_kind, v_shift from till_requests
   where tenant_id = p_tenant and id = v_id and deleted_at is null for update;
  if not found then raise exception 'bad-request'; end if;
  if v_was <> 'waiting' then return jsonb_build_object('id', v_id, 'changed', false); end if;
  if v_status = 'done' and v_kind = 'close_day'
     and exists (select 1 from shifts where tenant_id = p_tenant and id = v_shift and closed_at is null) then
    v_status := 'refused';
    v_note := 'The till closed its day, but the server did not take the closing. On the till, look at what the server refused.';
  end if;
  update till_requests
     set status = v_status, answered_at = now(), note = case when v_status = 'refused' then v_note end
   where tenant_id = p_tenant and id = v_id;
  return jsonb_build_object('id', v_id, 'changed', true);
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
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts','bookings','stock_levels','till_requests']
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
end $function$
;

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
    'bad-request'];
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
