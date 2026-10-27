-- 0139_purge_transfers.sql — Delete all transactions takes the transfers between branches too
--
-- Bug sweep 2026-10-27, 1 (docs/superpowers/reviews/2026-10-27-bug-sweep.md). purge_transactions deletes the
-- account's doc_counters, so its next transfer is numbered T-0001 again; but it kept stock_transfers and
-- stock_transfer_lines (0138), whose unique (tenant_id, number) then refused that transfer and every one after
-- it, for good. It also deleted the transfers' movements and kept the transfers. Now they go with the rest, the
-- lines first: block_update lets a delete through under app.purge_tenant, as it does for deliveries and counts.
-- Clear test activity (platform.clear_test_activity, 0128) keeps the counters and the transfers: unchanged.
--
-- Source: purge_transactions as it is on dev (db/scripts/dump-function.cjs), which is 0075's, with the two tables
-- added and its comment on the counters naming transfers.

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
    'stock_transfer_lines','stock_transfers',
    'stock_count_lines','stock_counts',
    'delivery_lines','deliveries','purchase_order_lines','purchase_orders',
    'bookings','approvals','drawer_counts','stock_movements','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied']
  loop
    execute format('delete from %I where tenant_id = $1', t) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant;
  -- orders, deliveries, counts and transfers number from 1 again, as bills do
  delete from doc_counters where tenant_id = p_tenant;
  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;
