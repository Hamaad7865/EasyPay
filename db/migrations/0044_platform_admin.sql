-- 0044_platform_admin.sql — the platform admin ("super admin") and tenants
-- that only the platform admin creates (spec 4.4, moved ahead of Phase 9 on
-- the owner's decision: there is no self-serve sign-up).
--
-- Everything here lives in its own schema, `platform`, which the tenant role
-- (app_user) cannot even see: 0003's default privileges cover `public` only,
-- and usage on this schema is granted to nobody. The web admin area reaches
-- it over the owner connection, on the server only.
--
--   platform.admins   who is a platform admin. A login is one only if it has
--                     a live row here AND role 'admin' in Neon Auth (which
--                     the auth admin endpoints require). No employee row: an
--                     admin login belongs to no tenant and never goes on a till.
--   platform.audit    insert-only log of every admin action. Never holds a
--                     password.
--
-- Every change goes through a function that checks the admin and writes the
-- audit row in the same transaction, so nothing an admin does is unlogged:
--   platform.create_tenant      tenant, first store, the four roles from spec
--                               12, and the owner's employee row
--   platform.add_login          another login for a tenant, with a role
--   platform.set_login_active   switch one login off or on
--   platform.set_tenant_status  active | suspended, with a reason
--   platform.set_tenant_plan    plan is a plain label (there is no billing)
--
-- Suspended, not deleted: a suspended tenant keeps its data and its tills keep
-- syncing sales already made (spec 4.4: never trap their data). What it loses
-- is enforced in the API and back office: no new devices, no catalog changes.
-- "Cancelling a plan" is a suspension with a reason. Receipts are insert-only,
-- so a tenant with sales is never deleted.
--
-- Role defaults (spec 12 names the permissions and only describes the waiter):
--   Owner    everything
--   Manager  every listed permission
--   Cashier  sells, takes payment, simple discounts, voids unsent lines, runs
--            a shift and its cash, sees and reprints receipts
--   Waiter   creates sales and voids unsent lines; no payment, no discounts
-- Never edit after merge.

create schema if not exists platform;
revoke all on schema platform from public;

create table if not exists platform.admins (
  auth_user_id uuid primary key,
  email text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists platform.audit (
  id uuid primary key default gen_random_uuid(),
  admin_auth_user_id uuid not null,
  action text not null,
  tenant_id uuid, -- no foreign key: the log outlives what it describes
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists idx_platform_audit_tenant on platform.audit (tenant_id, created_at desc);
drop trigger if exists trg_no_update on platform.audit;
create trigger trg_no_update before update or delete on platform.audit
  for each row execute function public.block_update();

alter table tenants add column if not exists status_reason text;
alter table tenants add column if not exists status_changed_at timestamptz;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'tenants_status_check') then
    alter table tenants add constraint tenants_status_check check (status in ('active', 'suspended'));
  end if;
end $$;

create or replace function platform.require_admin(p_admin uuid) returns void
language plpgsql set search_path = public as $fn$
begin
  if p_admin is null or not exists (
      select 1 from platform.admins where auth_user_id = p_admin and revoked_at is null) then
    raise exception 'not-a-platform-admin';
  end if;
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

create or replace function platform.set_login_active(
  p_admin uuid, p_employee uuid, p_active boolean
) returns void
language plpgsql set search_path = public as $fn$
declare v_tenant uuid;
begin
  perform platform.require_admin(p_admin);
  select tenant_id into v_tenant from employees where id = p_employee and deleted_at is null;
  if not found then raise exception 'unknown-login'; end if;
  perform set_config('app.tenant_id', v_tenant::text, true);
  update employees set is_active = coalesce(p_active, false) where id = p_employee;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, case when coalesce(p_active, false) then 'login.enable' else 'login.disable' end,
      v_tenant, jsonb_build_object('employee_id', p_employee));
end $fn$;

create or replace function platform.set_tenant_status(
  p_admin uuid, p_tenant uuid, p_status text, p_reason text
) returns void
language plpgsql set search_path = public as $fn$
declare v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  perform platform.require_admin(p_admin);
  if p_status not in ('active', 'suspended') then raise exception 'bad-status'; end if;
  if p_status = 'suspended' and v_reason is null then raise exception 'reason-required'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set status = p_status,
      status_reason = case when p_status = 'active' then null else v_reason end,
      status_changed_at = now()
    where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.' || p_status, p_tenant, jsonb_build_object('reason', v_reason));
end $fn$;

create or replace function platform.set_tenant_plan(
  p_admin uuid, p_tenant uuid, p_plan text
) returns void
language plpgsql set search_path = public as $fn$
declare
  v_plan text := nullif(btrim(coalesce(p_plan, '')), '');
  v_old text;
begin
  perform platform.require_admin(p_admin);
  if v_plan is null then raise exception 'plan-required'; end if;
  select plan into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set plan = v_plan where id = p_tenant;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.plan', p_tenant, jsonb_build_object('from', v_old, 'to', v_plan));
end $fn$;
