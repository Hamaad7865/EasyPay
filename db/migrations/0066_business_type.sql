-- 0066: a tenant is a restaurant or a retail shop.
--
-- tenants.business_type says which. Every tenant that exists is a restaurant,
-- so nothing changes for them. Only the platform admin sets it:
--   platform.set_tenant_business_type(admin, tenant, type)
--   platform.create_tenant_of_type(..., type)   create_tenant, then the type,
--                                                in the one transaction
-- A change is refused while the tenant has an open order, and is logged as
-- 'tenant.business_type'. The type is copied into pos_settings.data
-- (businessType), which every till already pulls and reads loosely: a till
-- that does not know the key ignores it, and a missing key means restaurant.
-- create_tenant keeps its seven arguments: an eighth with a default would be
-- a second function, and every call with seven would stop being unique.

alter table tenants add column if not exists business_type text not null default 'restaurant';
alter table tenants drop constraint if exists tenants_business_type_check;
alter table tenants add constraint tenants_business_type_check check (business_type in ('restaurant', 'retail'));

create or replace function platform.set_tenant_business_type(p_admin uuid, p_tenant uuid, p_type text)
returns void
language plpgsql set search_path = public as $fn$
declare
  v_type text := lower(btrim(coalesce(p_type, '')));
  v_old text;
begin
  perform platform.require_admin(p_admin);
  if v_type not in ('restaurant', 'retail') then raise exception 'bad-business-type'; end if;
  select business_type into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  if v_old = v_type then return; end if;
  -- an order opened on a table has nowhere to go in a shop
  if exists (select 1 from tickets where tenant_id = p_tenant and status = 'open' and deleted_at is null) then
    raise exception 'open-orders';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set business_type = v_type where id = p_tenant;
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('businessType', v_type))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.business_type', p_tenant, jsonb_build_object('from', v_old, 'to', v_type));
end $fn$;

create or replace function platform.create_tenant_of_type(
  p_admin uuid, p_name text, p_store_name text, p_store_code text,
  p_owner_name text, p_owner_auth uuid, p_plan text, p_type text
) returns jsonb
language plpgsql set search_path = public as $fn$
declare r jsonb;
begin
  if lower(btrim(coalesce(p_type, ''))) not in ('restaurant', 'retail') then
    raise exception 'bad-business-type';
  end if;
  r := platform.create_tenant(p_admin, p_name, p_store_name, p_store_code, p_owner_name, p_owner_auth, p_plan);
  perform platform.set_tenant_business_type(p_admin, (r->>'tenant_id')::uuid, p_type);
  return r;
end $fn$;
