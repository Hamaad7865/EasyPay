-- 0051_purge_transactions.sql — "delete all transactions", for a restaurant
-- that has finished trying the system out and wants to start clean.
-- Source: block_update() is the live definition (0001) with one way out
-- added. Earlier migrations untouched.
--
-- What changes:
--   - purge_transactions(tenant, employee): removes a restaurant's orders,
--     receipts, shifts, clock punches, cash movements, day closings, payment
--     corrections and stock movements, and starts its bill numbers again.
--     The menu, staff, tables, printers and settings stay. Only the owner
--     (a role that can do everything) of that restaurant can run it, and it
--     is written to platform.audit with who and how much was removed.
--   - Receipts and payments stay insert-only for everyone else. block_update
--     lets a DELETE through only inside purge_transactions: the caller is not
--     app_user (the function runs as its owner) and the row belongs to the
--     restaurant the function named. An UPDATE is never let through.
-- Never edit after merge.

create or replace function block_update() returns trigger
language plpgsql as $$
begin
  -- the one way out: purge_transactions(), which runs as the owner of the
  -- tables and names the restaurant it is emptying
  if TG_OP = 'DELETE' and current_user <> 'app_user'
      and old.tenant_id is not null
      and old.tenant_id::text = current_setting('app.purge_tenant', true) then
    return old;
  end if;
  raise exception 'table % is insert-only', TG_TABLE_NAME;
end $$;

create or replace function purge_transactions(p_tenant uuid, p_emp uuid) returns jsonb
language plpgsql security definer set search_path = public as $fn$
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
    'stock_movements','payment_corrections','day_closes','cash_movements',
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
end $fn$;

revoke all on function purge_transactions(uuid, uuid) from public;
grant execute on function purge_transactions(uuid, uuid) to app_user;
