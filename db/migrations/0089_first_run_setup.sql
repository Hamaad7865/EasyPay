-- 0089: what a tablet sets up on its first run.
--
-- The owner asked: "We need to create an onboarding flow for POS right after
-- sign in for the first time". A client made in /admin has its store, its
-- roles, its payment types and its VAT, and nothing to sell, no tables, no
-- printer, no staff PINs and no address: its tablet opened on "Register is
-- locked" over an empty till. Asked what the flow should cover on the tablet,
-- the owner chose all of it: something to sell (which a till could already
-- make, 0084 and 0087), "Tables (restaurants), Printer, Staff and PINs,
-- Business details". Each of those four was the back office's only.
--
--   tables.add      adds the tables of a new room, and changes none: the plan
--                   is drawn in the back office. A room is sent whole, up to
--                   60 tables, the store never above 300. A table the store
--                   has already is skipped, so a room sent twice adds
--                   nothing. A room the store has cannot be added to, and a
--                   table's name is its own in the whole store.
--   printer.save    makes a printer, or changes its name, how it is reached
--                   and its paper. The first printer of a store prints its
--                   receipts, as one made in the back office does. It may
--                   say whether one printer does everything (onePrinter). A
--                   kitchen screen stays the back office's.
--   company.save    writes what Company details writes: tenants, and the
--                   settings a till prints from.
--   staff.save      adds a member of staff with no login, at every store, as
--                   the Staff page does. Sent twice, the person is left as
--                   they are.
--   staff.set_pin   sets a PIN. Both take its hash, made on the tablet the
--                   way web/lib/pin.ts makes it, and nothing of another
--                   shape; the PIN itself is never sent.
--   setup.finish    marks the set-up done, for every tablet of the business.
--
-- Each asks for the right the back office asks for the same change, the
-- person's own or the approver's (may): settings.device for the tables, the
-- printer, the details and the finish; employees.edit, which only the owner
-- holds, for staff and PINs.
--
-- The mark is pos_settings.data.setup: 'open' or 'done'. platform.create_tenant
-- writes 'open', so a client made in /admin from now on is walked through the
-- set-up by the first tablet signed in for it. A client with no mark is never
-- shown it: every client there is today, and that is on purpose.
--
-- A BRN or a VAT number typed in /admin was written to tenants alone, and
-- tenants is in no pull: it reached no till and printed on no receipt until
-- Company details was saved in the back office. The tablet's own form for
-- these would have opened on empty boxes and wiped what /admin held when it
-- saved. So platform.set_tenant_details now writes the name, the BRN and the
-- VAT number into the settings as well, and once, here, for every client,
-- what tenants holds and the settings lack is copied in
-- (company_from_tenants). Nothing a client saved is overwritten, and its
-- address and phone are left as they are. Asked whether that should reach the
-- clients there are, whose receipts will print these from their next sync,
-- the owner said: "Yes, send them".
--
-- New refusals:
--   too-many       the store would hold more than 300 tables
--   room-exists    the store has a room of that name
--   name-taken     a table of that name is in the store, or twice in the room
--   bad-address    a network printer with no IP address, a Bluetooth one with
--                  none or with an IP address
--   bad-printer    the printer is gone, is a kitchen screen, or is another
--                  store's
--   bad-role       the role is gone, or not this client's
--   bad-pin        not a hash of the shape the till checks
--   unknown-staff  the member of staff is gone, or not this client's
-- and of those there were: bad-store, name-required, forbidden, bad-payload,
-- and conflict for an id that is another client's.
--
-- platform.create_tenant, platform.set_tenant_details and sync_push are as
-- they were on dev (as 0085, 0045 and 0087 left them), with these lines
-- added. Never edit after merge.

create or replace function push_tables_add(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_store uuid; v_area text; t jsonb; v_id uuid; v_name text;
  v_seats int; v_shape text; v_x int; v_y int; v_w int; v_h int;
  v_new jsonb := '[]'::jsonb; v_names text[] := '{}'; v_have int; v_sort int; v_added int := 0;
begin
  begin
    v_store := (p->>'store_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_area := left(btrim(coalesce(p->>'area', '')), 30);
  if v_store is null or v_area = '' or jsonb_typeof(p->'tables') is distinct from 'array'
     or jsonb_array_length(p->'tables') not between 1 and 60 then raise exception 'bad-payload'; end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-store';
  end if;
  -- one room at a time in a store: two tills adding rooms wait for each other
  perform pg_advisory_xact_lock(hashtextextended('tables.add:' || v_store::text, 0));
  for t in select * from jsonb_array_elements(p->'tables') loop
    begin
      v_id := (t->>'id')::uuid; v_seats := (t->>'seats')::int;
      v_x := (t->>'x')::int; v_y := (t->>'y')::int; v_w := (t->>'w')::int; v_h := (t->>'h')::int;
    exception when others then
      raise exception 'bad-payload';
    end;
    v_name := left(btrim(coalesce(t->>'name', '')), 30);
    v_shape := coalesce(t->>'shape', 'square');
    -- the table's own bounds (0048), and the whole of it on the 100 by 60 plan, as the back office keeps it
    if v_id is null or v_name = '' or v_seats is null or v_seats not between 1 and 99
       or v_shape not in ('square', 'round')
       or v_w is null or v_w not between 4 and 100 or v_h is null or v_h not between 4 and 60
       or v_x is null or v_x < 0 or v_x + v_w > 100 or v_y is null or v_y < 0 or v_y + v_h > 60 then
      raise exception 'bad-payload';
    end if;
    -- one this store has already: it was sent before, and the answer was lost
    if exists (select 1 from tables where id = v_id and tenant_id = p_tenant and store_id = v_store and deleted_at is null) then
      continue;
    end if;
    if lower(v_name) = any (v_names) then raise exception 'name-taken'; end if;
    v_names := v_names || lower(v_name);
    v_new := v_new || jsonb_build_object('id', v_id, 'name', v_name, 'seats', v_seats, 'shape', v_shape,
      'x', v_x, 'y', v_y, 'w', v_w, 'h', v_h);
  end loop;
  if jsonb_array_length(v_new) = 0 then return jsonb_build_object('added', 0); end if;
  if exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null
             and lower(area) = lower(v_area)) then raise exception 'room-exists'; end if;
  -- a table's name is its own in the whole store (uq_tables_store_name)
  if exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null
             and lower(name) = any (v_names)) then raise exception 'name-taken'; end if;
  select count(*), coalesce(max(sort_order), -1) into v_have, v_sort
    from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null;
  -- the back office's limit for a store
  if v_have + jsonb_array_length(v_new) > 300 then raise exception 'too-many'; end if;
  for t in select * from jsonb_array_elements(v_new) loop
    v_sort := v_sort + 1;
    -- an id that is another client's table stops here on the primary key, and is answered 'conflict'
    insert into tables (id, tenant_id, store_id, name, area, seats, shape, x, y, w, h, sort_order)
      values ((t->>'id')::uuid, p_tenant, v_store, t->>'name', v_area, (t->>'seats')::int, t->>'shape',
        (t->>'x')::int, (t->>'y')::int, (t->>'w')::int, (t->>'h')::int, v_sort);
    v_added := v_added + 1;
  end loop;
  return jsonb_build_object('added', v_added);
end $fn$;

create or replace function push_printer_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
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
  if v_id is null or v_store is null or v_kind not in ('network', 'usb', 'bluetooth') or v_paper not in (58, 80)
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
end $fn$;

create or replace function push_company_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare
  v_name text := left(btrim(coalesce(p->>'name', '')), 80);
  v_address text := left(btrim(coalesce(p->>'address', '')), 240);
  v_phone text := left(btrim(coalesce(p->>'phone', '')), 40);
  v_brn text := left(btrim(coalesce(p->>'brn', '')), 30);
  v_vat text := left(btrim(coalesce(p->>'vat', '')), 30);
begin
  if v_name = '' then raise exception 'name-required'; end if;
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  -- what Company details in the back office writes (company/page.tsx)
  update tenants set name = v_name, brn = nullif(v_brn, ''), vat_number = nullif(v_vat, '') where id = p_tenant;
  insert into pos_settings (tenant_id, data)
    values (p_tenant, jsonb_build_object('company', jsonb_build_object(
      'name', v_name, 'brn', v_brn, 'vat', v_vat, 'address', v_address, 'phone', v_phone)))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  return jsonb_build_object('name', v_name);
end $fn$;

-- A PIN's hash as web/lib/pin.ts and the till's PinHash make it: 20,000 rounds,
-- a 16-byte salt and a 32-byte hash in base64. Nothing else is stored as one.
create or replace function pin_hash_ok(p text) returns boolean language sql immutable as $fn$
  select coalesce(p ~ '^pbkdf2-sha256\$20000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$', false)
$fn$;

create or replace function push_staff_save(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_role uuid; v_name text; v_hash text := coalesce(p->>'pin_hash', '');
begin
  begin
    v_id := (p->>'id')::uuid; v_role := (p->>'role_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  v_name := left(btrim(coalesce(p->>'name', '')), 80);
  if v_id is null or v_role is null then raise exception 'bad-payload'; end if;
  if v_name = '' then raise exception 'name-required'; end if;
  if not pin_hash_ok(v_hash) then raise exception 'bad-pin'; end if;
  if not may(p_emp, p, 'employees.edit') then raise exception 'forbidden'; end if;
  if not exists (select 1 from roles where id = v_role and tenant_id = p_tenant and deleted_at is null) then
    raise exception 'bad-role';
  end if;
  -- sent before, and the answer was lost: the person is there, and is left as they are
  if exists (select 1 from employees where id = v_id and tenant_id = p_tenant) then
    return jsonb_build_object('employee_id', v_id, 'created', false);
  end if;
  -- no login, and at every store of the business, as the back office's Staff page adds one.
  -- An id that is another client's stops on the primary key, and is answered 'conflict'.
  insert into employees (id, tenant_id, name, role_id, pin_hash) values (v_id, p_tenant, v_name, v_role, v_hash);
  insert into employee_stores (tenant_id, employee_id, store_id)
    select p_tenant, v_id, s.id from stores s where s.tenant_id = p_tenant and s.deleted_at is null;
  return jsonb_build_object('employee_id', v_id, 'created', true);
end $fn$;

create or replace function push_staff_set_pin(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
declare v_id uuid; v_hash text := coalesce(p->>'pin_hash', '');
begin
  begin
    v_id := (p->>'employee_id')::uuid;
  exception when others then
    raise exception 'bad-payload';
  end;
  if v_id is null then raise exception 'bad-payload'; end if;
  if not pin_hash_ok(v_hash) then raise exception 'bad-pin'; end if;
  if not may(p_emp, p, 'employees.edit') then raise exception 'forbidden'; end if;
  update employees set pin_hash = v_hash where id = v_id and tenant_id = p_tenant and deleted_at is null;
  if not found then raise exception 'unknown-staff'; end if;
  return jsonb_build_object('employee_id', v_id);
end $fn$;

create or replace function push_setup_finish(p_tenant uuid, p_emp uuid, p jsonb)
returns jsonb language plpgsql set search_path = public as $fn$
begin
  if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('setup', 'done'))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  return jsonb_build_object('setup', 'done');
end $fn$;

-- Fills what pos_settings.company lacks from tenants: the name, the BRN and
-- the VAT number. What a client saved under Company details is kept, and so
-- are its address and phone.
create or replace function company_from_tenants(p_tenant uuid) returns void
language plpgsql set search_path = public as $fn$
declare t record; v_now jsonb; v_add jsonb := '{}'::jsonb;
begin
  select name, brn, vat_number into t from tenants where id = p_tenant;
  if not found then return; end if;
  select data->'company' into v_now from pos_settings where tenant_id = p_tenant;
  v_now := coalesce(v_now, '{}'::jsonb);
  if coalesce(v_now->>'name', '') = '' and coalesce(t.name, '') <> '' then v_add := v_add || jsonb_build_object('name', t.name); end if;
  if coalesce(v_now->>'brn', '') = '' and coalesce(t.brn, '') <> '' then v_add := v_add || jsonb_build_object('brn', t.brn); end if;
  if coalesce(v_now->>'vat', '') = '' and coalesce(t.vat_number, '') <> '' then v_add := v_add || jsonb_build_object('vat', t.vat_number); end if;
  if v_add = '{}'::jsonb then return; end if;
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('company', v_add))
    on conflict (tenant_id) do update set data = pos_settings.data || jsonb_build_object('company', v_now || v_add);
end $fn$;

-- once, for every client: what /admin holds and no till was ever sent
do $$
declare t record;
begin
  for t in select id from tenants where deleted_at is null loop
    perform set_config('app.tenant_id', t.id::text, true);
    perform company_from_tenants(t.id);
  end loop;
end $$;

CREATE OR REPLACE FUNCTION platform.create_tenant(p_admin uuid, p_name text, p_store_name text, p_store_code text, p_owner_name text, p_owner_auth uuid, p_plan text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_tenant uuid := gen_random_uuid();
  v_store uuid; v_role uuid; v_emp uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_store_name text := coalesce(nullif(btrim(coalesce(p_store_name, '')), ''), 'Main store');
  v_code text := upper(btrim(coalesce(p_store_code, '')));
  v_owner text := coalesce(nullif(btrim(coalesce(p_owner_name, '')), ''), 'Owner');
  v_plan text := coalesce(nullif(btrim(coalesce(p_plan, '')), ''), 'standard');
begin
  perform platform.require_admin(p_admin);
  if v_name = '' then raise exception 'name-required'; end if;
  if v_code !~ '^[A-Z0-9]{1,12}$' then raise exception 'bad-store-code'; end if;
  if p_owner_auth is null then raise exception 'owner-login-required'; end if;
  -- one login belongs to one tenant (employees.auth_user_id is unique)
  if exists (select 1 from employees where auth_user_id = p_owner_auth) then
    raise exception 'login-already-linked';
  end if;
  -- a platform admin belongs to no restaurant
  if exists (select 1 from platform.admins where auth_user_id = p_owner_auth and revoked_at is null) then
    raise exception 'login-is-platform-admin';
  end if;
  -- the tenant context is stamped so the same statements also pass RLS for a
  -- caller that does not bypass it
  perform set_config('app.tenant_id', v_tenant::text, true);
  insert into tenants (id, tenant_id, name, plan) values (v_tenant, v_tenant, v_name, v_plan);
  insert into stores (tenant_id, name, code) values (v_tenant, v_store_name, v_code) returning id into v_store;
  insert into roles (tenant_id, name, permissions) values (v_tenant, 'Owner', '["*"]') returning id into v_role;
  insert into roles (tenant_id, name, permissions) values
    (v_tenant, 'Manager', '["sale.create","sale.apply_discount","sale.apply_restricted_discount",
      "sale.void_line","sale.void_sent_line","sale.refund","ticket.view_all","ticket.reassign",
      "ticket.split_merge","payment.take","drawer.open_no_sale","shift.open_close",
      "shift.view_report","cash.pay_in_out","items.edit","settings.device","receipts.view_all",
      "receipts.reprint","backoffice.access","reports.view","payment.correct",
      "stock.view","stock.receive","stock.adjust","stock.count","suppliers.edit","costs.view","sale.change_price"]'),
    (v_tenant, 'Cashier', '["sale.create","sale.apply_discount","sale.void_line","ticket.view_all",
      "ticket.split_merge","payment.take","shift.open_close","cash.pay_in_out",
      "receipts.view_all","receipts.reprint"]'),
    (v_tenant, 'Waiter', '["sale.create","sale.void_line"]');
  insert into employees (tenant_id, name, role_id, auth_user_id)
    values (v_tenant, v_owner, v_role, p_owner_auth) returning id into v_emp;
  insert into employee_stores (tenant_id, employee_id, store_id) values (v_tenant, v_emp, v_store);
  -- what a restaurant needs before its first sale
  perform ensure_pos_basics(v_tenant);
  -- its tills learn the plan through the settings they pull, and that its
  -- set-up is open: the first tablet signed in is walked through it (0089)
  insert into pos_settings (tenant_id, data) values (v_tenant, jsonb_build_object('plan', v_plan, 'setup', 'open'))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.create', v_tenant,
      jsonb_build_object('name', v_name, 'store', v_store_name, 'store_code', v_code,
        'plan', v_plan, 'owner', v_owner, 'owner_auth_user_id', p_owner_auth));
  return jsonb_build_object('tenant_id', v_tenant, 'store_id', v_store, 'employee_id', v_emp);
end $function$
;

CREATE OR REPLACE FUNCTION platform.set_tenant_details(p_admin uuid, p_tenant uuid, p_name text, p_brn text, p_vat text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_name text := btrim(coalesce(p_name, ''));
  v_brn text := nullif(btrim(coalesce(p_brn, '')), '');
  v_vat text := nullif(btrim(coalesce(p_vat, '')), '');
  v_old record;
begin
  perform platform.require_admin(p_admin);
  if v_name = '' then raise exception 'name-required'; end if;
  select name, brn, vat_number into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set name = v_name, brn = v_brn, vat_number = v_vat where id = p_tenant;
  -- tenants is not in a pull: the tills read the name, the BRN and the VAT
  -- number from the settings. The address and phone there are left as they are.
  insert into pos_settings (tenant_id, data)
    values (p_tenant, jsonb_build_object('company', jsonb_build_object(
      'name', v_name, 'brn', coalesce(v_brn, ''), 'vat', coalesce(v_vat, ''))))
    on conflict (tenant_id) do update set data = pos_settings.data || jsonb_build_object('company',
      coalesce(pos_settings.data->'company', '{}'::jsonb) || (excluded.data->'company'));
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.details', p_tenant, jsonb_build_object(
      'from', jsonb_build_object('name', v_old.name, 'brn', v_old.brn, 'vat_number', v_old.vat_number),
      'to', jsonb_build_object('name', v_name, 'brn', v_brn, 'vat_number', v_vat)));
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
    'too-many','room-exists','name-taken','bad-address','bad-printer','bad-role','bad-pin','unknown-staff'];
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
