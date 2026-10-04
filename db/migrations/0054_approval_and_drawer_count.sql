-- 0054_approval_and_drawer_count.sql — a second person's go-ahead, and
-- counting the drawer without closing the shift.
-- Source: every function below except may() and push_drawer_count is the live
-- definition (pg_get_functiondef, as last written by 0049 to 0053) with the
-- edits listed here. Earlier migrations untouched.
--
-- What changes:
--   - Approval. When the person at the till may not do something (refund,
--     correct a payment type, close the shift or the day, change the waiter,
--     give a discount), someone who may enters their own PIN at the till and
--     the op carries them as approved_by in its payload. The seven checks
--     that were has_perm(employee) are now may(employee, payload): the
--     employee, or whoever approved. approved_by counts only from a login
--     that may set up tills (settings.device), the same rule as employee_id;
--     from any other login it is dropped.
--   - approvals: one row per op that was applied with an approver: which op,
--     who was at the till, who approved. Never sent to the till.
--   - Restricted discounts are unchanged: their approver was already carried
--     on the discount itself.
--   - drawer_counts: the cash counted in the drawer during a shift, with what
--     it should have held at that moment (drawer.count). It records a
--     handover; it does not close the shift and does not change how the
--     shift's expected cash is worked out. Sent to the till with its store's
--     other rows, a week back.
--   - purge_transactions also clears the two new tables.
-- Never edit after merge.

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  op_id uuid not null,
  op_type text not null,
  employee_id uuid,
  approved_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
alter table approvals enable row level security;
alter table approvals force row level security;
drop policy if exists tenant_isolation on approvals;
create policy tenant_isolation on approvals
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on approvals;
create trigger trg_touch before insert or update on approvals
  for each row execute function touch_row();
create index if not exists idx_approvals_tenant_seq on approvals (tenant_id, server_seq);
create index if not exists idx_approvals_tenant_time on approvals (tenant_id, created_at);

create table if not exists drawer_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid not null,
  shift_id uuid not null,
  employee_id uuid,
  counted bigint not null check (counted >= 0),
  expected bigint not null,
  device_time timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id),
  foreign key (tenant_id, store_id) references stores (tenant_id, id) on delete restrict
);
alter table drawer_counts enable row level security;
alter table drawer_counts force row level security;
drop policy if exists tenant_isolation on drawer_counts;
create policy tenant_isolation on drawer_counts
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on drawer_counts;
create trigger trg_touch before insert or update on drawer_counts
  for each row execute function touch_row();
create index if not exists idx_drawer_counts_tenant_seq on drawer_counts (tenant_id, server_seq);
create index if not exists idx_drawer_counts_shift on drawer_counts (tenant_id, shift_id, device_time);

-- The employee may, or whoever approved may. sync_push has already checked
-- that approved_by is one of this restaurant's staff, and dropped it when the
-- login may not vouch for staff.
create or replace function may(p_emp uuid, p jsonb, p_perm text)
returns boolean language plpgsql stable set search_path = public as $fn$
declare v uuid;
begin
  if has_perm(p_emp, p_perm) then return true; end if;
  begin
    v := nullif(p->>'approved_by', '')::uuid;
  exception when others then
    return false;
  end;
  return v is not null and has_perm(v, p_perm);
end $fn$;

create or replace function push_drawer_count(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_store uuid; v_device uuid; v_shift uuid; v_counted bigint; v_expected bigint;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_counted := (p->>'counted')::bigint;
  v_expected := (p->>'expected')::bigint;
  if v_id is null or v_store is null or v_device is null or v_counted is null or v_counted < 0 or v_expected is null then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store and tenant_id = p_tenant) then
    raise exception 'bad-device'; end if;
  -- the drawer has already been counted, so it is recorded whoever counted
  -- it; the till asks for an approval first when that person may not
  select s.id into v_shift from shifts s
    where s.id = (p->>'shift_id')::uuid and s.tenant_id = p_tenant and s.device_id = v_device;
  if v_shift is null then raise exception 'bad-shift'; end if;
  insert into drawer_counts (id, tenant_id, store_id, device_id, shift_id, employee_id, counted, expected, device_time)
    values (v_id, p_tenant, v_store, v_device, v_shift, p_emp, v_counted, v_expected,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end);
  return jsonb_build_object('id', v_id);
end $fn$;

CREATE OR REPLACE FUNCTION public.push_day_close(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_store uuid; v_device uuid; v_at timestamptz; v_from timestamptz; v_no int;
begin
  v_id := (p->>'id')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  if v_id is null or v_store is null or v_device is null then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'shift.open_close') then raise exception 'forbidden'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store and tenant_id = p_tenant) then
    raise exception 'bad-device'; end if;
  v_at := coalesce((p->>'closed_at')::timestamptz, now());
  -- one closing of a store at a time (contention becomes retry, never a wait)
  if not pg_try_advisory_xact_lock(hashtextextended('dayclose:' || v_store::text, 0)) then
    raise exception 'lock-busy' using errcode = '55P03';
  end if;
  select max(closed_at) into v_from from day_closes
    where tenant_id = p_tenant and device_id = v_device and deleted_at is null;
  select coalesce(max(number), 0) + 1 into v_no from day_closes where tenant_id = p_tenant and store_id = v_store;
  insert into day_closes (id, tenant_id, store_id, device_id, number, closed_by, from_time, closed_at, totals)
    values (v_id, p_tenant, v_store, v_device, v_no, p_emp, v_from, v_at, coalesce(p->'totals', '{}'::jsonb));
  return jsonb_build_object('id', v_id, 'number', v_no);
end $function$;

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
end $function$;

CREATE OR REPLACE FUNCTION public.push_refund_create(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_orig uuid; v_store uuid; v_device uuid; v_number text;
  o record;
  -- receipt-level targets the line shares must add up to
  v_t_tadd bigint; v_t_tincl bigint; v_w bigint; v_n int; v_i int := 0;
  v_a_sub bigint := 0; v_a_disc bigint := 0; v_a_tadd bigint := 0;
  v_a_tincl bigint := 0; v_a_svc bigint := 0; v_a_rnd bigint := 0;
  v_ls bigint; v_ld bigint; v_lta bigint; v_lti bigint; v_lsv bigint; v_lr bigint; v_div bigint;
  oln record; tx record; sh record; rw record;
  -- this refund
  v_sub bigint := 0; v_disc bigint := 0; v_tadd bigint := 0; v_tincl bigint := 0;
  v_svc bigint := 0; v_rnd bigint := 0; v_total bigint;
  sel jsonb; v_line uuid; v_qty int; v_done int; v_seen uuid[] := '{}';
  v_received bigint; v_cum bigint;
  pay jsonb; v_ptype uuid; v_pamt bigint; v_tender bigint; v_change bigint; v_chunk bigint := 0;
  v_nline uuid;
begin
  if not may(p_emp, p, 'sale.refund') then raise exception 'forbidden'; end if;
  v_id := (p->>'id')::uuid;
  v_orig := (p->>'refund_of')::uuid;
  v_store := (p->>'store_id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_number := nullif(p->>'number','');
  if v_id is null or v_orig is null or v_store is null or v_device is null or v_number is null then
    raise exception 'bad-payload'; end if;
  if not exists (select 1 from pos_devices where id = v_device and store_id = v_store) then
    raise exception 'bad-device'; end if;
  select * into o from receipts
    where id = v_orig and tenant_id = p_tenant and type = 'sale' and deleted_at is null;
  if not found then raise exception 'bad-receipt'; end if;
  if nullif(p->>'reason','') is null then raise exception 'bad-payload'; end if;

  -- one refund of a given receipt at a time: two tills must not both read the
  -- same "already refunded" figures (contention becomes retry, never a wait)
  if not pg_try_advisory_xact_lock(hashtextextended('refund:' || v_orig::text, 0)) then
    raise exception 'lock-busy' using errcode = '55P03';
  end if;

  -- 1+2. line shares of every component; the last line takes the remainder
  v_t_tadd := o.total - (o.subtotal - o.discount_total + o.service_charge + o.rounding);
  v_t_tincl := o.tax_total - v_t_tadd;
  select count(*), coalesce(sum(line_amount(x.unit_price, x.qty) +
      coalesce((select sum(xm.price) from receipt_line_modifiers xm
        where xm.receipt_line_id = x.id and xm.tenant_id = p_tenant), 0)::bigint), 0)
    into v_n, v_w
    from receipt_lines x where x.receipt_id = v_orig and x.tenant_id = p_tenant;

  drop table if exists _rshare;
  create temp table _rshare (
    oline uuid, tlid uuid, s_name text, s_unit bigint, s_qty int,
    s_sub bigint, s_disc bigint, s_tadd bigint, s_tincl bigint, s_svc bigint, s_rnd bigint
  ) on commit drop;
  drop table if exists _rlines;
  create temp table _rlines (oline uuid, r_name text, r_unit bigint, r_qty int) on commit drop;

  for oln in
    select x.id, x.ticket_line_id, x.name_snapshot, x.unit_price, x.qty,
      line_amount(x.unit_price, x.qty) +
        coalesce((select sum(xm.price) from receipt_line_modifiers xm
          where xm.receipt_line_id = x.id and xm.tenant_id = p_tenant), 0)::bigint as base
    from receipt_lines x where x.receipt_id = v_orig and x.tenant_id = p_tenant
    order by x.ticket_line_id, x.id
  loop
    v_i := v_i + 1;
    if v_i < v_n then
      v_ls := oln.base;
      v_ld := case when v_w > 0 then o.discount_total * oln.base / v_w else 0 end;
      v_lsv := case when v_w > 0 then o.service_charge * oln.base / v_w else 0 end;
      v_lr := case when v_w > 0 then o.rounding * oln.base / v_w else 0 end;
      v_lta := 0; v_lti := 0;
      for tx in select rate_bp, type from receipt_line_taxes
          where receipt_line_id = oln.id and tenant_id = p_tenant loop
        if tx.type = 'added' then
          v_lta := v_lta + ((v_ls - v_ld) * tx.rate_bp + 5000) / 10000;
        else
          v_div := 10000 + tx.rate_bp;
          v_lti := v_lti + ((v_ls - v_ld) * tx.rate_bp + v_div / 2) / v_div;
        end if;
      end loop;
    else
      v_ls := o.subtotal - v_a_sub;
      v_ld := o.discount_total - v_a_disc;
      v_lsv := o.service_charge - v_a_svc;
      v_lr := o.rounding - v_a_rnd;
      v_lta := v_t_tadd - v_a_tadd;
      v_lti := v_t_tincl - v_a_tincl;
    end if;
    v_a_sub := v_a_sub + v_ls; v_a_disc := v_a_disc + v_ld; v_a_svc := v_a_svc + v_lsv;
    v_a_rnd := v_a_rnd + v_lr; v_a_tadd := v_a_tadd + v_lta; v_a_tincl := v_a_tincl + v_lti;
    insert into _rshare values (oln.id, oln.ticket_line_id, oln.name_snapshot, oln.unit_price, oln.qty,
      v_ls, v_ld, v_lta, v_lti, v_lsv, v_lr);
  end loop;

  -- what to refund: the named lines, or everything still unrefunded
  if p->'lines' is null then
    for sh in select * from _rshare loop
      select coalesce(sum(rl2.qty), 0) into v_done
        from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
        where r2.refund_of = v_orig and r2.deleted_at is null
          and rl2.ticket_line_id = sh.tlid and rl2.deleted_at is null;
      if sh.s_qty - v_done > 0 then
        insert into _rlines values (sh.oline, sh.s_name, sh.s_unit, sh.s_qty - v_done);
      end if;
    end loop;
    if not exists (select 1 from _rlines) then raise exception 'bad-qty'; end if;
  else
    for sel in select value from jsonb_array_elements(p->'lines') as value loop
      v_line := (sel->>'receipt_line_id')::uuid;
      select * into sh from _rshare where oline = v_line;
      if not found then raise exception 'bad-line'; end if;
      if v_line = any (v_seen) then raise exception 'bad-payload'; end if;
      v_seen := v_seen || v_line;
      v_qty := coalesce((sel->>'qty')::int, 0);
      if v_qty <= 0 then raise exception 'bad-qty'; end if;
      select coalesce(sum(rl2.qty), 0) into v_done
        from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
        where r2.refund_of = v_orig and r2.deleted_at is null
          and rl2.ticket_line_id = sh.tlid and rl2.deleted_at is null;
      if v_qty + v_done > sh.s_qty then raise exception 'bad-qty'; end if;
      insert into _rlines values (sh.oline, sh.s_name, sh.s_unit, v_qty);
    end loop;
    if not exists (select 1 from _rlines) then raise exception 'bad-payload'; end if;
  end if;

  -- 3+4. each line returns alloc(done + q) - alloc(done) of its shares
  for rw in select rr.oline, rr.r_qty, sx.tlid, sx.s_qty, sx.s_sub, sx.s_disc, sx.s_tadd,
      sx.s_tincl, sx.s_svc, sx.s_rnd
    from _rlines rr join _rshare sx on sx.oline = rr.oline loop
    select coalesce(sum(rl2.qty), 0) into v_done
      from receipt_lines rl2 join receipts r2 on r2.tenant_id = p_tenant and r2.id = rl2.receipt_id
      where r2.refund_of = v_orig and r2.deleted_at is null
        and rl2.ticket_line_id = rw.tlid and rl2.deleted_at is null;
    v_sub := v_sub + refund_alloc(rw.s_sub, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_sub, v_done, rw.s_qty);
    v_disc := v_disc + refund_alloc(rw.s_disc, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_disc, v_done, rw.s_qty);
    v_tadd := v_tadd + refund_alloc(rw.s_tadd, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_tadd, v_done, rw.s_qty);
    v_tincl := v_tincl + refund_alloc(rw.s_tincl, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_tincl, v_done, rw.s_qty);
    v_svc := v_svc + refund_alloc(rw.s_svc, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_svc, v_done, rw.s_qty);
    v_rnd := v_rnd + refund_alloc(rw.s_rnd, v_done + rw.r_qty, rw.s_qty) - refund_alloc(rw.s_rnd, v_done, rw.s_qty);
  end loop;
  v_total := v_sub - v_disc + v_tadd + v_svc + v_rnd;
  if v_total < 0 then raise exception 'bad-totals'; end if;

  -- money out never exceeds money in: capped by the payments actually received
  -- on the original (amount is already net of change), not by receipts.total
  select coalesce(sum(amount), 0) into v_received from receipt_payments
    where receipt_id = v_orig and tenant_id = p_tenant;
  select coalesce(sum(total), 0) into v_cum from receipts
    where refund_of = v_orig and tenant_id = p_tenant and deleted_at is null;
  if v_cum + v_total > v_received then raise exception 'bad-qty'; end if;

  -- the money going back: validated like receipt payments, must sum exactly
  for pay in select value from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value loop
    v_ptype := (pay->>'payment_type_id')::uuid;
    v_pamt := coalesce((pay->>'amount')::bigint, 0);
    if v_ptype is null or v_pamt <= 0 then raise exception 'bad-payment'; end if;
    if not exists (select 1 from payment_types
        where id = v_ptype and is_active and deleted_at is null) then raise exception 'bad-payment'; end if;
    if pay->>'tendered' is not null then
      v_tender := (pay->>'tendered')::bigint;
      v_change := coalesce((pay->>'change')::bigint, -1);
      if v_tender < v_pamt or v_change <> v_tender - v_pamt then raise exception 'bad-change'; end if;
    end if;
    v_chunk := v_chunk + v_pamt;
  end loop;
  if v_chunk <> v_total then raise exception 'bad-payment'; end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type, refund_of,
      subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, device_time)
    values (v_id, p_tenant, v_store, v_device, o.ticket_id, v_number, 'refund', v_orig,
      v_sub, v_disc, v_tadd + v_tincl, v_svc, v_rnd, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end);

  for rw in select rr.oline, rr.r_name, rr.r_unit, rr.r_qty, sx.tlid
    from _rlines rr join _rshare sx on sx.oline = rr.oline loop
    v_nline := gen_random_uuid();
    insert into receipt_lines (id, tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
      values (v_nline, p_tenant, v_id, rw.tlid, rw.r_name, rw.r_unit, rw.r_qty);
    insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price)
      select p_tenant, v_nline, modifier_id, name_snapshot, price
      from receipt_line_modifiers where receipt_line_id = rw.oline and tenant_id = p_tenant;
    insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
      select p_tenant, v_nline, tax_id, name_snapshot, rate_bp, type
      from receipt_line_taxes where receipt_line_id = rw.oline and tenant_id = p_tenant;
  end loop;
  -- stock: what comes back goes back on the shelf
  insert into stock_movements (tenant_id, item_id, qty, reason, receipt_id, employee_id)
    select p_tenant, tl.item_id, sum(rr.r_qty)::int, 'refund', v_id, p_emp
      from _rlines rr join _rshare sx on sx.oline = rr.oline
      join ticket_lines tl on tl.tenant_id = p_tenant and tl.id = sx.tlid
      join items i on i.tenant_id = p_tenant and i.id = tl.item_id
      left join categories c on c.tenant_id = p_tenant and c.id = i.category_id
     where i.track_stock or coalesce(c.is_stock, false)
     group by tl.item_id;
  update items i set stock_qty = coalesce(i.stock_qty, 0) + s.qty
    from (select item_id, sum(qty)::int as qty from stock_movements
      where tenant_id = p_tenant and receipt_id = v_id group by item_id) s
   where i.tenant_id = p_tenant and i.id = s.item_id;
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;

  drop table _rlines;
  drop table _rshare;
  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig, 'total', v_total);
end $function$;

CREATE OR REPLACE FUNCTION public.push_shift_close(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_counted bigint; v_at timestamptz;
  v_device uuid; v_opened timestamptz; v_float bigint; v_closed timestamptz; v_cash bigint;
begin
  v_id := (p->>'id')::uuid;
  v_counted := (p->>'counted_cash')::bigint;
  v_at := coalesce((p->>'closed_at')::timestamptz, now());
  if v_id is null or v_counted is null or v_counted < 0 then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'shift.open_close') then raise exception 'forbidden'; end if;
  select device_id, opened_at, opening_float, closed_at into v_device, v_opened, v_float, v_closed
    from shifts where id = v_id and tenant_id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'bad-shift'; end if;
  if v_closed is not null then raise exception 'shift-closed'; end if;
  select coalesce(sum(case when r.type = 'refund' then -rp.amount else rp.amount end), 0) into v_cash
    from receipt_payments_effective rp
    join receipts r on r.tenant_id = rp.tenant_id and r.id = rp.receipt_id
    join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id
   where r.tenant_id = p_tenant and r.device_id = v_device and r.deleted_at is null
     and pt.kind = 'cash'
     and coalesce(r.device_time, r.created_at) >= v_opened
     and coalesce(r.device_time, r.created_at) <= v_at;
  -- cash put into and taken out of the drawer during the period
  select v_cash + coalesce(sum(case m.type when 'in' then m.amount when 'out' then -m.amount else 0 end), 0) into v_cash
    from cash_movements m
   where m.tenant_id = p_tenant and m.device_id = v_device and m.deleted_at is null
     and coalesce(m.device_time, m.created_at) >= v_opened
     and coalesce(m.device_time, m.created_at) <= v_at;
  update shifts set closed_by = p_emp, closed_at = v_at, counted_cash = v_counted,
      expected_cash = v_float + v_cash
    where id = v_id and tenant_id = p_tenant;
  return jsonb_build_object('shift_id', v_id, 'expected_cash', v_float + v_cash, 'counted_cash', v_counted);
end $function$;

CREATE OR REPLACE FUNCTION public.push_shift_open(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_device uuid; v_store uuid; v_float bigint; v_at timestamptz;
begin
  v_id := (p->>'id')::uuid;
  v_device := (p->>'device_id')::uuid;
  v_float := coalesce((p->>'opening_float')::bigint, 0);
  v_at := coalesce((p->>'opened_at')::timestamptz, now());
  if v_id is null or v_device is null or v_float < 0 then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'shift.open_close') then raise exception 'forbidden'; end if;
  -- a till that was deactivated but is still signed in keeps working (0045)
  select store_id into v_store from pos_devices where id = v_device and tenant_id = p_tenant;
  if not found then raise exception 'bad-device'; end if;
  -- a second open period on the same till breaks uq_shifts_one_open: 'conflict'
  insert into shifts (id, tenant_id, store_id, device_id, opened_by, opened_at, opening_float)
    values (v_id, p_tenant, v_store, v_device, p_emp, v_at, v_float);
  return jsonb_build_object('shift_id', v_id);
end $function$;

CREATE OR REPLACE FUNCTION public.push_ticket_update_meta(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_ticket uuid; v_dining uuid;
begin
  v_ticket := (p->>'ticket_id')::uuid;
  if v_ticket is null then raise exception 'bad-payload'; end if;
  if p->>'opened_by' is not null and not may(p_emp, p, 'ticket.reassign') then raise exception 'forbidden'; end if;
  if p->>'dining_option_id' is not null then
    v_dining := (p->>'dining_option_id')::uuid;
    if not exists (select 1 from dining_options where id = v_dining) then raise exception 'bad-dining'; end if;
  end if;
  update tickets set
    table_id = case when p ? 'table_id' and p->>'table_id' is null then null
      when p->>'table_id' is null then table_id
      -- moving to a table this restaurant does not have takes the order off its table
      else (select tb.id from tables tb where tb.id = (p->>'table_id')::uuid and tb.tenant_id = p_tenant) end,
    dining_option_id = case when p ? 'dining_option_id' and p->>'dining_option_id' is null then null
      when v_dining is null and not (p ? 'dining_option_id') then dining_option_id else v_dining end,
    note = case when p ? 'note' then nullif(p->>'note','') else note end,
    covers = case when p ? 'covers' and p->>'covers' is null then null
      when p->>'covers' is null then covers else (p->>'covers')::int end,
    name = case when p ? 'name' then nullif(p->>'name','') else name end,
    -- change waiter: someone of this restaurant, else the order keeps its waiter
    opened_by = coalesce((select e.id from employees e
      where p->>'opened_by' is not null and e.id = (p->>'opened_by')::uuid and e.tenant_id = p_tenant), opened_by)
    where id = v_ticket and tenant_id = p_tenant and status = 'open';
  if not found then raise exception 'bad-ticket'; end if;
  return jsonb_build_object('ticket_id', v_ticket);
end $function$;

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
  v_eff bigint; v_avail boolean; v_gone boolean; v_ovr bigint;
  v_drift jsonb := '[]'::jsonb; v_till bigint; md record;
  v_short boolean := false; v_over boolean := false;
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

  -- discounts: capped, permited, staged into a jsonb variable (no temp table)
  if not may(p_emp, p, 'sale.apply_discount')
      and coalesce(jsonb_array_length(p->'discounts'), 0) > 0 then
    raise exception 'forbidden';
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
    v_appr := null;
    if v_did is not null and exists (select 1 from discounts where id = v_did and requires_approval) then
      if d->>'approved_by' is null then raise exception 'approval-required'; end if;
      v_appr := (d->>'approved_by')::uuid;
      if not has_perm(v_appr, 'sale.apply_restricted_discount') then
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
    if not exists (select 1 from payment_types
        where id = v_ptype and is_active and deleted_at is null) then raise exception 'bad-payment'; end if;
    if pay->>'tendered' is not null then
      v_tender := (pay->>'tendered')::bigint;
      v_change := coalesce((pay->>'change')::bigint, -1);
      if v_tender < v_pamt or v_change <> v_tender - v_pamt then raise exception 'bad-change'; end if;
    end if;
    v_chunk := v_chunk + v_pamt;
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
  for ol in select id, item_id, variant_id, unit_price from ticket_lines where id = any(covered) loop
    v_eff := null; v_avail := true; v_gone := false;
    if ol.variant_id is not null then
      select price into v_eff from item_variants
        where id = ol.variant_id and item_id = ol.item_id and deleted_at is null;
      if not found then v_gone := true; end if;
      -- a variant price wins over the item-level override (most specific)
    else
      select price, is_available, deleted_at is not null into v_eff, v_avail, v_gone
        from items where id = ol.item_id;
      select price into v_ovr from store_item_overrides
        where tenant_id = p_tenant and store_id = v_store and item_id = ol.item_id
          and deleted_at is null and price is not null;
      if found then v_eff := v_ovr; end if;
    end if;
    if v_eff is null or v_eff <> ol.unit_price or not v_avail or v_gone then
      v_offline := true;
      v_drift := v_drift || jsonb_build_object('kind',
        case when v_gone or not v_avail or v_eff is null then 'unavailable' else 'item' end,
        'line_id', ol.id, 'till', ol.unit_price, 'catalog', v_eff);
    end if;
    -- modifier drift: a changed modifier price is also offline truth, kept + flagged
    for md in select lm.modifier_id, lm.price as till_price, mo.price as catalog_price
        from ticket_line_modifiers lm join modifiers mo
          on mo.tenant_id = lm.tenant_id and mo.id = lm.modifier_id
        where lm.tenant_id = p_tenant and lm.line_id = ol.id
          and (mo.price <> lm.price or mo.deleted_at is not null) loop
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
  if v_number <> v_base_number then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'number-collision',
        jsonb_build_object('requested', v_base_number, 'stored', v_number));
  end if;

  insert into receipt_lines (tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty)
    select p_tenant, v_id, l.id, l.name_snapshot, l.unit_price, l.qty
    from ticket_lines l where l.id = any(covered);
  insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price)
    select p_tenant, rl.id, m.modifier_id, m.name_snapshot, m.price
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
  -- by what was sold. Not on the review path: those lines were sold before.
  if not v_review then
    insert into stock_movements (tenant_id, item_id, qty, reason, receipt_id, employee_id)
      select p_tenant, l.item_id, -sum(l.qty)::int, 'sale', v_id, p_emp
        from ticket_lines l join items i on i.tenant_id = p_tenant and i.id = l.item_id
        left join categories c on c.tenant_id = p_tenant and c.id = i.category_id
       where l.id = any(covered) and (i.track_stock or coalesce(c.is_stock, false))
       group by l.item_id;
    update items i set stock_qty = coalesce(i.stock_qty, 0) + s.qty
      from (select item_id, sum(qty)::int as qty from stock_movements
        where tenant_id = p_tenant and receipt_id = v_id group by item_id) s
     where i.tenant_id = p_tenant and i.id = s.item_id;
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
end $function$;

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
    'bad-employee','bad-shift','shift-closed'];
begin
  tenant := current_tenant_id();
  if tenant is null then raise exception 'no-tenant-context'; end if;
  if not exists (select 1 from employees where id = p_employee_id and deleted_at is null and is_active) then
    raise exception 'unknown-employee';
  end if;
  if jsonb_typeof(p_ops) <> 'array' then raise exception 'bad-batch'; end if;

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
        case v_type
          when 'ticket.create' then v_data := push_ticket_create(tenant, v_emp, v_payload);
          when 'ticket.add_line' then v_data := push_ticket_add_line(tenant, v_emp, v_payload);
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
          when 'cash.move' then v_data := push_cash_move(tenant, v_emp, v_payload);
          when 'drawer.count' then v_data := push_drawer_count(tenant, v_emp, v_payload);
          when 'day.close' then v_data := push_day_close(tenant, v_emp, v_payload);
          when 'payment.correct' then v_data := push_payment_correct(tenant, v_emp, v_payload);
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
end $function$;

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
    'printers','pos_settings']
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
  foreach tbl in array array['tables','shifts','timeclock_punches','cash_movements','day_closes','drawer_counts']
  loop
    execute format(
      'select coalesce(jsonb_agg(t order by t.server_seq), ''[]''::jsonb), ' ||
      'coalesce(max(t.server_seq), %L), count(*) from (select x.* from %I x ' ||
      'where x.server_seq > %L and x.tenant_id = current_tenant_id() and x.store_id = %L ' ||
      'and (%s) order by x.server_seq limit %s) t',
      cur, tbl, cur, p_store_id,
      case tbl
        when 'tables' then 'true'
        when 'shifts' then 'x.closed_at is null or x.created_at > now() - interval ''7 days'''
        when 'day_closes' then 'x.created_at > now() - interval ''30 days'''
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

  return jsonb_build_object(
    'changes', changes,
    'next_cursor', coalesce(low_cut, high, cur), 'has_more', more,
    'epochs', (select coalesce(jsonb_object_agg(table_name, epoch), '{}'::jsonb) from sync_epoch));
end $function$;

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
    'approvals','drawer_counts','stock_movements','payment_corrections','day_closes','cash_movements',
    'receipt_reviews','receipt_discounts','receipt_payments','receipt_line_taxes','receipt_line_modifiers',
    'receipt_lines','receipts','ticket_line_taxes','ticket_line_modifiers','ticket_lines','tickets',
    'timeclock_punches','shifts','sync_ops_applied']
  loop
    execute format('delete from %I where tenant_id = $1', t) using p_tenant;
  end loop;
  perform set_config('app.purge_tenant', '', true);
  update pos_devices set last_receipt_seq = 0 where tenant_id = p_tenant;

  if v_auth is not null then
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (v_auth, 'tenant.purge_transactions', p_tenant,
        jsonb_build_object('employee_id', p_emp, 'receipts', v_receipts, 'orders', v_tickets));
  end if;
  return jsonb_build_object('receipts', v_receipts, 'orders', v_tickets);
end $function$;

