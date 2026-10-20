-- 0127: a 57 mm roll in a printer made for 80 mm (paper_mm 57).
--
-- Star Grill's receipts on 58 mm lost about four characters at the left
-- ("r type" for "Order type") while the right column stopped well short of
-- the paper's edge, and centred lines sat in the middle of the roll: the
-- printer lays out an 80 mm line (576 dots) with the 57 mm roll in a guide
-- in the middle of it, so a 32-character line starting at its left edge
-- starts off the paper (2026-10-20).
--
-- paper_mm 57 says so. The till then prints 32 characters, as on 58 mm, and
-- tells the printer to print in the middle 48 mm of its line (a left margin
-- of 96 dots and a print area of 384). A till built before this prints 57 as
-- it prints 58, which is what it does today. The back office and the till's
-- printer.save take 57 as they take 58 and 80. Rebuilt from
-- 0089_first_run_setup.sql, the last to write push_printer_save; only the
-- paper's test is new.

alter table printers drop constraint if exists printers_paper_mm_check;
alter table printers add constraint printers_paper_mm_check check (paper_mm in (57, 58, 80));

CREATE OR REPLACE FUNCTION public.push_printer_save(p_tenant uuid, p_emp uuid, p jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_id uuid; v_store uuid; v_name text; v_kind text; v_address text; v_paper int;
  v_was record; v_first boolean;
  -- the back office's rule for an address (printers/page.tsx)
  ip constant text := '^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}(:\d{2,5})?$';
begin
  begin
    v_id := (p->>'id')::uuid; v_store := (p->>'store_id')::uuid; v_paper := coalesce((p->>'paper_mm')::int, 80);
  exception when others then
    raise exception 'bad-payload';
  end;
  v_name := left(btrim(coalesce(p->>'name', '')), 40);
  v_kind := coalesce(p->>'kind', '');
  v_address := left(btrim(coalesce(p->>'address', '')), 40);
  if v_id is null or v_store is null or v_kind not in ('network', 'usb', 'bluetooth') or v_paper not in (57, 58, 80)
     or (p ? 'one_printer' and jsonb_typeof(p->'one_printer') <> 'boolean') then raise exception 'bad-payload'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  -- a network printer has an IP address; a Bluetooth one the name or address the tablet pairs it by,
  -- which an IP address is not (0088)
  if (v_kind = 'network' and v_address !~ ip) or (v_kind = 'bluetooth' and (v_address = '' or v_address ~ ip)) then
    raise exception 'bad-address';
  end if;
  if v_kind = 'usb' then v_address := null; end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-store';
  end if;
  select store_id, kind, deleted_at into v_was from printers where id = v_id and tenant_id = p_tenant for update;
  if found then
    -- removed, a kitchen screen (the back office's), or a printer of another store of the business
    if v_was.deleted_at is not null or v_was.kind = 'screen' or v_was.store_id <> v_store then
      raise exception 'bad-printer';
    end if;
    -- its receipts, its feed and cut, its place and whether it is switched on are left as they are
    update printers set name = v_name, kind = v_kind, address = v_address, paper_mm = v_paper
     where id = v_id and tenant_id = p_tenant;
  else
    -- the first printer of a store is where its receipts come out (saves.addPrinter)
    v_first := not exists (select 1 from printers where tenant_id = p_tenant and store_id = v_store
                             and deleted_at is null and kind <> 'screen');
    -- an id that is another client's printer stops here on the primary key, and is answered 'conflict'
    insert into printers (id, tenant_id, store_id, name, kind, address, paper_mm, is_receipt, sort_order)
      values (v_id, p_tenant, v_store, v_name, v_kind, v_address, v_paper, v_first,
        (select coalesce(max(sort_order), -1) + 1 from printers where tenant_id = p_tenant));
  end if;
  if p ? 'one_printer' then
    insert into pos_settings (tenant_id, data)
      values (p_tenant, jsonb_build_object('onePrinter', (p->>'one_printer')::boolean))
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end if;
  return jsonb_build_object('printer_id', v_id, 'created', v_first is not null,
    'receipt', (select is_receipt from printers where id = v_id and tenant_id = p_tenant));
end $function$;
