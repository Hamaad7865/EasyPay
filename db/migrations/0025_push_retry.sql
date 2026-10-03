-- 0025_push_retry.sql — rejection policy v2 for sync_push (replaces 0018 def).
-- Transients (class 40, class 53, 55P03, 57014) are NOT stored: processing
-- stops at that op and it plus every later op returns status 'retry', while
-- earlier ops stay applied (ops are ordered commands; continuing past a
-- transient would wrongly reject dependent ops). All other errors persist as
-- rejected and the batch continues: business codes keep their code,
-- unexpected ones get code 'error' with the detail in the server log
-- (RAISE WARNING, never in the client response). Replays return the stored
-- envelope with its original status/code plus "replayed": true. A missing op
-- type logs as 'unknown' so the NOT NULL log column never breaks the handler.
-- create or replace; 0018 untouched. Never edit after merge.

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
  res jsonb := '[]'::jsonb;
  codes text[] := array[
    'bad-op-id','bad-payload','unknown-op','bad-store','bad-ticket',
    'ticket-closed','bad-line','bad-item','bad-variant','bad-modifier',
    'bad-dining','bad-discount','bad-payment','bad-change','bad-totals',
    'bad-device','bad-receipt','bad-qty','overpayment','lines-required',
    'empty-ticket','already-refunded','forbidden','conflict',
    'bad-rounding','approval-required'];
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
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, p_employee_id, op->'payload');
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, p_employee_id, op->'payload');
          when 'ticket.void_line' then v_data := push_ticket_void_line(tenant, p_employee_id, op->'payload');
          when 'ticket.update_meta' then v_data := push_ticket_update_meta(tenant, p_employee_id, op->'payload');
          when 'ticket.move_lines' then v_data := push_ticket_move_lines(tenant, p_employee_id, op->'payload');
          when 'ticket.merge' then v_data := push_ticket_merge(tenant, p_employee_id, op->'payload');
          when 'receipt.create' then v_data := push_receipt_create(tenant, p_employee_id, op->'payload');
          when 'refund.create' then v_data := push_refund_create(tenant, p_employee_id, op->'payload');
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
