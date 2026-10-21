-- 0132_mra_till.sql — MRA e-invoicing, phase 2: each till signs in to the MRA
-- and sends every sale itself; the server learns what it sent.
--
-- The owner, 2026-10-21: "what we actually need is each tablet signs in to the
-- MRA", the back office shows each till is connected and what is sent, and
-- "Build phase 2 as written, with the MRA public key and address from our
-- server". The plan: docs/superpowers/plans/2026-10-21-mra-phase-2-till.md;
-- the rules: docs/superpowers/specs/2026-10-17-premium-mra-design.md 7, 8, 10.
--
-- Source: the live definitions (db/scripts/dump-function.cjs, dev, 2026-10-21)
-- of sync_push (0114), platform.set_tenant_mra (0116) and
-- platform.set_till_mra_ids (0118).
--
-- What changes:
--   mra_records         one row per document a till issued for the MRA, the
--                       invoice as it was sent (text: jsonb would reorder its
--                       keys). Only the MRA's answer is written after it is
--                       made (trigger); never deleted, by app_user or by
--                       Clear test activity (what was sent to the MRA stays).
--                       No foreign key to receipts or tills: Clear test
--                       activity removes those and the records stay.
--   pos_devices         mra_counter and mra_chain: the till's MRA counter and
--                       the last invoice of each type, which a pull hands
--                       back to a till set up again (design 7); mra_status:
--                       what the till last said of its MRA connection.
--   mra_ebs_state()     an EBS's counter and chains, worked out from
--                       mra_records: set_till_mra_ids gives them to the till
--                       an EBS MRA ID is typed for, so a till made again
--                       (Clear test activity removes tills) goes on from
--                       where its EBS was and never repeats a counter.
--   sync_push           mra.record and mra.status; the codes bad-mra-record,
--                       mra-record-fixed, and mra-no-correction (0116's,
--                       which reached the till as "error" until now).
--   platform.mra_connection, platform.set_mra_connection
--                       the MRA's address and public key, typed once in
--                       /admin, sent to the tills of every client on MRA in
--                       their settings (mra_connect). Nothing of it is
--                       secret; it is not in the app so that a new
--                       certificate needs no app update (the owner's D1).
--   platform.set_tenant_mra
--                       training and live: off from anything, off to setting
--                       up, setting up and training both ways, training to
--                       live. Training and live need the checklist complete
--                       and the MRA connection typed; live needs the client
--                       live on EasyPay (design 7) and sets mra_live_since
--                       once, never cleared. It writes mra, mra_seller and
--                       mra_connect into the settings the tills pull.
--   pos_settings        mra_seller {legal_name, tan, nature} for every client
--                       on MRA, backfilled here; the back office's Company
--                       page writes it from now on.
--
-- The receipt push rule (design 7: the server keeps each receipt as the till
-- sent it, a difference flagged, not rewritten) is met by mra_records: the
-- invoice is kept as sent, and `differs` holds the receipt's figure and the
-- invoice's when the server's receipt does not come to what the MRA was told
-- (the owner's choice 6). push_receipt_create is not touched.
--
-- Never edit after merge.

-- ---------------------------------------------------------------------------
-- mra_records

create table if not exists mra_records (
  id uuid primary key,
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  device_id uuid not null,
  ebs_id text not null,
  receipt_id uuid,
  doc_type text not null check (doc_type in ('STD', 'CRN', 'DRN', 'PRF', 'TRN')),
  counter bigint not null check (counter > 0),
  identifier text not null,
  ref_identifier text,
  previous_hash text not null,
  invoice text not null,
  issued_at timestamptz not null,
  status text not null default 'waiting' check (status in ('waiting', 'unsure', 'check', 'fiscalised', 'refused')),
  irn text,
  qr text,
  errors jsonb not null default '[]'::jsonb,
  warnings jsonb not null default '[]'::jsonb,
  answered_at timestamptz,
  response_id text,
  differs jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
create index if not exists idx_mra_records_tenant_seq on mra_records (tenant_id, server_seq);
create index if not exists idx_mra_records_ebs on mra_records (tenant_id, ebs_id, counter desc);
create index if not exists idx_mra_records_device on mra_records (tenant_id, device_id, issued_at desc);
create index if not exists idx_mra_records_receipt on mra_records (tenant_id, receipt_id) where receipt_id is not null;
alter table mra_records enable row level security;
alter table mra_records force row level security;
drop policy if exists tenant_isolation on mra_records;
create policy tenant_isolation on mra_records using (tenant_id = current_tenant_id()) with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on mra_records;
create trigger trg_touch before insert or update on mra_records for each row execute function touch_row();

-- what was sent stays as it was sent: only the MRA's answer, and the
-- server's note of a difference, are ever written after the row is made
create or replace function mra_records_answer_only() returns trigger
language plpgsql as $$
begin
  if (new.tenant_id, new.store_id, new.device_id, new.ebs_id, new.receipt_id, new.doc_type, new.counter,
      new.identifier, new.ref_identifier, new.previous_hash, new.invoice, new.issued_at, new.deleted_at)
     is distinct from
     (old.tenant_id, old.store_id, old.device_id, old.ebs_id, old.receipt_id, old.doc_type, old.counter,
      old.identifier, old.ref_identifier, old.previous_hash, old.invoice, old.issued_at, old.deleted_at) then
    raise exception 'mra-record-fixed';
  end if;
  return new;
end $$;
drop trigger if exists trg_mra_records_answer_only on mra_records;
create trigger trg_mra_records_answer_only before update on mra_records for each row execute function mra_records_answer_only();
-- never deleted, but by the owner's purge of a whole client (block_update, 0051)
drop trigger if exists trg_mra_records_no_delete on mra_records;
create trigger trg_mra_records_no_delete before delete on mra_records for each row execute function block_update();
revoke delete on mra_records from app_user;

-- ---------------------------------------------------------------------------
-- the till's counter and chains, and its MRA status

alter table pos_devices add column if not exists mra_counter bigint not null default 0;
alter table pos_devices add column if not exists mra_chain jsonb not null default '{}'::jsonb;
alter table pos_devices add column if not exists mra_status jsonb;

-- two chains ({type: {counter, dateTime, totalAmtPaid, brn, invoiceIdentifier}})
-- as one: for each type, the one with the higher counter
create or replace function mra_merge_chain(p_a jsonb, p_b jsonb) returns jsonb
language sql immutable as $$
  select coalesce(jsonb_object_agg(k,
           case when coalesce((p_b->k->>'counter')::bigint, -1) > coalesce((p_a->k->>'counter')::bigint, -1) then p_b->k else p_a->k end),
         '{}'::jsonb)
    from (select jsonb_object_keys(coalesce(p_a, '{}'::jsonb)) as k
          union select jsonb_object_keys(coalesce(p_b, '{}'::jsonb))) ks;
$$;

-- an invoice of mra_records as a link of its chain
create or replace function mra_link(p_counter bigint, p_identifier text, p_invoice jsonb) returns jsonb
language sql immutable as $$
  select jsonb_build_object('counter', p_counter, 'dateTime', p_invoice->>'dateTimeInvoiceIssued',
    'totalAmtPaid', p_invoice->>'totalAmtPaid', 'brn', p_invoice->'seller'->>'brn', 'invoiceIdentifier', p_identifier);
$$;

-- An EBS's counter and the last invoice of each type it issued, from what its
-- tills sent: {counter, chain}.
create or replace function mra_ebs_state(p_tenant uuid, p_ebs text) returns jsonb
language sql stable set search_path to 'public' as $$
  select jsonb_build_object(
    'counter', coalesce((select max(counter) from mra_records where tenant_id = p_tenant and ebs_id = p_ebs), 0),
    'chain', coalesce((select jsonb_object_agg(l.doc_type, mra_link(l.counter, l.identifier, l.invoice::jsonb))
                         from (select distinct on (doc_type) doc_type, counter, identifier, invoice
                                 from mra_records where tenant_id = p_tenant and ebs_id = p_ebs
                                order by doc_type, counter desc) l), '{}'::jsonb));
$$;

-- ---------------------------------------------------------------------------
-- what a till pushes

-- A document the till issued, when it is made (status waiting) and again
-- with each answer from the MRA. A record seen before takes only the answer,
-- and not once it is final (fiscalised or refused).
create or replace function push_mra_record(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path to 'public' as $$
declare
  v_id uuid; v_store uuid; v_device uuid; v_receipt uuid; v_counter bigint; v_issued timestamptz;
  v_type text; v_status text; v_inv jsonb; v_old mra_records%rowtype; v_r record; v_paid bigint;
begin
  begin
    v_id := (p->>'id')::uuid;
    v_store := (p->>'store_id')::uuid;
    v_device := (p->>'device_id')::uuid;
    v_receipt := nullif(p->>'receipt_id', '')::uuid;
    v_counter := (p->>'counter')::bigint;
    v_issued := (p->>'issued_at')::timestamptz;
    v_inv := (p->>'invoice')::jsonb;
  exception when others then
    raise exception 'bad-mra-record';
  end;
  v_type := p->>'type';
  v_status := coalesce(nullif(p->>'status', ''), 'waiting');
  if v_id is null or v_store is null or v_device is null or v_counter is null or v_counter <= 0 or v_issued is null
     or jsonb_typeof(v_inv) <> 'object'
     or v_type is null or v_type not in ('STD', 'CRN', 'DRN', 'PRF', 'TRN')
     or v_status not in ('waiting', 'unsure', 'check', 'fiscalised', 'refused')
     or nullif(btrim(coalesce(p->>'ebs_id', '')), '') is null
     or nullif(btrim(coalesce(p->>'identifier', '')), '') is null
     or nullif(btrim(coalesce(p->>'previous_hash', '')), '') is null then
    raise exception 'bad-mra-record';
  end if;
  if not exists (select 1 from pos_devices where tenant_id = p_tenant and id = v_device and store_id = v_store and deleted_at is null) then
    raise exception 'bad-mra-record';
  end if;

  select * into v_old from mra_records where tenant_id = p_tenant and id = v_id for update;
  if not found then
    insert into mra_records (id, tenant_id, store_id, device_id, ebs_id, receipt_id, doc_type, counter, identifier, ref_identifier,
                             previous_hash, invoice, issued_at, status, irn, qr, errors, warnings, answered_at, response_id)
    values (v_id, p_tenant, v_store, v_device, p->>'ebs_id', v_receipt, v_type, v_counter, p->>'identifier', nullif(p->>'ref_identifier', ''),
            p->>'previous_hash', p->>'invoice', v_issued, v_status, nullif(p->>'irn', ''), nullif(p->>'qr', ''),
            coalesce(case when jsonb_typeof(p->'errors') = 'array' then p->'errors' end, '[]'::jsonb),
            coalesce(case when jsonb_typeof(p->'warnings') = 'array' then p->'warnings' end, '[]'::jsonb),
            nullif(p->>'answered_at', '')::timestamptz, nullif(p->>'response_id', ''));
  else
    -- the same document, or nothing: what was sent never changes
    if v_old.counter <> v_counter or v_old.invoice <> p->>'invoice' or v_old.doc_type <> v_type then
      raise exception 'mra-record-fixed';
    end if;
    if v_old.status not in ('fiscalised', 'refused') then
      update mra_records set status = v_status, irn = nullif(p->>'irn', ''), qr = nullif(p->>'qr', ''),
             errors = coalesce(case when jsonb_typeof(p->'errors') = 'array' then p->'errors' end, '[]'::jsonb),
             warnings = coalesce(case when jsonb_typeof(p->'warnings') = 'array' then p->'warnings' end, '[]'::jsonb),
             answered_at = nullif(p->>'answered_at', '')::timestamptz, response_id = nullif(p->>'response_id', '')
       where tenant_id = p_tenant and id = v_id;
    end if;
  end if;

  -- the receipt as the server worked it out, against what the MRA was told:
  -- the invoice's total paid is the receipt's total before cash rounding
  if v_receipt is not null and v_type in ('STD', 'CRN', 'TRN') then
    select total, rounding into v_r from receipts where tenant_id = p_tenant and id = v_receipt;
    if found then
      v_paid := round((v_inv->>'totalAmtPaid')::numeric * 100)::bigint;
      update mra_records set differs = case when v_r.total - v_r.rounding <> v_paid
               then jsonb_build_object('receipt', v_r.total - v_r.rounding, 'invoice', v_paid) end
       where tenant_id = p_tenant and id = v_id and differs is distinct from
             case when v_r.total - v_r.rounding <> v_paid then jsonb_build_object('receipt', v_r.total - v_r.rounding, 'invoice', v_paid) end;
    end if;
  end if;

  -- the till's counter and chain, for the day it is set up again
  update pos_devices
     set mra_counter = greatest(mra_counter, v_counter),
         mra_chain = mra_merge_chain(mra_chain, jsonb_build_object(v_type, mra_link(v_counter, p->>'identifier', v_inv)))
   where tenant_id = p_tenant and id = v_device
     and (mra_counter < v_counter or coalesce((mra_chain->v_type->>'counter')::bigint, 0) < v_counter);

  return jsonb_build_object('id', v_id, 'status', (select status from mra_records where tenant_id = p_tenant and id = v_id));
end $$;

-- What the till last said of its connection to the MRA (signed in until,
-- refused and why, how many wait, the last fiscalised), with the server's time.
create or replace function push_mra_status(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb
language plpgsql set search_path to 'public' as $$
declare v_device uuid;
begin
  begin
    v_device := (p->>'device_id')::uuid;
  exception when others then
    raise exception 'bad-mra-record';
  end;
  if v_device is null or jsonb_typeof(p->'status') <> 'object' or length((p->'status')::text) > 4000 then
    raise exception 'bad-mra-record';
  end if;
  update pos_devices set mra_status = (p->'status') || jsonb_build_object('at', now())
   where tenant_id = p_tenant and id = v_device and deleted_at is null;
  if not found then raise exception 'bad-mra-record'; end if;
  return jsonb_build_object('device_id', v_device);
end $$;

-- ---------------------------------------------------------------------------
-- sync_push: the live definition (0114), with mra.record, mra.status and
-- their codes

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
    'not-entitled','bad-deposit',
    -- a shop's customer accounts (0114)
    'bad-account',
    -- MRA e-invoicing: a payment not corrected on a live client (0116), what a till sent the MRA (0132)
    'mra-no-correction','bad-mra-record','mra-record-fixed'];
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
          -- a shop's customer accounts (0114)
          when 'account.pay' then v_data := push_account_pay(tenant, v_emp, v_payload);
          -- MRA e-invoicing: what a till sent the MRA, and its connection (0132)
          when 'mra.record' then v_data := push_mra_record(tenant, v_emp, v_payload);
          when 'mra.status' then v_data := push_mra_status(tenant, v_emp, v_payload);
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

-- ---------------------------------------------------------------------------
-- the MRA's address and public key, for every client's tills

do $$
begin
  if not exists (select 1 from pg_tables where schemaname = 'platform' and tablename = 'mra_connection') then
    create table platform.mra_connection (
      id int primary key default 1 check (id = 1),
      url text not null,
      certificate text not null,
      updated_at timestamptz not null default now()
    );
  end if;
end $$;

-- what a client's tills are told of the MRA: its state, the seller's details
-- the invoices carry, and the MRA's address and key
create or replace function platform.mra_settings(p_tenant uuid) returns jsonb
language sql stable set search_path to 'public' as $$
  select jsonb_build_object(
    'mra', t.mra,
    'mra_seller', jsonb_build_object('legal_name', coalesce(t.legal_name, ''), 'tan', coalesce(t.tan, ''), 'nature', coalesce(t.mra_nature, '')),
    'mra_connect', coalesce((select jsonb_build_object('url', c.url, 'certificate', c.certificate) from platform.mra_connection c where c.id = 1), 'null'::jsonb))
    from tenants t where t.id = p_tenant;
$$;

create or replace function platform.write_mra_settings(p_tenant uuid) returns void
language plpgsql set search_path to 'public' as $$
begin
  perform set_config('app.tenant_id', p_tenant::text, true);
  insert into pos_settings (tenant_id, data) values (p_tenant, platform.mra_settings(p_tenant))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
end $$;

create or replace function platform.set_mra_connection(p_admin uuid, p_url text, p_certificate text) returns integer
language plpgsql set search_path to 'public' as $$
declare v_url text := btrim(coalesce(p_url, '')); v_cert text := btrim(coalesce(p_certificate, '')); r record; v_n integer := 0;
begin
  perform platform.require_admin(p_admin);
  if v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$' then raise exception 'bad-mra-url'; end if;
  if v_cert !~ '^-----BEGIN CERTIFICATE-----' or v_cert !~ '-----END CERTIFICATE-----$' or length(v_cert) > 20000 then
    raise exception 'bad-mra-certificate';
  end if;
  insert into platform.mra_connection (id, url, certificate, updated_at) values (1, rtrim(v_url, '/'), v_cert, now())
    on conflict (id) do update set url = excluded.url, certificate = excluded.certificate, updated_at = now();
  for r in select id from tenants where mra <> 'off' and deleted_at is null loop
    perform platform.write_mra_settings(r.id);
    v_n := v_n + 1;
  end loop;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'mra.connection', null, jsonb_build_object('url', rtrim(v_url, '/'), 'clients', v_n));
  return v_n;
end $$;

-- ---------------------------------------------------------------------------
-- training and live

CREATE OR REPLACE FUNCTION platform.set_tenant_mra(p_admin uuid, p_tenant uuid, p_state text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_old text;
begin
  perform platform.require_admin(p_admin);
  if p_state is null or p_state not in ('off', 'setting_up', 'training', 'live') then raise exception 'bad-mra-state'; end if;
  select mra into v_old from tenants where id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'unknown-tenant'; end if;
  if v_old = p_state then return; end if;
  -- off from anything; off to setting up; setting up and training both ways; training to live
  if not (p_state = 'off' or (v_old, p_state) in (('off', 'setting_up'), ('setting_up', 'training'), ('training', 'setting_up'), ('training', 'live'))) then
    raise exception 'bad-mra-move';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  if p_state in ('training', 'live') then
    if exists (select 1 from jsonb_array_elements(mra_checklist(p_tenant)) x where not coalesce((x->>'ok')::boolean, false)) then
      raise exception 'mra-checklist';
    end if;
    if not exists (select 1 from platform.mra_connection) then raise exception 'mra-no-connection'; end if;
  end if;
  -- the MRA counts a client's invoices once its sales are its books (design 7)
  if p_state = 'live' and platform.is_setting_up(p_tenant) then raise exception 'mra-before-go-live'; end if;
  update tenants set mra = p_state,
         mra_live_since = case when p_state = 'live' then coalesce(mra_live_since, now()) else mra_live_since end
   where id = p_tenant;
  -- the tills learn it, the seller's details and the MRA's address through the settings they pull
  perform platform.write_mra_settings(p_tenant);
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.mra', p_tenant, jsonb_build_object('from', v_old, 'to', p_state));
end $function$
;

-- ---------------------------------------------------------------------------
-- an EBS MRA ID typed for a till brings its EBS's counter and chains with it

CREATE OR REPLACE FUNCTION platform.set_till_mra_ids(p_admin uuid, p_tenant uuid, p_ids jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_changes jsonb;
  v_n integer := 0;
  v_state jsonb;
begin
  perform platform.require_admin(p_admin);
  if p_ids is null or jsonb_typeof(p_ids) <> 'object' then raise exception 'bad-mra-id'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  perform 1 from pos_devices d
    where d.tenant_id = p_tenant and d.id::text in (select jsonb_object_keys(p_ids))
    order by d.id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id', d.id, 'was', d.mra_ebs_id, 'want', w.want) order by d.id), '[]'::jsonb)
    into v_changes
    from (select e.key as id, nullif(btrim(e.value #>> '{}'), '') as want from jsonb_each(p_ids) e) w
    join pos_devices d on d.tenant_id = p_tenant and d.id::text = w.id
   where d.mra_ebs_id is distinct from w.want;
  for r in select x->>'id' as id, x->>'was' as was, x->>'want' as want from jsonb_array_elements(v_changes) x loop
    if r.want is not null and r.want !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'bad-mra-id'; end if;
    update pos_devices set mra_ebs_id = null where tenant_id = p_tenant and id = r.id::uuid;
  end loop;
  for r in select x->>'id' as id, x->>'was' as was, x->>'want' as want from jsonb_array_elements(v_changes) x loop
    if r.want is not null then
      begin
        update pos_devices set mra_ebs_id = r.want where tenant_id = p_tenant and id = r.id::uuid;
      exception when unique_violation then
        raise exception 'mra-id-taken';
      end;
      -- the EBS goes on from where it was: a till made again, or the EBS
      -- moved to another till, never repeats a counter (0132)
      v_state := mra_ebs_state(p_tenant, r.want);
      update pos_devices set mra_counter = greatest(mra_counter, (v_state->>'counter')::bigint),
             mra_chain = mra_merge_chain(mra_chain, v_state->'chain')
       where tenant_id = p_tenant and id = r.id::uuid;
    end if;
    insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
      values (p_admin, 'till.mra_id', p_tenant, jsonb_build_object('till', r.id::uuid, 'from', r.was, 'to', r.want));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $function$
;

-- ---------------------------------------------------------------------------
-- the clients on MRA today: their tills are told the seller's details

do $$
declare r record;
begin
  for r in select id from tenants where mra <> 'off' and deleted_at is null loop
    perform platform.write_mra_settings(r.id);
  end loop;
end $$;
