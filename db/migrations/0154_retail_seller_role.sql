-- 0154: a shop's seeded role is called Seller, not Waiter
-- The base create_tenant makes four roles (Owner, Manager, Cashier, Waiter)
-- with restaurant permissions. create_tenant_of_type calls it, then sets
-- the business_type. Here we rename Waiter to Seller for retail tenants
-- and keep its permissions (sale.create, sale.void_line) which are valid for both.

create or replace function platform.create_tenant_of_type(
  p_admin uuid, p_name text, p_store_name text, p_store_code text,
  p_owner_name text, p_owner_auth uuid, p_plan text, p_type text
) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  r jsonb;
  v_type text;
  v_tenant uuid;
begin
  v_type := lower(btrim(coalesce(p_type, '')));
  if v_type not in ('restaurant', 'retail') then
    raise exception 'bad-business-type';
  end if;
  r := platform.create_tenant(p_admin, p_name, p_store_name, p_store_code, p_owner_name, p_owner_auth, p_plan);
  perform platform.set_tenant_business_type(p_admin, (r->>'tenant_id')::uuid, v_type);
  if v_type = 'retail' then
    v_tenant := (r->>'tenant_id')::uuid;
    -- rename Waiter to Seller for this retail tenant
    perform set_config('app.tenant_id', v_tenant::text, true);
    update roles set name = 'Seller'
    where tenant_id = v_tenant and name = 'Waiter' and deleted_at is null;
  end if;
  return r;
end $fn$;