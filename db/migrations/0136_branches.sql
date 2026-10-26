-- 0136_branches.sql — staff per branch, and who may have branches
-- (docs/superpowers/specs/2026-10-27-multi-branch-design.md, sections 2 and 5).
--
--   employee_set_stores(tenant, employee, stores[])
--                        the branches a member of staff works at, as the
--                        back office's Staff page saves them (Works at). At
--                        least one, each a branch of the account. A branch
--                        left out is removed (deleted_at), one put back is
--                        revived: the tills get either by sequence and let
--                        the person in, or not, at their next pull
--                        (Staff.kt). The page asks for employees.edit before
--                        it calls this; the function runs as the caller,
--                        under the tenant's row security.
--   platform.add_store   an account on the offline plan has one branch:
--                        refused with offline-one-branch. A new branch takes
--                        the staff who work at every branch the account has;
--                        staff kept to some branches stay kept to them.
--                        (Staff with no branch at all work everywhere on a
--                        till, and still do.)
--   platform.set_tenant_plan
--                        an account with two or more branches cannot be put
--                        on the offline plan, which runs one tablet's branch:
--                        offline-one-branch. A default taken while writing
--                        the plan, told to the owner.
--
-- Source: platform.add_store and platform.set_tenant_plan are their live
-- definitions on dev on 2026-10-27 (pg_get_functiondef: 0045's and 0121's),
-- with the lines described above added. employee_set_stores is new.
-- Never edit after merge.

create or replace function employee_set_stores(p_tenant uuid, p_emp uuid, p_stores uuid[])
returns integer
language plpgsql set search_path = public as $fn$
declare
  v_want uuid[] := array(select distinct s from unnest(coalesce(p_stores, '{}'::uuid[])) s where s is not null);
  v_n integer;
begin
  if not exists (select 1 from employees where tenant_id = p_tenant and id = p_emp and deleted_at is null) then
    raise exception 'unknown-employee';
  end if;
  if cardinality(v_want) = 0 then raise exception 'no-branch'; end if;
  select count(*) into v_n from stores where tenant_id = p_tenant and deleted_at is null and id = any(v_want);
  if v_n <> cardinality(v_want) then raise exception 'unknown-store'; end if;
  update employee_stores set deleted_at = now()
   where tenant_id = p_tenant and employee_id = p_emp and deleted_at is null and not (store_id = any(v_want));
  insert into employee_stores (tenant_id, employee_id, store_id)
    select p_tenant, p_emp, s from unnest(v_want) s
  on conflict (employee_id, store_id) do update set deleted_at = null
    where employee_stores.deleted_at is not null;
  return v_n;
end $fn$;

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
  -- the offline plan runs one tablet's branch (0136)
  if exists (select 1 from tenants where id = p_tenant and lower(btrim(coalesce(plan, ''))) = 'offline') then
    raise exception 'offline-one-branch';
  end if;
  if v_name = '' then raise exception 'name-required'; end if;
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'bad-store-code'; end if;
  if exists (select 1 from stores where tenant_id = p_tenant and code = v_code) then
    raise exception 'store-code-taken';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  insert into stores (tenant_id, name, code) values (p_tenant, v_name, v_code) returning id into v_store;
  -- the new branch takes the staff who work at every branch; staff kept to some branches stay so (0136)
  insert into employee_stores (tenant_id, employee_id, store_id)
    select p_tenant, e.id, v_store from employees e
    where e.tenant_id = p_tenant and e.deleted_at is null
      and not exists (select 1 from stores s
                       where s.tenant_id = p_tenant and s.deleted_at is null and s.id <> v_store
                         and not exists (select 1 from employee_stores es
                                          where es.employee_id = e.id and es.store_id = s.id and es.deleted_at is null));
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'store.add', p_tenant, jsonb_build_object('store_id', v_store, 'name', v_name, 'code', v_code));
  return v_store;
end $fn$;

create or replace function platform.set_tenant_plan(p_admin uuid, p_tenant uuid, p_plan text)
returns void
language plpgsql set search_path = public as $fn$
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
  -- the offline plan runs one tablet's branch (0136)
  if v_plan = 'offline' and (select count(*) from stores where tenant_id = p_tenant and deleted_at is null) > 1 then
    raise exception 'offline-one-branch';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set plan = v_plan where id = p_tenant;
  -- the tills learn the plan through the settings they already pull
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('plan', v_plan))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.plan', p_tenant, jsonb_build_object('from', v_old, 'to', v_plan));
end $fn$;
