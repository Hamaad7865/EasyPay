# The tablet's first-run set-up, the server: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the server takes from a till the tables, the printer, the business details, the staff and PINs of
a first-run set-up, and the word that it is finished; a client made in `/admin` starts with its set-up
open; a BRN or VAT number typed in `/admin` reaches the tills.

**Architecture:** six ops in `sync_push`, each a `push_*` function checked with `may()`, in migration 0089.
The mark is `pos_settings.data.setup`. `platform.create_tenant` and `platform.set_tenant_details` are
regenerated from dev's live definitions with one change each. No change to the till API.

**Tech stack:** Postgres (plpgsql), Node test scripts.

**Spec:** `docs/superpowers/specs/2026-10-09-first-run-setup-design.md`. The till is the second plan,
`2026-10-09-first-run-setup-till.md`; this one comes first.

**Rules of this folder:** another session commits here. Stage only the files a task names. Before taking
0089, `ls db/migrations | tail -1` must still say 0088. Apply migrations to dev only (`node db/migrate.cjs`).
Never push a tag. Commit on `restopos`; leave `web/next-env.d.ts` and `.claude/` out.

**Codes.** Where `sync_push` has a code it is used: the spec's `unknown-store` is `bad-store` here. New
codes: `too-many`, `room-exists`, `name-taken`, `bad-address`, `bad-printer`, `bad-role`, `bad-pin`,
`unknown-staff`. A unique-key clash that a function does not name first is answered `conflict` by
`sync_push` itself.

---

### Task 1: the suite, failing

**Files:** create `db/tests/till-setup.test.cjs`, modelled line for line on
`db/tests/till-categories-stock.test.cjs`: the same `check`, `op`, `asApp`, `push`, `one`, `pull`, and the
cleanup in `finally`.

Set-up, by direct inserts as that suite does:

- Tenants `SU-Probe` (`plan = 'premium'`, so a kitchen screen can be inserted) and `SU-Other`.
- Stores `SUS1` and `SUS3` for the probe, `SUS2` for the other.
- Roles: Owner `['*']`; Manager `['settings.device','items.edit']`; Cashier
  `['sale.create','payment.take','shift.open_close']`. One employee of each; the owner is the till's login.
- `select ensure_pos_basics(...)` for both, then `update pos_settings set data = data || '{"setup":"open"}'`
  for the probe.
- `pushAs(employee, ops)`: `push` with another login, for the checks that push as the manager.
- `H`, a well-formed hash: `pbkdf2-sha256$20000$BwcHBwcHBwcHBwcHBwcHBw==$e9J4dc709SPTq5CLB1eFvtyPhs9JnBATLVf107XfVaI=`
  (what `web/lib/pin.ts` makes of `1234` with a salt of sixteen bytes of 7).
- `room(area, names)`: the tables of a room, each `{id: randomUUID, name, seats: 4, shape: 'square', x, y,
  w: 8, h: 8}` laid ten to a row (`x = 2 + 10 * (i % 10)`, `y = 2 + 10 * floor(i / 10)`).

- [ ] **Step 1: write it.** Checks:
  - T1 `tables.add {store_id: SUS1, area: 'Main', tables: room('Main', 1..12)}` applied, data `added: 12`;
    12 live rows in SUS1, all `area = 'Main'`, `seats = 4`, `sort_order` 0 to 11.
  - T2 a room `Terrace` named 13 to 18: applied; 18 rows; its `sort_order` runs on from 12.
  - T3 the same Terrace tables again under a new `op_id`: applied, `added: 0`, still 18.
  - T4 refused, the count unchanged: new ids in `main` (another case) `room-exists`; a new room with a
    table named `7` `name-taken`; a new room with two tables named `A` `name-taken`; `tables: []`, 61
    tables, `w: 3`, `x: 95` with `w: 8`, `seats: 0`, `shape: 'star'`, a blank name, a blank `area`, each
    `bad-payload`; the other client's store `bad-store`; a table id that is the other client's `conflict`
    and theirs unchanged; the cashier as the op's `employee_id` `forbidden`, and applied with
    `approved_by: manager`.
  - T5 SUS3 with 290 tables inserted directly (`generate_series`, names `x1`..`x290`, area `Hall`): a new
    room of 11 `too-many`; of 10 applied.
  - T6 `pull()` for SUS1 carries the 18 tables, as that suite's C4 reads a pull.
  - P1 `printer.save {id, store_id: SUS1, name: '  Receipt ', kind: 'network', address: '192.168.1.50',
    paper_mm: 80, one_printer: true}` applied, data `created: true, receipt: true`; the row: name
    `Receipt`, `is_receipt`, `feed_lines = 3`, `cut`, `is_active`; `pos_settings.data.onePrinter` true and
    `setup` still `open`.
  - P2 a second, `kind: 'bluetooth', address: 'MPT-II', paper_mm: 58`, no `one_printer`: applied, data
    `receipt: false`; `onePrinter` still true.
  - P3 the first again with `kind: 'usb', name: 'Counter', one_printer: false`: data `created: false`; its
    address null, `is_receipt` still true, `sort_order` as it was; `onePrinter` false.
  - P4 refused, nothing changed: blank name `name-required`; network with `printer.local` and with `''`,
    Bluetooth with `''` and with `192.168.1.9`, each `bad-address`; `kind: 'screen'`, `paper_mm: 70`,
    `one_printer: 'yes'`, each `bad-payload`; the id of a kitchen screen (a row inserted with
    `kind = 'screen'`, a pair code, an address), of a printer removed with `deleted_at`, and of a printer
    of SUS3 sent with `store_id: SUS1`, each `bad-printer`; the other client's store `bad-store`; the other
    client's printer id `conflict`; the cashier `forbidden`, applied with the manager's approval.
  - P5 SUS3, which holds only a kitchen screen: its first printer has `is_receipt` true.
  - P6 the pull carries both printers and settings with `onePrinter`.
  - C1 `company.save {name: ' Chez Nous ', address: 'Royal Road\nCurepipe', phone: '5 123 4567', brn:
    'C12345678', vat: 'VAT27000000'}` applied; `tenants` has the name, `brn`, `vat_number`;
    `pos_settings.data.company` has the five; `setup` and `onePrinter` as they were; the pull's settings
    carry the company.
  - C2 with `brn: ''` and `vat: ''`: `tenants.brn` and `vat_number` null, the settings hold `''`. A name of
    100 characters is stored as its first 80.
  - C3 blank name `name-required`; the cashier `forbidden`, applied with approval; the other client's
    `tenants` row and settings unchanged throughout.
  - F1 `staff.save {id, name: ' Asha ', role_id: cashier's, pin_hash: H}` applied, data `created: true`;
    the row: `Asha`, the role, `pin_hash = H`, no `auth_user_id`, active; an `employee_stores` row for
    SUS1 and for SUS3.
  - F2 the same id with another name: applied, `created: false`, the row unchanged.
  - F3 refused, no row made: blank name `name-required`; the other client's role and a role removed with
    `deleted_at`, each `bad-role`; `pin_hash` of `abc`, of `1234`, and of `H` with `10000` for its rounds,
    each `bad-pin`; the other client's employee id `conflict`; pushed as the manager `forbidden`; pushed as
    the manager with `approved_by: owner` applied; the cashier with `approved_by: manager` `forbidden`.
  - F4 `staff.set_pin {employee_id: owner, pin_hash: H}` applied, the hash stored; the other client's
    employee and one removed with `deleted_at`, each `unknown-staff`; a bad hash `bad-pin`; pushed as the
    manager `forbidden`.
  - F5 the pull carries Asha with her hash.
  - D1 `setup.finish {}` applied; `setup` is `done`, the other keys kept. Again: applied. The cashier
    `forbidden`, applied with approval.
  - N1 a client made with `platform.create_tenant_of_type`, as `db/tests/business-type.test.cjs` makes its
    admin and calls it: `pos_settings.data` has `setup: 'open'` beside its `plan`. `SU-Other`, made by a
    direct insert, has no `setup` key.
  - N2 `platform.set_tenant_details(admin, probe, 'New Name', 'C999', 'VAT999')`: `tenants` as before
    0089, and `pos_settings.data.company` has that name, BRN and VAT with the address and phone C1 left.
    With `''` for the BRN: null in `tenants`, `''` in the settings.
  - N3 `company_from_tenants(id)` on three clients prepared by direct updates: settings with no `company`
    and `tenants.brn = 'T1'` gain `company.brn = 'T1'` and the name; settings with `company.brn = 'SAVED'`
    and `tenants.brn = 'ADMIN'` keep `SAVED`; `tenants.brn` null adds no `brn`. An address in `company` is
    kept in each.
- [ ] **Step 2: run** `node db/tests/till-setup.test.cjs`. Expected: T1 fails `rejected:unknown-op`.
- [ ] **Step 3: commit** the suite alone.

### Task 2: migration 0089

**Files:** create `db/migrations/0089_first_run_setup.sql`, written by a generator in the scratchpad from
dev's live definitions, as 0082 to 0087 were.

- [ ] **Step 1: dump** the three live functions. `dump.cjs` in the scratchpad, run from the repo root as
  `node <scratchpad>/dump.cjs <scratchpad>/live`:

  ```js
  const fs = require('fs'); const path = require('path'); const { Client } = require('pg');
  const devguard = require(path.resolve('db/tests/require-dev.cjs'));
  (async () => {
    const env = devguard.envMap();
    const c = new Client({ connectionString: env.DATABASE_URL_UNPOOLED, ssl: { require: true } });
    await c.connect();
    fs.mkdirSync(process.argv[2], { recursive: true });
    for (const [schema, name] of [['public', 'sync_push'], ['platform', 'create_tenant'], ['platform', 'set_tenant_details']]) {
      const r = await c.query(
        `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = $1 and p.proname = $2`, [schema, name]);
      if (r.rowCount !== 1) throw new Error(`${schema}.${name}: ${r.rowCount} definitions`);
      fs.writeFileSync(path.join(process.argv[2], `${schema}.${name}.sql`), r.rows[0].def + ';\n');
    }
    await c.end();
  })().catch((e) => { console.error(e.message); process.exit(1); });
  ```

  Confirm the dumped `sync_push` has `'not-enough-stock'` among its codes (0087 is in it) and the dumped
  `create_tenant` has `jsonb_build_object('plan', v_plan)` (0085 is in it).

- [ ] **Step 2: write the new functions** to `<scratchpad>/new.sql`:

  ```sql
  create or replace function push_tables_add(p_tenant uuid, p_emp uuid, p jsonb)
  returns jsonb language plpgsql set search_path = public as $fn$
  declare
    v_store uuid; v_area text; t jsonb; v_id uuid; v_name text;
    v_seats int; v_shape text; v_x int; v_y int; v_w int; v_h int;
    v_new jsonb := '[]'::jsonb; v_names text[] := '{}'; v_have int; v_sort int; v_added int := 0;
  begin
    begin
      v_store := (p->>'store_id')::uuid;
    exception when others then raise exception 'bad-payload'; end;
    v_area := left(btrim(coalesce(p->>'area', '')), 30);
    if v_store is null or v_area = '' or jsonb_typeof(p->'tables') is distinct from 'array'
       or jsonb_array_length(p->'tables') not between 1 and 60 then raise exception 'bad-payload'; end if;
    if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
    if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
      raise exception 'bad-store'; end if;
    -- one room at a time in a store: two tills adding rooms wait for each other
    perform pg_advisory_xact_lock(hashtextextended('tables.add:' || v_store::text, 0));
    for t in select * from jsonb_array_elements(p->'tables') loop
      begin
        v_id := (t->>'id')::uuid; v_seats := (t->>'seats')::int;
        v_x := (t->>'x')::int; v_y := (t->>'y')::int; v_w := (t->>'w')::int; v_h := (t->>'h')::int;
      exception when others then raise exception 'bad-payload'; end;
      v_name := left(btrim(coalesce(t->>'name', '')), 30);
      v_shape := coalesce(t->>'shape', 'square');
      if v_id is null or v_name = '' or v_seats is null or v_seats not between 1 and 99
         or v_shape not in ('square', 'round')
         or v_w is null or v_w not between 4 and 100 or v_h is null or v_h not between 4 and 60
         or v_x is null or v_x < 0 or v_x + v_w > 100 or v_y is null or v_y < 0 or v_y + v_h > 60 then
        raise exception 'bad-payload'; end if;
      -- one this store has already: it was sent before, and the answer was lost
      if exists (select 1 from tables where id = v_id and tenant_id = p_tenant and store_id = v_store and deleted_at is null) then
        continue; end if;
      if lower(v_name) = any (v_names) then raise exception 'name-taken'; end if;
      v_names := v_names || lower(v_name);
      v_new := v_new || jsonb_build_object('id', v_id, 'name', v_name, 'seats', v_seats, 'shape', v_shape,
        'x', v_x, 'y', v_y, 'w', v_w, 'h', v_h);
    end loop;
    if jsonb_array_length(v_new) = 0 then return jsonb_build_object('added', 0); end if;
    if exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null
               and lower(area) = lower(v_area)) then raise exception 'room-exists'; end if;
    if exists (select 1 from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null
               and lower(name) = any (v_names)) then raise exception 'name-taken'; end if;
    select count(*), coalesce(max(sort_order), -1) into v_have, v_sort
      from tables where tenant_id = p_tenant and store_id = v_store and deleted_at is null;
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
    exception when others then raise exception 'bad-payload'; end;
    v_name := left(btrim(coalesce(p->>'name', '')), 40);
    v_kind := coalesce(p->>'kind', '');
    v_address := left(btrim(coalesce(p->>'address', '')), 40);
    if v_id is null or v_store is null or v_kind not in ('network', 'usb', 'bluetooth') or v_paper not in (58, 80)
       or (p ? 'one_printer' and jsonb_typeof(p->'one_printer') <> 'boolean') then raise exception 'bad-payload'; end if;
    if v_name = '' then raise exception 'name-required'; end if;
    -- a network printer has an IP address; a Bluetooth one the name or address the tablet pairs it by,
    -- which an IP address is not
    if (v_kind = 'network' and v_address !~ ip) or (v_kind = 'bluetooth' and (v_address = '' or v_address ~ ip)) then
      raise exception 'bad-address'; end if;
    if v_kind = 'usb' then v_address := null; end if;
    if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;
    if not exists (select 1 from stores where id = v_store and tenant_id = p_tenant and deleted_at is null) then
      raise exception 'bad-store'; end if;
    select store_id, kind, deleted_at into v_was from printers where id = v_id and tenant_id = p_tenant for update;
    if found then
      if v_was.deleted_at is not null or v_was.kind = 'screen' or v_was.store_id <> v_store then
        raise exception 'bad-printer'; end if;
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

  -- A PIN's hash as web/lib/pin.ts and the till's PinHash make it: 20,000 rounds, a 16-byte salt and a
  -- 32-byte hash in base64. Nothing else is stored as one.
  create or replace function pin_hash_ok(p text) returns boolean language sql immutable as $fn$
    select coalesce(p ~ '^pbkdf2-sha256\$20000\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=$', false)
  $fn$;

  create or replace function push_staff_save(p_tenant uuid, p_emp uuid, p jsonb)
  returns jsonb language plpgsql set search_path = public as $fn$
  declare v_id uuid; v_role uuid; v_name text; v_hash text := coalesce(p->>'pin_hash', '');
  begin
    begin
      v_id := (p->>'id')::uuid; v_role := (p->>'role_id')::uuid;
    exception when others then raise exception 'bad-payload'; end;
    v_name := left(btrim(coalesce(p->>'name', '')), 80);
    if v_id is null or v_role is null then raise exception 'bad-payload'; end if;
    if v_name = '' then raise exception 'name-required'; end if;
    if not pin_hash_ok(v_hash) then raise exception 'bad-pin'; end if;
    if not may(p_emp, p, 'employees.edit') then raise exception 'forbidden'; end if;
    if not exists (select 1 from roles where id = v_role and tenant_id = p_tenant and deleted_at is null) then
      raise exception 'bad-role'; end if;
    -- sent before, and the answer was lost: the person is there, and is left as they are
    if exists (select 1 from employees where id = v_id and tenant_id = p_tenant) then
      return jsonb_build_object('employee_id', v_id, 'created', false); end if;
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
    exception when others then raise exception 'bad-payload'; end;
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

  -- Fills what pos_settings.company lacks from tenants: the name, the BRN and the VAT number. What a
  -- client saved under Company details is kept, and so are its address and phone.
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
  ```

- [ ] **Step 3: write the generator** `gen_0089.cjs` in the scratchpad. It reads the three dumps and
  `new.sql`, makes four replacements, each of which must match exactly once or nothing is written, and
  writes the file: a header, `new.sql`, then the three regenerated functions.

  ```js
  const once = (text, find, put, what) => {
    const n = text.split(find).length - 1;
    if (n !== 1) throw new Error(`${what}: found ${n} times`);
    return text.replace(find, () => put);
  };
  ```

  - `sync_push`, the codes: find
    `'has-items','bad-reason','not-counted','pick-variant','not-enough-stock'];` and put the same five
    followed by `,\n    -- a tablet's first-run set-up (0089)\n    'too-many','room-exists','name-taken','bad-address','bad-printer','bad-role','bad-pin','unknown-staff'];`
  - `sync_push`, the ops: find the line
    `          when 'stock.adjust' then v_data := push_stock_adjust(tenant, v_emp, v_payload);\n` and put
    it followed by six lines of the same shape: `tables.add` → `push_tables_add`, `printer.save` →
    `push_printer_save`, `company.save` → `push_company_save`, `staff.save` → `push_staff_save`,
    `staff.set_pin` → `push_staff_set_pin`, `setup.finish` → `push_setup_finish`.
  - `platform.create_tenant`: find `values (v_tenant, jsonb_build_object('plan', v_plan))` and put
    `values (v_tenant, jsonb_build_object('plan', v_plan, 'setup', 'open'))`.
  - `platform.set_tenant_details`: find
    `update tenants set name = v_name, brn = v_brn, vat_number = v_vat where id = p_tenant;` and put it
    followed by:

    ```sql
      -- tenants is not in a pull: the tills read the name, the BRN and the VAT number from the settings
      insert into pos_settings (tenant_id, data)
        values (p_tenant, jsonb_build_object('company', jsonb_build_object(
          'name', v_name, 'brn', coalesce(v_brn, ''), 'vat', coalesce(v_vat, ''))))
        on conflict (tenant_id) do update set data = pos_settings.data || jsonb_build_object('company',
          coalesce(pos_settings.data->'company', '{}'::jsonb) || (excluded.data->'company'));
    ```

  The header, in the voice of 0087's: what the owner asked ("We need to create an onboarding flow for POS
  right after sign in for the first time"), the six ops and what each refuses with, the mark and why a
  missing one means "never shown", why BRN and VAT now reach the settings and that the owner chose it for
  existing clients too ("Yes, send them"), and that the three functions are as dev had them (0087, 0085,
  0045) with these lines added. "Never edit after merge."

- [ ] **Step 4:** `ls db/migrations | tail -1` says 0088. Run the generator, read the file it wrote from
  top to bottom, then `node db/migrate.cjs`. Expected: `apply 0089_first_run_setup.sql`, `migrations ok`.
- [ ] **Step 5:** `node db/tests/till-setup.test.cjs`: every check passes. If a check fails with
  `permission denied` for a table, `app_user` lacks a right the back office never needed there: say which,
  and stop before granting anything.
- [ ] **Step 6:** every dev-safe suite that makes a client passes as before: `business-type`, `platform`,
  `platform-auth`, `premium-gate`, `kitchen-screens`, `retail-till`, `shop-pages`, `backoffice-access`,
  `catalog`, `catalog-import`, `stock-adjust`, `stock-counts`, `stock-engine`, `stock-reports`,
  `purchase-orders`, and `item-ops`, `till-categories-stock`, `push-policy`, `delete-client` (each
  `node db/tests/<name>.test.cjs`). One that compared `pos_settings.data` exactly is put right in the same
  commit, and said.
- [ ] **Step 7: commit** the migration.

### Task 3: the demo script leaves the set-up done

**Files:** modify `db/scripts/seed-demo-client.cjs` (inside `seed()`, before the line
`await c.query(apply ? 'COMMIT' : 'ROLLBACK')`), and `db/tests/seed-demo-client.test.cjs`.

- [ ] **Step 1: the check, failing.** In the suite, after S3's "both are filled": for both clients
  `select data->>'setup' as s from pos_settings where tenant_id = $1` is `done`. The suite makes its
  clients the way `/admin` does, so after 0089 they start `open`. Run it: the new check fails with `open`.
- [ ] **Step 2: the script.** In the same transaction as the rest:

  ```js
  // A client shown to customers opens on its start screen: the set-up a new client is walked through
  // (0089) is marked done, since this script has filled what it would have asked for.
  await c.query(
    `insert into pos_settings (tenant_id, data) values ($1, '{"setup":"done"}'::jsonb)
       on conflict (tenant_id) do update set data = pos_settings.data || excluded.data`, [t.id]);
  ```

  Its opening comment gains one line saying so.
- [ ] **Step 3:** `node db/tests/seed-demo-client.test.cjs` passes, 23 checks.
- [ ] **Step 4: commit.**

### Release (not part of the build)

0089 goes to production with the tag that carries till 0.7.0, after 0088. Nothing here is pushed or
tagged. Until the till plan is built, no till sends these ops and the only visible change is in the
settings: a new client carries `setup: "open"`, which tills up to 0.6.3 ignore, and a BRN or VAT number
held in `/admin` prints on that client's receipts from its next sync.
