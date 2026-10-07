-- 0073: a shop's stock, line by line.
--
-- The stock engine (0067) moves stock; this is what a shop's Stock on hand
-- page is built on.
--
--   - stock_adjust(): stock taken out, or put back, by hand, with a reason.
--     The reason decides the direction: damaged, expired, lost, internal (used
--     in the shop) and supplier_return take out; found puts in. Taking out
--     more than a line holds is refused. That floor lives here and not in
--     stock_move(): a sale must never be refused (a till sells offline), and a
--     restaurant's Stock page goes on adding and counting as it did.
--   - stock_on_hand(): the one definition of a line of stock, for the page,
--     the order that fills itself from what is low, the counts and the
--     reports: a counted product, or each live variant of one, with what one
--     shop holds of it.
--   - Six permissions: see stock, receive deliveries, adjust stock, run
--     counts, manage suppliers, see cost and profit. Every role that could
--     edit the catalog is given them, so nobody loses what they could do, and
--     a new tenant's Manager starts with them. The owner's role has
--     everything already.
-- Source: platform.create_tenant is its live definition (0050,
-- pg_get_functiondef) with the six ids added to the Manager's list.
-- Nothing here is pulled by a till. Never edit after merge.

create or replace function stock_adjust(
  p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_units integer, p_reason text, p_emp uuid, p_note text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_out boolean;
  v_counted boolean;
  v_level stock_levels%rowtype;
begin
  if p_units is null or p_units <= 0 then raise exception 'bad-quantity'; end if;
  if p_reason in ('damaged', 'expired', 'lost', 'internal', 'supplier_return') then v_out := true;
  elsif p_reason = 'found' then v_out := false;
  else raise exception 'bad-reason';
  end if;
  if not exists (select 1 from stores where tenant_id = p_tenant and id = p_store and deleted_at is null) then
    raise exception 'unknown-store';
  end if;
  -- read, not locked: the engine locks the line first and the item's row second
  select (i.track_stock or coalesce(c.is_stock, false)) into v_counted
    from items i left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
   where i.tenant_id = p_tenant and i.id = p_item and i.deleted_at is null;
  if not found then raise exception 'unknown-item'; end if;
  if not v_counted then raise exception 'not-counted'; end if;
  -- a product with variants holds its stock on them, never on itself
  if p_variant is null then
    if exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null) then
      raise exception 'pick-variant';
    end if;
  elsif not exists (select 1 from item_variants
                     where tenant_id = p_tenant and item_id = p_item and id = p_variant and deleted_at is null) then
    raise exception 'unknown-line';
  end if;
  -- the line is locked from here: what it holds cannot change under the check
  v_level := stock_level_for(p_tenant, p_store, p_item, p_variant);
  if v_out and v_level.qty < p_units then raise exception 'not-enough-stock'; end if;
  return stock_move(p_tenant, p_store, p_item, p_variant, case when v_out then -p_units else p_units end,
    p_reason, null, null, null, p_emp, nullif(btrim(coalesce(p_note, '')), ''));
end $fn$;

-- The lines of one shop's stock. A line with no level yet holds nothing, at
-- the cost its variant or product was given. sold30 is what left by sale in
-- this shop in the last 30 days, less what came back.
create or replace function stock_on_hand(p_tenant uuid, p_store uuid)
returns table (
  item_id uuid, variant_id uuid, name text, variant text, sku text, barcode text,
  category_id uuid, category text, supplier_id uuid, supplier text,
  price bigint, qty integer, avg_cost numeric, reorder_point integer, reorder_qty integer, sold30 integer)
language sql stable set search_path = public as $fn$
  select i.id, v.id, i.name, v.name,
         case when v.id is null then i.sku else v.sku end,
         case when v.id is null then i.barcode else v.barcode end,
         i.category_id, c.name, s.id, s.name,
         coalesce(v.price, i.price),
         coalesce(l.qty, 0),
         coalesce(l.avg_cost, v.cost, i.cost, 0)::numeric,
         l.reorder_point, l.reorder_qty,
         coalesce((select -sum(m.qty) from stock_movements m
                    where m.tenant_id = p_tenant and m.store_id = p_store and m.item_id = i.id
                      and m.variant_id is not distinct from v.id and m.reason in ('sale', 'refund')
                      and m.deleted_at is null and m.created_at > now() - interval '30 days'), 0)::integer
    from items i
    left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
    left join suppliers s on s.tenant_id = i.tenant_id and s.id = i.supplier_id and s.deleted_at is null
    left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
    left join stock_levels l on l.tenant_id = i.tenant_id and l.store_id = p_store and l.item_id = i.id
                            and l.variant_id is not distinct from v.id and l.deleted_at is null
   where i.tenant_id = p_tenant and i.deleted_at is null and (i.track_stock or coalesce(c.is_stock, false))
$fn$;

-- The six permissions, for every live role that may edit the catalog and
-- does not hold them all yet (one tenant's roles, or every tenant's when
-- p_tenant is null). Returns how many roles it changed.
create or replace function grant_stock_perms(p_tenant uuid) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_new constant text[] := array['stock.view', 'stock.receive', 'stock.adjust', 'stock.count', 'suppliers.edit', 'costs.view'];
  v_n integer;
begin
  with changed as (
    update roles r
       set permissions = r.permissions || (
             select coalesce(jsonb_agg(n.p order by n.ord), '[]'::jsonb)
               from unnest(v_new) with ordinality as n(p, ord) where not r.permissions ? n.p)
     where (p_tenant is null or r.tenant_id = p_tenant) and r.deleted_at is null
       and r.permissions ? 'items.edit' and not r.permissions ?& v_new
    returning 1)
  select count(*)::int into v_n from changed;
  return v_n;
end $fn$;
revoke all on function grant_stock_perms(uuid) from public;

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
      "receipts.reprint","backoffice.access","reports.view","payment.correct",
      "stock.view","stock.receive","stock.adjust","stock.count","suppliers.edit","costs.view"]'),
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
end $function$;

-- every role that exists and may edit the catalog
select grant_stock_perms(null);
