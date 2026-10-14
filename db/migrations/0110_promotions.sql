-- 0110: a shop's promotions.
--
-- The owner, 2026-10-14: "also write the spec for promotion like kids corner
-- does it", and "both should be available offline and online". Spec:
-- docs/superpowers/specs/2026-10-14-shop-promotions-design.md
--
-- A promotion is a real change to a line's selling price (a product's, or a
-- variant's), never below the line's cost, with the price before it
-- remembered on the line (items.promo_was, item_variants.promo_was: the
-- tills read it with the rows they already pull) and in promotions (one
-- live row per line). Reducing again moves promo_price alone, so lifting
-- puts the whole markdown back in one step; lifting restores the price only
-- if it is still the promotion's (a price changed by hand since is the
-- shop's latest word and stays).
--
-- The three functions below are what the back office calls and what the
-- push operations promotion.apply, promotion.reduce and promotion.lift reach
-- (push_promotion_*), under items.edit. A product's price moves through the
-- same path a price change takes (app.price_by, so item_price_changes says
-- who). slow_movers and stale_promotions are the two detections, queries
-- and not jobs: a line with stock, no live promotion and no sale for
-- p_days (a line that never sold counts from the day it was made), and a
-- live promotion whose line sold nothing since it was applied or since its
-- last sale for p_days. Two shop settings carry the days (slowMoverDays,
-- promoStillDays), taken by push_settings_save under settings.device.
-- sync_pull sends a shop's promotions. sync_push knows the operations and
-- their refusals. push_settings_save, sync_push and sync_pull are rebuilt
-- from their live definitions (dump-function.cjs on dev, 2026-10-14).

alter table items add column if not exists promo_was bigint;
alter table item_variants add column if not exists promo_was bigint;

create table if not exists promotions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  item_id uuid not null,
  variant_id uuid,
  original_price bigint not null check (original_price >= 0),
  promo_price bigint not null check (promo_price >= 0),
  status text not null default 'active' check (status in ('active', 'lifted')),
  note text,
  applied_by uuid,
  applied_at timestamptz not null default now(),
  lifted_by uuid,
  lifted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  constraint promotions_is_a_reduction check (promo_price <= original_price),
  foreign key (tenant_id, item_id) references items (tenant_id, id) on delete cascade,
  foreign key (tenant_id, variant_id) references item_variants (tenant_id, id) on delete cascade,
  foreign key (tenant_id, applied_by) references employees (tenant_id, id) on delete set null,
  foreign key (tenant_id, lifted_by) references employees (tenant_id, id) on delete set null
);
create unique index if not exists promotions_one_active
  on promotions (tenant_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status = 'active' and deleted_at is null;
create index if not exists idx_promotions_tenant_seq on promotions (tenant_id, server_seq);
alter table promotions enable row level security;
alter table promotions force row level security;
drop policy if exists tenant_isolation on promotions;
create policy tenant_isolation on promotions using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on promotions;
create trigger trg_touch before insert or update on promotions for each row execute function touch_row();

-- The line a promotion is on: a variant's price and cost, or the product's.
-- Locked for the caller.
create or replace function promo_line(p_tenant uuid, p_item uuid, p_variant uuid, out o_price bigint, out o_cost bigint)
language plpgsql set search_path = public as $fn$
begin
  if p_variant is not null then
    select price, cost into o_price, o_cost from item_variants
      where id = p_variant and item_id = p_item and tenant_id = p_tenant and deleted_at is null for update;
    if not found then raise exception 'bad-variant'; end if;
  else
    select price, cost into o_price, o_cost from items where id = p_item and tenant_id = p_tenant and deleted_at is null for update;
    if not found then raise exception 'bad-item'; end if;
    if exists (select 1 from item_variants where tenant_id = p_tenant and item_id = p_item and deleted_at is null) then
      raise exception 'pick-variant';
    end if;
  end if;
end $fn$;

-- the line's price, moved as a price change is moved (0061: who, from what to what)
create or replace function promo_set_price(p_tenant uuid, p_emp uuid, p_item uuid, p_variant uuid, p_price bigint, p_was bigint)
returns void language plpgsql set search_path = public as $fn$
begin
  if p_variant is not null then
    update item_variants set price = p_price, promo_was = p_was where id = p_variant and tenant_id = p_tenant;
  else
    perform set_config('app.price_by', p_emp::text, true);
    perform set_config('app.price_approver', '', true);
    update items set price = p_price, promo_was = p_was where id = p_item and tenant_id = p_tenant;
    perform set_config('app.price_by', '', true);
  end if;
end $fn$;

create or replace function promotion_apply(p_tenant uuid, p_emp uuid, p_item uuid, p_variant uuid, p_price bigint, p_note text, p_id uuid default null)
returns uuid language plpgsql set search_path = public as $fn$
declare v_price bigint; v_cost bigint; v_id uuid := coalesce(p_id, gen_random_uuid());
begin
  if p_price is null or p_price < 0 then raise exception 'bad-payload'; end if;
  if not has_perm(p_emp, 'items.edit') then raise exception 'forbidden'; end if;
  select o_price, o_cost into v_price, v_cost from promo_line(p_tenant, p_item, p_variant);
  if v_cost is null then raise exception 'no-cost'; end if;
  if p_price < v_cost then raise exception 'below-cost'; end if;
  if p_price >= v_price then raise exception 'not-lower'; end if;
  if exists (select 1 from promotions where tenant_id = p_tenant and item_id = p_item and variant_id is not distinct from p_variant
               and status = 'active' and deleted_at is null) then raise exception 'on-promotion'; end if;
  insert into promotions (id, tenant_id, item_id, variant_id, original_price, promo_price, note, applied_by)
    values (v_id, p_tenant, p_item, p_variant, v_price, p_price, nullif(left(btrim(coalesce(p_note, '')), 120), ''), p_emp);
  perform promo_set_price(p_tenant, p_emp, p_item, p_variant, p_price, v_price);
  return v_id;
end $fn$;

create or replace function promotion_reduce(p_tenant uuid, p_emp uuid, p_item uuid, p_variant uuid, p_price bigint, p_note text)
returns uuid language plpgsql set search_path = public as $fn$
declare v_price bigint; v_cost bigint; v_id uuid; v_promo bigint; v_orig bigint;
begin
  if p_price is null or p_price < 0 then raise exception 'bad-payload'; end if;
  if not has_perm(p_emp, 'items.edit') then raise exception 'forbidden'; end if;
  select id, promo_price, original_price into v_id, v_promo, v_orig from promotions
    where tenant_id = p_tenant and item_id = p_item and variant_id is not distinct from p_variant and status = 'active' and deleted_at is null
    for update;
  if not found then raise exception 'not-active'; end if;
  select o_price, o_cost into v_price, v_cost from promo_line(p_tenant, p_item, p_variant);
  if v_cost is null then raise exception 'no-cost'; end if;
  if p_price < v_cost then raise exception 'below-cost'; end if;
  if p_price >= v_promo then raise exception 'not-lower'; end if;
  update promotions set promo_price = p_price, note = coalesce(nullif(left(btrim(coalesce(p_note, '')), 120), ''), note) where id = v_id and tenant_id = p_tenant;
  perform promo_set_price(p_tenant, p_emp, p_item, p_variant, p_price, v_orig);
  return v_id;
end $fn$;

-- true when the price was put back; false when it was left, having been changed by hand since
create or replace function promotion_lift(p_tenant uuid, p_emp uuid, p_id uuid)
returns boolean language plpgsql set search_path = public as $fn$
declare r record; v_price bigint; v_cost bigint;
begin
  if not has_perm(p_emp, 'items.edit') then raise exception 'forbidden'; end if;
  select * into r from promotions where id = p_id and tenant_id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'bad-payload'; end if;
  if r.status <> 'active' then raise exception 'not-active'; end if;
  update promotions set status = 'lifted', lifted_by = p_emp, lifted_at = now() where id = p_id and tenant_id = p_tenant;
  select o_price, o_cost into v_price, v_cost from promo_line(p_tenant, r.item_id, r.variant_id);
  if v_price = r.promo_price then
    perform promo_set_price(p_tenant, p_emp, r.item_id, r.variant_id, r.original_price, null);
    return true;
  end if;
  perform promo_set_price(p_tenant, p_emp, r.item_id, r.variant_id, v_price, null);
  return false;
end $fn$;

-- A line with stock, no live promotion and no sale for p_days, counted from
-- the day it was made when it never sold. Stock and sales are the shop's
-- whole (every store).
create or replace function slow_movers(p_tenant uuid, p_days int)
returns table (
  item_id uuid, variant_id uuid, name text, variant text, category text,
  qty integer, price bigint, cost bigint, last_sold timestamptz, idle_since timestamptz, days_idle integer)
language sql stable set search_path = public as $fn$
  select x.item_id, x.variant_id, x.name, x.variant, x.category, x.qty, x.price, x.cost, x.last_sold,
         greatest(x.made, x.last_sold) as idle_since,
         extract(day from now() - greatest(x.made, x.last_sold))::int as days_idle
    from (
      select i.id as item_id, v.id as variant_id, i.name, v.name as variant, c.name as category,
             coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id
                         and l.variant_id is not distinct from v.id and l.deleted_at is null), 0)::integer as qty,
             coalesce(v.price, i.price) as price, coalesce(v.cost, i.cost) as cost, coalesce(v.created_at, i.created_at) as made,
             (select max(m.created_at) from stock_movements m
               where m.tenant_id = i.tenant_id and m.item_id = i.id and m.variant_id is not distinct from v.id
                 and m.reason = 'sale' and m.deleted_at is null) as last_sold
        from items i
        left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
        left join item_variants v on v.tenant_id = i.tenant_id and v.item_id = i.id and v.deleted_at is null
       where i.tenant_id = p_tenant and i.deleted_at is null and i.is_available and not i.open_price
         and not exists (select 1 from promotions pr where pr.tenant_id = i.tenant_id and pr.item_id = i.id
                           and pr.variant_id is not distinct from v.id and pr.status = 'active' and pr.deleted_at is null)
    ) x
   where x.qty > 0 and greatest(x.made, x.last_sold) <= now() - make_interval(days => greatest(p_days, 1))
   order by greatest(x.made, x.last_sold), x.name, x.variant
$fn$;

create or replace function count_slow_movers(p_tenant uuid, p_days int) returns int
language sql stable set search_path = public as $fn$
  select count(*)::int from slow_movers(p_tenant, p_days)
$fn$;

-- A live promotion whose line still holds stock and sold nothing for p_days,
-- counted from when it was applied or its last sale, whichever came later.
create or replace function stale_promotions(p_tenant uuid, p_days int)
returns table (
  promotion_id uuid, item_id uuid, variant_id uuid, name text, variant text, category text,
  qty integer, original_price bigint, promo_price bigint, cost bigint, applied_at timestamptz, days_idle integer)
language sql stable set search_path = public as $fn$
  select pr.id, pr.item_id, pr.variant_id, i.name, v.name, c.name,
         coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = pr.tenant_id and l.item_id = pr.item_id
                     and l.variant_id is not distinct from pr.variant_id and l.deleted_at is null), 0)::integer,
         pr.original_price, pr.promo_price, coalesce(v.cost, i.cost), pr.applied_at,
         extract(day from now() - greatest(pr.applied_at, coalesce(x.last_sold, pr.applied_at)))::int
    from promotions pr
    join items i on i.tenant_id = pr.tenant_id and i.id = pr.item_id
    left join item_variants v on v.tenant_id = pr.tenant_id and v.id = pr.variant_id
    left join categories c on c.tenant_id = i.tenant_id and c.id = i.category_id
    left join lateral (
      select max(m.created_at) as last_sold from stock_movements m
       where m.tenant_id = pr.tenant_id and m.item_id = pr.item_id and m.variant_id is not distinct from pr.variant_id
         and m.reason = 'sale' and m.deleted_at is null) x on true
   where pr.tenant_id = p_tenant and pr.status = 'active' and pr.deleted_at is null
     and greatest(pr.applied_at, coalesce(x.last_sold, pr.applied_at)) <= now() - make_interval(days => greatest(p_days, 1))
     and coalesce((select sum(l.qty) from stock_levels l where l.tenant_id = pr.tenant_id and l.item_id = pr.item_id
                     and l.variant_id is not distinct from pr.variant_id and l.deleted_at is null), 0) > 0
   order by pr.applied_at
$fn$;

-- the three, as a till sends them
create or replace function push_promotion_apply(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_item uuid; v_variant uuid; v_price bigint; v_id uuid;
begin
  begin
    v_item := (p->>'item_id')::uuid; v_variant := nullif(p->>'variant_id', '')::uuid; v_price := (p->>'price')::bigint; v_id := nullif(p->>'id', '')::uuid;
  exception when others then raise exception 'bad-payload'; end;
  if v_item is null or v_price is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- an approver's right counts as the person's own here, as for a price change
  v_id := promotion_apply(p_tenant, case when has_perm(p_emp, 'items.edit') then p_emp else nullif(p->>'approved_by', '')::uuid end, v_item, v_variant, v_price, p->>'note', v_id);
  return jsonb_build_object('id', v_id, 'item_id', v_item, 'variant_id', v_variant, 'price', v_price);
end $fn$;

create or replace function push_promotion_reduce(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_item uuid; v_variant uuid; v_price bigint; v_id uuid;
begin
  begin
    v_item := (p->>'item_id')::uuid; v_variant := nullif(p->>'variant_id', '')::uuid; v_price := (p->>'price')::bigint;
  exception when others then raise exception 'bad-payload'; end;
  if v_item is null or v_price is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  v_id := promotion_reduce(p_tenant, case when has_perm(p_emp, 'items.edit') then p_emp else nullif(p->>'approved_by', '')::uuid end, v_item, v_variant, v_price, p->>'note');
  return jsonb_build_object('id', v_id, 'item_id', v_item, 'variant_id', v_variant, 'price', v_price);
end $fn$;

create or replace function push_promotion_lift(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_item uuid; v_variant uuid; v_restored boolean;
begin
  begin
    v_id := nullif(p->>'id', '')::uuid; v_item := nullif(p->>'item_id', '')::uuid; v_variant := nullif(p->>'variant_id', '')::uuid;
  exception when others then raise exception 'bad-payload'; end;
  if not may(p_emp, p, 'items.edit') then raise exception 'forbidden'; end if;
  -- a till may name the line instead of the row (its own row's id is the server's once it is here, but a lift sent before the apply was answered names the line)
  if v_id is null then
    select id into v_id from promotions where tenant_id = p_tenant and item_id = v_item and variant_id is not distinct from v_variant and status = 'active' and deleted_at is null;
    if v_id is null then raise exception 'not-active'; end if;
  end if;
  v_restored := promotion_lift(p_tenant, case when has_perm(p_emp, 'items.edit') then p_emp else nullif(p->>'approved_by', '')::uuid end, v_id);
  return jsonb_build_object('id', v_id, 'restored', v_restored);
end $fn$;

CREATE OR REPLACE FUNCTION public.push_settings_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_patch jsonb := '{}'::jsonb; v_receipt jsonb; v_pct int; v_now jsonb; v_notes jsonb; v_int int;
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
  -- the notes offered when an item is added (0108): the list whole, as the
  -- back office's Settings saves it. Twelve of forty letters at most; what is
  -- empty or not words is left out; a list saved empty stays empty.
  if p ? 'kitchenNotes' then
    if jsonb_typeof(p->'kitchenNotes') <> 'array' then raise exception 'bad-payload'; end if;
    select coalesce(jsonb_agg(x.note order by x.n), '[]'::jsonb) into v_notes
      from (select left(btrim(e.v #>> '{}'), 40) as note, e.n
              from jsonb_array_elements(p->'kitchenNotes') with ordinality as e(v, n)
             where jsonb_typeof(e.v) = 'string' and btrim(e.v #>> '{}') <> ''
             order by e.n limit 12) x;
    v_patch := v_patch || jsonb_build_object('kitchenNotes', v_notes);
  end if;
  -- a shop's return policy (0109): each key is taken when sent and left as
  -- it was when not; a value nobody knows is refused
  if p ? 'returns' then
    if p->>'returns' not in ('exchange', 'credit', 'refund') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('returns', p->>'returns');
  end if;
  if p ? 'returnDays' then
    begin v_int := (p->>'returnDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('returnDays', v_int);
  end if;
  if p ? 'noteMonths' then
    begin v_int := (p->>'noteMonths')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 36 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('noteMonths', v_int);
  end if;
  -- a shop's promotions (0110): the two thresholds, in days
  if p ? 'slowMoverDays' then
    begin v_int := (p->>'slowMoverDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('slowMoverDays', v_int);
  end if;
  if p ? 'promoStillDays' then
    begin v_int := (p->>'promoStillDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('promoStillDays', v_int);
  end if;
  if v_patch <> '{}'::jsonb then
    insert into pos_settings (tenant_id, data) values (p_tenant, v_patch)
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('saved', (select count(*) from jsonb_object_keys(v_patch)));
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
    -- a shop's return policy (0109)
    'refund-policy',
    -- a shop's promotions (0110)
    'below-cost','not-lower','on-promotion','not-active','no-cost','pick-variant',
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
    'bad-limits','bad-group',
    -- a product's variants from a till (0097)
    'bad-options','too-many-variants','has-stock'];
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
          when 'variants.make' then v_data := push_variants_make(tenant, v_emp, v_payload);
          when 'variants.save' then v_data := push_variants_save(tenant, v_emp, v_payload);
          when 'variant.remove' then v_data := push_variant_remove(tenant, v_emp, v_payload);
          when 'floor.save' then v_data := push_floor_save(tenant, v_emp, v_payload);
          when 'room.rename' then v_data := push_room_rename(tenant, v_emp, v_payload);
          when 'room.remove' then v_data := push_room_remove(tenant, v_emp, v_payload);
          -- a shop's promotions (0110)
          when 'promotion.apply' then v_data := push_promotion_apply(tenant, v_emp, v_payload);
          when 'promotion.reduce' then v_data := push_promotion_reduce(tenant, v_emp, v_payload);
          when 'promotion.lift' then v_data := push_promotion_lift(tenant, v_emp, v_payload);
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

CREATE OR REPLACE FUNCTION public.sync_pull(p_store_id uuid, p_cursor bigint, p_lim integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  tbl text;
  cols text;
  r jsonb; m bigint; c int;
  lim int := greatest(least(coalesce(p_lim, 200), 1000), 1);
  cur bigint := coalesce(p_cursor, 0);
  low_cut bigint := null;
  high bigint := null;
  more boolean := false;
  changes jsonb := '{}'::jsonb;
begin
  if current_tenant_id() is null then
    raise exception 'app.tenant_id must be set';
  end if;
  if not exists (select 1 from stores where id = p_store_id) then
    raise exception 'unknown store';
  end if;
  -- one point in the sequence: writers holding touch_row's exclusive lock
  -- finish first, and new writers wait until this txn commits
  perform pg_advisory_xact_lock_shared(hashtextextended(current_tenant_id()::text, 0));

  foreach tbl in array array[
    'categories','items','item_variants','modifier_groups','modifiers',
    'item_modifier_groups','item_taxes','taxes','discounts','dining_options',
    'payment_types','stores','roles','employees','employee_stores',
    'store_item_overrides','grid_pages','grid_page_items','pos_devices',
    'printers','pos_settings','customers']
  loop
    cols := case tbl when 'employees' then
        'id, tenant_id, name, pin_hash, role_id, auth_user_id, is_active, ' ||
        'created_at, updated_at, deleted_at, server_seq'
      else '*' end;
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from ' ||
      '(select %s from %I where server_seq > %L and tenant_id = current_tenant_id() ' ||
      'order by server_seq limit %s) t',
      cur, cols, tbl, cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tickets + children: this store only; open ones, and ones that changed in
  -- the last 30 days (a ticket changes when it closes, so the close arrives)
  foreach tbl in array array[
    'tickets','ticket_lines','ticket_line_modifiers','ticket_line_taxes']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() ' ||
      'order by x.server_seq limit %s) t',
      cur, tbl,
      case tbl
        when 'tickets' then
          format('join stores s on s.tenant_id = x.tenant_id and s.id = x.store_id and s.id = %L ' ||
            'and (x.status = ''open'' or x.updated_at > now() - interval ''30 days'')', p_store_id)
        when 'ticket_lines' then
          format('join tickets t on t.tenant_id = x.tenant_id and t.id = x.ticket_id and t.store_id = %L ' ||
            'and (t.status = ''open'' or t.updated_at > now() - interval ''30 days'')', p_store_id)
        else
          format('join ticket_lines tl on tl.tenant_id = x.tenant_id and tl.id = x.line_id ' ||
            'join tickets t on t.tenant_id = tl.tenant_id and t.id = tl.ticket_id and t.store_id = %L ' ||
            'and (t.status = ''open'' or t.updated_at > now() - interval ''30 days'')', p_store_id)
      end,
      cur, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- receipts: this store, last 30 days
  foreach tbl in array array[
    'receipts','receipt_lines','receipt_line_modifiers','receipt_line_taxes',
    'receipt_payments','receipt_discounts']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x %s ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and r.store_id = %L ' ||
      'and r.created_at > now() - interval ''30 days'' order by x.server_seq limit %s) t',
      cur, tbl,
      case tbl
        when 'receipts' then
          'join receipts r on r.tenant_id = x.tenant_id and r.id = x.id'
        when 'receipt_line_modifiers' then
          'join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id ' ||
          'join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id'
        when 'receipt_line_taxes' then
          'join receipt_lines rl on rl.tenant_id = x.tenant_id and rl.id = x.receipt_line_id ' ||
          'join receipts r on r.tenant_id = rl.tenant_id and r.id = rl.receipt_id'
        else
          'join receipts r on r.tenant_id = x.tenant_id and r.id = x.receipt_id'
      end,
      cur, p_store_id, lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- tables, sales periods and clock punches: this store. A till needs the
  -- open period and who is clocked in, not the history, so a week is enough.
  -- and what the shop holds of each product (0077): a till that does not know
  -- the table reads past it. And what the back office asked of the store's
  -- tills (0091): each till acts on its own, and one too old to reads past it
  -- and what stands in its rooms beside the tables (0102): walls, doors,
  -- windows, a bar. A till that does not know the table reads past it
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts','bookings','stock_levels','till_requests','floor_elements']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and x.store_id = %L ' ||
      'and (%s) order by x.server_seq limit %s) t',
      cur, tbl, cur, p_store_id,
      case tbl
        when 'tables' then 'true'
        when 'stock_levels' then 'true'
        when 'floor_elements' then 'true'
        when 'shifts' then 'x.closed_at is null or x.created_at > now() - interval ''7 days'''
        when 'day_closes' then 'x.created_at > now() - interval ''30 days'''
        when 'bookings' then 'x.booked_for > now() - interval ''7 days'''
        else 'x.created_at > now() - interval ''7 days'''
      end,
      lim)
      into r, m, c;
    changes := changes || jsonb_build_object(tbl, r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end loop;

  -- A shop's stock papers (0092): its suppliers, and this store's orders,
  -- deliveries, counts and movements. An order and a delivery arrive with
  -- their lines inside the row, as they stand when the pull runs: a draft's
  -- lines are deleted outright when it is saved again, which rows sent by
  -- sequence would never tell a till. A restaurant is sent none of this, and
  -- a till that does not know these tables reads past them.
  if exists (select 1 from pos_settings where tenant_id = current_tenant_id() and data->>'businessType' = 'retail') then
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from suppliers x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('suppliers', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'qty', l.qty, 'unit_cost', l.unit_cost,
                             'received', (select coalesce(sum(d.qty), 0)::integer from delivery_lines d where d.tenant_id = l.tenant_id and d.order_line_id = l.id))
                             order by l.item_id, l.variant_id nulls first), '[]'::jsonb)
                      from purchase_order_lines l where l.tenant_id = x.tenant_id and l.order_id = x.id and l.deleted_at is null) as lines
              from purchase_orders x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and (x.status in ('draft', 'sent', 'part') or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('purchase_orders', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(jsonb_build_object('item_id', l.item_id, 'variant_id', l.variant_id, 'qty', l.qty, 'unit_cost', l.unit_cost)
                             order by l.item_id, l.variant_id nulls first), '[]'::jsonb)
                      from delivery_lines l where l.tenant_id = x.tenant_id and l.delivery_id = x.id) as lines
              from deliveries x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and x.created_at > now() - interval '30 days'
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('deliveries', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_counts x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and (x.status = 'open' or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_counts', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_count_lines x
              join stock_counts k on k.tenant_id = x.tenant_id and k.id = x.count_id and k.store_id = p_store_id
               and k.status <> 'open' and k.updated_at > now() - interval '30 days'
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_count_lines', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from stock_movements x
             where x.server_seq > cur and x.tenant_id = current_tenant_id() and x.store_id = p_store_id
               and x.created_at > now() - interval '30 days'
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('stock_movements', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    -- The shop's credit notes (0109): every store's, since a note is spent
    -- at any till of the shop; the open ones, and ones that changed in the
    -- last 30 days so a till learns a note was used up or cancelled.
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from credit_notes x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
               and (x.status = 'open' or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('credit_notes', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;

    -- The shop's promotions (0110): the live ones, and ones that changed in
    -- the last 30 days so a till learns one was lifted.
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from promotions x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
               and (x.status = 'active' or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('promotions', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
  end if;

  return jsonb_build_object(
    'changes', changes,
    'next_cursor', coalesce(low_cut, high, cur), 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $function$
;

