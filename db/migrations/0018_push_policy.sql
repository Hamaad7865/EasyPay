-- 0018_push_policy.sql — rejection policy for sync_push (replaces 0014 def).
-- Only known business codes persist as rejections; anything else re-raises so
-- the caller's transaction rolls the batch back and the client retries the
-- whole batch later (nothing half-persisted, nothing masked as dead-letter).
-- Replay returns the ORIGINAL stored envelope unchanged (applied stays
-- applied, rejected stays rejected with its code).
-- create or replace; 0014 untouched. Never edit after merge.
-- Ops are commands, not row upserts. Each op_id applies at most once
-- (sync_ops_applied). Each op runs in its own subtransaction: one bad op
-- never blocks the queue. Totals are recomputed server-side; client totals
-- are ignored. tenant/device/store/employee come from the JWT context (GUC),
-- never trusted from payloads (spec 15). SECURITY INVOKER so RLS applies.
-- Never edit after merge.

create or replace function has_perm(p_employee_id uuid, p_perm text) returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from employees e join roles r
      on r.tenant_id = e.tenant_id and r.id = e.role_id
    where e.id = p_employee_id and e.deleted_at is null and e.is_active
      and (r.permissions ? '*' or r.permissions ? p_perm)
  )
$$;

create or replace function sync_push(p_employee_id uuid, p_ops jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  tenant uuid;
  op jsonb;
  v_op_id uuid;
  v_type text;
  v_stored jsonb;
  v_data jsonb;
  v_code text;
  v_envelope jsonb;
  res jsonb := '[]'::jsonb;
  -- Business validations persist as rejections. bad-rounding and
  -- approval-required are raised by item-4 handlers (listed ahead of use).
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

  for op in select value from jsonb_array_elements(p_ops) as value loop
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

      select result into v_stored from sync_ops_applied where op_id = v_op_id;
      if found then
        -- replay: original envelope unchanged
        res := res || v_stored;
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
          values (v_op_id, tenant, v_type, v_envelope);
        res := res || v_envelope;
      exception when others then
        if sqlstate = '23505' then
          select result into v_stored from sync_ops_applied where op_id = v_op_id;
          if found then
            res := res || v_stored;
          else
            v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', 'conflict');
            insert into sync_ops_applied (op_id, tenant_id, type, result)
              values (v_op_id, tenant, v_type, v_envelope);
            res := res || v_envelope;
          end if;
        else
          v_code := case when sqlerrm ~ '^[a-z0-9-]+$' then sqlerrm else 'unexpected' end;
          if not (v_code = any (codes)) then
            -- not a business validation: re-raise, persist nothing
            raise;
          end if;
          v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', v_code);
          insert into sync_ops_applied (op_id, tenant_id, type, result)
            values (v_op_id, tenant, v_type, v_envelope);
          res := res || v_envelope;
        end if;
      end;
    end;
  end loop;
  return res;
end $fn$;
