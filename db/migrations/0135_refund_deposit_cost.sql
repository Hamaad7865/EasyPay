-- 0135_refund_deposit_cost.sql — goods collected from a deposit and brought
-- back go on the shelf at what they left it at (sweep 2026-10-18, seen while
-- fixing finding 2).
-- A deposit (0113) takes its goods off the shelf the day it is taken, as a
-- 'deposit' movement at that day's average; collecting them moves no stock.
-- A refund put back what came back at the cost of the ticket's last sale
-- movement of the product, and a collection has none for those goods, so
-- they came back at the average of the refund's moment: a rattle that left
-- at Rs 10.00 came back at Rs 20.34 after a dearer delivery, and lifted the
-- shelf's average for nothing. Now a product that comes back only from
-- deposits' goods is put back at their movements' cost (weighted, when two
-- deposits took it at different costs). One that also comes back off the
-- shelf on the same refund is put back at the sale's cost, as before: the
-- engine moves a product once per document, at one cost, and the item sales
-- report reads that movement for the shelf's line (and the deposit's own
-- for the other; web/lib/stock-reports.ts, itemSalesSql), so a cost between
-- the two would put the report out.
-- Source: push_refund_create (last written by 0128_loyalty_points.sql), the
-- live definition on dev (db/scripts/dump-function.cjs, 2026-10-23), the
-- same as 0128's, with only its stock loop changed (and v_cost declared for
-- it). Earlier migrations untouched.
-- Never edit after merge.

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
  v_sm record;
  -- what one of a product comes back at (0135)
  v_cost numeric;
  v_restock boolean := true;
  v_unapp boolean := false;
  -- the shop's return policy (0109)
  v_policy text; v_days int; v_age int;
  v_exch bigint := 0; v_note bigint := 0; v_back bigint := 0; v_ptkind text;
  cn jsonb; v_cn_id uuid; v_cn_number text; v_cn_amount bigint; v_cn_customer uuid; v_cn_valid date;
  -- what goes off the bill of a sale made on account (0114)
  v_acct bigint := 0; v_bill account_bills%rowtype; v_has_bill boolean := false; v_money bigint; v_paid_money bigint;
  v_rflags jsonb := '[]'::jsonb;
  -- loyalty points (0128): taken back of what the sale earned, given back of what it used
  v_ptake bigint := 0; v_pback bigint := 0; v_pleft_e bigint := 0; v_pleft_u bigint := 0; v_pflags jsonb := '[]'::jsonb;
begin
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
  -- "Put back into stock" switched off on the till: the goods are faulty
  if p->>'restock' = 'false' then v_restock := false; end if;

  -- The shop's return policy and window (0109). A restaurant refunds as it
  -- always did. Inside the window whoever is at the till returns alone; past
  -- it (and always, with a window of 0) the right to refund is needed, held
  -- or approved, as it was needed for every refund before this.
  select data->>'returns', coalesce((data->>'returnDays')::int, 7)
    into v_policy, v_days
    from pos_settings where tenant_id = p_tenant and deleted_at is null;
  if exists (select 1 from tenants where id = p_tenant and business_type = 'retail') then
    v_policy := coalesce(v_policy, 'exchange');
  else
    v_policy := 'refund'; v_days := 0;
  end if;
  v_age := extract(day from (now() - o.device_time))::int;
  if not (v_days > 0 and v_age <= v_days) then
    -- A refund needs someone allowed to give one: whoever rang it up, or
    -- whoever approved it. From a login that may not vouch for staff, one
    -- nobody was allowed to give is refused, as it always was. From a till
    -- whose login may (sync_push says which), the customer has the money by
    -- the time it gets here: it is stored either way, and the refund says so
    -- (0082).
    if not may(p_emp, p, 'sale.refund') then
      if coalesce(current_setting('app.till_vouched', true), '') <> '1' then raise exception 'forbidden'; end if;
      v_unapp := true;
    end if;
  end if;

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
      if sel->>'receipt_line_id' is not null then
        v_line := (sel->>'receipt_line_id')::uuid;
        select * into sh from _rshare where oline = v_line;
      else
        -- the till names a line by the line of the order it paid for
        select * into sh from _rshare where tlid = (sel->>'ticket_line_id')::uuid;
      end if;
      if not found then raise exception 'bad-line'; end if;
      v_line := sh.oline;
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
        where id = v_ptype and (is_active or kind = 'account') and deleted_at is null) then raise exception 'bad-payment'; end if;
    if pay->>'tendered' is not null then
      v_tender := (pay->>'tendered')::bigint;
      v_change := coalesce((pay->>'change')::bigint, -1);
      if v_tender < v_pamt or v_change <> v_tender - v_pamt then raise exception 'bad-change'; end if;
    end if;
    -- by kind (0109): to the new sale, to a credit note, or back to the customer
    select kind into v_ptkind from payment_types where id = v_ptype and tenant_id = p_tenant;
    if v_ptkind = 'exchange' then v_exch := v_exch + v_pamt;
    elsif v_ptkind = 'credit_note' then v_note := v_note + v_pamt;
    elsif v_ptkind = 'account' then
      if pay->>'tendered' is not null then raise exception 'bad-change'; end if;
      v_acct := v_acct + v_pamt;
    else v_back := v_back + v_pamt; end if;
    v_chunk := v_chunk + v_pamt;
  end loop;
  if v_chunk <> v_total then raise exception 'bad-payment'; end if;
  -- money back to the customer only where the shop refunds (0109)
  if v_back > 0 and v_policy <> 'refund' then raise exception 'refund-policy'; end if;
  -- A credit note only out of an exchange, under that policy, and only with
  -- its refund: the note is in the same operation, and the two must agree,
  -- so a note can never exist without the refund that backs it.
  cn := p->'credit_note';
  if v_note > 0 then
    if v_policy <> 'credit' or v_exch = 0 then raise exception 'refund-policy'; end if;
    if cn is null or jsonb_typeof(cn) <> 'object' then raise exception 'bad-payment'; end if;
    begin
      v_cn_id := (cn->>'id')::uuid; v_cn_number := nullif(cn->>'number', ''); v_cn_amount := (cn->>'amount')::bigint;
      v_cn_customer := nullif(cn->>'customer_id', '')::uuid;
      v_cn_valid := nullif(cn->>'valid_to', '')::date;
    exception when others then
      raise exception 'bad-payment';
    end;
    if v_cn_id is null or v_cn_number is null or v_cn_amount is distinct from v_note then raise exception 'bad-payment'; end if;
    if exists (select 1 from credit_notes where tenant_id = p_tenant and (id = v_cn_id or number = v_cn_number)) then raise exception 'bad-payment'; end if;
    if v_cn_customer is not null and not exists (select 1 from customers where id = v_cn_customer and tenant_id = p_tenant) then v_cn_customer := null; end if;
  elsif cn is not null then
    raise exception 'bad-payment';
  end if;

  -- On account (0114). What goes off the bill moves no money, so the
  -- policy above did not ask about it; there must be a bill to take it
  -- off. Past what the bill owes (paid meanwhile at another till), it is
  -- stored: the bill goes below nothing, paid over, and says so. Money
  -- back is at most what was paid with money: the sale's own payments
  -- less its part on account, plus what was paid on its bill, less money
  -- earlier returns gave back; past that it is stored and said.
  select * into v_bill from account_bills where tenant_id = p_tenant and id = v_orig and deleted_at is null for update;
  v_has_bill := found;
  if v_acct > 0 then
    if not v_has_bill then raise exception 'bad-payment'; end if;
    if v_acct > greatest(account_owed(v_bill), 0) then
      v_rflags := v_rflags || jsonb_build_object('why', 'over-returned', 'bill', v_bill.number, 'amount', v_acct, 'owed', account_owed(v_bill));
    end if;
  end if;
  v_money := v_back + v_note + v_exch;
  if v_has_bill and v_money > 0 then
    select v_received - v_bill.amount + v_bill.paid - coalesce(sum(rp.amount), 0) into v_paid_money
      from receipts r
      join receipt_payments rp on rp.tenant_id = r.tenant_id and rp.receipt_id = r.id
      join payment_types pt on pt.tenant_id = rp.tenant_id and pt.id = rp.payment_type_id and pt.kind <> 'account'
     where r.tenant_id = p_tenant and r.refund_of = v_orig and r.type = 'refund' and r.deleted_at is null;
    if v_money > v_paid_money then
      v_rflags := v_rflags || jsonb_build_object('why', 'money-before-paid', 'bill', v_bill.number, 'money', v_money, 'paid', v_paid_money);
    end if;
  end if;
  -- Loyalty points (0128): the till's figures, each held to what is left of
  -- the sale's (what it earned or used, less what refunds before this one
  -- took or gave back; refunds hold them at or below zero). Refunds of one
  -- sale are made one at a time (the lock above).
  if p ? 'points' then
    begin
      v_ptake := coalesce((p->'points'->>'taken')::bigint, 0);
      v_pback := coalesce((p->'points'->>'back')::bigint, 0);
    exception when others then v_ptake := -1; v_pback := -1;
    end;
    select o.points_earned + coalesce(sum(r.points_earned), 0), o.points_used + coalesce(sum(r.points_used), 0)
      into v_pleft_e, v_pleft_u
      from receipts r where r.tenant_id = p_tenant and r.refund_of = v_orig and r.type = 'refund' and r.deleted_at is null;
    if o.customer_id is null then v_pleft_e := 0; v_pleft_u := 0; end if;
    if v_ptake < 0 or v_ptake > greatest(v_pleft_e, 0) then
      v_pflags := v_pflags || jsonb_build_object('why', 'over-returned', 'what', 'taken', 'till', p->'points'->>'taken', 'left', v_pleft_e);
      v_ptake := least(greatest(v_ptake, 0), greatest(v_pleft_e, 0));
    end if;
    if v_pback < 0 or v_pback > greatest(v_pleft_u, 0) then
      v_pflags := v_pflags || jsonb_build_object('why', 'over-returned', 'what', 'back', 'till', p->'points'->>'back', 'left', v_pleft_u);
      v_pback := least(greatest(v_pback, 0), greatest(v_pleft_u, 0));
    end if;
  end if;
  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type, refund_of,
      subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, device_time, needs_review,
      customer_id, points_earned, points_used)
    values (v_id, p_tenant, v_store, v_device, o.ticket_id, v_number, 'refund', v_orig,
      v_sub, v_disc, v_tadd + v_tincl, v_svc, v_rnd, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end,
      v_unapp or jsonb_array_length(v_rflags) > 0 or jsonb_array_length(v_pflags) > 0,
      case when v_ptake <> 0 or v_pback <> 0 then o.customer_id end, -v_ptake, -v_pback);
  if o.customer_id is not null and v_pback <> v_ptake then
    update customers set points = points + v_pback - v_ptake where tenant_id = p_tenant and id = o.customer_id;
  end if;
  if jsonb_array_length(v_pflags) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'points', jsonb_build_object('flags', v_pflags));
  end if;
  if v_acct > 0 or jsonb_array_length(v_rflags) > 0 then
    update account_bills set returned = returned + v_acct, flags = flags || v_rflags
      where tenant_id = p_tenant and id = v_orig;
  end if;
  if jsonb_array_length(v_rflags) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'account', jsonb_build_object('flags', v_rflags));
  end if;
  if v_unapp then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'refund-unapproved',
        jsonb_build_object('by', p_emp, 'approved_by', nullif(p->>'approved_by', ''), 'total', v_total));
  end if;

  for rw in select rr.oline, rr.r_name, rr.r_unit, rr.r_qty, sx.tlid
    from _rlines rr join _rshare sx on sx.oline = rr.oline loop
    v_nline := gen_random_uuid();
    insert into receipt_lines (id, tenant_id, receipt_id, ticket_line_id, name_snapshot, unit_price, qty, list_price, price_kind, price_label)
      select v_nline, p_tenant, v_id, rw.tlid, rw.r_name, rw.r_unit, rw.r_qty, x.list_price, x.price_kind, x.price_label
        from receipt_lines x where x.id = rw.oline and x.tenant_id = p_tenant;
    insert into receipt_line_modifiers (tenant_id, receipt_line_id, modifier_id, name_snapshot, price, qty)
      select p_tenant, v_nline, modifier_id, name_snapshot, price, qty
      from receipt_line_modifiers where receipt_line_id = rw.oline and tenant_id = p_tenant;
    insert into receipt_line_taxes (tenant_id, receipt_line_id, tax_id, name_snapshot, rate_bp, type)
      select p_tenant, v_nline, tax_id, name_snapshot, rate_bp, type
      from receipt_line_taxes where receipt_line_id = rw.oline and tenant_id = p_tenant;
  end loop;
  -- stock: what comes back goes back on the shelf of the shop taking it back,
  -- at the cost its sale left at; goods collected from a deposit left with
  -- the deposit, and come back at its movement's cost (0135)
  for v_sm in
    -- a line made of others gives its parts back (0112), as they are now
    select x.item_id, x.variant_id, sum(x.qty)::int as qty,
           sum(x.qty) filter (where dc.unit_cost is not null) as dep_qty,
           sum(x.qty * dc.unit_cost) filter (where dc.unit_cost is not null) as dep_value
      from _rlines rr join _rshare sx on sx.oline = rr.oline
      join ticket_lines tl on tl.tenant_id = p_tenant and tl.id = sx.tlid
      cross join lateral stock_parts(p_tenant, tl.item_id, tl.variant_id, rr.r_qty) x
      left join lateral (
        select m.unit_cost from deposit_lines dl
          join stock_movements m on m.tenant_id = dl.tenant_id and m.ref_type = 'deposit' and m.ref_id = dl.deposit_id
         where dl.tenant_id = p_tenant and dl.id = tl.deposit_line_id
           and m.reason = 'deposit' and m.deleted_at is null and m.item_id = x.item_id
           and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
             = coalesce(x.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
         limit 1) dc on true
     group by x.item_id, x.variant_id
     order by x.item_id, x.variant_id
  loop
    v_cost := (select m.unit_cost from stock_movements m
        where m.tenant_id = p_tenant and m.reason = 'sale' and m.ref_type = 'receipt'
          and m.item_id = v_sm.item_id
          and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(v_sm.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          and m.ref_id in (select r.id from receipts r where r.tenant_id = p_tenant and r.ticket_id = o.ticket_id)
        order by m.created_at desc limit 1);
    -- all of the product that comes back was collected from deposits: at what
    -- they took it off at. Some of it off the shelf too: one movement holds
    -- one cost, so the sale's, as before, which Item sales reads for the
    -- shelf's line (it reads the deposit's for the other).
    if v_sm.dep_qty = v_sm.qty then
      v_cost := round(v_sm.dep_value / v_sm.dep_qty, 4);
    end if;
    perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, v_sm.qty, 'refund', v_cost,
      'receipt', v_id, p_emp, null);
    -- Not put back on the shelf: it came back, and leaves again as damaged,
    -- so the shelf is as it was and the loss is on the report. A document of
    -- its own: the engine moves a product once for one document.
    if not v_restock then
      perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, -v_sm.qty, 'damaged', null,
        'refund-writeoff', v_id, p_emp, 'Returned, not put back: ' || left(p->>'reason', 120));
    end if;
  end loop;
  insert into receipt_payments (tenant_id, receipt_id, payment_type_id, amount, tendered, change, reference)
    select p_tenant, v_id, (value->>'payment_type_id')::uuid, (value->>'amount')::bigint,
      case when value->>'tendered' is null then null else (value->>'tendered')::bigint end,
      coalesce((value->>'change')::bigint, 0), nullif(value->>'reference','')
    from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) as value;
  -- the credit note, with the refund that backs it (0109)
  if v_note > 0 then
    insert into credit_notes (id, tenant_id, store_id, device_id, number, amount, balance, refund_id, customer_id, valid_to, issued_by)
      values (v_cn_id, p_tenant, v_store, v_device, v_cn_number, v_cn_amount, v_cn_amount, v_id, v_cn_customer, v_cn_valid, p_emp);
  end if;

  drop table _rlines;
  drop table _rshare;
  return jsonb_build_object('receipt_id', v_id, 'number', v_number, 'refund_of', v_orig, 'total', v_total,
    'needs_review', v_unapp or jsonb_array_length(v_rflags) > 0 or jsonb_array_length(v_pflags) > 0, 'credit_note', case when v_note > 0 then v_cn_number else null end);
end $function$
;
