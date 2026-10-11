-- 0096: add-ons, and a few settings, from a till.
--
-- More of what a business on the offline plan sets up on its tablet
-- (docs/superpowers/specs/2026-10-11-tablet-alone-design.md), each the back
-- office's rule.
--
--   addon.save      a group of add-ons, whole: its name, the fewest and the
--                   most that may be picked (most 0: any number), and its
--                   choices with their prices, each under the id the tablet
--                   made. A choice that is not in the list is removed.
--   addon.remove    as the back office's page: taken off its items, its
--                   choices removed, its name freed.
--   item.save       grows again: groups, the add-on groups the item carries.
--                   Not sent, nothing changes.
--   settings.save   the two notes on the receipt, and the service charge on
--                   orders served at a table (0 to 30 %). The logo and the
--                   other settings are left as they are.
--
-- Sent twice, written once: a group and each of its choices are saved under
-- the ids the tablet made.
--
-- New refusals: bad-limits, bad-group. Used again: too-many, name-taken,
-- name-required, bad-value.
-- Source: push_item_save and sync_push are their live definitions on the dev
-- branch with the lines this migration adds.

create or replace function push_addon_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_name text; v_min int; v_max int; v_was record; v_made boolean := false;
  c jsonb; v_cid uuid; v_cname text; v_price bigint; v_keep uuid[] := '{}';
begin
  begin
    v_id := (p->>'id')::uuid;
    v_min := coalesce((p->>'min')::int, 0);
    v_max := coalesce((p->>'max')::int, 0);
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null or jsonb_typeof(p->'choices') is distinct from 'array' then raise exception 'bad-payload'; end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 40);
  if v_name = '' then raise exception 'name-required'; end if;
  -- min 0 is optional, min 1 means one must be picked; max 0 is as many as they like
  if v_min not between 0 and 20 or v_max not between 0 and 20 or (v_max <> 0 and v_max < v_min) then raise exception 'bad-limits'; end if;
  if jsonb_array_length(p->'choices') > 50 then raise exception 'too-many'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  if exists (select 1 from modifier_groups where tenant_id = p_tenant and id <> v_id and lower(name) = lower(v_name)) then
    raise exception 'name-taken';
  end if;
  select deleted_at into v_was from modifier_groups where tenant_id = p_tenant and id = v_id for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-group'; end if;
    update modifier_groups set name = v_name, min_select = v_min, max_select = v_max where tenant_id = p_tenant and id = v_id;
  else
    insert into modifier_groups (id, tenant_id, name, min_select, max_select) values (v_id, p_tenant, v_name, v_min, v_max);
    v_made := true;
  end if;
  for c in select * from jsonb_array_elements(p->'choices') loop
    begin
      v_cid := (c->>'id')::uuid;
      v_price := coalesce((c->>'price')::bigint, 0);
    exception when others then
      raise exception 'bad-payload';
    end;
    v_cname := left(btrim(coalesce(c->>'name', '')), 40);
    if v_cid is null or v_price < 0 or v_price > 100000000 then raise exception 'bad-payload'; end if;
    if v_cname = '' then raise exception 'name-required'; end if;
    -- under the id the tablet made: a second send finds it there. One that is another group's is left alone.
    insert into modifiers (id, tenant_id, group_id, name, price) values (v_cid, p_tenant, v_id, v_cname, v_price)
      on conflict (id) do update set name = excluded.name, price = excluded.price, deleted_at = null
        where modifiers.tenant_id = p_tenant and modifiers.group_id = v_id;
    v_keep := v_keep || v_cid;
  end loop;
  update modifiers set deleted_at = now()
   where tenant_id = p_tenant and group_id = v_id and deleted_at is null and not (id = any (v_keep));
  return jsonb_build_object('group_id', v_id, 'created', v_made);
end $fn$;

create or replace function push_addon_remove(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_was record;
begin
  begin
    v_id := (p->>'group_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  perform pg_advisory_xact_lock(hashtextextended(v_id::text, 0));
  select deleted_at into v_was from modifier_groups where tenant_id = p_tenant and id = v_id for update;
  if not found then raise exception 'bad-group'; end if;
  -- removed already is removed
  if v_was.deleted_at is not null then return jsonb_build_object('group_id', v_id); end if;
  update item_modifier_groups set deleted_at = now() where tenant_id = p_tenant and group_id = v_id and deleted_at is null;
  update modifiers set deleted_at = now() where tenant_id = p_tenant and group_id = v_id and deleted_at is null;
  update modifier_groups set deleted_at = now(), name = left(name, 40) || ' (removed ' || to_char(now(), 'YYYYMMDDHH24MISS') || ')'
   where tenant_id = p_tenant and id = v_id;
  return jsonb_build_object('group_id', v_id);
end $fn$;

-- The add-on groups an item carries: the others are taken off, these put (back) on.
create or replace function item_set_groups(p_tenant uuid, p_item uuid, p_groups jsonb) returns void
language plpgsql set search_path = public as $fn$
declare v_ids uuid[];
begin
  if jsonb_typeof(p_groups) is distinct from 'array' then raise exception 'bad-payload'; end if;
  begin
    select coalesce(array_agg(distinct x::uuid), '{}') into v_ids from jsonb_array_elements_text(p_groups) x;
  exception when others then
    raise exception 'bad-payload';
  end;
  if exists (select 1 from unnest(v_ids) g where not exists (
       select 1 from modifier_groups m where m.tenant_id = p_tenant and m.id = g and m.deleted_at is null)) then
    raise exception 'bad-group';
  end if;
  update item_modifier_groups set deleted_at = now()
   where tenant_id = p_tenant and item_id = p_item and deleted_at is null and not (group_id = any (v_ids));
  insert into item_modifier_groups (tenant_id, item_id, group_id)
    select p_tenant, p_item, g from unnest(v_ids) g
    on conflict (item_id, group_id) do update set deleted_at = null;
end $fn$;

create or replace function push_settings_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_patch jsonb := '{}'::jsonb; v_receipt jsonb; v_pct int; v_now jsonb;
begin
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if p ? 'receipt' then
    if jsonb_typeof(p->'receipt') <> 'object' then raise exception 'bad-payload'; end if;
    -- the two notes only: the logo and whether it shows are left as they are
    select data->'receipt' into v_now from pos_settings where tenant_id = p_tenant;
    v_receipt := coalesce(case when jsonb_typeof(v_now) = 'object' then v_now end, '{}'::jsonb);
    if p->'receipt' ? 'header' then v_receipt := v_receipt || jsonb_build_object('header', left(replace(coalesce(p->'receipt'->>'header', ''), E'\r', ''), 300)); end if;
    if p->'receipt' ? 'footer' then v_receipt := v_receipt || jsonb_build_object('footer', left(replace(coalesce(p->'receipt'->>'footer', ''), E'\r', ''), 300)); end if;
    v_patch := v_patch || jsonb_build_object('receipt', v_receipt);
  end if;
  if p ? 'servicePct' then
    begin
      v_pct := (p->>'servicePct')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_pct is null or v_pct not between 0 and 30 then raise exception 'bad-value'; end if;
    v_patch := v_patch || jsonb_build_object('servicePct', v_pct);
  end if;
  if v_patch <> '{}'::jsonb then
    insert into pos_settings (tenant_id, data) values (p_tenant, v_patch)
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('saved', (select count(*) from jsonb_object_keys(v_patch)));
end $fn$;

-- ---- as they were on dev, with the lines this migration adds ----

CREATE OR REPLACE FUNCTION public.push_item_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_name text; v_price bigint; v_open boolean; v_cat uuid; v_code text; v_avail boolean;
  v_was record; v_tax uuid; v_shop boolean; v_appr uuid;
  v_track boolean;
  -- the fuller sheet (0094)
  v_new_tax uuid; v_sup uuid; v_store uuid; v_cost bigint; v_point int; v_qty int;
  v_reorder boolean; v_may_cost boolean;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_price := coalesce((p->>'price')::bigint, 0);
    v_cat := nullif(p->>'category_id', '')::uuid;
    v_open := coalesce((p->>'open_price')::boolean, false);
    v_avail := coalesce((p->>'available')::boolean, true);
    -- whether its stock is counted (0087); a till that does not say leaves it as it is
    v_track := (p->>'track_stock')::boolean;
  exception when others then
    raise exception 'bad-payload';
  end;
  -- What the fuller sheet of a till carries (0094). A key that is not there
  -- changes nothing: a till built before this sends none of them.
  begin
    v_new_tax := nullif(p->>'tax_id', '')::uuid;
    v_sup := nullif(p->>'supplier_id', '')::uuid;
    v_store := nullif(p->>'store_id', '')::uuid;
    v_cost := (p->>'cost')::bigint;
    v_point := (p->>'reorder_point')::int;
    v_qty := (p->>'reorder_qty')::int;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_cost < 0 or v_cost > 100000000 then raise exception 'bad-payload'; end if;
  if v_point < 0 or v_qty < 0 then raise exception 'bad-quantity'; end if;
  v_name := left(btrim(coalesce(p->>'name', '')), 80);
  v_code := nullif(regexp_replace(coalesce(p->>'barcode', ''), '\s+', '', 'g'), '');
  -- Rs 1,000,000 for one item is a slip of the finger, not a price
  if v_id is null or v_price < 0 or v_price > 100000000 or length(coalesce(v_code, '')) > 64 then raise exception 'bad-payload'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- one whose price is typed at the sale has none of its own
  if v_open then v_price := 0; end if;
  if v_cat is not null and not exists (select 1 from categories where tenant_id = p_tenant and id = v_cat and deleted_at is null) then
    raise exception 'bad-category';
  end if;
  if v_new_tax is not null and not exists (select 1 from taxes where tenant_id = p_tenant and id = v_new_tax and deleted_at is null) then
    raise exception 'bad-tax';
  end if;
  if v_sup is not null and not exists (select 1 from suppliers where tenant_id = p_tenant and id = v_sup and deleted_at is null) then
    raise exception 'unknown-supplier';
  end if;
  -- a reorder level is one store's: the till names its own
  v_reorder := p ? 'reorder_point' or p ? 'reorder_qty';
  if v_reorder and (v_store is null or not exists (select 1 from stores where tenant_id = p_tenant and id = v_store and deleted_at is null)) then
    raise exception 'bad-store';
  end if;
  -- a cost is written only for someone who may see cost, or with the word of
  -- someone who may: a sheet that does not show it must not wipe it
  v_may_cost := p ? 'cost' and may(p_emp, p, 'costs.view');
  -- the approver is named only when it was the approval that allowed it
  if not has_perm(p_emp, 'items.edit') then
    begin v_appr := nullif(p->>'approved_by', '')::uuid; exception when others then v_appr := null; end;
  end if;

  select id, deleted_at, sold_by into v_was from items where id = v_id and tenant_id = p_tenant for update;
  if found then
    if v_was.deleted_at is not null then raise exception 'bad-item'; end if;
    if v_open and (v_was.sold_by = 'weight'
        or exists (select 1 from item_variants where tenant_id = p_tenant and item_id = v_id and deleted_at is null)) then
      raise exception 'open-price-not-here';
    end if;
    -- a change of price is written down with who made it, as one from item.set_price is
    perform set_config('app.price_by', p_emp::text, true);
    perform set_config('app.price_approver', coalesce(v_appr::text, ''), true);
    update items set name = v_name, price = v_price, open_price = v_open, category_id = v_cat, barcode = v_code, is_available = v_avail,
        -- one whose price is typed at the sale is a service, and has no stock to count
        track_stock = case when v_track is null then track_stock else v_track and not v_open end,
        sku = case when p ? 'sku' then nullif(left(btrim(p->>'sku'), 60), '') else sku end,
        brand = case when p ? 'brand' then nullif(left(btrim(p->>'brand'), 60), '') else brand end,
        supplier_id = case when p ? 'supplier_id' then v_sup else supplier_id end,
        supplier_code = case when p ? 'supplier_code' then nullif(left(btrim(p->>'supplier_code'), 60), '') else supplier_code end,
        cost = case when v_may_cost then v_cost else cost end
      where id = v_id and tenant_id = p_tenant;
    perform set_config('app.price_by', '', true);
    perform set_config('app.price_approver', '', true);
    -- one tax per item: the others are taken off, the chosen one put (back) on
    if v_new_tax is not null then
      update item_taxes set deleted_at = now() where tenant_id = p_tenant and item_id = v_id and tax_id <> v_new_tax and deleted_at is null;
      insert into item_taxes (tenant_id, item_id, tax_id) values (p_tenant, v_id, v_new_tax)
        on conflict (item_id, tax_id) do update set deleted_at = null;
    end if;
    if v_reorder then perform stock_set_reorder(p_tenant, v_store, v_id, v_point, v_qty); end if;
    -- the add-on groups it carries (0096), when the sheet says
    if p ? 'groups' then perform item_set_groups(p_tenant, v_id, p->'groups'); end if;
    return jsonb_build_object('item_id', v_id, 'created', false);
  end if;

  select business_type = 'retail' into v_shop from tenants where id = p_tenant;
  v_shop := coalesce(v_shop, false);
  -- an id that is another client's item stops here on the primary key, and is answered 'conflict'
  insert into items (id, tenant_id, category_id, name, price, open_price, is_available, barcode, track_stock, sku, brand, supplier_id, supplier_code, cost)
    values (v_id, p_tenant, v_cat, v_name, v_price, v_open, v_avail, v_code, coalesce(v_track, v_shop) and not v_open,
            nullif(left(btrim(p->>'sku'), 60), ''), nullif(left(btrim(p->>'brand'), 60), ''), v_sup,
            nullif(left(btrim(p->>'supplier_code'), 60), ''), case when v_may_cost then v_cost end);
  -- the tax the sheet named, or the usual one
  v_tax := v_new_tax;
  if v_tax is null then
    select id into v_tax from taxes where tenant_id = p_tenant and deleted_at is null order by is_default desc, created_at, id limit 1;
  end if;
  if v_tax is not null then
    insert into item_taxes (tenant_id, item_id, tax_id) values (p_tenant, v_id, v_tax)
      on conflict (item_id, tax_id) do update set deleted_at = null;
  end if;
  if v_shop then perform barcodes_auto(p_tenant, v_id); end if;
  if v_reorder then perform stock_set_reorder(p_tenant, v_store, v_id, v_point, v_qty); end if;
  if p ? 'groups' then perform item_set_groups(p_tenant, v_id, p->'groups'); end if;
  return jsonb_build_object('item_id', v_id, 'created', true);
end $function$
;

CREATE OR REPLACE FUNCTION public.sync_push(p_employee_id uuid, p_ops jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  tenant uuid;
  n int;
  i int;
  j int;
  op jsonb;
  rop jsonb;
  v_op_id uuid;
  v_type text;
  v_logtype text;
  v_stored jsonb;
  v_data jsonb;
  v_code text;
  v_envelope jsonb;
  v_emp uuid;
  v_payload jsonb;
  v_appr uuid;
  res jsonb := '[]'::jsonb;
  codes text[] := array[
    'bad-op-id','bad-payload','unknown-op','bad-store','bad-ticket',
    'ticket-closed','bad-line','bad-item','bad-variant','bad-modifier',
    'bad-dining','bad-discount','bad-payment','bad-change','bad-totals',
    'bad-device','bad-receipt','bad-qty','overpayment','lines-required',
    'empty-ticket','already-refunded','forbidden','conflict',
    'bad-rounding','approval-required','paid-line',
    'unknown-item','unknown-variant',
    'bad-employee','bad-shift','shift-closed',
    -- an item made or changed from a till (0084)
    'name-required','bad-category','barcode-taken','sku-taken','open-price-not-here',
    -- a premium feature asked of a restaurant whose plan does not carry it (0085)
    'not-premium',
    -- a category, and stock, changed from a till (0087)
    'has-items','bad-reason','not-counted','pick-variant','not-enough-stock',
    -- a tablet's first-run set-up (0089)
    'too-many','room-exists','name-taken','bad-address','bad-printer','bad-role','bad-pin','unknown-staff',
    -- a till's answer to what the back office asked of it (0091)
    'bad-request',
    -- a shop's stock tools on its till (0092)
    'unknown-supplier','unknown-store','unknown-order','not-draft','no-lines','already-received','not-open','not-part',
    'bad-delivery','nothing-received','unknown-line','bad-scope','nothing-to-count','bad-uncounted','bad-quantity',
    -- taxes and the fuller product sheet from a till (0094)
    'bad-rate','bad-tax',
    -- roles, staff and discounts from a till (0095)
    'owner-role','role-in-use','has-login','bad-value',
    -- add-ons and settings from a till (0096)
    'bad-limits','bad-group'];
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no-tenant-context'; end if;
  if not exists (select 1 from employees where id = p_employee_id and deleted_at is null and is_active) then
    raise exception 'unknown-employee';
  end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad-batch'; end if;
  -- Whether the login pushing may vouch for staff: it may set up tills, so
  -- its word is taken for who did each thing and who approved it. The
  -- functions that store a refund and a bill ask this (0082): a refund or a
  -- discount the roles do not allow is stored and flagged when it comes from
  -- such a login, and refused, as it always was, from any other.
  perform set_config('app.till_vouched', case when has_perm(p_employee_id, 'settings.device') then '1' else '' end, true);

  n := jsonb_array_length(p_ops);
  for i in 0..n - 1 loop
    op := p_ops->i;
    begin
      begin
        v_op_id := (op->>'op_id')::uuid;
      exception when others then
        res := res || jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'code', 'bad-op-id');
        continue;
      end;
      if v_op_id is null then
        res := res || jsonb_build_object('op_id', op->>'op_id', 'status', 'rejected', 'code', 'bad-op-id');
        continue;
      end if;
      v_type := op->>'type';
      v_logtype := coalesce(v_type, 'unknown');

      select result into v_stored from sync_ops_applied where op_id = v_op_id;
      if found then
        res := res || (v_stored || jsonb_build_object('replayed', true));
        continue;
      end if;

      begin
        -- Who did it. The op names the member of staff who was signed in at
        -- the till with their PIN. An op that names nobody (a till with no
        -- staff PINs, or an older build) is the signed-in login's own.
        -- The login vouches for its staff only if it is allowed to set up
        -- tills; otherwise the op stays the login's own, so a lesser login
        -- cannot borrow someone else's permissions. Nothing is rejected for
        -- that: a sale must not be lost over who rang it up.
        v_emp := p_employee_id;
        if op->>'employee_id' is not null and has_perm(p_employee_id, 'settings.device') then
          begin
            v_emp := (op->>'employee_id')::uuid;
          exception when others then
            raise exception 'bad-employee';
          end;
          -- switched off or removed since is fine (the sale happened); an id
          -- that was never this restaurant's is not
          if not exists (select 1 from employees where id = v_emp and tenant_id = tenant) then
            raise exception 'bad-employee';
          end if;
        end if;
        -- Who approved it. When the person at the till may not do something,
        -- someone who may enters their own PIN there, and the op names them
        -- in its payload as approved_by. The same rule as for employee_id:
        -- it counts only from a login allowed to set up tills. From any other
        -- login it is dropped, and the op stands or falls on who sent it.
        v_payload := op->'payload';
        v_appr := null;
        if v_payload ? 'approved_by' then
          if has_perm(p_employee_id, 'settings.device') then
            begin
              v_appr := nullif(v_payload->>'approved_by', '')::uuid;
            exception when others then
              raise exception 'bad-employee';
            end;
            if v_appr is not null and not exists (select 1 from employees where id = v_appr and tenant_id = tenant) then
              raise exception 'bad-employee';
            end if;
          else
            v_payload := v_payload - 'approved_by';
          end if;
        end if;
        -- A discount that needs a manager names who approved it inside the
        -- discount itself. The same rule holds there (0082): from a login
        -- that may not set up tills it is dropped, and the discount stands
        -- or falls on who sent it.
        if jsonb_typeof(v_payload->'discounts') = 'array' and not has_perm(p_employee_id, 'settings.device') then
          v_payload := jsonb_set(v_payload, '{discounts}', (
            select coalesce(jsonb_agg(case when jsonb_typeof(x.d) = 'object' then x.d - 'approved_by' else x.d end order by x.n), '[]'::jsonb)
              from jsonb_array_elements(v_payload->'discounts') with ordinality as x(d, n)));
        end if;
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, v_emp, v_payload);
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, v_emp, v_payload);
          when 'ticket.edit_line' then v_data := push_ticket_edit_line(tenant, v_emp, v_payload);
          when 'ticket.void_line' then v_data := push_ticket_void_line(tenant, v_emp, v_payload);
          when 'ticket.update_meta' then v_data := push_ticket_update_meta(tenant, v_emp, v_payload);
          when 'ticket.move_lines' then v_data := push_ticket_move_lines(tenant, v_emp, v_payload);
          when 'ticket.merge' then v_data := push_ticket_merge(tenant, v_emp, v_payload);
          when 'receipt.create' then v_data := push_receipt_create(tenant, v_emp, v_payload);
          when 'refund.create' then v_data := push_refund_create(tenant, v_emp, v_payload);
          when 'shift.open' then v_data := push_shift_open(tenant, v_emp, v_payload);
          when 'shift.close' then v_data := push_shift_close(tenant, v_emp, v_payload);
          when 'timeclock.punch' then v_data := push_timeclock_punch(tenant, v_emp, v_payload);
          when 'ticket.send' then v_data := push_ticket_send(tenant, v_emp, v_payload);
          when 'ticket.split_line' then v_data := push_ticket_split_line(tenant, v_emp, v_payload);
          when 'ticket.place_lines' then v_data := push_ticket_place_lines(tenant, v_emp, v_payload);
          when 'customer.upsert' then v_data := push_customer_upsert(tenant, v_emp, v_payload);
          when 'ticket.stage' then v_data := push_ticket_stage(tenant, v_emp, v_payload);
          when 'ticket.cancel' then v_data := push_ticket_cancel(tenant, v_emp, v_payload);
          when 'kitchen.mark' then v_data := push_kitchen_mark(tenant, v_emp, v_payload);
          when 'booking.upsert' then v_data := push_booking_upsert(tenant, v_emp, v_payload);
          when 'item.set_available' then v_data := push_item_set_available(tenant, v_emp, v_payload);
          when 'item.set_price' then v_data := push_item_set_price(tenant, v_emp, v_payload);
          when 'item.save' then v_data := push_item_save(tenant, v_emp, v_payload);
          when 'item.remove' then v_data := push_item_remove(tenant, v_emp, v_payload);
          when 'category.save' then v_data := push_category_save(tenant, v_emp, v_payload);
          when 'category.remove' then v_data := push_category_remove(tenant, v_emp, v_payload);
          when 'stock.adjust' then v_data := push_stock_adjust(tenant, v_emp, v_payload);
          when 'tables.add' then v_data := push_tables_add(tenant, v_emp, v_payload);
          when 'printer.save' then v_data := push_printer_save(tenant, v_emp, v_payload);
          when 'company.save' then v_data := push_company_save(tenant, v_emp, v_payload);
          when 'staff.save' then v_data := push_staff_save(tenant, v_emp, v_payload);
          when 'staff.set_pin' then v_data := push_staff_set_pin(tenant, v_emp, v_payload);
          when 'setup.finish' then v_data := push_setup_finish(tenant, v_emp, v_payload);
          when 'cash.move' then v_data := push_cash_move(tenant, v_emp, v_payload);
          when 'drawer.count' then v_data := push_drawer_count(tenant, v_emp, v_payload);
          when 'day.close' then v_data := push_day_close(tenant, v_emp, v_payload);
          when 'payment.correct' then v_data := push_payment_correct(tenant, v_emp, v_payload);
          when 'request.answer' then v_data := push_request_answer(tenant, v_emp, v_payload);
          when 'supplier.save' then v_data := push_supplier_save(tenant, v_emp, v_payload);
          when 'supplier.remove' then v_data := push_supplier_remove(tenant, v_emp, v_payload);
          when 'po.save' then v_data := push_po_save(tenant, v_emp, v_payload);
          when 'po.send' then v_data := push_po_state(tenant, v_emp, v_payload, 'send');
          when 'po.cancel' then v_data := push_po_state(tenant, v_emp, v_payload, 'cancel');
          when 'po.close' then v_data := push_po_state(tenant, v_emp, v_payload, 'close');
          when 'delivery.receive' then v_data := push_delivery_receive(tenant, v_emp, v_payload);
          when 'count.complete' then v_data := push_count_complete(tenant, v_emp, v_payload);
          when 'tax.save' then v_data := push_tax_save(tenant, v_emp, v_payload);
          when 'role.save' then v_data := push_role_save(tenant, v_emp, v_payload);
          when 'role.remove' then v_data := push_role_remove(tenant, v_emp, v_payload);
          when 'staff.update' then v_data := push_staff_update(tenant, v_emp, v_payload);
          when 'discount.save' then v_data := push_discount_save(tenant, v_emp, v_payload);
          when 'discount.remove' then v_data := push_discount_remove(tenant, v_emp, v_payload);
          when 'addon.save' then v_data := push_addon_save(tenant, v_emp, v_payload);
          when 'addon.remove' then v_data := push_addon_remove(tenant, v_emp, v_payload);
          when 'settings.save' then v_data := push_settings_save(tenant, v_emp, v_payload);
          else raise exception 'unknown-op';
        end case;
        v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'applied', 'data', v_data);
        insert into sync_ops_applied (op_id, tenant_id, type, result)
          values (v_op_id, tenant, v_logtype, v_envelope);
        if v_appr is not null then
          insert into approvals (tenant_id, op_id, op_type, employee_id, approved_by)
            values (tenant, v_op_id, v_logtype, v_emp, v_appr);
        end if;
        res := res || v_envelope;
      exception when others then
        if sqlstate = '23505' then
          select result into v_stored from sync_ops_applied where op_id = v_op_id;
          if found then
            res := res || (v_stored || jsonb_build_object('replayed', true));
          else
            v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', 'conflict');
            insert into sync_ops_applied (op_id, tenant_id, type, result)
              values (v_op_id, tenant, v_logtype, v_envelope);
            res := res || v_envelope;
          end if;
        elsif sqlstate like '40%' or sqlstate like '53%' or sqlstate in ('55P03', '57014') then
          -- transient: stop here; this op and every later one retries.
          -- earlier ops keep their stored results.
          for j in i..n - 1 loop
            rop := p_ops->j;
            res := res || jsonb_build_object('op_id', rop->>'op_id', 'status', 'retry', 'code', 'transient');
          end loop;
          return res;
        else
          v_code := case when sqlerrm ~ '^[a-z0-9-]+$' then sqlerrm else 'error' end;
          if not (v_code = any (codes)) then
            raise warning 'sync_push unexpected op %: %', v_op_id, sqlerrm;
            v_code := 'error';
          end if;
          v_envelope := jsonb_build_object('op_id', v_op_id, 'status', 'rejected', 'code', v_code);
          insert into sync_ops_applied (op_id, tenant_id, type, result)
            values (v_op_id, tenant, v_logtype, v_envelope);
          res := res || v_envelope;
        end if;
      end;
    end;
  end loop;
  return res;
end $function$
;
