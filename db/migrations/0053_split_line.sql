-- 0053_split_line.sql — splitting one line of an order in two, for a split
-- check: two beers rung up as one line, one for each guest.
-- Source: sync_push is the live definition (pg_get_functiondef, last written
-- by 0049) with ticket.split_line added. Earlier migrations untouched.
--
-- What changes:
--   - ticket.split_line {line_id, new_id, qty}: takes qty off a line and puts
--     it on a new line (the till's id) of the same order. The new line is the
--     same item at the same price, with the same note, course, taxes and
--     kitchen state: nothing goes to the kitchen again and nothing is voided.
--   - Whole units only, so the two parts add up to exactly what the line was.
--   - A line with a priced add-on is refused (bad-modifier): an add-on is
--     charged once per line, so two lines would charge it twice. Such a line
--     moves to a check whole. Free add-ons are copied.
--   - A paid, voided or closed line is refused, as is a quantity that is not
--     less than the line's.
-- Never edit after merge.

create or replace function push_ticket_split_line(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
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
      note, course, paid, sent_to_kitchen_at, kitchen_status)
    values (v_new, p_tenant, l.ticket_id, l.item_id, l.variant_id, l.name_snapshot, l.unit_price, v_qty,
      l.note, l.course, false, l.sent_to_kitchen_at, l.kitchen_status);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_new, tax_id, name_snapshot, rate_bp, type from ticket_line_taxes
     where tenant_id = p_tenant and line_id = v_line and deleted_at is null;
  insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
    select p_tenant, v_new, modifier_id, name_snapshot, price from ticket_line_modifiers
     where tenant_id = p_tenant and line_id = v_line and deleted_at is null;
  return jsonb_build_object('line_id', v_line, 'new_id', v_new, 'qty', v_qty);
end $fn$;

create or replace function sync_push(p_employee_id uuid, p_ops jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
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
          when 'ticket.send' then v_data := push_ticket_send(tenant, v_emp, op->'payload');
          when 'ticket.split_line' then v_data := push_ticket_split_line(tenant, v_emp, op->'payload');
          when 'cash.move' then v_data := push_cash_move(tenant, v_emp, op->'payload');
          when 'day.close' then v_data := push_day_close(tenant, v_emp, op->'payload');
          when 'payment.correct' then v_data := push_payment_correct(tenant, v_emp, op->'payload');
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
