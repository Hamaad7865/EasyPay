-- 0121: a client's plan is trial, offline or premium, and nothing else.
--
-- Since 0115 there are three plans (the owner, 2026-10-17: "Standard is
-- offline. So we should have trial Offline and Premium thats it"), and every
-- client on another was moved to offline. platform.create_tenant (and
-- create_tenant_of_type, which calls it) and platform.set_tenant_plan still
-- wrote whatever name they were given: /admin offers the three, but a plan
-- typed or sent otherwise ("standard", "Premium ", "gold") was written as it
-- came, and a client on a name no part of EasyPay knows is neither offline
-- (it syncs, it has a back office) nor Premium (it has none of its parts).
--
-- Now both take a name whatever its capitals and spaces, write it in small
-- letters, and refuse any other with 'bad-plan' (said in /admin,
-- web/lib/platform.ts). No plan named is still offline. Nothing that is
-- stored changes: 0115 moved every client to one of the three.
--
-- Source: both are their live definitions on dev on 2026-10-18
-- (db/scripts/dump-function.cjs; create_tenant as 0115 left it,
-- set_tenant_plan as 0085 left it), with only the plan's lines changed.
-- Never edit after merge.

CREATE OR REPLACE FUNCTION platform.create_tenant(p_admin uuid, p_name text, p_store_name text, p_store_code text, p_owner_name text, p_owner_auth uuid, p_plan text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := gen_random_uuid();
  v_store uuid; v_role uuid; v_emp uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_store_name text := coalesce(nullif(btrim(coalesce(p_store_name, '')), ''), 'Main store');
  v_code text := upper(btrim(coalesce(p_store_code, '')));
  v_owner text := coalesce(nullif(btrim(coalesce(p_owner_name, '')), ''), 'Owner');
  v_plan text := lower(coalesce(nullif(btrim(coalesce(p_plan, '')), ''), 'offline'));
begin
  perform platform.require_admin(p_admin);
  if v_name = '' then raise exception 'name-required'; end if;
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'bad-store-code'; end if;
  -- the three plans (0115), and nothing else (0121)
  if v_plan not in ('trial', 'offline', 'premium') then raise exception 'bad-plan'; end if;
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
      "receipts.reprint","backoffice.access","reports.view","payment.correct",
      "stock.view","stock.receive","stock.adjust","stock.count","suppliers.edit","costs.view","sale.change_price","payments.view"]'),
    (v_tenant, 'Cashier', '["sale.create","sale.apply_discount","sale.void_line","ticket.view_all",
      "ticket.split_merge","payment.take","shift.open_close","cash.pay_in_out",
      "receipts.view_all","receipts.reprint"]'),
    (v_tenant, 'Waiter', '["sale.create","sale.void_line"]');
  insert into employees (tenant_id, name, role_id, auth_user_id)
    values (v_tenant, v_owner, v_role, p_owner_auth) returning id into v_emp;
  insert into employee_stores (tenant_id, employee_id, store_id) values (v_tenant, v_emp, v_store);
  -- what a restaurant needs before its first sale
  perform ensure_pos_basics(v_tenant);
  -- its tills learn the plan through the settings they pull, and that its
  -- set-up is open: the first tablet signed in is walked through it (0089)
  insert into pos_settings (tenant_id, data) values (v_tenant, jsonb_build_object('plan', v_plan, 'setup', 'open'))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.create', v_tenant,
      jsonb_build_object('name', v_name, 'store', v_store_name, 'store_code', v_code,
        'plan', v_plan, 'owner', v_owner, 'owner_auth_user_id', p_owner_auth));
  return jsonb_build_object('tenant_id', v_tenant, 'store_id', v_store, 'employee_id', v_emp);
end $function$;

CREATE OR REPLACE FUNCTION platform.set_tenant_plan(p_admin uuid, p_tenant uuid, p_plan text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_plan text := lower(nullif(btrim(coalesce(p_plan, '')), ''));
  v_old text;
begin
  perform platform.require_admin(p_admin);
  if v_plan is null then raise exception 'plan-required'; end if;
  -- the three plans (0115), and nothing else (0121)
  if v_plan not in ('trial', 'offline', 'premium') then raise exception 'bad-plan'; end if;
  select plan into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set plan = v_plan where id = p_tenant;
  -- the tills learn the plan through the settings they already pull
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('plan', v_plan))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.plan', p_tenant, jsonb_build_object('from', v_old, 'to', v_plan));
end $function$;
