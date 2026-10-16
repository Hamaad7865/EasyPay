-- 0113: a shop's deposits (layaway).
--
-- The owner, 2026-10-16: a client who sells kids' things, "and sometime
-- people deposits an amount to reserve what they want to buy". Kids Corner's
-- rule (20260823100000_deposit_orders.sql) in EasyPay's stack.
-- Spec: docs/superpowers/specs/2026-10-16-shop-deposits-design.md
-- Plan: docs/superpowers/plans/2026-10-16-shop-deposits.md
--
-- A deposit is not a sale. The goods leave the shelf the day it is taken (a
-- stock movement 'deposit', added up per product as a sale is), at the price
-- of that day, which the deposit keeps. Money comes in once or many times
-- (deposit_payments; cash also as a cash_movements row with deposit_id, so
-- the drawer counts it). The sale is written when goods are collected: an
-- ordinary receipt whose lines name their deposit line, paid first from a
-- built-in payment type of kind 'deposit' naming the deposit by its number.
-- Those lines move no stock: it left the shelf already. A cancel puts what
-- was not collected back ('deposit_release') and does with the money what the
-- shop's setting says: back to the customer, onto a credit note, or kept.
--
-- A paid feature (the owner: "if an offline wishes to have it they need to
-- pay more"): tenants.features, set by the platform admin, copied into
-- pos_settings.data.features as the plan is (0085). Premium and trial carry
-- it. Money that already moved is never refused for that: a deposit.create
-- carrying a payment from a client without the feature is stored and flagged.
--
-- The deposit type is made for every shop INACTIVE, so a till built before
-- this (which offers only active types on Pay) never shows it; the new till
-- finds it by kind and push_receipt_create takes it whatever is_active says.
--
-- Rebuilt from their live definitions (db/scripts/dump-function.cjs on dev,
-- 2026-10-16): push_receipt_create, push_ticket_add_line, push_settings_save,
-- push_payment_correct, sync_pull, sync_push, platform.set_tenant_plan,
-- platform.set_tenant_business_type, platform.clear_test_activity,
-- platform.till_is_bare, platform.test_sales_on_stock.

alter table tenants add column if not exists features text[] not null default '{}';

alter table payment_types drop constraint if exists payment_types_kind_check;
alter table payment_types add constraint payment_types_kind_check
  check (kind in ('cash', 'card', 'wallet', 'qr', 'other', 'exchange', 'credit_note', 'deposit'));
create unique index if not exists payment_types_one_deposit
  on payment_types (tenant_id) where kind = 'deposit' and deleted_at is null;

alter table receipt_reviews drop constraint if exists receipt_reviews_reason_check;
alter table receipt_reviews add constraint receipt_reviews_reason_check
  check (reason in ('double-pay', 'underpaid', 'overpaid', 'price-drift', 'number-collision', 'price-unapproved',
                    'exchange-unmatched', 'discount-unapproved', 'refund-unapproved', 'credit-note-refused', 'credit-overspent',
                    'deposit-overused'));

alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check
  check (reason in ('sale', 'refund', 'adjust', 'count', 'receive', 'supplier_return', 'opening', 'damaged', 'expired',
                    'lost', 'internal', 'found', 'deposit', 'deposit_release'));

create table if not exists deposits (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid not null,
  number text not null,
  customer_id uuid,
  collect_by date not null,
  status text not null default 'open' check (status in ('open', 'collected', 'cancelled')),
  total bigint not null default 0 check (total >= 0),
  paid bigint not null default 0,
  given_back bigint not null default 0,
  used bigint not null default 0,
  kept bigint not null default 0,
  owed bigint not null default 0,
  noted bigint not null default 0,
  cancel_outcome text check (cancel_outcome in ('refund', 'credit', 'keep')),
  cancel_reason text,
  auto_cancelled boolean not null default false,
  credit_note_id uuid,
  flags jsonb not null default '[]'::jsonb,
  created_by uuid,
  cancelled_by uuid,
  approved_by uuid,
  cancelled_at timestamptz,
  device_time timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  unique (tenant_id, number),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, device_id) references pos_devices (tenant_id, id) on delete restrict,
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete set null
);
create index if not exists idx_deposits_open on deposits (tenant_id, status) where deleted_at is null;
create index if not exists idx_deposits_tenant_seq on deposits (tenant_id, server_seq);
alter table deposits enable row level security;
alter table deposits force row level security;
drop policy if exists tenant_isolation on deposits;
create policy tenant_isolation on deposits using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on deposits;
create trigger trg_touch before insert or update on deposits for each row execute function touch_row();

create table if not exists deposit_lines (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  deposit_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  name text not null,
  qty integer not null check (qty > 0),
  qty_collected integer not null default 0 check (qty_collected >= 0),
  unit_price bigint not null check (unit_price >= 0),
  list_price bigint,
  price_kind text check (price_kind in ('discount', 'override')),
  price_label text,
  price_by uuid,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, deposit_id) references deposits (tenant_id, id) on delete cascade
);
create index if not exists idx_deposit_lines_deposit on deposit_lines (tenant_id, deposit_id);
alter table deposit_lines enable row level security;
alter table deposit_lines force row level security;
drop policy if exists tenant_isolation on deposit_lines;
create policy tenant_isolation on deposit_lines using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

create table if not exists deposit_payments (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  deposit_id uuid not null,
  payment_type_id uuid not null,
  kind text not null check (kind in ('in', 'back')),
  amount bigint not null check (amount <> 0),
  tendered bigint,
  change bigint not null default 0,
  shift_id uuid,
  device_id uuid,
  employee_id uuid,
  device_time timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, deposit_id) references deposits (tenant_id, id) on delete cascade
);
create index if not exists idx_deposit_payments_deposit on deposit_payments (tenant_id, deposit_id);
alter table deposit_payments enable row level security;
alter table deposit_payments force row level security;
drop policy if exists tenant_isolation on deposit_payments;
create policy tenant_isolation on deposit_payments using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());

-- a collection's line names the deposit line it hands over
alter table ticket_lines add column if not exists deposit_line_id uuid;
create index if not exists idx_ticket_lines_deposit_line on ticket_lines (tenant_id, deposit_line_id) where deposit_line_id is not null;
-- the drawer's rows that are a deposit's money, so reports tell them from pay-ins
alter table cash_movements add column if not exists deposit_id uuid;
-- a credit note from a cancelled deposit has no refund behind it
alter table credit_notes alter column refund_id drop not null;
alter table credit_notes add column if not exists deposit_id uuid;
alter table credit_notes drop constraint if exists credit_notes_backed;
alter table credit_notes add constraint credit_notes_backed check (refund_id is not null or deposit_id is not null);

-- ── the feature switch ────────────────────────────────────────────────────
create or replace function has_feature(p_tenant uuid, p_name text) returns boolean
language sql stable set search_path = public as $fn$
  select coalesce((select (p_name = 'deposits' and lower(btrim(plan)) in ('premium', 'trial')) or p_name = any (features)
                     from tenants where id = p_tenant), false)
$fn$;

create or replace function platform.set_tenant_features(p_admin uuid, p_tenant uuid, p_features text[]) returns void
language plpgsql set search_path = public as $fn$
declare v_old text[]; v_new text[];
begin
  perform platform.require_admin(p_admin);
  select coalesce(array_agg(distinct f order by f), '{}') into v_new
    from unnest(coalesce(p_features, '{}')) f where btrim(f) <> '';
  if exists (select 1 from unnest(v_new) f where f not in ('deposits')) then raise exception 'bad-feature'; end if;
  select features into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set features = v_new where id = p_tenant;
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('features', to_jsonb(v_new)))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.features', p_tenant, jsonb_build_object('from', to_jsonb(v_old), 'to', to_jsonb(v_new)));
end $fn$;

-- the shop's deposit type: as ensure_credit_note_type (0109), but inactive
create or replace function ensure_deposit_type(p_tenant uuid) returns uuid
language plpgsql set search_path = public as $fn$
declare v_id uuid; v_name text := 'Deposit';
begin
  select id into v_id from payment_types where tenant_id = p_tenant and kind = 'deposit' and deleted_at is null;
  if found then return v_id; end if;
  select id into v_id from payment_types where tenant_id = p_tenant and kind = 'deposit' order by deleted_at desc limit 1;
  if found then
    update payment_types set deleted_at = null, is_active = false where tenant_id = p_tenant and id = v_id;
    return v_id;
  end if;
  if exists (select 1 from payment_types where tenant_id = p_tenant and name = v_name) then v_name := 'Deposit (held goods)'; end if;
  if exists (select 1 from payment_types where tenant_id = p_tenant and name = v_name) then v_name := 'Deposit ' || left(gen_random_uuid()::text, 8); end if;
  insert into payment_types (tenant_id, name, kind, opens_drawer, is_active, sort_order)
    values (p_tenant, v_name, 'deposit', false, false, 997) returning id into v_id;
  return v_id;
end $fn$;

-- What is free to use on a deposit: money in, less what went back, what
-- collections used, what the shop kept, what is owed back and what went on
-- a credit note.
create or replace function deposit_free(d deposits) returns bigint
language sql immutable as $fn$
  select d.paid - d.given_back - d.used - d.kept - d.owed - d.noted
$fn$;

-- The shop's day, by its store's clock.
create or replace function deposit_today(p_tenant uuid, p_store uuid) returns date
language sql stable set search_path = public as $fn$
  select (now() at time zone coalesce((select timezone from stores where tenant_id = p_tenant and id = p_store), 'Indian/Mauritius'))::date
$fn$;

-- Money into or out of a deposit. 'in' is a payment taken, 'back' is money
-- given back (stored negative). Cash also goes in the drawer's rows, under
-- the payment's own id, as the till writes it. A payment sent twice is
-- written once. Returns the amount, 0 when it was there already.
create or replace function deposit_money(p_tenant uuid, p_emp uuid, p_dep uuid, p_store uuid, p_device uuid, pay jsonb,
                                         p_kind text, p_number text, p_time timestamptz) returns bigint
language plpgsql set search_path = public as $fn$
declare v_pid uuid; v_type uuid; v_amt bigint; v_kind text; v_tender bigint; v_change bigint := 0; v_shift uuid;
begin
  if pay is null or jsonb_typeof(pay) <> 'object' then raise exception 'bad-payment'; end if;
  begin
    v_pid := (pay->>'id')::uuid;
    v_type := (pay->>'payment_type_id')::uuid;
    v_amt := (pay->>'amount')::bigint;
  exception when others then raise exception 'bad-payment';
  end;
  if v_pid is null or v_type is null or v_amt is null or v_amt <= 0 then raise exception 'bad-payment'; end if;
  if exists (select 1 from deposit_payments where tenant_id = p_tenant and id = v_pid) then return 0; end if;
  select kind into v_kind from payment_types where tenant_id = p_tenant and id = v_type and deleted_at is null;
  if not found or v_kind in ('exchange', 'credit_note', 'deposit') then raise exception 'bad-payment'; end if;
  if p_kind = 'in' and pay->>'tendered' is not null then
    v_tender := (pay->>'tendered')::bigint;
    v_change := coalesce((pay->>'change')::bigint, -1);
    if v_tender < v_amt or v_change <> v_tender - v_amt then raise exception 'bad-change'; end if;
  end if;
  begin
    select s.id into v_shift from shifts s where s.tenant_id = p_tenant and s.id = nullif(pay->>'shift_id', '')::uuid;
  exception when others then v_shift := null;
  end;
  insert into deposit_payments (id, tenant_id, deposit_id, payment_type_id, kind, amount, tendered, change, shift_id, device_id, employee_id, device_time)
    values (v_pid, p_tenant, p_dep, v_type, p_kind, case when p_kind = 'in' then v_amt else -v_amt end,
      v_tender, v_change, v_shift, p_device, p_emp, coalesce(p_time, now()));
  if v_kind = 'cash' then
    insert into cash_movements (id, tenant_id, store_id, device_id, shift_id, employee_id, type, amount, reason, device_time, deposit_id)
      values (v_pid, p_tenant, p_store, p_device, v_shift, p_emp, case when p_kind = 'in' then 'in' else 'out' end, v_amt,
        left('Deposit ' || p_number, 200), coalesce(p_time, now()), p_dep)
      on conflict (id) do nothing;
  end if;
  return v_amt;
end $fn$;

-- Puts back on the shelf what a deposit holds and nobody collected, added up
-- per product as a sale is (its own document pair: once per deposit).
create or replace function deposit_release(p_tenant uuid, p_emp uuid, d deposits) returns void
language plpgsql set search_path = public as $fn$
declare v_sm record;
begin
  for v_sm in
    select x.item_id, x.variant_id, sum(x.qty)::int as qty
      from deposit_lines l cross join lateral stock_parts(p_tenant, l.item_id, l.variant_id, l.qty - l.qty_collected) x
     where l.tenant_id = p_tenant and l.deposit_id = d.id and l.qty > l.qty_collected
     group by x.item_id, x.variant_id
     order by x.item_id, x.variant_id
  loop
    perform stock_move(p_tenant, d.store_id, v_sm.item_id, v_sm.variant_id, v_sm.qty, 'deposit_release', null,
      'deposit_release', d.id, p_emp, left('Back from deposit ' || d.number, 200));
  end loop;
end $fn$;

-- A credit note for what was free on a cancelled deposit: its number is the
-- deposit's with -CN. Returns the note's id.
create or replace function deposit_note(p_tenant uuid, p_emp uuid, d deposits, p_id uuid, p_amount bigint, p_valid date, p_device uuid)
returns uuid
language plpgsql set search_path = public as $fn$
declare v_id uuid := coalesce(p_id, gen_random_uuid()); v_number text := d.number || '-CN';
begin
  perform ensure_credit_note_type(p_tenant);
  if exists (select 1 from credit_notes where tenant_id = p_tenant and (id = v_id or number = v_number)) then
    select id into v_id from credit_notes where tenant_id = p_tenant and (id = v_id or number = v_number) limit 1;
    return v_id;
  end if;
  insert into credit_notes (id, tenant_id, store_id, device_id, number, amount, balance, refund_id, deposit_id, customer_id, valid_to, issued_by)
    values (v_id, p_tenant, d.store_id, coalesce(p_device, d.device_id), v_number, p_amount, p_amount, null, d.id, d.customer_id, p_valid, p_emp);
  return v_id;
end $fn$;

-- ── a deposit taken ─────────────────────────────────────────────────────────
create or replace function push_deposit_create(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v_id uuid; v_store uuid; v_device uuid; v_base text; v_number text; v_try int := 1; v_collect date; v_cust uuid;
  v_time timestamptz; v_flags jsonb := '[]'::jsonb; v_money boolean; l jsonb; v_n int := 0;
  v_item uuid; v_variant uuid; v_qty int; v_price bigint; v_list bigint; v_kind text; v_by uuid; v_name text;
  v_sub bigint := 0; v_tax bigint := 0; r_line record; r_tax record; v_sm record; v_paid bigint := 0; d deposits;
  v_vouched boolean := coalesce(current_setting('app.till_vouched', true), '') = '1';
begin
  begin
    v_id := (p->>'id')::uuid;
    v_store := (p->>'store_id')::uuid;
    v_device := (p->>'device_id')::uuid;
    v_collect := (p->>'collect_by')::date;
    v_time := coalesce((p->>'device_time')::timestamptz, now());
  exception when others then raise exception 'bad-payload';
  end;
  v_base := nullif(btrim(coalesce(p->>'number', '')), '');
  if v_id is null or v_store is null or v_device is null or v_collect is null or v_base is null
     or jsonb_typeof(p->'lines') <> 'array' or jsonb_array_length(p->'lines') = 0 then
    raise exception 'bad-payload'; end if;
  if exists (select 1 from deposits where tenant_id = p_tenant and id = v_id) then
    return jsonb_build_object('deposit_id', v_id, 'replayed', true);
  end if;
  if not exists (select 1 from pos_devices where tenant_id = p_tenant and id = v_device and store_id = v_store) then
    raise exception 'bad-device'; end if;
  v_money := jsonb_typeof(p->'payment') = 'object' and coalesce((p->'payment'->>'amount')::bigint, 0) > 0;
  -- not this client's feature: refused, unless money already changed hands
  if not (has_feature(p_tenant, 'deposits') and exists (select 1 from tenants where id = p_tenant and business_type = 'retail')) then
    if not v_money then raise exception 'not-entitled'; end if;
    v_flags := v_flags || jsonb_build_object('why', 'not-entitled');
  end if;
  if p->>'customer_id' is not null then
    begin v_cust := (p->>'customer_id')::uuid; exception when others then v_cust := null; end;
    if v_cust is not null and not exists (select 1 from customers where tenant_id = p_tenant and id = v_cust) then
      v_flags := v_flags || jsonb_build_object('why', 'customer-unknown', 'customer_id', v_cust);
      v_cust := null;
    end if;
  end if;
  -- a number this shop has already: kept with a suffix, and said
  v_number := v_base;
  while exists (select 1 from deposits where tenant_id = p_tenant and number = v_number) loop
    v_try := v_try + 1;
    if v_try > 10 then raise exception 'bad-payload'; end if;
    v_number := v_base || '-' || v_try;
  end loop;
  if v_number <> v_base then v_flags := v_flags || jsonb_build_object('why', 'number-collision', 'requested', v_base); end if;

  insert into deposits (id, tenant_id, store_id, device_id, number, customer_id, collect_by, created_by, device_time, flags)
    values (v_id, p_tenant, v_store, v_device, v_number, v_cust, v_collect, p_emp, v_time, v_flags);

  for l in select value from jsonb_array_elements(p->'lines') loop
    v_n := v_n + 1;
    begin
      v_item := (l->>'item_id')::uuid;
      v_variant := nullif(l->>'variant_id', '')::uuid;
      v_qty := (l->>'qty')::int;
      v_price := (l->>'unit_price')::bigint;
      v_list := (l->>'list_price')::bigint;
      v_by := coalesce(nullif(l->>'price_by', '')::uuid, p_emp);
    exception when others then raise exception 'bad-payload';
    end;
    v_kind := nullif(l->>'price_kind', '');
    if v_item is null or v_qty is null or v_qty <= 0 or v_price is null or v_price < 0 then raise exception 'bad-payload'; end if;
    select name into v_name from items where tenant_id = p_tenant and id = v_item;
    if not found then raise exception 'unknown-item'; end if;
    if v_variant is not null and not exists (select 1 from item_variants where id = v_variant and item_id = v_item) then
      raise exception 'unknown-variant'; end if;
    if v_kind is not null then
      if v_kind not in ('discount', 'override') or v_list is null or v_list < 0 or (v_kind = 'discount' and v_price > v_list) then
        raise exception 'bad-payload'; end if;
      if not has_perm(v_by, case v_kind when 'discount' then 'sale.apply_discount' else 'sale.change_price' end) then
        if not v_vouched and not v_money then raise exception 'forbidden'; end if;
        v_flags := v_flags || jsonb_build_object('why', 'price-unapproved', 'item_id', v_item, 'charged', v_price, 'listed', v_list);
      end if;
    else
      v_list := null;
    end if;
    insert into deposit_lines (id, tenant_id, deposit_id, item_id, variant_id, name, qty, unit_price, list_price, price_kind, price_label, price_by, sort)
      values (coalesce(nullif(l->>'id', '')::uuid, gen_random_uuid()), p_tenant, v_id, v_item, v_variant,
        left(coalesce(nullif(btrim(l->>'name'), ''), v_name), 200), v_qty, v_price, v_list, v_kind,
        nullif(left(l->>'price_label', 60), ''), case when v_kind is not null then v_by end, v_n);
  end loop;

  -- the total, as the collection's receipt will charge it: the lines, and a
  -- tax that is added on top (an included one is in the price already)
  for r_line in select l.item_id, line_amount(l.unit_price, l.qty) as base from deposit_lines l
      where l.tenant_id = p_tenant and l.deposit_id = v_id loop
    v_sub := v_sub + r_line.base;
    for r_tax in select t.rate_bp from item_taxes it join taxes t on t.tenant_id = it.tenant_id and t.id = it.tax_id
        where it.tenant_id = p_tenant and it.item_id = r_line.item_id and it.deleted_at is null and t.type = 'added' loop
      v_tax := v_tax + (r_line.base * r_tax.rate_bp + 5000) / 10000;
    end loop;
  end loop;

  -- the goods leave the shelf now, once per product
  for v_sm in
    select x.item_id, x.variant_id, sum(x.qty)::int as qty
      from deposit_lines l cross join lateral stock_parts(p_tenant, l.item_id, l.variant_id, l.qty) x
     where l.tenant_id = p_tenant and l.deposit_id = v_id
     group by x.item_id, x.variant_id
     order by x.item_id, x.variant_id
  loop
    perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, -v_sm.qty, 'deposit', null, 'deposit', v_id, p_emp,
      left('Held for deposit ' || v_number, 200));
  end loop;

  if v_money then
    v_paid := deposit_money(p_tenant, p_emp, v_id, v_store, v_device, p->'payment', 'in', v_number, v_time);
  end if;
  update deposits set total = v_sub + v_tax, paid = v_paid, flags = v_flags where tenant_id = p_tenant and id = v_id
    returning * into d;
  return jsonb_build_object('deposit_id', v_id, 'number', v_number, 'total', d.total, 'flagged', jsonb_array_length(v_flags) > 0);
end $fn$;

-- ── money paid on a deposit ─────────────────────────────────────────────────
create or replace function push_deposit_pay(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare d deposits; v_amt bigint; v_dev uuid; v_time timestamptz;
begin
  begin
    v_dev := (p->>'device_id')::uuid;
    v_time := coalesce((p->>'device_time')::timestamptz, now());
    select * into d from deposits where tenant_id = p_tenant and id = (p->>'deposit_id')::uuid and deleted_at is null for update;
  exception when others then raise exception 'bad-payload';
  end;
  if not found then raise exception 'bad-deposit'; end if;
  v_amt := deposit_money(p_tenant, p_emp, d.id, d.store_id, coalesce(v_dev, d.device_id), p->'payment', 'in', d.number, v_time);
  if v_amt = 0 then return jsonb_build_object('deposit_id', d.id, 'replayed', true); end if;
  -- money on a deposit that is closed (two tills apart): it was taken, so it
  -- is kept, and the deposit says so for the owner to settle
  update deposits set paid = paid + v_amt,
      flags = case when d.status <> 'open' then flags || jsonb_build_object('why', 'closed-payment', 'amount', v_amt) else flags end
    where tenant_id = p_tenant and id = d.id;
  return jsonb_build_object('deposit_id', d.id, 'paid', d.paid + v_amt);
end $fn$;

-- ── a deposit cancelled, or closed with money left on it ───────────────────
-- outcome: refund (back: the payments out), credit (credit_note: the note the
-- till printed), keep. auto: the tablet's own day opening cancelled it (a
-- tablet working alone); the right to refund is not asked then.
create or replace function push_deposit_cancel(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  d deposits; v_outcome text := p->>'outcome'; v_auto boolean := coalesce((p->>'auto')::boolean, false);
  v_free bigint; v_back bigint := 0; b jsonb; v_dev uuid; v_time timestamptz; v_flags jsonb := '[]'::jsonb;
  v_note uuid; v_namt bigint; v_valid date; v_left boolean; v_owed bigint := 0; v_kept bigint := 0;
  v_vouched boolean := coalesce(current_setting('app.till_vouched', true), '') = '1';
begin
  begin
    v_dev := (p->>'device_id')::uuid;
    v_time := coalesce((p->>'device_time')::timestamptz, now());
    select * into d from deposits where tenant_id = p_tenant and id = (p->>'deposit_id')::uuid and deleted_at is null for update;
  exception when others then raise exception 'bad-payload';
  end;
  if not found then raise exception 'bad-deposit'; end if;
  if v_outcome is null or v_outcome not in ('refund', 'credit', 'keep') then raise exception 'bad-payload'; end if;
  if d.cancel_outcome is not null then
    -- cancelled already (the server's own expiry, or another till): money a
    -- till paid out since was paid, so it is recorded and said
    for b in select value from jsonb_array_elements(coalesce(p->'back', '[]'::jsonb)) loop
      v_back := v_back + deposit_money(p_tenant, p_emp, d.id, d.store_id, coalesce(v_dev, d.device_id), b, 'back', d.number, v_time);
    end loop;
    if v_back > 0 then
      update deposits set given_back = given_back + v_back, owed = greatest(owed - v_back, 0),
          flags = flags || jsonb_build_object('why', 'cancelled-twice', 'given_back', v_back)
        where tenant_id = p_tenant and id = d.id;
    end if;
    return jsonb_build_object('deposit_id', d.id, 'already', true);
  end if;
  if not v_auto and not may(p_emp, p, 'sale.refund') then
    if not v_vouched then raise exception 'forbidden'; end if;
    v_flags := v_flags || jsonb_build_object('why', 'cancel-unapproved');
  end if;
  v_free := deposit_free(d);
  v_left := exists (select 1 from deposit_lines where tenant_id = p_tenant and deposit_id = d.id and qty > qty_collected);
  perform deposit_release(p_tenant, p_emp, d);

  if v_outcome = 'refund' then
    for b in select value from jsonb_array_elements(coalesce(p->'back', '[]'::jsonb)) loop
      v_back := v_back + deposit_money(p_tenant, p_emp, d.id, d.store_id, coalesce(v_dev, d.device_id), b, 'back', d.number, v_time);
    end loop;
    if v_back > v_free then v_flags := v_flags || jsonb_build_object('why', 'over-given', 'free', v_free, 'given', v_back); end if;
    -- what was not handed over yet is owed (a tablet alone cancelling by date)
    v_owed := greatest(v_free - v_back, 0);
  elsif v_outcome = 'credit' then
    v_namt := coalesce((p->'credit_note'->>'amount')::bigint, v_free);
    if v_namt <> v_free then v_flags := v_flags || jsonb_build_object('why', 'note-differs', 'free', v_free, 'note', v_namt); end if;
    if v_namt > 0 then
      begin v_valid := nullif(p->'credit_note'->>'valid_to', '')::date; exception when others then v_valid := null; end;
      v_note := deposit_note(p_tenant, p_emp, d, nullif(p->'credit_note'->>'id', '')::uuid, v_namt, v_valid, v_dev);
    end if;
    v_kept := 0;
  else
    v_kept := greatest(v_free, 0);
  end if;

  update deposits set
      status = case when v_left then 'cancelled' else 'collected' end,
      cancel_outcome = v_outcome, cancel_reason = left(nullif(btrim(coalesce(p->>'reason', '')), ''), 200),
      auto_cancelled = v_auto, cancelled_by = p_emp, approved_by = nullif(p->>'approved_by', '')::uuid, cancelled_at = v_time,
      given_back = given_back + v_back, owed = v_owed,
      kept = kept + v_kept, noted = noted + case when v_outcome = 'credit' then greatest(coalesce(v_namt, 0), 0) else 0 end,
      credit_note_id = v_note, flags = flags || v_flags
    where tenant_id = p_tenant and id = d.id;
  return jsonb_build_object('deposit_id', d.id, 'credit_note_id', v_note, 'owed', v_owed);
end $fn$;

-- ── what a cancelled deposit owed, paid out at a till ──────────────────────
create or replace function push_deposit_give_back(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path = public as $fn$
declare d deposits; b jsonb; v_back bigint := 0; v_dev uuid; v_time timestamptz;
begin
  begin
    v_dev := (p->>'device_id')::uuid;
    v_time := coalesce((p->>'device_time')::timestamptz, now());
    select * into d from deposits where tenant_id = p_tenant and id = (p->>'deposit_id')::uuid and deleted_at is null for update;
  exception when others then raise exception 'bad-payload';
  end;
  if not found then raise exception 'bad-deposit'; end if;
  if not may(p_emp, p, 'sale.refund') and coalesce(current_setting('app.till_vouched', true), '') <> '1' then
    raise exception 'forbidden'; end if;
  for b in select value from jsonb_array_elements(coalesce(p->'back', '[]'::jsonb)) loop
    v_back := v_back + deposit_money(p_tenant, p_emp, d.id, d.store_id, coalesce(v_dev, d.device_id), b, 'back', d.number, v_time);
  end loop;
  if v_back = 0 then return jsonb_build_object('deposit_id', d.id, 'replayed', true); end if;
  update deposits set given_back = given_back + v_back, owed = greatest(owed - v_back, 0),
      flags = case when v_back > d.owed then flags || jsonb_build_object('why', 'over-given', 'owed', d.owed, 'given', v_back) else flags end
    where tenant_id = p_tenant and id = d.id;
  return jsonb_build_object('deposit_id', d.id, 'owed', greatest(d.owed - v_back, 0));
end $fn$;

-- ── past the date: cancelled by the server, for a shop set to ──────────────
-- Not a tablet working alone (it does it at its day opening). Runs when a
-- till pulls and when the back office opens Deposits; nothing runs nightly.
create or replace function deposits_expire(p_tenant uuid) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_set jsonb; v_grace int; v_outcome text; v_months int; d deposits; v_free bigint; v_note uuid; v_n int := 0;
begin
  if exists (select 1 from tenants where id = p_tenant and lower(btrim(coalesce(plan, ''))) = 'offline') then return 0; end if;
  select data into v_set from pos_settings where tenant_id = p_tenant;
  if coalesce(v_set->>'depositOverdue', 'show') <> 'cancel' then return 0; end if;
  v_grace := coalesce(case when (v_set->>'depositGrace') ~ '^[0-9]+$' then (v_set->>'depositGrace')::int end, 7);
  v_outcome := coalesce(nullif(v_set->>'depositCancel', ''), 'credit');
  if v_outcome not in ('refund', 'credit', 'keep') then v_outcome := 'credit'; end if;
  v_months := coalesce(case when (v_set->>'noteMonths') ~ '^[0-9]+$' then (v_set->>'noteMonths')::int end, 6);
  for d in select * from deposits x
      where x.tenant_id = p_tenant and x.status = 'open' and x.deleted_at is null
        and x.collect_by + v_grace < deposit_today(p_tenant, x.store_id)
      order by x.id for update skip locked loop
    v_free := greatest(deposit_free(d), 0);
    v_note := null;
    perform deposit_release(p_tenant, null, d);
    if v_outcome = 'credit' and v_free > 0 then
      v_note := deposit_note(p_tenant, null, d, null, v_free,
        case when v_months = 0 then null else (deposit_today(p_tenant, d.store_id) + make_interval(months => v_months))::date end, d.device_id);
    end if;
    update deposits set status = 'cancelled', cancel_outcome = v_outcome, auto_cancelled = true, cancelled_at = now(),
        cancel_reason = 'Not collected by ' || to_char(d.collect_by, 'DD Mon YYYY'),
        owed = case when v_outcome = 'refund' then v_free else 0 end,
        kept = kept + case when v_outcome = 'keep' then v_free else 0 end,
        noted = noted + case when v_outcome = 'credit' then v_free else 0 end,
        credit_note_id = v_note
      where tenant_id = p_tenant and id = d.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $fn$;

-- every shop has its deposit type, inactive
select ensure_deposit_type(id) from tenants where business_type = 'retail' and deleted_at is null;


-- a collection: the deposit line's kept price, its stock already held, the deposit's money
CREATE OR REPLACE FUNCTION public.push_receipt_create(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_ticket uuid; v_store uuid; v_device uuid;
  v_tstatus text;
  v_sub bigint := 0; v_disc bigint := 0;
  v_tax_add bigint := 0; v_tax_incl bigint := 0;
  v_service bigint := 0; v_round bigint := 0; v_total bigint;
  v_chunk bigint := 0; v_prior bigint := 0; v_review boolean; v_offline boolean := false;
  v_number text; v_base_number text; v_seq int; v_lock text; v_pct int; v_try int;
  d jsonb; v_dtype text; v_dval bigint; v_dname text; v_did uuid; v_amt bigint; v_appr uuid;
  pay jsonb; v_ptype uuid; v_pamt bigint; v_tender bigint; v_change bigint;
  lid jsonb; v_lid uuid; covered uuid[] := '{}';
  r_line record; r_tax record; v_pl bigint; v_div bigint;
  rdiscs jsonb := '[]'::jsonb;
  ol record; cur record;
  v_eff bigint; v_avail boolean; v_gone boolean; v_ovr bigint; v_open boolean;
  v_drift jsonb := '[]'::jsonb; v_till bigint; md record;
  v_short boolean := false; v_over boolean := false;
  v_sm record;
  v_unapp jsonb := '[]'::jsonb;
  v_exch jsonb := '[]'::jsonb; v_unmatched jsonb := '[]'::jsonb; ex record;
  -- credit notes spent on this sale (0109)
  v_notes jsonb := '[]'::jsonb; v_refused jsonb := '[]'::jsonb; v_overspent jsonb := '[]'::jsonb; nt record; v_cn credit_notes%rowtype; v_take bigint; v_sold date;
  -- a collection of deposits (0113)
  v_deps jsonb := '[]'::jsonb; dp record; dd deposits; dl deposit_lines%rowtype; v_held jsonb := '{}'::jsonb;
  v_dover jsonb := '[]'::jsonb; v_h int; v_dfree bigint; v_dtake bigint; v_froz bigint;
  v_vouched boolean; v_nodisc boolean := false; v_claim uuid; v_why text; v_undisc jsonb := '[]'::jsonb;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_base_number := nullif(p->>'number','');
  v_seq := coalesce((p->>'device_seq')::int, 0);
  if v_id is null or v_ticket is null or v_store is null or v_device is null or v_base_number is null then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store) then
    raise exception 'bad-device'; end if;
  select status into v_tstatus from tickets where id = v_ticket and store_id = v_store;
  if not found then raise exception 'bad-ticket'; end if;
  if v_tstatus = 'cancelled' then raise exception 'ticket-closed'; end if;

  -- fail-fast lock: contention becomes 55P03 -> retry envelopes, never a wait
  v_lock := 'receipt:' || v_ticket::text;
  if not pg_try_advisory_xact_lock(hashtextextended(v_lock, 0)) then
    raise exception 'lock-busy' using errcode = '55P03';
  end if;

  if not exists (select 1 from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null and not paid) then
    v_review := true;
  else
    v_review := false;
  end if;

  if p->'line_ids' is not null and jsonb_array_length(p->'line_ids') > 0 then
    for lid in select value from jsonb_array_elements(p->'line_ids') as value loop
      v_lid := (lid->>0)::uuid;
      if not exists (select 1 from ticket_lines
          where id = v_lid and ticket_id = v_ticket and tenant_id = p_tenant and voided_at is null) then
        raise exception 'bad-line';
      end if;
      covered := covered || v_lid;
    end loop;
    select array_agg(x) into covered from unnest(covered) x
      where x in (select id from ticket_lines where ticket_id = v_ticket and not paid);
    if covered is null then covered := '{}'; end if;
  else
    select array_agg(id) into covered from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null and not paid;
    if covered is null then covered := '{}'; end if;
  end if;
  -- review path (already fully paid): snapshot all non-void lines for the record
  if v_review then
    select array_agg(id) into covered from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null;
    if covered is null then covered := '{}'; end if;
  end if;

  -- subtotal from snapshots, modifiers flat per line
  select coalesce(sum(line_amount(l.unit_price, l.qty) +
      coalesce((select sum(m.price) from ticket_line_modifiers m
        where m.line_id = l.id and m.tenant_id = p_tenant and m.deleted_at is null), 0)::bigint), 0)
    into v_sub from ticket_lines l where l.id = any(covered);

  select coalesce(sum(total), 0) into v_prior from receipts
    where ticket_id = v_ticket and tenant_id = p_tenant and type = 'sale' and deleted_at is null;
  -- per-receipt totals: discounts/service/rounding compute over this
  -- receipt's own lines on every chunk (no cross-chunk coupling)
  if p ? 'service_charge' then raise exception 'bad-payload'; end if;

  -- discounts: capped, staged into a jsonb variable (no temp table). A
  -- discount needs someone allowed to give one: whoever rang the bill up, or
  -- whoever approved it. From a login that may not vouch for staff, one
  -- nobody was allowed to give is refused, as it always was. From a till
  -- whose login may (sync_push says which), the bill was paid with the
  -- discount on it: it is stored either way, and the receipt says so (0082).
  v_vouched := coalesce(current_setting('app.till_vouched', true), '') = '1';
  if coalesce(jsonb_array_length(p->'discounts'), 0) > 0 and not may(p_emp, p, 'sale.apply_discount') then
    if not v_vouched then raise exception 'forbidden'; end if;
    v_nodisc := true;
  end if;
  for d in select value from jsonb_array_elements(coalesce(p->'discounts', '[]'::jsonb)) as value loop
    v_did := case when d->>'discount_id' is null then null else (d->>'discount_id')::uuid end;
    if v_did is not null then
      select type, value, name into v_dtype, v_dval, v_dname from discounts
        where id = v_did and deleted_at is null;
      if not found then raise exception 'bad-discount'; end if;
      if v_dtype = 'percent' and v_dval > 100 then raise exception 'bad-discount'; end if;
    else
      v_dtype := coalesce(d->>'type', 'amount');
      v_dval := coalesce((d->>'value')::bigint, 0);
      v_dname := coalesce(nullif(d->>'name',''), 'Discount');
      if v_dtype not in ('percent','amount') or v_dval < 0 then raise exception 'bad-discount'; end if;
      if v_dtype = 'percent' and v_dval > 100 then raise exception 'bad-discount'; end if;
    end if;
    v_appr := null; v_claim := null;
    v_why := case when v_nodisc then 'not-allowed' end;
    if v_did is not null and exists (select 1 from discounts where id = v_did and requires_approval) then
      -- One that needs a manager. Who approved it is written on the bill
      -- only when they may approve it; an approver that is not an id is no
      -- approver.
      begin
        v_claim := nullif(d->>'approved_by', '')::uuid;
      exception when others then
        v_claim := null;
      end;
      if v_claim is not null and has_perm(v_claim, 'sale.apply_restricted_discount') then
        v_appr := v_claim;
      elsif v_vouched then
        v_why := 'needs-approval';
      else
        raise exception 'approval-required';
      end if;
    end if;
    v_amt := case when v_dtype = 'percent' then (v_sub * v_dval + 50) / 100 else least(v_dval, v_sub - v_disc) end;
    if v_amt < 0 then v_amt := 0; end if;
    if v_sub > 0 and v_disc + v_amt > v_sub then v_amt := v_sub - v_disc; end if;
    -- the amount the till actually took off wins (the printed receipt is the
    -- record); it is bounded, and flagged when it differs from the catalog rule
    if d->>'amount' is not null then
      v_till := (d->>'amount')::bigint;
      if v_till < 0 or v_till > v_sub - v_disc then raise exception 'bad-discount'; end if;
      if v_till <> v_amt then
        v_drift := v_drift || jsonb_build_object('kind', 'discount', 'discount_id', v_did,
          'name', v_dname, 'till', v_till, 'catalog', v_amt);
        v_offline := true;
      end if;
      v_amt := v_till;
    end if;
    v_disc := v_disc + v_amt;
    rdiscs := rdiscs || jsonb_build_object('name', v_dname, 'amount', v_amt, 'did', v_did, 'approver', v_appr);
    if v_why is not null then
      v_offline := true;
      v_undisc := v_undisc || jsonb_build_object('name', v_dname, 'amount', v_amt, 'discount_id', v_did,
        'why', v_why, 'approved_by', v_claim);
    end if;
  end loop;

  -- tax from line snapshots; added on top, included extracted
  for r_line in
    select l.id,
      line_amount(l.unit_price, l.qty) +
      coalesce((select sum(m.price) from ticket_line_modifiers m
        where m.line_id = l.id and m.tenant_id = p_tenant and m.deleted_at is null), 0)::bigint as base
    from ticket_lines l where l.id = any(covered) loop
    v_pl := case when v_sub > 0 then v_disc * r_line.base / v_sub else 0 end;
    for r_tax in select rate_bp, type from ticket_line_taxes
        where line_id = r_line.id and tenant_id = p_tenant and deleted_at is null loop
      if r_tax.type = 'added' then
        v_tax_add := v_tax_add + ((r_line.base::bigint - v_pl) * r_tax.rate_bp + 5000) / 10000;
      else
        v_div := 10000 + r_tax.rate_bp;
        v_tax_incl := v_tax_incl + ((r_line.base::bigint - v_pl) * r_tax.rate_bp + v_div / 2) / v_div;
      end if;
    end loop;
  end loop;

  v_pct := coalesce((p->>'service_pct')::int, 0);
  if v_pct < 0 or v_pct > 2000 then raise exception 'bad-payload'; end if;
  v_service := ((v_sub - v_disc) * v_pct + 5000) / 10000;
  v_round := coalesce((p->>'rounding')::bigint, 0);
  if v_round < -500 or v_round > 500 then raise exception 'bad-rounding'; end if;
  -- total assembles added tax only; included tax is display (tax_total stores
  -- added + extracted so the VAT breakdown is right in both modes)
  v_total := v_sub - v_disc + v_tax_add + v_service + v_round;
  if v_total < 0 then raise exception 'bad-totals'; end if;

  for pay in select value from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value loop
    v_ptype := (pay->>'payment_type_id')::uuid;
    v_pamt := coalesce((pay->>'amount')::bigint, 0);
    if v_ptype is null or v_pamt <= 0 then raise exception 'bad-payment'; end if;
    -- the deposit type is never active (0113): a till built before it never offers it
    if not exists (select 1 from payment_types
        where id = v_ptype and (is_active or kind = 'deposit') and deleted_at is null) then raise exception 'bad-payment'; end if;
    if pay->>'tendered' is not null then
      v_tender := (pay->>'tendered')::bigint;
      v_change := coalesce((pay->>'change')::bigint, -1);
      if v_tender < v_pamt or v_change <> v_tender - v_pamt then raise exception 'bad-change'; end if;
    end if;
    -- the part of an exchange that the goods brought back pay for (0079):
    -- it names the refund it comes from, by that refund's number
    if exists (select 1 from payment_types where id = v_ptype and tenant_id = p_tenant and kind = 'exchange') then
      v_exch := v_exch || jsonb_build_object('amount', v_pamt, 'refund', coalesce(pay->>'reference', ''));
    end if;
    -- the part a credit note covers (0109): it names the note by its number
    if exists (select 1 from payment_types where id = v_ptype and tenant_id = p_tenant and kind = 'credit_note') then
      v_notes := v_notes || jsonb_build_object('amount', v_pamt, 'number', coalesce(pay->>'reference', ''));
    end if;
    -- the part a deposit covers (0113): it names the deposit by its number
    if exists (select 1 from payment_types where id = v_ptype and tenant_id = p_tenant and kind = 'deposit') then
      v_deps := v_deps || jsonb_build_object('amount', v_pamt, 'number', coalesce(pay->>'reference', ''));
    end if;
    v_chunk := v_chunk + v_pamt;
  end loop;
  -- A credit note spent: its balance comes down under its lock. One that is
  -- not there, cancelled, expired or used up, or that two tills apart spent
  -- past its balance, leaves a sale paid in part with nothing on the books.
  -- The sale happened, so it is stored and says so (as exchange-unmatched).
  v_sold := (case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end)::date;
  for nt in select (e->>'amount')::bigint as amount, e->>'number' as number from jsonb_array_elements(v_notes) e loop
    select * into v_cn from credit_notes where tenant_id = p_tenant and number = nt.number and deleted_at is null for update;
    if not found then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'not-found');
    elsif v_cn.status = 'void' then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'void');
    elsif v_cn.valid_to is not null and v_cn.valid_to < v_sold then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'expired', 'valid_to', v_cn.valid_to);
    elsif v_cn.balance <= 0 then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'used');
    else
      v_take := least(nt.amount, v_cn.balance);
      if nt.amount > v_cn.balance then
        v_offline := true; v_overspent := v_overspent || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'balance', v_cn.balance, 'excess', nt.amount - v_cn.balance);
      end if;
      update credit_notes set balance = balance - v_take,
          status = case when balance - v_take = 0 then 'used' else status end,
          used_at = case when balance - v_take = 0 then now() else used_at end
        where id = v_cn.id and tenant_id = p_tenant;
    end if;
  end loop;
  -- An exchange's credit is good when the refund it names is there, gave
  -- that same amount to an exchange, and no other sale has used it. The till
  -- sends the refund first; one that was refused (another till refunded that
  -- receipt in the meantime) leaves a sale paid in part with goods that never
  -- came back on the books. The sale happened, so it is stored, and says so.
  for ex in select (e->>'amount')::bigint as amount, e->>'refund' as refund from jsonb_array_elements(v_exch) e loop
    if not exists (
         select 1 from receipts rf
           join receipt_payments rp on rp.tenant_id = rf.tenant_id and rp.receipt_id = rf.id
           join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id and pt.kind = 'exchange'
          where rf.tenant_id = p_tenant and rf.type = 'refund' and rf.number = ex.refund and rf.deleted_at is null
          group by rf.id having sum(rp.amount) = ex.amount)
       or exists (
         select 1 from receipt_payments rp
           join receipts s on s.tenant_id = rp.tenant_id and s.id = rp.receipt_id and s.type = 'sale' and s.id <> v_id and s.deleted_at is null
           join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id and pt.kind = 'exchange'
          where rp.tenant_id = p_tenant and rp.reference = ex.refund) then
      v_offline := true;
      v_unmatched := v_unmatched || jsonb_build_object('amount', ex.amount, 'refund', ex.refund);
    end if;
  end loop;
  -- a receipt that carries payments is never rejected for amount mismatch:
  -- store it flagged, keeping both figures (receipt.total vs payments sum).
  -- (zero money for a positive total is still a bad payload, not a mismatch)
  if v_total > 0 and v_chunk <= 0 then
    raise exception 'bad-payment';
  end if;
  if not v_review and v_chunk <> v_total then
    v_offline := true;
    v_short := v_chunk < v_total;
    v_over := v_chunk > v_total;
  end if;

  -- offline pricing: the till price must match the EFFECTIVE catalog price
  -- (payload-stamped, else store override, else variant, else item). Any
  -- drift, unavailability or deletion flags the receipt, never blocks it.
  for ol in select id, item_id, variant_id, unit_price, list_price, price_kind, price_by, deposit_line_id from ticket_lines where id = any(covered) loop
    v_eff := null; v_avail := true; v_gone := false; v_open := false;
    -- a deposit's line (0113) is sold at the price the deposit kept: that is
    -- the price it is held to, not the catalogue's, and its discount was
    -- allowed the day the deposit was taken
    if ol.deposit_line_id is not null then
      select unit_price into v_froz from deposit_lines where tenant_id = p_tenant and id = ol.deposit_line_id;
      if found then
        if v_froz <> ol.unit_price then
          v_offline := true;
          v_drift := v_drift || jsonb_build_object('kind', 'deposit', 'line_id', ol.id, 'till', ol.unit_price, 'catalog', v_froz);
        end if;
        continue;
      end if;
    end if;
    if ol.variant_id is not null then
      select price into v_eff from item_variants
        where id = ol.variant_id and item_id = ol.item_id and deleted_at is null;
      if not found then v_gone := true; end if;
      -- a variant price wins over the item-level override (most specific)
    else
      select price, is_available, deleted_at is not null, open_price into v_eff, v_avail, v_gone, v_open
        from items where id = ol.item_id;
      v_open := coalesce(v_open, false);
      select price into v_ovr from store_item_overrides
        where tenant_id = p_tenant and store_id = v_store and item_id = ol.item_id
          and deleted_at is null and price is not null;
      if found then v_eff := v_ovr; end if;
    end if;
    -- a line whose price was changed on the till is compared by what it was
    -- listed at: the change itself is not drift (0077)
    -- An item whose price is typed at the sale (0083) has no price to drift
    -- from: what the till charged is its price. It is still flagged when it
    -- was off sale or removed.
    if (not v_open and (v_eff is null or v_eff <> coalesce(ol.list_price, ol.unit_price))) or not v_avail or v_gone then
      v_offline := true;
      v_drift := v_drift || jsonb_build_object('kind',
        case when v_gone or not v_avail or v_eff is null then 'unavailable' else 'item' end,
        'line_id', ol.id, 'till', coalesce(ol.list_price, ol.unit_price), 'catalog', v_eff);
    end if;
    -- The change needs someone allowed to make it: a discount takes the right
    -- to discount, a changed price its own right. The sale happened, so it is
    -- stored either way, and the receipt says so.
    if ol.price_kind is not null and not has_perm(coalesce(ol.price_by, p_emp),
        case ol.price_kind when 'discount' then 'sale.apply_discount' else 'sale.change_price' end) then
      v_offline := true;
      v_unapp := v_unapp || jsonb_build_object('line_id', ol.id, 'kind', ol.price_kind,
        'listed', ol.list_price, 'charged', ol.unit_price, 'by', ol.price_by);
    end if;
    -- modifier drift: a changed modifier price is also offline truth, kept + flagged.
    -- A line's price for an add-on is for as many as were taken (0105), so it
    -- is held against the catalog's price for that many.
    for md in select lm.modifier_id, lm.price as till_price, mo.price * lm.qty as catalog_price
        from ticket_line_modifiers lm join modifiers mo
          on mo.tenant_id = lm.tenant_id and mo.id = lm.modifier_id
        where lm.tenant_id = p_tenant and lm.line_id = ol.id
          and (mo.price * lm.qty <> lm.price or mo.deleted_at is not null) loop
      v_offline := true;
      v_drift := v_drift || jsonb_build_object('kind', 'modifier', 'line_id', ol.id,
        'modifier_id', md.modifier_id, 'till', md.till_price, 'catalog', md.catalog_price);
    end loop;
    -- a modifier this item does not offer (its group is not linked to the
    -- item): the sale stands, the receipt says so
    for md in select lm.modifier_id, lm.price as till_price
        from ticket_line_modifiers lm join modifiers mo
          on mo.tenant_id = lm.tenant_id and mo.id = lm.modifier_id
        where lm.tenant_id = p_tenant and lm.line_id = ol.id
          and not exists (select 1 from item_modifier_groups g
            where g.tenant_id = p_tenant and g.item_id = ol.item_id
              and g.group_id = mo.group_id and g.deleted_at is null) loop
      v_offline := true;
      v_drift := v_drift || jsonb_build_object('kind', 'modifier-unlinked', 'line_id', ol.id,
        'modifier_id', md.modifier_id, 'till', md.till_price);
    end loop;
  end loop;

  -- A collection (0113): what its lines take from their deposits, and the
  -- money it uses. Each deposit under its own lock, in a fixed order. A line
  -- takes off its deposit what is still held, at most; what it takes beyond
  -- (two tills apart, or a deposit cancelled in the meantime) was never held,
  -- so it leaves the shelf as a sale does, and the receipt says so. The money
  -- is taken up to what is free; beyond that the sale is stored and flagged.
  if not v_review then
    for dp in
      select distinct x.dep from (
        select dl2.deposit_id as dep from ticket_lines tl
          join deposit_lines dl2 on dl2.tenant_id = tl.tenant_id and dl2.id = tl.deposit_line_id
         where tl.id = any(covered)
        union
        select d2.id from jsonb_array_elements(v_deps) e
          join deposits d2 on d2.tenant_id = p_tenant and d2.number = e->>'number' and d2.deleted_at is null
      ) x order by x.dep
    loop
      select * into dd from deposits where tenant_id = p_tenant and id = dp.dep for update;
      for ol in select tl.id, tl.qty, tl.deposit_line_id from ticket_lines tl
          join deposit_lines dl2 on dl2.tenant_id = tl.tenant_id and dl2.id = tl.deposit_line_id
         where tl.id = any(covered) and dl2.deposit_id = dd.id order by tl.id loop
        select * into dl from deposit_lines where tenant_id = p_tenant and id = ol.deposit_line_id;
        v_h := case when dd.status = 'open' then greatest(0, least(ol.qty, dl.qty - dl.qty_collected)) else 0 end;
        if v_h > 0 then
          update deposit_lines set qty_collected = qty_collected + v_h where tenant_id = p_tenant and id = dl.id;
          v_held := v_held || jsonb_build_object(ol.id::text, v_h);
        end if;
        if v_h < ol.qty then
          v_offline := true;
          v_dover := v_dover || jsonb_build_object('deposit', dd.number, 'why', case when dd.status <> 'open' then 'closed' else 'not-held' end,
            'line_id', ol.id, 'qty', ol.qty - v_h);
        end if;
      end loop;
      for nt in select (e->>'amount')::bigint as amount, e->>'number' as number from jsonb_array_elements(v_deps) e
          where e->>'number' = dd.number loop
        v_dfree := greatest(deposit_free(dd), 0);
        v_dtake := least(nt.amount, v_dfree);
        if nt.amount > v_dfree then
          v_offline := true;
          v_dover := v_dover || jsonb_build_object('deposit', dd.number, 'why', case when dd.status = 'cancelled' then 'closed' else 'overused' end,
            'amount', nt.amount, 'free', v_dfree, 'excess', nt.amount - v_dfree);
        end if;
        update deposits set used = used + v_dtake where tenant_id = p_tenant and id = dd.id returning * into dd;
      end loop;
      update deposits set status = 'collected'
        where tenant_id = p_tenant and id = dd.id and status = 'open'
          and not exists (select 1 from deposit_lines where tenant_id = p_tenant and deposit_id = dd.id and qty > qty_collected);
    end loop;
    for nt in select (e->>'amount')::bigint as amount, e->>'number' as number from jsonb_array_elements(v_deps) e
        where not exists (select 1 from deposits where tenant_id = p_tenant and number = e->>'number' and deleted_at is null) loop
      v_offline := true;
      v_dover := v_dover || jsonb_build_object('deposit', nt.number, 'why', 'not-found', 'amount', nt.amount);
    end loop;
  end if;

  -- number collision: disambiguate and flag instead of rejecting the sale
  v_number := v_base_number;
  v_try := 1;
  while exists (select 1 from receipts where tenant_id = p_tenant and number = v_number and id <> v_id) loop
    v_try := v_try + 1;
    if v_try > 10 then raise exception 'bad-payload'; end if;
    v_number := v_base_number || '-' || v_try;
    v_offline := true;
  end loop;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type,
      subtotal, discount_total, tax_total, service_charge, rounding, total,
      employee_id, device_time, needs_review)
    values (v_id, p_tenant, v_store, v_device, v_ticket, v_number, 'sale',
      v_sub, v_disc, v_tax_add + v_tax_incl, v_service, v_round, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end,
      v_review or v_offline);

  -- why it needs review: one row per reason (needs_review stays the summary,
  -- and is true exactly when at least one of these rows exists)
  if v_review then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'double-pay',
        jsonb_build_object('already_paid', v_prior, 'received', v_chunk));
  end if;
  if v_short or v_over then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, case when v_short then 'underpaid' else 'overpaid' end,
        jsonb_build_object('total', v_total, 'received', v_chunk));
  end if;
  if jsonb_array_length(v_drift) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'price-drift', jsonb_build_object('items', v_drift));
  end if;
  if jsonb_array_length(v_unapp) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'price-unapproved', jsonb_build_object('lines', v_unapp));
  end if;
  if jsonb_array_length(v_undisc) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'discount-unapproved',
        jsonb_build_object('by', p_emp, 'approved_by', nullif(p->>'approved_by', ''), 'discounts', v_undisc));
  end if;
  if jsonb_array_length(v_unmatched) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'exchange-unmatched', jsonb_build_object('credits', v_unmatched));
  end if;
  if jsonb_array_length(v_refused) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'credit-note-refused', jsonb_build_object('notes', v_refused));
  end if;
  if jsonb_array_length(v_overspent) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'credit-overspent', jsonb_build_object('notes', v_overspent));
  end if;
  if jsonb_array_length(v_dover) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'deposit-overused', jsonb_build_object('deposits', v_dover));
  end if;
  if v_number <> v_base_number then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'number-collision',
        jsonb_build_object('requested', v_base_number, 'stored', v_number));
  end if;

  insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty, list_price, price_kind, price_label)
    select p_tenant, v_id, l.id, l.name_snapshot, l.unit_price, l.qty, l.list_price, l.price_kind, l.price_label
    from ticket_lines l where l.id = any(covered);
  insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price, qty)
    select p_tenant, rl.id, m.modifier_id, m.name_snapshot, m.price, m.qty
    from receipt_lines rl join ticket_line_modifiers m
      on m.tenant_id = p_tenant and m.line_id = rl.ticket_line_id
    where rl.receipt_id = v_id and rl.tenant_id = p_tenant;
  insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, rl.id, t.tax_id, t.name_snapshot, t.rate_bp, t.type
    from receipt_lines rl join ticket_line_taxes t
      on t.tenant_id = p_tenant and t.line_id = rl.ticket_line_id
    where rl.receipt_id = v_id and rl.tenant_id = p_tenant;
  insert into receipt_discounts (tenant_id, receipt_id, discount_id, name_snapshot, amount, approved_by)
    select p_tenant, v_id, case when x.did is null then null else (x.did)::uuid end,
      x.name, x.amount, case when x.approver is null then null else (x.approver)::uuid end
    from jsonb_to_recordset(rdiscs) as x(name text, amount bigint, did text, approver text);
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;
  update ticket_lines set paid = true where id = any(covered) and tenant_id = p_tenant;
  -- stock: an item that is counted (its own flag, or its category's) goes down
  -- by what was sold, through the one stock engine (0067). Not on the review
  -- path: those lines were sold before. One movement per product, in a fixed
  -- order.
  if not v_review then
    for v_sm in
      -- what each line takes off the shelf (0112): its parts when it is made
      -- of others, else itself; added up per product, so a Chicken BBQ sold
      -- alone and one inside a Mix grill on the same receipt are one movement
      select x.item_id, x.variant_id, sum(x.qty)::int as qty, string_agg(distinct x.via, ', ') as via
        -- less what a deposit already took off the shelf (0113)
        from ticket_lines l cross join lateral stock_parts(p_tenant, l.item_id, l.variant_id, l.qty - coalesce((v_held->>(l.id::text))::int, 0)) x
       where l.id = any(covered)
       group by x.item_id, x.variant_id
       order by x.item_id, x.variant_id
    loop
      perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, -v_sm.qty, 'sale', null, 'receipt', v_id, p_emp,
        case when v_sm.via is not null then left('Sold in ' || v_sm.via, 200) end);
    end loop;
  end if;
  update pos_devices set last_receipt_seq = greatest(last_receipt_seq, v_seq)
    where id = v_device and tenant_id = p_tenant;
  -- a flagged sale still closes its ticket when fully paid (flags review, not block)
  if not exists (select 1 from ticket_lines
      where ticket_id = v_ticket and tenant_id = p_tenant
        and voided_at is null and deleted_at is null and not paid) then
    update tickets set status = 'paid' where id = v_ticket;
  end if;

  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'total', v_total,
    'needs_review', v_review or v_offline);
end $function$
;


-- a line can name the deposit line it hands over
CREATE OR REPLACE FUNCTION public.push_ticket_add_line(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_ticket uuid; v_item uuid; v_variant uuid; v_qty int;
  v_price bigint; v_name text; m jsonb; v_mod uuid; v_grp uuid;
  v_cat record; v_var record; v_tstore uuid;
  v_mrec record; v_mprice bigint; v_mqty int;
  v_list bigint; v_kind text; v_label text; v_by uuid; v_dl uuid;
begin
  v_id := (p->>'id')::uuid;
  v_ticket := (p->>'ticket_id')::uuid;
  v_item := (p->>'item_id')::uuid;
  v_qty := coalesce((p->>'qty')::int, 0);
  if v_id is null or v_ticket is null or v_item is null or v_qty <= 0 then raise exception 'bad-payload'; end if;
  select store_id into v_tstore from tickets where id = v_ticket and status = 'open';
  if not found then raise exception 'ticket-closed'; end if;
  -- the row must exist for snapshots, but an offline sale is never rejected
  -- for price/availability drift: payload wins, then store override, then
  -- variant, then item. Drift is flagged at receipt time, not here.
  select price, name into v_cat from items where id = v_item;
  if not found then raise exception 'unknown-item'; end if;
  v_price := (p->>'unit_price')::bigint;
  v_name := nullif(p->>'name_snapshot','');
  if p->>'variant_id' is not null then
    v_variant := (p->>'variant_id')::uuid;
    select price, name into v_var from item_variants
      where id = v_variant and item_id = v_item and deleted_at is null;
    if not found then raise exception 'unknown-variant'; end if;
    v_name := coalesce(v_name, v_var.name);
    if v_price is null then v_price := v_var.price; end if;
  end if;
  if v_price is null then
    select price into v_price from store_item_overrides
      where tenant_id = p_tenant and store_id = v_tstore and item_id = v_item
        and deleted_at is null and price is not null;
  end if;
  if v_price is null then v_price := v_cat.price; end if;
  if v_name is null then v_name := v_cat.name; end if;
  if v_price < 0 then raise exception 'bad-payload'; end if;
  -- A line charged something other than its listed price says so: what it was
  -- listed at, whether that is a discount or a changed price, in what words,
  -- and who allowed it (whoever approved, else whoever rang it up). Whether
  -- they were allowed to is asked when the receipt arrives (0077).
  v_kind := nullif(p->>'price_kind', '');
  if v_kind is not null then
    if v_kind not in ('discount', 'override') then raise exception 'bad-payload'; end if;
    begin
      v_list := (p->>'list_price')::bigint;
      v_by := coalesce(nullif(p->>'approved_by', '')::uuid, p_emp);
    exception when others then
      raise exception 'bad-payload';
    end;
    if v_list is null or v_list < 0 then raise exception 'bad-payload'; end if;
    if v_kind = 'discount' and v_price > v_list then raise exception 'bad-payload'; end if;
    v_label := nullif(left(p->>'price_label', 60), '');
  end if;
  if p->>'seat' is not null and (p->>'seat')::int not between 1 and 99 then raise exception 'bad-payload'; end if;
  -- the deposit line this line hands over (0113); judged when it is paid
  begin v_dl := nullif(p->>'deposit_line_id', '')::uuid; exception when others then raise exception 'bad-payload'; end;
  insert into ticket_lines (id, tenant_id, ticket_id, item_id, variant_id, name_snapshot, unit_price, qty, note, course, seat,
      list_price, price_kind, price_label, price_by, deposit_line_id)
    values (v_id, p_tenant, v_ticket, v_item, v_variant, v_name, v_price, v_qty,
      nullif(p->>'note',''),
      case when p->>'course' is null then null else (p->>'course')::int end,
      case when p->>'seat' is null then null else (p->>'seat')::int end,
      v_list, v_kind, v_label, v_by, v_dl);
  insert into ticket_line_taxes (tenant_id, line_id, tax_id, name_snapshot, rate_bp, type)
    select p_tenant, v_id, t.id, t.name, t.rate_bp, t.type
    from item_taxes it join taxes t on t.tenant_id = p_tenant and t.id = it.tax_id
    where it.tenant_id = p_tenant and it.item_id = v_item and it.deleted_at is null;
  if jsonb_typeof(p->'modifiers') = 'array' then
    -- till-priced modifiers: [{modifier_id, price, name, qty}]. What the till charged
    -- is stored. The modifier only has to exist: one that was re-priced or
    -- deleted while the till was offline is flagged at receipt time, never
    -- rejected here (the sale already happened).
    for m in select value from jsonb_array_elements(p->'modifiers') as value loop
      v_mod := (m->>'modifier_id')::uuid;
      select mo.name, mo.price into v_mrec from modifiers mo where mo.id = v_mod;
      if not found then raise exception 'bad-modifier'; end if;
      -- how many of it (0105). A till built before this sends none, which is
      -- one. price is what they add to the line in all, as the till charged it.
      v_mqty := coalesce((m->>'qty')::int, 1);
      if v_mqty not between 1 and 99 then raise exception 'bad-payload'; end if;
      v_mprice := coalesce((m->>'price')::bigint, v_mrec.price * v_mqty);
      if v_mprice < 0 then raise exception 'bad-payload'; end if;
      insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price, qty)
        values (p_tenant, v_id, v_mod, coalesce(nullif(m->>'name',''), v_mrec.name), v_mprice, v_mqty);
    end loop;
  else
    for m in select value from jsonb_array_elements(coalesce(p->'modifier_ids', '[]'::jsonb)) as value loop
      v_mod := (m->>0)::uuid;
      select group_id into v_grp from modifiers where id = v_mod and deleted_at is null;
      if not found then raise exception 'bad-modifier'; end if;
      if not exists (select 1 from item_modifier_groups
          where tenant_id = p_tenant and item_id = v_item and group_id = v_grp and deleted_at is null) then
        raise exception 'bad-modifier';
      end if;
      insert into ticket_line_modifiers (tenant_id, line_id, modifier_id, name_snapshot, price)
        select p_tenant, v_id, mo.id, mo.name, mo.price from modifiers mo where mo.id = v_mod;
    end loop;
  end if;
  return jsonb_build_object('line_id', v_id);
end $function$
;


-- the deposit settings
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
  -- minutes before an order for later is due that the tills ring (0111); 0 is off
  if p ? 'dueReminderMinutes' then
    begin v_int := (p->>'dueReminderMinutes')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 120 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('dueReminderMinutes', v_int);
  end if;
  -- a shop's deposits (0113): each key taken when sent, refused out of range
  if p ? 'deposits' then
    if p->>'deposits' not in ('on', 'off') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('deposits', p->>'deposits');
  end if;
  if p ? 'depositCancel' then
    if p->>'depositCancel' not in ('refund', 'credit', 'keep') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositCancel', p->>'depositCancel');
  end if;
  if p ? 'depositOverdue' then
    if p->>'depositOverdue' not in ('show', 'cancel') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositOverdue', p->>'depositOverdue');
  end if;
  if p ? 'depositCustomer' then
    if p->>'depositCustomer' not in ('required', 'optional') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositCustomer', p->>'depositCustomer');
  end if;
  if p ? 'depositDays' then
    begin v_int := (p->>'depositDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositDays', v_int);
  end if;
  if p ? 'depositGrace' then
    begin v_int := (p->>'depositGrace')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('depositGrace', v_int);
  end if;
  if v_patch <> '{}'::jsonb then
    insert into pos_settings (tenant_id, data) values (p_tenant, v_patch)
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('saved', (select count(*) from jsonb_object_keys(v_patch)));
end $function$
;


-- what a deposit covered is not corrected either
CREATE OR REPLACE FUNCTION public.push_payment_correct(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_receipt uuid; v_from uuid; v_to uuid; v_at timestamptz; v_n int := 0; rp record;
begin
  v_id := (p->>'id')::uuid;
  v_receipt := (p->>'receipt_id')::uuid;
  v_from := (p->>'from_payment_type_id')::uuid;
  v_to := (p->>'to_payment_type_id')::uuid;
  if v_id is null or v_receipt is null or v_from is null or v_to is null or v_from = v_to then
    raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'payment.correct') then raise exception 'forbidden'; end if;
  if not exists (select 1 from receipts where id = v_receipt and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-receipt'; end if;
  if not exists (select 1 from payment_types where id = v_to and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-payment'; end if;
  -- what an exchange settled with returned goods was never money (0079), nor
  -- is what a credit note covered (0109): neither is corrected into cash, nor cash into them
  if exists (select 1 from payment_types where id in (v_from, v_to) and tenant_id = p_tenant and kind in ('exchange', 'credit_note', 'deposit')) then
    raise exception 'bad-payment'; end if;
  v_at := coalesce((p->>'corrected_at')::timestamptz, now());
  -- every payment of this receipt that is of the old type, as it stands now
  for rp in select e.id, e.amount from receipt_payments_effective e
      where e.tenant_id = p_tenant and e.receipt_id = v_receipt and e.payment_type_id = v_from loop
    insert into payment_corrections (id, tenant_id, receipt_id, receipt_payment_id,
        old_payment_type_id, new_payment_type_id, amount, employee_id, corrected_at)
      values (case when v_n = 0 then v_id else gen_random_uuid() end, p_tenant, v_receipt, rp.id,
        v_from, v_to, rp.amount, p_emp, v_at);
    v_n := v_n + 1;
  end loop;
  if v_n = 0 then raise exception 'bad-payment'; end if;
  return jsonb_build_object('receipt_id', v_receipt, 'corrected', v_n);
end $function$
;


-- the pull: deposits past their date first, then the shop's deposits
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
  -- deposits past their date, for a shop that cancels them (0113): done
  -- before the pull, so this pull already carries what it changed
  perform deposits_expire(current_tenant_id());
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

    -- The shop's deposits (0113): every store's (one taken here can be
    -- collected at another till), the open ones and ones that changed in the
    -- last 30 days, each with its lines and its payments inside the row as
    -- they stand now: the row changes whenever either does.
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.*,
                   (select coalesce(jsonb_agg(to_jsonb(l) order by l.sort), '[]'::jsonb)
                      from deposit_lines l where l.tenant_id = x.tenant_id and l.deposit_id = x.id) as lines,
                   (select coalesce(jsonb_agg(to_jsonb(q) order by q.device_time, q.id), '[]'::jsonb)
                      from deposit_payments q where q.tenant_id = x.tenant_id and q.deposit_id = x.id) as payments
              from deposits x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
               and (x.status = 'open' or x.owed > 0 or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('deposits', r);
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


-- sync_push knows the four operations and their codes
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
    'bad-options','too-many-variants','has-stock',
    -- an item made of others, from a till (0112)
    'bad-part','part-has-parts','is-a-part',
    -- a shop's deposits (0113)
    'not-entitled','bad-deposit'];
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
          -- a shop's deposits (0113)
          when 'deposit.create' then v_data := push_deposit_create(tenant, v_emp, v_payload);
          when 'deposit.pay' then v_data := push_deposit_pay(tenant, v_emp, v_payload);
          when 'deposit.cancel' then v_data := push_deposit_cancel(tenant, v_emp, v_payload);
          when 'deposit.give_back' then v_data := push_deposit_give_back(tenant, v_emp, v_payload);
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


-- a shop has its deposit type
CREATE OR REPLACE FUNCTION platform.set_tenant_business_type(p_admin uuid, p_tenant uuid, p_type text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
  -- a shop's exchanges go through a payment type of their own (0079), and its
  -- credit notes through a second (0109); a restaurant has neither
  if v_type = 'retail' then
    perform ensure_exchange_type(p_tenant);
    perform ensure_credit_note_type(p_tenant);
    perform ensure_deposit_type(p_tenant);
  else
    update payment_types set deleted_at = now() where tenant_id = p_tenant and kind in ('exchange', 'credit_note', 'deposit') and deleted_at is null;
  end if;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.business_type', p_tenant, jsonb_build_object('from', v_old, 'to', v_type));
end $function$
;


-- what deposits held is a test's too
CREATE OR REPLACE FUNCTION platform.test_sales_on_stock(p_tenant uuid)
 RETURNS TABLE(store_id uuid, item_id uuid, variant_id uuid, qty bigint)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with counted as (
    select x.store_id, x.item_id, x.variant_id, max(x.at) as at from (
      select k.store_id, l.item_id, l.variant_id, l.counted_at as at
        from stock_count_lines l
        join stock_counts k on k.tenant_id = l.tenant_id and k.id = l.count_id
       where l.tenant_id = p_tenant and k.status = 'completed' and not l.left_out
         and l.counted is not null and l.counted_at is not null
      union all
      select m.store_id, m.item_id, m.variant_id, m.created_at
        from stock_movements m
       where m.tenant_id = p_tenant and m.reason = 'count' and m.ref_id is null and m.deleted_at is null) x
     group by 1, 2, 3)
  select m.store_id, m.item_id, m.variant_id, sum(m.qty)::bigint
    from stock_movements m
    left join receipts r on r.tenant_id = m.tenant_id and r.id = m.receipt_id
    left join counted c on c.store_id is not distinct from m.store_id and c.item_id = m.item_id
         and c.variant_id is not distinct from m.variant_id
   where m.tenant_id = p_tenant and m.reason in ('sale', 'refund', 'deposit', 'deposit_release') and m.deleted_at is null
     and (c.at is null or coalesce(r.device_time, m.created_at) > c.at)
   group by 1, 2, 3
  having sum(m.qty) <> 0;
$function$
;


-- clearing a test client clears its deposits and credit notes (0109 left the notes out)
CREATE OR REPLACE FUNCTION platform.clear_test_activity(p_admin uuid, p_tenant uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  t record;
  v_receipts bigint; v_orders bigint; v_tills bigint; v_codes bigint;
  tbl text;
begin
  perform platform.require_admin(p_admin);
  select id, lower(btrim(coalesce(plan, ''))) = 'offline' as offline into t
    from tenants where id = p_tenant and deleted_at is null;
  if not found then raise exception 'unknown-tenant'; end if;
  if not platform.is_setting_up(p_tenant) then raise exception 'client-live'; end if;
  -- a client that runs on its tablet has nothing of its trying here: its
  -- sales are on the tablet, and its tills are removed one by one
  if t.offline then raise exception 'client-offline'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  -- a till that is sending at this moment makes this wait; not for long
  perform set_config('lock_timeout', '8s', true);

  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_orders from tickets where tenant_id = p_tenant;
  select count(*) into v_tills from pos_devices where tenant_id = p_tenant;
  -- a code made for a new tablet that nobody has used yet stays: it may be in
  -- someone's hand for the day the tablets are set up again
  select count(*) into v_codes from tablet_codes
   where tenant_id = p_tenant and not (device_id is null and used_at is null and ended_at is null);

  -- the shelves first: the level, then the item's total, in the order the
  -- stock engine locks them (0067)
  update stock_levels s set qty = s.qty - b.qty
    from platform.test_sales_on_stock(p_tenant) b
   where s.tenant_id = p_tenant and s.store_id = b.store_id and s.item_id = b.item_id
     and s.variant_id is not distinct from b.variant_id;
  update items i set stock_qty = coalesce(i.stock_qty, 0) - b.qty
    from (select x.item_id, sum(x.qty) as qty from platform.test_sales_on_stock(p_tenant) x group by 1) b
   where i.tenant_id = p_tenant and i.id = b.item_id;
  delete from stock_movements where tenant_id = p_tenant and reason in ('sale', 'refund', 'deposit', 'deposit_release');

  insert into platform.removed_tills (device_id, tenant_id)
    select id, p_tenant from pos_devices where tenant_id = p_tenant
  on conflict do nothing;

  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach tbl in array array[
    'credit_notes','deposit_payments','deposit_lines','deposits',
    'bookings','approvals','drawer_counts','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied',
    'till_requests','device_activity','device_keys','pos_devices']
  loop
    execute format('delete from %I where tenant_id = $1', tbl) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  delete from tablet_codes
   where tenant_id = p_tenant and not (device_id is null and used_at is null and ended_at is null);

  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.clear_test', p_tenant,
      jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'tills', v_tills, 'codes', v_codes));
  return jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'tills', v_tills, 'codes', v_codes);
end $function$
;


-- a till that took a deposit or issued a note is not bare
CREATE OR REPLACE FUNCTION platform.till_is_bare(p_tenant uuid, p_device uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select not (
       exists (select 1 from receipts where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from shifts where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from cash_movements where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from day_closes where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from drawer_counts where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from timeclock_punches where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from deposits where tenant_id = p_tenant and device_id = p_device)
    or exists (select 1 from credit_notes where tenant_id = p_tenant and device_id = p_device));
$function$
;
