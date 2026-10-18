-- 0123: an add-on is charged for every one of the item.
--
-- The owner, 2026-10-18: "Say a burger is 100 and theres 1 egg add on cost
-- 20rs. When plusing 2, it doesnt come 120 + 120". Until now an add-on was
-- charged once for its line, whatever the line's quantity (0105: "two
-- grillades with three sausages are two grillades and three sausages"), so
-- two burgers with an egg came to 200 + 20. The guests' ordering page already
-- counted it per dish.
--
-- What a line's row for an add-on holds keeps its meaning: what it adds to
-- the whole line, as the till charged it. So every sum written so far (the
-- receipt's subtotal and tax, a refund's shares, the back office's reports)
-- adds price as it is and stays right, and nothing already stored changes.
-- What changes is the till: from this build it charges an add-on for each of
-- the item on the line (core/data/Calc.addonForLine), and on a quantity
-- change it keeps what the add-on costs for one.
--
-- push_receipt_create held an add-on's price against the catalog's price for
-- that many of it (0105); it is now held against that many on each of the
-- item, line_amount(price * count, line qty), the tablet's own rounding. A
-- price charged once for the line, as a till built before this does, is not
-- marked either: tablets are updated after the migrations run, and an order
-- open across the update keeps what it was rung up with.
--
-- Rebuilt from the live definition on dev (pg_get_functiondef; last written
-- by 0114_customer_accounts.sql). Only the modifier check changes, and the
-- loop over the receipt's lines that it sits in now reads each line's qty.

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
  -- the part paid on account (0114)
  v_acct bigint := 0; v_cust uuid; v_bflags jsonb := '[]'::jsonb;
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
        where id = v_ptype and (is_active or kind in ('deposit', 'account')) and deleted_at is null) then raise exception 'bad-payment'; end if;
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
    -- the part paid on account (0114): a bill on the sale's customer, no change given
    if exists (select 1 from payment_types where id = v_ptype and tenant_id = p_tenant and kind = 'account') then
      if pay->>'tendered' is not null then raise exception 'bad-change'; end if;
      v_acct := v_acct + v_pamt;
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
  for ol in select id, item_id, variant_id, unit_price, list_price, qty, price_kind, price_by, deposit_line_id from ticket_lines where id = any(covered) loop
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
    -- A line's price for an add-on is for as many as were taken (0105), and
    -- since 0123 for every one of the item on the line: it is held against
    -- the catalog's price for that many on each. A till built before 0123
    -- charges it once for the line, and that is not drift either.
    for md in select lm.modifier_id, lm.price as till_price, line_amount(mo.price * lm.qty, ol.qty) as catalog_price
        from ticket_line_modifiers lm join modifiers mo
          on mo.tenant_id = lm.tenant_id and mo.id = lm.modifier_id
        where lm.tenant_id = p_tenant and lm.line_id = ol.id
          and ((line_amount(mo.price * lm.qty, ol.qty) <> lm.price and mo.price * lm.qty <> lm.price)
               or mo.deleted_at is not null) loop
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

  -- On account (0114): the sale is never refused for it (the goods left);
  -- with no customer, from a client without the extra, by someone without
  -- the right, or on a sale paid already, the bill says so for the owner.
  if v_acct > 0 then
    select customer_id into v_cust from tickets where tenant_id = p_tenant and id = v_ticket;
    if v_cust is not null and not exists (select 1 from customers where tenant_id = p_tenant and id = v_cust) then v_cust := null; end if;
    if v_cust is null then v_bflags := v_bflags || jsonb_build_object('why', 'no-customer'); end if;
    if not (has_feature(p_tenant, 'accounts') and exists (select 1 from tenants where id = p_tenant and business_type = 'retail')) then
      v_bflags := v_bflags || jsonb_build_object('why', 'not-entitled');
    end if;
    if not may(p_emp, p, 'sale.on_account') then
      v_bflags := v_bflags || jsonb_build_object('why', 'not-allowed', 'by', p_emp, 'approved_by', nullif(p->>'approved_by', ''));
    end if;
    -- a sale paid already: the customer is not billed twice
    if v_review then v_bflags := v_bflags || jsonb_build_object('why', 'double-pay', 'amount', v_acct); end if;
    if jsonb_array_length(v_bflags) > 0 then v_offline := true; end if;
  end if;

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
  if v_acct > 0 then
    insert into account_bills (id, tenant_id, store_id, device_id, customer_id, number, day, amount, flags)
      values (v_id, p_tenant, v_store, v_device, v_cust, v_number,
        ((case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end)
          at time zone coalesce((select timezone from stores where tenant_id = p_tenant and id = v_store), 'Indian/Mauritius'))::date,
        case when v_review then 0 else v_acct end, v_bflags);
    if jsonb_array_length(v_bflags) > 0 then
      insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
        values (p_tenant, v_id, 'account', jsonb_build_object('amount', v_acct, 'flags', v_bflags));
    end if;
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
end $function$;
