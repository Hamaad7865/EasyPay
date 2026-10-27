-- 0140_purge_shop_money.sql — Delete all transactions takes credit notes, deposits and account bills too
--
-- Bug sweep 2026-10-27, 9 (docs/superpowers/reviews/2026-10-27-bug-sweep.md). credit_notes.refund_id references
-- receipts with RESTRICT (0109), and purge_transactions deleted the receipts and kept the notes: a shop that had
-- issued one credit note (its returns give an exchange by default) could not delete its transactions at all, the
-- purge rolled back and Backup and data said it could not be saved. The purge also kept deposits, bills on account
-- and the money paid on them, and every customer's points, all made at the tills by the receipts it deletes.
-- The owner's choice: they go, as a till's Go live (core/database/GoLive.kt) and Clear test activity
-- (platform.clear_test_activity, 0128) take them, in the order Clear test activity deletes them, children first;
-- block_update lets them through under app.purge_tenant. A customer's points are what their receipts earned and
-- used (0128): with no receipt left, none. MRA records stay: the MRA has those invoices, and each till's chain
-- of them goes on from its last.
--
-- Source: purge_transactions as it is on dev (db/scripts/dump-function.cjs), which is 0139's, with the seven
-- tables added and the points set to nothing.

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
    'account_payment_lines','account_payments','account_bills',
    'credit_notes','deposit_payments','deposit_lines','deposits',
    'bookings','approvals','drawer_counts','stock_movements','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied']
  loop
    execute format('delete from %I where tenant_id = $1', t) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  -- a customer's points are what their receipts earned and used: none are left
  update customers set points = 0 where tenant_id = p_tenant and points <> 0;
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
