-- 0155_purge_tells_the_tills.sql — Delete all transactions empties the tills' Receipts too
--
-- A shop that went live on 2026-11-06 deleted all transactions in the back office (/backoffice/data,
-- purge_transactions): the back office showed none, but the Receipts on its tablet still listed every test sale.
-- The pull sends the rows that changed since a till's cursor (server_seq), never the rows that were deleted, so a
-- till kept what the purge deleted until it was signed out and in again. sync_epoch cannot say it: it is one
-- counter per table for every business, and bumping it would start every business's tills again from nothing.
-- Now the purge writes when into the business's settings (pos_settings.data.cleared), which every till pulls. A
-- till of 0.9.37 or later empties what it rang up once for each mark and pulls again from nothing, so what the
-- server still has comes back (android core/sync/OfficeClear.kt). An older till goes on as before: signed out
-- and in again.
--
-- The purges of the last week are marked as well, so that the shop's tablet, once updated, empties itself. An
-- older one is not: the pull sends a week of days and cash, so a till that emptied them would lose its days since.
--
-- Source: purge_transactions as it is on dev (db/scripts/dump-function.cjs), which is 0140's, with the mark
-- written after the points.

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
  -- the tills: a pull never says what was deleted, so the settings say when (0155)
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('cleared', to_jsonb(clock_timestamp())))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;

-- the purges of the last week, by the audit each one wrote
insert into pos_settings (tenant_id, data)
  select a.tenant_id, jsonb_build_object('cleared', to_jsonb(max(a.created_at)))
    from platform.audit a join tenants t on t.id = a.tenant_id
   where a.action = 'tenant.purge_transactions' and a.created_at > now() - interval '7 days'
   group by a.tenant_id
  on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
