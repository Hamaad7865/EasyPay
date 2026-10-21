-- 0128_loyalty_points.sql — loyalty points for every business, on every plan
-- (docs/superpowers/specs/2026-10-21-loyalty-points-design.md).
-- Source: push_receipt_create (last written by 0123_addons_per_item.sql),
-- push_refund_create (0114_customer_accounts.sql), push_customer_upsert
-- (0055_seats_and_customers.sql), push_settings_save (0114) and
-- platform.clear_test_activity (0114) are the live definitions on dev
-- (pg_get_functiondef) with the edits listed here. Earlier migrations
-- untouched.
--
-- What changes:
--   - customers.points: the customer's balance in cents (a point is a
--     rupee), kept by the functions below; customers.card: a card number
--     the till's scanner reads, or none.
--   - receipts.customer_id, points_earned, points_used: who earned or used
--     points on a receipt and how much. A refund holds what it took back
--     (points_earned, at most 0) and gave back (points_used, at most 0). A
--     customer's balance is always the sum of points_earned - points_used
--     over their receipts.
--   - receipt.create: a discount marked "points": true is the customer's
--     points, spent; it needs no right to discount and no approval. The
--     block "points": {customer_id, earned} says what the receipt earned.
--     The till's figures stand (they were printed, and an offline tablet's
--     queue must come out as the tablet had it), held to bounds: an unknown
--     customer drops the points, more points used than the balance is
--     stored, earned below zero or past the total is held to it; each is
--     flagged (receipt_reviews reason "points"), none refused.
--   - refund.create: "points": {customer_id, taken, back}, each held to what
--     is left of the sale's points; past it held and flagged.
--   - customer.upsert takes card: present sets it (blank clears it), absent
--     keeps it. It never touches the points.
--   - settings.save takes loyalty (on/off) and loyaltyBp (1 to 10000).
--   - Clear test activity puts every balance back to the sum of the
--     receipts left (none).
--   - sync_pull sends whole rows already: no change.
-- Never edit after merge.

alter table customers add column if not exists points bigint not null default 0;
alter table customers add column if not exists card text;
create index if not exists idx_customers_card on customers (tenant_id, card) where card is not null;

alter table receipts add column if not exists customer_id uuid;
alter table receipts add column if not exists points_earned bigint not null default 0;
alter table receipts add column if not exists points_used bigint not null default 0;
alter table receipts drop constraint if exists receipts_customer_fk;
alter table receipts add constraint receipts_customer_fk
  foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete set null (customer_id);
create index if not exists idx_receipts_customer on receipts (tenant_id, customer_id) where customer_id is not null;

alter table receipt_reviews drop constraint if exists receipt_reviews_reason_check;
alter table receipt_reviews add constraint receipt_reviews_reason_check
  check (reason in ('double-pay', 'underpaid', 'overpaid', 'price-drift', 'number-collision', 'price-unapproved',
                    'exchange-unmatched', 'discount-unapproved', 'refund-unapproved', 'credit-note-refused', 'credit-overspent',
                    'deposit-overused', 'account', 'points'));

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
  -- loyalty points (0128): used (the Points discount), earned, by whom
  v_ispts boolean; v_pts bigint := 0; v_earn bigint := 0; v_pcust uuid; v_pbal bigint; v_pflags jsonb := '[]'::jsonb;
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
  -- the customer's points spent (0128) are not a discount the shop gives:
  -- they need no right to discount
  if (select count(*) from jsonb_array_elements(case when jsonb_typeof(p->'discounts') = 'array' then p->'discounts' else '[]'::jsonb end) as e
       where coalesce(e->>'points', '') <> 'true') > 0 and not may(p_emp, p, 'sale.apply_discount') then
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
    -- the Points discount (0128): an amount of the customer's own, from no catalogue
    v_ispts := coalesce(d->>'points', '') = 'true';
    if v_ispts then
      if v_did is not null or v_dtype <> 'amount' then raise exception 'bad-discount'; end if;
      v_why := null;
    end if;
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
    if v_ispts then v_pts := v_pts + v_amt; end if;
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
  if v_pct < 0 or v_pct > 3000 then raise exception 'bad-payload'; end if;
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

  -- Loyalty points (0128). The till's figures stand: they were printed, and
  -- an offline tablet's queue must come out as the tablet had it. They are
  -- held to bounds, and what is out of them is flagged, never refused.
  if v_pts > 0 or p ? 'points' then
    begin
      v_pcust := nullif(p->'points'->>'customer_id', '')::uuid;
    exception when others then v_pcust := null;
    end;
    -- points used, and no customer named: the order's customer
    if v_pcust is null and nullif(p->'points'->>'customer_id', '') is null then
      select customer_id into v_pcust from tickets where tenant_id = p_tenant and id = v_ticket;
    end if;
    begin
      v_earn := coalesce((p->'points'->>'earned')::bigint, 0);
    exception when others then v_earn := -1;
    end;
    select points into v_pbal from customers where tenant_id = p_tenant and id = v_pcust for update;
    if not found then
      v_pflags := v_pflags || jsonb_build_object('why', 'no-customer', 'customer_id', p->'points'->>'customer_id', 'earned', p->'points'->>'earned', 'used', v_pts);
      v_pcust := null; v_earn := 0; v_pts := 0;
    else
      if v_earn < 0 or v_earn > greatest(v_total, 0) then
        v_pflags := v_pflags || jsonb_build_object('why', 'over-earned', 'till', p->'points'->>'earned', 'total', v_total);
        v_earn := least(greatest(v_earn, 0), greatest(v_total, 0));
      end if;
      -- two tills apart spending the same points: the balance goes below zero
      if v_pts > v_pbal then
        v_pflags := v_pflags || jsonb_build_object('why', 'overspent', 'used', v_pts, 'balance', v_pbal);
      end if;
    end if;
    if jsonb_array_length(v_pflags) > 0 then v_offline := true; end if;
  end if;

  insert into receipts (id, tenant_id, store_id, device_id, ticket_id, number, type,
      subtotal, discount_total, tax_total, service_charge, rounding, total,
      employee_id, device_time, needs_review, customer_id, points_earned, points_used)
    values (v_id, p_tenant, v_store, v_device, v_ticket, v_number, 'sale',
      v_sub, v_disc, v_tax_add + v_tax_incl, v_service, v_round, v_total, p_emp,
      case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end,
      v_review or v_offline, v_pcust, v_earn, v_pts);
  if v_pcust is not null and v_earn <> v_pts then
    update customers set points = points + v_earn - v_pts where tenant_id = p_tenant and id = v_pcust;
  end if;
  if jsonb_array_length(v_pflags) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'points', jsonb_build_object('flags', v_pflags));
  end if;

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
end $function$
;

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
  -- at the cost its sale left at
  for v_sm in
    -- a line made of others gives its parts back (0112), as they are now
    select x.item_id, x.variant_id, sum(x.qty)::int as qty
      from _rlines rr join _rshare sx on sx.oline = rr.oline
      join ticket_lines tl on tl.tenant_id = p_tenant and tl.id = sx.tlid
      cross join lateral stock_parts(p_tenant, tl.item_id, tl.variant_id, rr.r_qty) x
     group by x.item_id, x.variant_id
     order by x.item_id, x.variant_id
  loop
    perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, v_sm.qty, 'refund',
      (select m.unit_cost from stock_movements m
        where m.tenant_id = p_tenant and m.reason = 'sale' and m.ref_type = 'receipt'
          and m.item_id = v_sm.item_id
          and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(v_sm.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          and m.ref_id in (select r.id from receipts r where r.tenant_id = p_tenant and r.ticket_id = o.ticket_id)
        order by m.created_at desc limit 1),
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

CREATE OR REPLACE FUNCTION public.push_customer_upsert(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_id uuid; v_name text; v_card text;
begin
  v_id := (p->>'id')::uuid;
  v_name := btrim(coalesce(p->>'name', ''));
  if v_id is null or v_name = '' or length(v_name) > 120 then raise exception 'bad-payload'; end if;
  -- the card (0128): sent sets it, blank clears it, not sent keeps it. Never
  -- refused for another customer holding it (two tills apart can both give
  -- one number); the till and the back office refuse that themselves.
  v_card := nullif(btrim(coalesce(p->>'card', '')), '');
  if length(v_card) > 40 then raise exception 'bad-payload'; end if;
  insert into customers (id, tenant_id, name, phone, email, note, card)
    values (v_id, p_tenant, v_name, nullif(btrim(coalesce(p->>'phone', '')), ''), nullif(btrim(coalesce(p->>'email', '')), ''),
      nullif(btrim(coalesce(p->>'note', '')), ''), v_card)
    on conflict (id) do update set name = excluded.name, phone = excluded.phone, email = excluded.email, note = excluded.note,
      card = case when p ? 'card' then excluded.card else customers.card end,
      deleted_at = null
    where customers.tenant_id = p_tenant;
  return jsonb_build_object('id', v_id);
end $function$
;

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
  -- a shop's customer accounts (0114)
  if p ? 'accounts' then
    if p->>'accounts' not in ('on', 'off') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('accounts', p->>'accounts');
  end if;
  if p ? 'accountDays' then
    begin v_int := (p->>'accountDays')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('accountDays', v_int);
  end if;
  -- loyalty points, for every business (0128)
  if p ? 'loyalty' then
    if p->>'loyalty' not in ('on', 'off') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('loyalty', p->>'loyalty');
  end if;
  if p ? 'loyaltyBp' then
    begin v_int := (p->>'loyaltyBp')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 1 and 10000 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('loyaltyBp', v_int);
  end if;
  if v_patch <> '{}'::jsonb then
    insert into pos_settings (tenant_id, data) values (p_tenant, v_patch)
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('saved', (select count(*) from jsonb_object_keys(v_patch)));
end $function$
;

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
end $function$
;

