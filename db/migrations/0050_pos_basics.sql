-- 0050_pos_basics.sql — what a restaurant needs before its first sale.
-- Source: platform.create_tenant is the live definition (pg_get_functiondef,
-- last written by 0045) with two edits. Earlier migrations untouched.
--
-- What changes:
--   - ensure_pos_basics(tenant): the payment types, the three taxes (VAT 15%
--     in the price, Zero rated, Exempt), Dine-in and Takeaway, and the
--     settings row. Each is added only if the restaurant has none of that
--     kind (taxes: by name), so it can be run again and never duplicates
--     what a restaurant set up itself.
--   - Every restaurant gets them now, and platform.create_tenant gives them
--     to a new one. Until now a new restaurant had roles and nothing else,
--     so it could not take a payment.
--   - A new restaurant's Manager can correct a payment type (0049 gave that
--     to the managers that already existed).
-- Never edit after merge.

create or replace function ensure_pos_basics(p_tenant uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  if not exists (select 1 from payment_types where tenant_id = p_tenant) then
    insert into payment_types (tenant_id, name, kind, opens_drawer, sort_order) values
      (p_tenant, 'Cash', 'cash', true, 0),
      (p_tenant, 'Card', 'card', false, 1),
      (p_tenant, 'Juice by MCB', 'wallet', false, 2),
      (p_tenant, 'my.t money', 'wallet', false, 3),
      (p_tenant, 'Blink', 'wallet', false, 4),
      (p_tenant, 'MauCAS QR', 'qr', false, 5),
      (p_tenant, 'Bank transfer', 'other', false, 6);
  end if;
  if not exists (select 1 from taxes where tenant_id = p_tenant) then
    insert into taxes (tenant_id, name, rate_bp, type, is_default) values (p_tenant, 'VAT', 1500, 'included', true);
  end if;
  insert into taxes (tenant_id, name, rate_bp, type, is_default)
    select p_tenant, n.name, 0, 'included', false from (values ('Zero rated'), ('Exempt')) as n(name)
     where not exists (select 1 from taxes x where x.tenant_id = p_tenant and lower(x.name) = lower(n.name));
  if not exists (select 1 from dining_options where tenant_id = p_tenant) then
    insert into dining_options (tenant_id, name, is_default, sort_order, needs_table, kitchen) values
      (p_tenant, 'Dine-in', true, 0, true, 'save'),
      (p_tenant, 'Takeaway', false, 1, false, 'pay');
  end if;
  insert into pos_settings (tenant_id, data)
    select p_tenant, '{}'::jsonb where not exists (select 1 from pos_settings where tenant_id = p_tenant);
end $fn$;

do $$
declare t record;
begin
  for t in select id from tenants where deleted_at is null loop
    perform ensure_pos_basics(t.id);
  end loop;
end $$;

create or replace function platform.create_tenant(p_admin uuid, p_name text, p_store_name text, p_store_code text,
  p_owner_name text, p_owner_auth uuid, p_plan text)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_tenant uuid := gen_random_uuid();
  v_store uuid; v_role uuid; v_emp uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_store_name text := coalesce(nullif(btrim(coalesce(p_store_name, '')), ''), 'Main store');
  v_code text := upper(btrim(coalesce(p_store_code, '')));
  v_owner text := coalesce(nullif(btrim(coalesce(p_owner_name, '')), ''), 'Owner');
  v_plan text := coalesce(nullif(btrim(coalesce(p_plan, '')), ''), 'standard');
begin
  perform platform.require_admin(p_admin);
  if v_name = '' then raise exception 'name-required'; end if;
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'bad-store-code'; end if;
  if p_owner_auth is null then raise exception 'owner-login-required'; end if;
  -- one login belongs to one tenant (employees.auth_user_id is unique)
  if exists (select 1 from employees where auth_user_id = p_owner_auth) then
    raise exception 'login-already-linked';
  end if;
  -- a platform admin belongs to no restaurant
  if exists (select 1 from platform.admins where auth_user_id = p_owner_auth and revoked_at is null) then
    raise exception 'login-is-platform-admin';
  end if;

  -- the tenant context is stamped so the same statements also pass RLS for a
  -- caller that does not bypass it
  perform set_config('app.tenant_id', v_tenant::text, true);
  insert into tenants (id, tenant_id, name, plan) values (v_tenant, v_tenant, v_name, v_plan);
  insert into stores (tenant_id, name, code) values (v_tenant, v_store_name, v_code) returning id into v_store;

  insert into roles (tenant_id, name, permissions) values (v_tenant, 'Owner', '["*"]') returning id into v_role;
  insert into roles (tenant_id, name, permissions) values
    (v_tenant, 'Manager', '["sale.create","sale.apply_discount","sale.apply_restricted_discount",
      "sale.void_line","sale.void_sent_line","sale.refund","ticket.view_all","ticket.reassign",
      "ticket.split_merge","payment.take","drawer.open_no_sale","shift.open_close",
      "shift.view_report","cash.pay_in_out","items.edit","settings.device","receipts.view_all",
      "receipts.reprint","backoffice.access","reports.view","payment.correct"]'),
    (v_tenant, 'Cashier', '["sale.create","sale.apply_discount","sale.void_line","ticket.view_all",
      "ticket.split_merge","payment.take","shift.open_close","cash.pay_in_out",
      "receipts.view_all","receipts.reprint"]'),
    (v_tenant, 'Waiter', '["sale.create","sale.void_line"]');

  insert into employees (tenant_id, name, role_id, auth_user_id)
    values (v_tenant, v_owner, v_role, p_owner_auth) returning id into v_emp;
  insert into employee_stores (tenant_id, employee_id, store_id) values (v_tenant, v_emp, v_store);

  -- what a restaurant needs before its first sale
  perform ensure_pos_basics(v_tenant);

  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.create', v_tenant,
      jsonb_build_object('name', v_name, 'store', v_store_name, 'store_code', v_code,
        'plan', v_plan, 'owner', v_owner, 'owner_auth_user_id', p_owner_auth));
  return jsonb_build_object('tenant_id', v_tenant, 'store_id', v_store, 'employee_id', v_emp);
end $fn$;
