-- 0159_invoices.sql — invoices for business customers, from draft to paid
-- (docs/superpowers/specs/2026-11-12-invoices-design.md).
--
--   - invoice_setup: one per business: the bank details, terms, language and footer its invoices print.
--   - invoice_series: one per branch: its prefix and its next number. A shop coming from another system
--     sets where its numbers start, before its first invoice and only upwards (invoice_series_set).
--   - invoice_customers: one per customer: what an invoice asks of a business customer (address, BRN,
--     VAT number, buyer type, language). Kept apart from customers, which the tills pull whole.
--   - invoices, invoice_lines: a draft has no number. invoice_issue numbers it from its branch's series
--     inside its own transaction (the series row stays locked until it commits, so a failed issue leaves
--     no gap and two people are never given the same number), works out its figures again, and takes its
--     products off the branch's shelf as a sale does (stock_parts, 0112; one movement per product,
--     reason sale, document invoice). From then on the database refuses any change to its lines or its
--     figures (invoice_locked, invoice_lines_draft_only): only what has been paid on it moves.
--   - invoice_payments: money received against one invoice, never more than it still owes. A payment
--     typed in error is cancelled (who, when), not deleted; the tenant role cannot delete one.
--   - invoice_figures: the till's own rules (0049 push_receipt_create): line_amount, a percent discount
--     (sub*pct+50)/100 or an amount up to the subtotal, spread over the lines as disc*base/sub, added tax
--     (x*rate+5000)/10000, included tax (x*rate+div/2)/div. No service charge, no rounding.
--   - A client on Premium MRA (tenants.mra not off) makes drafts but cannot issue: the owner chose
--     (2026-11-12) that its invoices go to the MRA through one of its tills, which is not built yet.
--   - Nothing here is pulled by a till, so the tables have no server_seq and no trg_touch (touch_row would
--     take the business's write lock at every save of a draft); updated_at is kept by invoice_touch.
-- Source: purge_transactions, platform.clear_test_activity and platform.go_live_clear are their live
-- definitions (pg_get_functiondef on dev, 2026-11-12) with the invoice tables added to what they delete,
-- and the series started again. Go live and Clear test activity already put an invoice's stock back:
-- platform.test_sales_on_stock adds up every movement of reason sale. Never edit after merge.

-- ---- 1. tables ----
create or replace function invoice_touch() returns trigger
language plpgsql as $fn$
begin
  new.updated_at := now();
  return new;
end $fn$;

create table if not exists invoice_setup (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  bank_name text,
  account_name text,
  account_no text,
  swift text,
  terms text not null default 'receipt' check (terms ~ '^(receipt|eom|[0-9]{1,3})$'),
  lang text not null default 'en' check (lang in ('en', 'fr')),
  footer text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id)
);

create table if not exists invoice_series (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  prefix text not null check (prefix ~ '^[A-Za-z0-9/._-]{0,16}$'),
  start_no integer not null default 1 check (start_no >= 1),
  next_no integer not null default 1 check (next_no >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, store_id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade
);

create table if not exists invoice_customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  customer_id uuid not null,
  buyer_type text not null default 'B2C' check (buyer_type in ('B2C', 'B2B', 'B2G')),
  address text,
  brn text,
  vat_no text,
  lang text check (lang in ('en', 'fr')),
  email_cc text,
  contact text,
  deliver_to text,
  terms text check (terms ~ '^(receipt|eom|[0-9]{1,3})$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, customer_id),
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete cascade
);

create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  customer_id uuid,
  status text not null default 'draft' check (status in ('draft', 'issued')),
  number text,
  seq integer,
  -- the buyer as the invoice prints them
  buyer_type text not null default 'B2C' check (buyer_type in ('B2C', 'B2B', 'B2G')),
  buyer_name text not null default '',
  buyer_email text,
  buyer_cc text,
  buyer_phone text,
  buyer_address text,
  buyer_contact text,
  buyer_brn text,
  buyer_vat text,
  deliver_to text,
  -- dates and terms
  issued_on date not null default current_date,
  terms text not null default 'receipt' check (terms ~ '^(receipt|eom|date|[0-9]{1,3})$'),
  due_on date,
  cust_ref text,
  our_ref text,
  rep_id uuid,
  lang text not null default 'en' check (lang in ('en', 'fr')),
  show_excl boolean not null default false,
  note text,
  -- the discount on the whole invoice: an amount in cents, or a percent 0..100 (a receipt's rule)
  disc_type text not null default 'amount' check (disc_type in ('amount', 'percent')),
  disc_value bigint not null default 0 check (disc_value >= 0),
  -- the figures (invoice_figures), kept at every save and again at issue
  subtotal bigint not null default 0,
  discount_total bigint not null default 0,
  tax_added bigint not null default 0,
  tax_total bigint not null default 0,
  total bigint not null default 0 check (total >= 0),
  paid bigint not null default 0 check (paid >= 0),
  rev integer not null default 1,
  created_by uuid,
  issued_by uuid,
  issued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (tenant_id, id),
  unique (tenant_id, number),
  check ((status = 'draft') = (number is null)),
  check (status = 'draft' or deleted_at is null),
  check (paid <= total),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete cascade,
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete set null (customer_id)
);
create index if not exists idx_invoices_list on invoices (tenant_id, status, issued_on desc) where deleted_at is null;
create index if not exists idx_invoices_customer on invoices (tenant_id, customer_id) where deleted_at is null;

create table if not exists invoice_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  invoice_id uuid not null,
  pos integer not null,
  kind text not null default 'line' check (kind in ('line', 'heading', 'note')),
  item_id uuid,
  variant_id uuid,
  name text not null default '',
  detail text,
  sku text,
  qty integer not null default 1000 check (qty >= 0 and qty <= 1000000000),
  unit_price bigint not null default 0 check (unit_price >= 0),
  list_price bigint check (list_price >= 0),
  -- the line's taxes as they were when it was saved: [{tax_id, name, rate_bp, type}]
  taxes jsonb not null default '[]'::jsonb,
  -- what the product cost the branch when the line was saved, cents per unit (for the margin)
  unit_cost numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete cascade
);
create index if not exists idx_invoice_lines_invoice on invoice_lines (tenant_id, invoice_id, pos);
create index if not exists idx_invoice_lines_item on invoice_lines (tenant_id, item_id) where item_id is not null;

create table if not exists invoice_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  invoice_id uuid not null,
  paid_on date not null,
  amount bigint not null check (amount > 0),
  method text not null check (method in ('bank', 'cheque', 'cash', 'card', 'mobile', 'other')),
  reference text,
  employee_id uuid,
  cancelled_at timestamptz,
  cancelled_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices (tenant_id, id) on delete cascade
);
create index if not exists idx_invoice_payments_invoice on invoice_payments (tenant_id, invoice_id);
create index if not exists idx_invoice_payments_day on invoice_payments (tenant_id, paid_on);

do $$
declare t text;
begin
  foreach t in array array['invoice_setup', 'invoice_series', 'invoice_customers', 'invoices', 'invoice_lines', 'invoice_payments'] loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('create policy tenant_isolation on %I using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id())', t);
    execute format('drop trigger if exists trg_invoice_touch on %I', t);
    execute format('create trigger trg_invoice_touch before update on %I for each row execute function invoice_touch()', t);
  end loop;
end $$;
-- a payment is a record: cancelled, never deleted (the purge runs as the owner)
revoke delete on invoice_payments from app_user;

-- ---- 2. an issued invoice is never changed ----
-- What may still move on an issued invoice: what has been paid, and when it was touched. The purge
-- (purge_transactions, Go live, removing a client) names the business in app.purge_tenant and may delete.
create or replace function invoice_locked() returns trigger
language plpgsql as $fn$
begin
  -- the purge, and removing a client (its customers' rows go first: customer_id is set null on the way)
  if coalesce(current_setting('app.purge_tenant', true), '') = old.tenant_id::text then
    return case when tg_op = 'DELETE' then old else new end;
  end if;
  if tg_op = 'DELETE' then
    if old.status = 'issued' then raise exception 'invoice-issued'; end if;
    return old;
  end if;
  if old.status = 'issued'
     and (to_jsonb(new) - array['paid', 'updated_at']) is distinct from (to_jsonb(old) - array['paid', 'updated_at']) then
    raise exception 'invoice-issued';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_invoice_locked on invoices;
create trigger trg_invoice_locked before update or delete on invoices
  for each row execute function invoice_locked();

create or replace function invoice_lines_draft_only() returns trigger
language plpgsql as $fn$
declare v_inv uuid := coalesce(new.invoice_id, old.invoice_id); v_tenant uuid := coalesce(new.tenant_id, old.tenant_id);
begin
  if coalesce(current_setting('app.purge_tenant', true), '') = v_tenant::text then return coalesce(new, old); end if;
  if exists (select 1 from invoices where tenant_id = v_tenant and id = v_inv and status = 'issued') then
    raise exception 'invoice-issued';
  end if;
  if tg_op = 'UPDATE' and new.invoice_id <> old.invoice_id then raise exception 'invoice-issued'; end if;
  return coalesce(new, old);
end $fn$;
drop trigger if exists trg_invoice_lines_draft on invoice_lines;
create trigger trg_invoice_lines_draft before insert or update or delete on invoice_lines
  for each row execute function invoice_lines_draft_only();

-- a payment keeps its figures; only its cancelling is written, once
create or replace function invoice_payment_kept() returns trigger
language plpgsql as $fn$
begin
  if (to_jsonb(new) - array['cancelled_at', 'cancelled_by', 'updated_at']) is distinct from (to_jsonb(old) - array['cancelled_at', 'cancelled_by', 'updated_at'])
     or old.cancelled_at is not null then
    raise exception 'invoice-payment-kept';
  end if;
  return new;
end $fn$;
drop trigger if exists trg_invoice_payment_kept on invoice_payments;
create trigger trg_invoice_payment_kept before update on invoice_payments
  for each row execute function invoice_payment_kept();

-- ---- 3. the figures: the till's own rules ----
create or replace function invoice_figures(p_tenant uuid, p_invoice uuid)
returns table (subtotal bigint, discount_total bigint, tax_added bigint, tax_total bigint, total bigint)
language plpgsql stable set search_path = public as $fn$
declare
  v_type text; v_val bigint;
  v_sub bigint := 0; v_disc bigint := 0; v_add bigint := 0; v_incl bigint := 0;
  r record; t record; v_pl bigint; v_div bigint;
begin
  select i.disc_type, i.disc_value into v_type, v_val from invoices i where i.tenant_id = p_tenant and i.id = p_invoice;
  select coalesce(sum(line_amount(l.unit_price, l.qty)), 0) into v_sub
    from invoice_lines l where l.tenant_id = p_tenant and l.invoice_id = p_invoice and l.kind = 'line';
  -- a percent as a receipt's (0..100, rounded), an amount never more than the lines
  v_disc := case when v_type = 'percent' then (v_sub * least(v_val, 100) + 50) / 100 else least(v_val, v_sub) end;
  if v_disc < 0 then v_disc := 0; end if;
  if v_disc > v_sub then v_disc := v_sub; end if;
  for r in select l.id, line_amount(l.unit_price, l.qty)::bigint as base, l.taxes
             from invoice_lines l where l.tenant_id = p_tenant and l.invoice_id = p_invoice and l.kind = 'line' loop
    v_pl := case when v_sub > 0 then v_disc * r.base / v_sub else 0 end;
    for t in select (x->>'rate_bp')::bigint as rate_bp, x->>'type' as type from jsonb_array_elements(r.taxes) x loop
      if t.type = 'added' then
        v_add := v_add + ((r.base - v_pl) * t.rate_bp + 5000) / 10000;
      else
        v_div := 10000 + t.rate_bp;
        v_incl := v_incl + ((r.base - v_pl) * t.rate_bp + v_div / 2) / v_div;
      end if;
    end loop;
  end loop;
  return query select v_sub, v_disc, v_add, v_add + v_incl, v_sub - v_disc + v_add;
end $fn$;

-- when a bill on these terms falls due
create or replace function invoice_due(p_issued date, p_terms text, p_due date) returns date
language sql immutable set search_path = public as $fn$
  select case
    when p_terms = 'receipt' then p_issued
    when p_terms = 'eom' then (date_trunc('month', p_issued) + interval '1 month - 1 day')::date
    when p_terms = 'date' then coalesce(p_due, p_issued)
    else p_issued + p_terms::int end
$fn$;

-- the store's own day
create or replace function invoice_today(p_tenant uuid, p_store uuid) returns date
language sql stable set search_path = public as $fn$
  select coalesce((select (now() at time zone s.timezone)::date from stores s where s.tenant_id = p_tenant and s.id = p_store), current_date)
$fn$;

-- ---- 4. numbers ----
-- A branch's series as it starts: INV- with one branch, INV-<branch code>- with several.
create or replace function invoice_series_of(p_tenant uuid, p_store uuid) returns invoice_series
language plpgsql set search_path = public as $fn$
declare v invoice_series; v_code text; v_many boolean;
begin
  select * into v from invoice_series where tenant_id = p_tenant and store_id = p_store;
  if found then return v; end if;
  select code into v_code from stores where tenant_id = p_tenant and id = p_store;
  if not found then raise exception 'invoice-branch'; end if;
  v_many := (select count(*) from stores where tenant_id = p_tenant and deleted_at is null) > 1;
  insert into invoice_series (tenant_id, store_id, prefix)
    values (p_tenant, p_store, case when v_many then left('INV-' || regexp_replace(upper(v_code), '[^A-Z0-9]', '', 'g') || '-', 16) else 'INV-' end)
    on conflict (tenant_id, store_id) do nothing;
  select * into v from invoice_series where tenant_id = p_tenant and store_id = p_store;
  return v;
end $fn$;

-- The prefix and where the numbers start: the prefix may change while the branch has issued nothing,
-- and the start only then, upwards. A prefix another branch uses is refused (numbers are the business's).
create or replace function invoice_series_set(p_tenant uuid, p_store uuid, p_prefix text, p_start integer) returns jsonb
language plpgsql set search_path = public as $fn$
declare v invoice_series; v_issued boolean;
begin
  v := invoice_series_of(p_tenant, p_store);
  select * into v from invoice_series where id = v.id for update;
  v_issued := exists (select 1 from invoices where tenant_id = p_tenant and store_id = p_store and status = 'issued');
  if p_prefix is null or p_prefix !~ '^[A-Za-z0-9/._-]{0,16}$' then raise exception 'invoice-prefix'; end if;
  if v_issued and (p_prefix <> v.prefix or p_start <> v.start_no) then raise exception 'invoice-series-started'; end if;
  if p_start is null or p_start < 1 or p_start > 99999999 then raise exception 'invoice-start'; end if;
  if exists (select 1 from invoice_series s where s.tenant_id = p_tenant and s.store_id <> p_store and upper(s.prefix) = upper(p_prefix)) then
    raise exception 'invoice-prefix-used';
  end if;
  update invoice_series set prefix = p_prefix, start_no = p_start, next_no = p_start where id = v.id and not v_issued;
  return jsonb_build_object('prefix', p_prefix, 'start', p_start);
end $fn$;

-- ---- 5. a draft ----
-- p_head: the fields of the invoice as the editor sends them; p_lines: its lines in order. A draft's
-- lines are written again whole. Taxes come from the business's own taxes (tax_ids), not from the page.
-- p_rev: the version the page was showing; another save since then is refused (two windows on one draft).
create or replace function invoice_save(p_tenant uuid, p_emp uuid, p_invoice uuid, p_store uuid, p_rev integer, p_head jsonb, p_lines jsonb)
returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v invoices; v_id uuid := p_invoice; f record; x jsonb; v_pos int := 0; v_taxes jsonb; v_cust uuid;
  v_kind text; v_item uuid; v_var uuid; v_terms text; v_cost numeric;
begin
  if jsonb_typeof(coalesce(p_lines, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) > 500 then
    raise exception 'invoice-lines';
  end if;
  if v_id is null then
    if not exists (select 1 from stores where tenant_id = p_tenant and id = p_store and deleted_at is null) then
      raise exception 'invoice-branch';
    end if;
    insert into invoices (tenant_id, store_id, created_by, issued_on, lang, terms)
      values (p_tenant, p_store, p_emp, invoice_today(p_tenant, p_store),
              coalesce((select s.lang from invoice_setup s where s.tenant_id = p_tenant), 'en'),
              coalesce((select s.terms from invoice_setup s where s.tenant_id = p_tenant), 'receipt'))
      returning id into v_id;
    p_rev := 1;
  end if;
  select * into v from invoices where tenant_id = p_tenant and id = v_id and deleted_at is null for update;
  if not found then raise exception 'invoice-gone'; end if;
  if v.status <> 'draft' then raise exception 'invoice-issued'; end if;
  if p_rev is not null and p_rev <> v.rev then raise exception 'invoice-changed'; end if;
  if p_head is null then p_head := '{}'::jsonb; end if;

  v_cust := case when coalesce(p_head->>'customer_id', '') = '' then null else (p_head->>'customer_id')::uuid end;
  if v_cust is not null and not exists (select 1 from customers where tenant_id = p_tenant and id = v_cust) then
    raise exception 'invoice-customer';
  end if;
  v_terms := coalesce(nullif(p_head->>'terms', ''), v.terms);
  if v_terms !~ '^(receipt|eom|date|[0-9]{1,3})$' then raise exception 'invoice-terms'; end if;

  update invoices set
    store_id = case when p_head ? 'store_id' and exists (select 1 from stores s where s.tenant_id = p_tenant and s.id = (p_head->>'store_id')::uuid and s.deleted_at is null)
                    then (p_head->>'store_id')::uuid else store_id end,
    customer_id = v_cust,
    buyer_type = case when p_head->>'buyer_type' in ('B2C', 'B2B', 'B2G') then p_head->>'buyer_type' else buyer_type end,
    buyer_name = left(btrim(coalesce(p_head->>'buyer_name', '')), 200),
    buyer_email = nullif(left(btrim(coalesce(p_head->>'buyer_email', '')), 200), ''),
    buyer_cc = nullif(left(btrim(coalesce(p_head->>'buyer_cc', '')), 200), ''),
    buyer_phone = nullif(left(btrim(coalesce(p_head->>'buyer_phone', '')), 60), ''),
    buyer_address = nullif(left(btrim(coalesce(p_head->>'buyer_address', '')), 500), ''),
    buyer_contact = nullif(left(btrim(coalesce(p_head->>'buyer_contact', '')), 200), ''),
    buyer_brn = nullif(left(btrim(coalesce(p_head->>'buyer_brn', '')), 40), ''),
    buyer_vat = nullif(left(btrim(coalesce(p_head->>'buyer_vat', '')), 40), ''),
    deliver_to = nullif(left(btrim(coalesce(p_head->>'deliver_to', '')), 500), ''),
    issued_on = case when coalesce(p_head->>'issued_on', '') ~ '^\d{4}-\d{2}-\d{2}$' then (p_head->>'issued_on')::date else issued_on end,
    terms = v_terms,
    due_on = case when v_terms = 'date' and coalesce(p_head->>'due_on', '') ~ '^\d{4}-\d{2}-\d{2}$' then (p_head->>'due_on')::date else null end,
    cust_ref = nullif(left(btrim(coalesce(p_head->>'cust_ref', '')), 80), ''),
    our_ref = nullif(left(btrim(coalesce(p_head->>'our_ref', '')), 80), ''),
    rep_id = case when coalesce(p_head->>'rep_id', '') = '' then null
                  when exists (select 1 from employees e where e.tenant_id = p_tenant and e.id = (p_head->>'rep_id')::uuid) then (p_head->>'rep_id')::uuid
                  else rep_id end,
    lang = case when p_head->>'lang' in ('en', 'fr') then p_head->>'lang' else lang end,
    show_excl = coalesce((p_head->>'show_excl')::boolean, show_excl),
    note = nullif(left(coalesce(p_head->>'note', ''), 2000), ''),
    disc_type = case when p_head->>'disc_type' in ('amount', 'percent') then p_head->>'disc_type' else disc_type end,
    disc_value = greatest(0, least(coalesce((p_head->>'disc_value')::bigint, disc_value), 100000000000)),
    rev = rev + 1
  where id = v_id;

  delete from invoice_lines where tenant_id = p_tenant and invoice_id = v_id;
  for x in select value from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) loop
    v_pos := v_pos + 1;
    v_kind := case when x->>'kind' in ('heading', 'note') then x->>'kind' else 'line' end;
    v_item := case when v_kind = 'line' and coalesce(x->>'item_id', '') <> '' then (x->>'item_id')::uuid end;
    v_var := case when v_item is not null and coalesce(x->>'variant_id', '') <> '' then (x->>'variant_id')::uuid end;
    if v_item is not null and not exists (select 1 from items where tenant_id = p_tenant and id = v_item) then v_item := null; v_var := null; end if;
    if v_var is not null and not exists (select 1 from item_variants where tenant_id = p_tenant and id = v_var and item_id = v_item) then v_var := null; end if;
    -- the taxes named, as the business has them now
    select coalesce(jsonb_agg(jsonb_build_object('tax_id', t.id, 'name', t.name, 'rate_bp', t.rate_bp, 'type', t.type) order by t.name), '[]'::jsonb)
      into v_taxes
      from taxes t
     where v_kind = 'line' and t.tenant_id = p_tenant and t.deleted_at is null
       and t.id in (select (e #>> '{}')::uuid from jsonb_array_elements(case when jsonb_typeof(x->'tax_ids') = 'array' then x->'tax_ids' else '[]'::jsonb end) e
                     where (e #>> '{}') ~ '^[0-9a-f-]{36}$');
    v_cost := null;
    if v_item is not null then
      select coalesce(
               (select sl.avg_cost from stock_levels sl where sl.tenant_id = p_tenant and sl.store_id = (select store_id from invoices where id = v_id)
                   and sl.item_id = v_item and sl.variant_id is not distinct from v_var and sl.avg_cost > 0 limit 1),
               (select i.cost::numeric from items i where i.tenant_id = p_tenant and i.id = v_item))
        into v_cost;
    end if;
    insert into invoice_lines (tenant_id, invoice_id, pos, kind, item_id, variant_id, name, detail, sku, qty, unit_price, list_price, taxes, unit_cost)
      values (p_tenant, v_id, v_pos, v_kind, v_item, v_var,
              left(coalesce(x->>'name', ''), 300),
              nullif(left(coalesce(x->>'detail', ''), 1000), ''),
              nullif(left(coalesce(x->>'sku', ''), 80), ''),
              case when v_kind = 'line' then greatest(0, least(coalesce((x->>'qty')::int, 1000), 1000000000)) else 0 end,
              case when v_kind = 'line' then greatest(0, coalesce((x->>'unit_price')::bigint, 0)) else 0 end,
              case when v_kind = 'line' and x->>'list_price' is not null then greatest(0, (x->>'list_price')::bigint) end,
              v_taxes, v_cost);
  end loop;

  select * into f from invoice_figures(p_tenant, v_id);
  update invoices set subtotal = f.subtotal, discount_total = f.discount_total, tax_added = f.tax_added,
                      tax_total = f.tax_total, total = f.total
   where id = v_id;

  -- what this customer's invoices should say next time
  if v_cust is not null and coalesce((p_head->>'remember')::boolean, false) then
    insert into invoice_customers (tenant_id, customer_id, buyer_type, address, brn, vat_no, lang, email_cc, contact, deliver_to, terms)
      select p_tenant, v_cust, i.buyer_type, i.buyer_address, i.buyer_brn, i.buyer_vat, i.lang, i.buyer_cc, i.buyer_contact, i.deliver_to,
             case when i.terms = 'date' then null else i.terms end
        from invoices i where i.id = v_id
    on conflict (tenant_id, customer_id) do update set
      buyer_type = excluded.buyer_type, address = excluded.address, brn = excluded.brn, vat_no = excluded.vat_no,
      lang = excluded.lang, email_cc = excluded.email_cc, contact = excluded.contact, deliver_to = excluded.deliver_to,
      terms = coalesce(excluded.terms, invoice_customers.terms);
  end if;

  select * into v from invoices where id = v_id;
  return jsonb_build_object('id', v.id, 'rev', v.rev, 'subtotal', v.subtotal, 'discount_total', v.discount_total,
    'tax_added', v.tax_added, 'tax_total', v.tax_total, 'total', v.total, 'due_on', invoice_due(v.issued_on, v.terms, v.due_on));
end $fn$;

-- ---- 6. issuing ----
create or replace function invoice_issue(p_tenant uuid, p_emp uuid, p_invoice uuid, p_rev integer) returns jsonb
language plpgsql set search_path = public as $fn$
declare
  v invoices; s invoice_series; f record; r record; v_n integer; v_number text; v_today date; v_last date;
begin
  select * into v from invoices where tenant_id = p_tenant and id = p_invoice and deleted_at is null for update;
  if not found then raise exception 'invoice-gone'; end if;
  if v.status = 'issued' then return jsonb_build_object('id', v.id, 'number', v.number, 'already', true); end if;
  if p_rev is not null and p_rev <> v.rev then raise exception 'invoice-changed'; end if;
  -- a client on Premium MRA: its invoices go to the MRA through a till (not built yet)
  if exists (select 1 from tenants where id = p_tenant and coalesce(mra, 'off') <> 'off') then raise exception 'invoice-mra'; end if;
  if btrim(v.buyer_name) = '' then raise exception 'invoice-buyer'; end if;
  if v.buyer_type in ('B2B', 'B2G') and coalesce(btrim(v.buyer_brn), '') = '' then raise exception 'invoice-brn'; end if;
  if not exists (select 1 from invoice_lines where tenant_id = p_tenant and invoice_id = p_invoice and kind = 'line') then
    raise exception 'invoice-empty';
  end if;
  if exists (select 1 from invoice_lines where tenant_id = p_tenant and invoice_id = p_invoice and kind = 'line'
               and (qty = 0 or btrim(name) = '')) then
    raise exception 'invoice-line-blank';
  end if;
  v_today := invoice_today(p_tenant, v.store_id);
  if v.issued_on > v_today then raise exception 'invoice-future'; end if;
  if v.terms = 'date' and (v.due_on is null or v.due_on < v.issued_on) then raise exception 'invoice-due'; end if;

  -- the series, locked until this commits: numbers and dates go up together
  s := invoice_series_of(p_tenant, v.store_id);
  select * into s from invoice_series where id = s.id for update;
  select max(issued_on) into v_last from invoices where tenant_id = p_tenant and store_id = v.store_id and status = 'issued';
  if v_last is not null and v.issued_on < v_last then raise exception 'invoice-date-order'; end if;
  v_n := s.next_no;
  v_number := s.prefix || lpad(v_n::text, greatest(5, length(v_n::text)), '0');
  if exists (select 1 from invoices where tenant_id = p_tenant and number = v_number) then raise exception 'invoice-number-used'; end if;
  update invoice_series set next_no = v_n + 1 where id = s.id;

  select * into f from invoice_figures(p_tenant, p_invoice);
  update invoices set status = 'issued', number = v_number, seq = v_n,
         subtotal = f.subtotal, discount_total = f.discount_total, tax_added = f.tax_added, tax_total = f.tax_total, total = f.total,
         due_on = invoice_due(v.issued_on, v.terms, v.due_on), issued_by = p_emp, issued_at = now(), rev = v.rev + 1
   where id = p_invoice;

  -- what it takes off the branch's shelf, as a sale does: parts of a made-of product, one movement per product
  for r in
    select x.item_id, x.variant_id, sum(x.qty)::int as qty, string_agg(distinct x.via, ', ') as via
      from invoice_lines l cross join lateral stock_parts(p_tenant, l.item_id, l.variant_id, l.qty) x
     where l.tenant_id = p_tenant and l.invoice_id = p_invoice and l.kind = 'line' and l.item_id is not null
     group by x.item_id, x.variant_id
     order by x.item_id, x.variant_id
  loop
    perform stock_move(p_tenant, v.store_id, r.item_id, r.variant_id, -r.qty, 'sale', null, 'invoice', p_invoice, p_emp,
      left('Invoice ' || v_number || case when r.via is not null then ', in ' || r.via else '' end, 200));
  end loop;
  return jsonb_build_object('id', p_invoice, 'number', v_number, 'already', false, 'total', f.total);
end $fn$;

-- ---- 7. payments ----
create or replace function invoice_pay(p_tenant uuid, p_emp uuid, p_invoice uuid, p_day date, p_amount bigint, p_method text, p_ref text)
returns jsonb
language plpgsql set search_path = public as $fn$
declare v invoices; v_id uuid;
begin
  select * into v from invoices where tenant_id = p_tenant and id = p_invoice and deleted_at is null for update;
  if not found then raise exception 'invoice-gone'; end if;
  if v.status <> 'issued' then raise exception 'invoice-not-issued'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'invoice-pay-amount'; end if;
  if p_amount > v.total - v.paid then raise exception 'invoice-overpaid'; end if;
  if p_method is null or p_method not in ('bank', 'cheque', 'cash', 'card', 'mobile', 'other') then raise exception 'invoice-pay-method'; end if;
  if p_day is null or p_day > invoice_today(p_tenant, v.store_id) then raise exception 'invoice-pay-future'; end if;
  if p_day < v.issued_on then raise exception 'invoice-pay-early'; end if;
  insert into invoice_payments (tenant_id, invoice_id, paid_on, amount, method, reference, employee_id)
    values (p_tenant, p_invoice, p_day, p_amount, p_method, nullif(left(btrim(coalesce(p_ref, '')), 120), ''), p_emp)
    returning id into v_id;
  update invoices set paid = paid + p_amount where id = p_invoice;
  return jsonb_build_object('id', v_id, 'paid', v.paid + p_amount, 'owed', v.total - v.paid - p_amount);
end $fn$;

create or replace function invoice_pay_cancel(p_tenant uuid, p_emp uuid, p_payment uuid) returns jsonb
language plpgsql set search_path = public as $fn$
declare p invoice_payments; v invoices;
begin
  select * into p from invoice_payments where tenant_id = p_tenant and id = p_payment;
  if not found then raise exception 'invoice-gone'; end if;
  select * into v from invoices where tenant_id = p_tenant and id = p.invoice_id for update;
  select * into p from invoice_payments where id = p_payment for update;
  if p.cancelled_at is not null then return jsonb_build_object('id', p.id, 'already', true); end if;
  update invoice_payments set cancelled_at = now(), cancelled_by = p_emp where id = p_payment;
  update invoices set paid = paid - p.amount where id = v.id;
  return jsonb_build_object('id', p.id, 'already', false, 'owed', v.total - v.paid + p.amount);
end $fn$;

-- ---- 8. deleting transactions takes invoices too ----
CREATE OR REPLACE FUNCTION public.purge_transactions(p_tenant uuid, p_emp uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_auth uuid; v_receipts bigint; v_tickets bigint; t text;
begin
  -- the caller is working in this restaurant, and is its owner
  if p_tenant is null or current_tenant_id() is distinct from p_tenant then raise exception 'forbidden'; end if;
  select e.auth_user_id into v_auth from employees e join roles r on r.tenant_id = e.tenant_id and r.id = e.role_id
    where e.id = p_emp and e.tenant_id = p_tenant and e.deleted_at is null and e.is_active and r.permissions ? '*';
  if not found then raise exception 'forbidden'; end if;
  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_tickets from tickets where tenant_id = p_tenant;
  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach t in array array[
    'invoice_payments','invoice_lines','invoices',
    'stock_transfer_lines','stock_transfers',
    'stock_count_lines','stock_counts',
    'delivery_lines','deliveries','purchase_order_lines','purchase_orders',
    'account_payment_lines','account_payments','account_bills',
    'credit_notes','deposit_payments','deposit_lines','deposits',
    'bookings','approvals','drawer_counts','stock_movements','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied']
  loop
    execute format('delete from %I where tenant_id = $1', t) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  -- a customer's points are what their receipts earned and used: none are left
  update customers set points = 0 where tenant_id = p_tenant and points <> 0;
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant;
  -- orders, deliveries, counts and transfers number from 1 again, as bills do
  delete from doc_counters where tenant_id = p_tenant;
  -- and each branch's invoices from where its series was set to start (0159)
  update invoice_series set next_no = start_no where tenant_id = p_tenant;
  -- the tills: a pull never says what was deleted, so the settings say when (0155)
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('cleared', to_jsonb(clock_timestamp())))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;

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
    'invoice_payments','invoice_lines','invoices',
    'account_payment_lines','account_payments','account_bills',
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
  update invoice_series set next_no = start_no where tenant_id = p_tenant;
  -- a customer's points are the sum of their receipts (0128): none are left
  update customers c set points = coalesce((select sum(r.points_earned - r.points_used) from receipts r
      where r.tenant_id = c.tenant_id and r.customer_id = c.id and r.deleted_at is null), 0)
   where c.tenant_id = p_tenant and c.points <> 0;
  delete from tablet_codes
   where tenant_id = p_tenant and not (device_id is null and used_at is null and ended_at is null);

  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.clear_test', p_tenant,
      jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'tills', v_tills, 'codes', v_codes));
  return jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'tills', v_tills, 'codes', v_codes);
end $function$;

CREATE OR REPLACE FUNCTION platform.go_live_clear(p_tenant uuid, p_admin uuid, p_by jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_receipts bigint; v_orders bigint;
  v_mark jsonb := to_jsonb(clock_timestamp());
  v_live bigint;
  tbl text;
begin
  perform set_config('app.tenant_id', p_tenant::text, true);
  -- a till that is sending at this moment makes this wait; not for long
  perform set_config('lock_timeout', '8s', true);
  v_live := floor(extract(epoch from (v_mark #>> '{}')::timestamptz) * 1000)::bigint;

  select count(*) into v_receipts from receipts where tenant_id = p_tenant;
  select count(*) into v_orders from tickets where tenant_id = p_tenant;

  -- the shelves first: the level, then the item's total, in the order the stock engine locks them (0067)
  update stock_levels s set qty = s.qty - b.qty
    from platform.test_sales_on_stock(p_tenant) b
   where s.tenant_id = p_tenant and s.store_id = b.store_id and s.item_id = b.item_id
     and s.variant_id is not distinct from b.variant_id;
  update items i set stock_qty = coalesce(i.stock_qty, 0) - b.qty
    from (select x.item_id, sum(x.qty) as qty from platform.test_sales_on_stock(p_tenant) x group by 1) b
   where i.tenant_id = p_tenant and i.id = b.item_id;
  delete from stock_movements where tenant_id = p_tenant and reason in ('sale', 'refund', 'deposit', 'deposit_release');

  -- what was rung up, children first; the tills, their keys and what they were asked stay
  perform set_config('app.purge_tenant', p_tenant::text, true);
  foreach tbl in array array[
    'invoice_payments','invoice_lines','invoices',
    'account_payment_lines','account_payments','account_bills',
    'credit_notes','deposit_payments','deposit_lines','deposits',
    'bookings','approvals','drawer_counts','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts']
  loop
    execute format('delete from %I where tenant_id = $1', tbl) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  -- each branch's invoices number from where its series was set to start (0159)
  update invoice_series set next_no = start_no where tenant_id = p_tenant;
  -- a customer's points are the sum of their receipts (0128): none are left
  update customers c set points = coalesce((select sum(r.points_earned - r.points_used) from receipts r
      where r.tenant_id = c.tenant_id and r.customer_id = c.id and r.deleted_at is null), 0)
   where c.tenant_id = p_tenant and c.points <> 0;
  -- the bills number from 1 again
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant and last_receipt_seq <> 0;

  -- the tills: empty what you hold (0155), and the business is live from this moment
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('cleared', v_mark, 'live', v_live))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  delete from platform.setting_up where tenant_id = p_tenant;

  -- the log holds a login: from a till, the owner's (push_business_go_live); a business with none is not written down
  if p_admin is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (p_admin, 'tenant.live', p_tenant,
        coalesce(p_by, '{}'::jsonb) || jsonb_build_object('cleared', true, 'receipts', v_receipts, 'orders', v_orders));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_orders, 'cleared', v_mark, 'live', v_live);
end $function$;
