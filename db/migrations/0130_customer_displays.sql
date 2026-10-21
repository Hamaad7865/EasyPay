-- 0130: a customer display is a printer row of kind "display".
--
-- The owner asked what is missing to beat Loyverse, which gives away a
-- customer display: a second tablet, the same app, facing the customer,
-- showing the order as it is rung up, its discounts and VAT, the total and
-- the change, over the shop's own Wi-Fi, with or without internet. They
-- chose: free on every plan, restaurants and shops, words only, the name,
-- logo and a typed message between sales, paired in the back office under
-- Printers like a kitchen screen (0086), and on an offline-edition tablet
-- from the tablet itself.
--
-- So a display sits where the kitchen screens sit:
--
--   kind       'display', beside 'network', 'usb', 'bluetooth' and 'screen'
--   address    the display tablet's address on the Wi-Fi, as it shows it
--              (ip, or ip:port; the till uses port 9311 when none is given)
--   pair_code  the code the display shows; the till signs what it sends
--              with it, and the display shows nothing else
--   device_id  the till it faces: a display shows one till's sale. Required
--              for a display, nothing for any other kind.
--   message    its two lines for between sales, at most 120 characters
--
-- A display shows, it never prints: it is never the receipt printer, never
-- a store's first printer (so a printer added after it still takes the
-- receipts), and it has its address, its code and its till or it is not a
-- display. There is no plan trigger: displays are free on every plan.
--
-- push_printer_save is rebuilt from its live definition (0127, the last to
-- write it) so that a till can add a display too: an offline-edition tablet
-- adds its own, and when such a business goes to the cloud, its queue
-- (printer.save with kind 'display') is sent up and must be taken. Its two
-- tests of "not a kitchen screen" become "not a kitchen screen or a display".
-- A display with a code that is not one is refused 'bad-address', a code
-- sync_push already knows (the till's form says "address or code").
--
-- A pull hands out whole rows: tills are sent the two new columns with no
-- change to sync_pull. A till older than the build that knows displays takes
-- a display for a network printer at port 9100: it prints nothing on it (a
-- display is never the receipt printer and never ticked), but lists it under
-- Printers as not answering. The release that carries this raises
-- MIN_TILL_VERSION to the build that knows displays.

alter table printers drop constraint if exists printers_kind_check;
alter table printers add constraint printers_kind_check check (kind in ('network', 'usb', 'bluetooth', 'screen', 'display'));
alter table printers add column if not exists device_id uuid;
alter table printers add column if not exists message text;

alter table printers drop constraint if exists printers_display_check;
alter table printers add constraint printers_display_check
  check (
    (kind = 'display' and not is_receipt and pair_code is not null and btrim(pair_code) <> ''
       and address is not null and btrim(address) <> '' and device_id is not null
       and (message is null or char_length(message) <= 120))
    or (kind <> 'display' and device_id is null and message is null)
  );

-- The till a display faces is a till of its own store. Checked when a
-- display is written with another till than it had; a till removed later
-- leaves the row as it is (the Printers page says so).
create or replace function printers_display_device() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.kind = 'display' and new.deleted_at is null
     and (tg_op = 'INSERT' or new.device_id is distinct from old.device_id or old.kind <> 'display' or new.store_id <> old.store_id)
     and not exists (select 1 from pos_devices d where d.id = new.device_id and d.tenant_id = new.tenant_id
                       and d.store_id = new.store_id and d.deleted_at is null) then
    raise exception 'bad-device';
  end if;
  return new;
end $fn$;

drop trigger if exists printers_display_device on printers;
create trigger printers_display_device before insert or update on printers
  for each row execute function printers_display_device();

CREATE OR REPLACE FUNCTION public.push_printer_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_store uuid; v_name text; v_kind text; v_address text; v_paper int;
  v_was record; v_first boolean; v_new boolean := false;
  -- a display's (0130)
  v_code text; v_device uuid; v_message text;
  -- the back office's rule for an address (printers/page.tsx)
  ip constant text := '^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$';
begin
  begin
    v_id := (p->>'id')::uuid; v_store := (p->>'store_id')::uuid; v_paper := coalesce((p->>'paper_mm')::int, 80);
    v_device := nullif(p->>'device_id', '')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_name := left(btrim(coalesce(p->>'name', '')), 40);
  v_kind := coalesce(p->>'kind', '');
  v_address := left(btrim(coalesce(p->>'address', '')), 40);
  if v_id is null or v_store is null or v_kind not in ('network', 'usb', 'bluetooth', 'display') or v_paper not in (57, 58, 80)
     or (p ? 'one_printer' and jsonb_typeof(p->'one_printer') <> 'boolean') then raise exception 'bad-payload'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  -- a network printer and a display have an IP address; a Bluetooth printer the name or address the tablet pairs
  -- it by, which an IP address is not (0088)
  if (v_kind in ('network', 'display') and v_address !~ ip) or (v_kind = 'bluetooth' and (v_address = '' or v_address ~ ip)) then
    raise exception 'bad-address';
  end if;
  if v_kind = 'usb' then v_address := null; end if;
  if v_kind = 'display' then
    -- the code as the display shows it, however it was typed (PairCode.tidy): eight of these letters and digits
    v_code := upper(regexp_replace(coalesce(p->>'pair_code', ''), '[\s-]', '', 'g'));
    if v_code !~ '^[A-HJ-NP-Z2-9]{8}$' then raise exception 'bad-address'; end if;
    if v_device is null then raise exception 'bad-device'; end if;
    v_message := nullif(left(btrim(coalesce(p->>'message', '')), 120), '');
  else
    -- only a display faces a till and has a message
    v_device := null;
  end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-store';
  end if;
  select store_id, kind, deleted_at into v_was from printers where id = v_id and tenant_id = p_tenant for update;
  if found then
    -- removed, a kitchen screen (the back office's), a printer of another store of the business, or a
    -- display becoming a printer or a printer a display
    if v_was.deleted_at is not null or v_was.kind = 'screen' or v_was.store_id <> v_store
       or (v_was.kind = 'display') <> (v_kind = 'display') then
      raise exception 'bad-printer';
    end if;
    -- its receipts, its feed and cut, its place and whether it is switched on are left as they are
    update printers set name = v_name, kind = v_kind, address = v_address, paper_mm = v_paper,
           pair_code = case when v_kind = 'display' then v_code else pair_code end,
           device_id = v_device, message = v_message
     where id = v_id and tenant_id = p_tenant;
  else
    v_new := true;
    -- the first printer of a store is where its receipts come out (saves.addPrinter); a display never is
    v_first := v_kind <> 'display' and not exists (select 1 from printers where tenant_id = p_tenant and store_id = v_store
                             and deleted_at is null and kind not in ('screen', 'display'));
    -- an id that is another client's printer stops here on the primary key, and is answered 'conflict'
    insert into printers (id, tenant_id, store_id, name, kind, address, paper_mm, is_receipt, sort_order, pair_code, device_id, message)
      values (v_id, p_tenant, v_store, v_name, v_kind, v_address, v_paper, v_first,
        (select coalesce(max(sort_order), -1) + 1 from printers where tenant_id = p_tenant),
        v_code, v_device, v_message);
  end if;
  if p ? 'one_printer' then
    insert into pos_settings (tenant_id, data)
      values (p_tenant, jsonb_build_object('onePrinter', (p->>'one_printer')::boolean))
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('printer_id', v_id, 'created', v_new,
    'receipt', (select is_receipt from printers where id = v_id and tenant_id = p_tenant));
end $function$;
