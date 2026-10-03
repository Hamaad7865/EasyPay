-- 0045_platform_manage.sql — the rest of what the platform admin manages:
-- stores, business details, tills, and linking a login that already exists.
-- Same rules as 0044: owner-only `platform` schema, every function checks the
-- admin and writes its audit row in the same transaction.
--
--   platform.add_store            another store for a restaurant; every
--                                 existing login gets access to it
--   platform.set_tenant_details   name, BRN, VAT number
--   platform.set_device_active    deactivate or reactivate a till. A
--                                 deactivated till is refused when it tries
--                                 to register again; sales it already made
--                                 still sync (never trap their data)
--
-- create_tenant and add_login are redefined to refuse a platform admin's own
-- login: an admin belongs to no restaurant. Source: 0044_platform_admin.sql
-- (the live definitions). Everything else in them is unchanged, so a login
-- that already exists in the auth service, but belongs to no restaurant, can
-- be linked by passing its id.
-- Never edit after merge.

create or replace function platform.add_store(
  p_admin uuid, p_tenant uuid, p_name text, p_code text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_store uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_code text := upper(btrim(coalesce(p_code, '')));
begin
  perform platform.require_admin(p_admin);
  if not exists (select 1 from tenants where id = p_tenant) then raise exception 'unknown-tenant'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'bad-store-code'; end if;
  if exists (select 1 from stores where tenant_id = p_tenant and code = v_code) then
    raise exception 'store-code-taken';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  insert into stores (tenant_id, name, code) values (p_tenant, v_name, v_code) returning id into v_store;
  insert into employee_stores (tenant_id, employee_id, store_id)
    select p_tenant, e.id, v_store from employees e
    where e.tenant_id = p_tenant and e.deleted_at is null;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'store.add', p_tenant, jsonb_build_object('store_id', v_store, 'name', v_name, 'code', v_code));
  return v_store;
end $fn$;

create or replace function platform.set_tenant_details(
  p_admin uuid, p_tenant uuid, p_name text, p_brn text, p_vat text
) returns void
language plpgsql set search_path = public as $fn$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_brn text := nullif(btrim(coalesce(p_brn, '')), '');
  v_vat text := nullif(btrim(coalesce(p_vat, '')), '');
  v_old record;
begin
  perform platform.require_admin(p_admin);
  if v_name = '' then raise exception 'name-required'; end if;
  select name, brn, vat_number into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set name = v_name, brn = v_brn, vat_number = v_vat where id = p_tenant;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.details', p_tenant, jsonb_build_object(
      'from', jsonb_build_object('name', v_old.name, 'brn', v_old.brn, 'vat_number', v_old.vat_number),
      'to', jsonb_build_object('name', v_name, 'brn', v_brn, 'vat_number', v_vat)));
end $fn$;

create or replace function platform.set_device_active(
  p_admin uuid, p_device uuid, p_active boolean
) returns void
language plpgsql set search_path = public as $fn$
declare v_tenant uuid; v_code text;
begin
  perform platform.require_admin(p_admin);
  select tenant_id, code into v_tenant, v_code from pos_devices where id = p_device;
  if not found then raise exception 'unknown-till'; end if;
  perform set_config('app.tenant_id', v_tenant::text, true);
  update pos_devices set deleted_at = case when coalesce(p_active, false) then null else now() end
    where id = p_device;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, case when coalesce(p_active, false) then 'till.activate' else 'till.deactivate' end,
      v_tenant, jsonb_build_object('device_id', p_device, 'code', v_code));
end $fn$;

create or replace function platform.create_tenant(
  p_admin uuid, p_name text, p_store_name text, p_store_code text,
  p_owner_name text, p_owner_auth uuid, p_plan text
) returns jsonb
language plpgsql set search_path = public as $fn$
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
      "receipts.reprint","backoffice.access","reports.view"]'),
    (v_tenant, 'Cashier', '["sale.create","sale.apply_discount","sale.void_line","ticket.view_all",
      "ticket.split_merge","payment.take","shift.open_close","cash.pay_in_out",
      "receipts.view_all","receipts.reprint"]'),
    (v_tenant, 'Waiter', '["sale.create","sale.void_line"]');

  insert into employees (tenant_id, name, role_id, auth_user_id)
    values (v_tenant, v_owner, v_role, p_owner_auth) returning id into v_emp;
  insert into employee_stores (tenant_id, employee_id, store_id) values (v_tenant, v_emp, v_store);

  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.create', v_tenant,
      jsonb_build_object('name', v_name, 'store', v_store_name, 'store_code', v_code,
        'plan', v_plan, 'owner', v_owner, 'owner_auth_user_id', p_owner_auth));
  return jsonb_build_object('tenant_id', v_tenant, 'store_id', v_store, 'employee_id', v_emp);
end $fn$;

create or replace function platform.add_login(
  p_admin uuid, p_tenant uuid, p_name text, p_role text, p_auth uuid
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_role uuid; v_emp uuid;
  v_name text := btrim(coalesce(p_name, ''));
begin
  perform platform.require_admin(p_admin);
  if not exists (select 1 from tenants where id = p_tenant) then raise exception 'unknown-tenant'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  if p_auth is null then raise exception 'login-required'; end if;
  if exists (select 1 from employees where auth_user_id = p_auth) then
    raise exception 'login-already-linked';
  end if;
  if exists (select 1 from platform.admins where auth_user_id = p_auth and revoked_at is null) then
    raise exception 'login-is-platform-admin';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  select id into v_role from roles
    where tenant_id = p_tenant and name = p_role and deleted_at is null;
  if not found then raise exception 'unknown-role'; end if;
  insert into employees (tenant_id, name, role_id, auth_user_id)
    values (p_tenant, v_name, v_role, p_auth) returning id into v_emp;
  insert into employee_stores (tenant_id, employee_id, store_id)
    select p_tenant, v_emp, s.id from stores s where s.tenant_id = p_tenant and s.deleted_at is null;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'login.add', p_tenant,
      jsonb_build_object('employee_id', v_emp, 'name', v_name, 'role', p_role, 'auth_user_id', p_auth));
  return v_emp;
end $fn$;
