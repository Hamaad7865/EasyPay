# Self-order kiosk: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A restaurant's customers order on an EasyPay kiosk (a portrait Android kiosk) and get a numbered slip. They pay at the counter, and the paid order goes to the kitchen. The kiosk runs itself: no one touches it in daily use.

**Architecture:**
- The kiosk is the same EasyPay APK in a mode of its own, drawn by its own portrait `KioskActivity` (no ScreenFit).
- It listens on the Wi-Fi (port 9312) like a customer display. The till it is paired with calls it about once a second over the existing signed wire (`Wire.sign`). Each call:
  - sends the menu, only when its hash changed;
  - sends the pictures the kiosk lacks, one per call;
  - takes the orders placed since the last call;
  - hands back the numbers the till gave them.
- The till keeps kiosk orders in their own Room table. The cashier opens one into an ordinary order, and Pay sends it to the kitchen.
- On the server the kiosk is a paid extra (`kiosk` in `tenants.features`, trial carries it, Premium does not) and a printer row of kind `kiosk`.
- On install day the kiosk is made device owner. That lets it be its own Home, stay in lock task, keep its screen on, hold system updates to the night and update itself quietly.

**Tech stack:**
- Postgres migrations (`db/migrations`), Node test suites (`db/tests/*.test.cjs`, `pg`).
- Next.js back office (`web/`).
- Android: Kotlin, Jetpack Compose, Room, Hilt, kotlinx.serialization. JUnit tests (`./gradlew :app:testDebugUnitTest`).
- Android `DevicePolicyManager` and `PackageInstaller`.

**Spec:** `docs/superpowers/specs/2026-11-18-self-order-kiosk-design.md` (commit `2bd3d3a7`).

---

## Read this first

### Settled while planning (the spec's two "to check" items)

- **A dining option that needs a table, paid with no table.** Nothing stops it. No check in `feature/pay`, `core/data/OrderClose.kt`, `core/data/OrderOps.kt` or `feature/order`, and none in the server's migrations (searched for `needs_table`). `TicketRepository.startOrder(diningId)` takes any option. So a kiosk order opened as "Eat in" with no table is paid like any order. No change is needed.
- **How the paid extra reaches an offline-edition tablet.** The same way as deposits and accounts. `platform.set_tenant_features` writes `features` into `pos_settings.data`, the till pulls `pos_settings` (an offline tablet does so on "Get changes"), and `PosSettings.parse` reads `d["features"]`. `kioskPaid` reads that same array. The gate is visible on the till the kiosk pairs with, which is the till that answers it.

### Deferred from the spec (tell the owner; each is a small piece of its own later)

1. **Unticking dining options per kiosk.** The kiosk offers every dining option except kind `delivery`. With only one, the step is skipped. A per-kiosk choice would need a column carried through the server, sync, Room, the back office and offline Settings.
2. **The VAT figure on Review.** The kiosk shows the total only. The receipt from the till carries the VAT.
3. **Several of one add-on.** As on the guest's phone, each option is taken once on the kiosk (`OptionRules.mostOnAPhone`).
4. **Device owner by QR code.** This plan builds and tests the `adb` route only. The QR route (`android.app.extra.PROVISIONING_*`) needs a factory-fresh real kiosk and is written up in Task 23 as real-device only.

### Changed from the spec, on purpose

- **The PIN that leaves kiosk mode is the kiosk's own.** It is set on the kiosk at set-up and kept hashed (`PinHash`). A kiosk is never signed in, so it has no staff list to check a manager's PIN against.

### Numbers claimed (checked 2026-11-18 on every local branch, every worktree and `github`)

- Migration **0160** (the last is 0159).
- Room version **40** (the last is 39).
- Kiosk port **9312**: kitchen screen 9310, display 9311.
- Debug pairing code **`KYSK2345`**. PairCode letters are `[A-HJ-NP-Z2-9]`, so I and O are not allowed.

Before Task 1, check again; another session may have taken a number since. If so, take the next free one and change it everywhere in this plan:

```bash
git fetch -q github
for b in $(git for-each-ref --format='%(refname:short)' refs/heads refs/remotes/github); do git ls-tree --name-only $b db/migrations/ | grep -o "01[6-9][0-9]_.*" | sed "s|^|$b |"; done
git worktree list
```

### House rules for whoever builds this

- Work on `restopos`, or in a worktree cut from it if another session is live in the main folder (`git worktree add .claude/worktrees/kiosk -b claude/kiosk restopos`, then copy `android/local.properties`). Never `git add -A`: `web/app/zz-preview/` belongs to another session. Add files by name.
- Commit after every task. **Never push, never tag:** that is the owner's call.
- **Database tests:** apply to dev with `node db/migrate.cjs`, then run the one new suite once: `node db/tests/kiosk.test.cjs`. Never run the `db-tests` workflow, never run suites side by side.
- **Android unit tests:** `android/gradlew -p android :app:testDebugUnitTest --tests '<pattern>'`. Run with `--priority low --max-workers 2` if any emulator is open.
- **Emulators are shared** (read the memory note `restopos-emulator-is-shared` whole before Task 24):
  - Build first, then `gradlew --stop` (or kill only your own idle daemons), then start an emulator. Gradle and an emulator don't fit in memory together here.
  - Say before you start, install on, clear or resize any emulator. Read the screen before every series of taps.
  - **Device owner is a one-way door.** Only on the new AVD `easypay_claude_kiosk` made for this work, never on any other AVD.
- Words on screens and papers: plain, short, the owner's ("order", "dish", "pay at the counter"). The back office's restaurant pages only; a shop never sees "kiosk".

---

## File map

**Server and back office**

| File | What it does |
|---|---|
| `db/migrations/0160_kiosk.sql` (new) | `has_feature` with the kiosk rule, `set_tenant_features` taking `kiosk`, printer kind `kiosk`, its row rule, its trigger (feature and till), `push_printer_save` taking a kiosk |
| `db/tests/kiosk.test.cjs` (new) | The suite for all of the above |
| `web/lib/printers.ts` | `kind` takes `"kiosk"`; `silent()` true for it |
| `web/lib/saves.ts` | `addPrinter` / `savePrinter` treat a kiosk as they treat a display |
| `web/app/backoffice/printers/page.tsx` | A **Kiosks** section (restaurants with the extra only) |
| `web/app/admin/tenants/[id]/page.tsx`, `view.tsx` | A restaurant's **Kiosk** extra; both forms keep each other's features |

**Till (Android, `android/app/src/main/java/com/restopos/`)**

| File | What it does |
|---|---|
| `core/data/PosSettings.kt` | `kioskPaid` |
| `core/data/Routing.kt` | `KIOSK` kind: silent, port 9312, `kiosks(all, device)` |
| `core/guest/GuestOrders.kt` | `GuestCheck.lines(...)` split out of `of(...)`, so the kiosk checks lines the same way |
| `core/kiosk/KioskWire.kt` (new) | Request/reply, signed, and the menu types |
| `core/kiosk/KioskMenus.kt` (new) | Builds the menu the till sends, and its hash |
| `core/kiosk/KioskRules.kt` (new) | Checks an order, makes the number, the total, which dining options |
| `core/database/Kiosk.kt` (new) | `KioskOrderEntity`, `KioskDao` |
| `core/database/TillDatabase.kt`, `Migrations.kt` | Room 40: `kiosk_orders` |
| `core/kiosk/KioskDesk.kt` (new) | The till's side: take, number, open, cancel, close the day |
| `core/kiosk/KioskLink.kt` (new) | The till calls each kiosk about once a second |
| `core/data/OrderOps.kt` | Save holds a kiosk order until it is paid |
| `core/data/CashOps.kt` | Each of the three day closes cancels waiting kiosk orders and counts them |
| `feature/main/MainShell.kt` | Kiosk key with count and chime |
| `feature/orders/` (Kiosk tab) | The list: Open, Cancel, type a number |
| `core/data/PrinterForm.kt` + Settings → Printers | An offline-edition till adds a kiosk |

**Kiosk (same APK)**

| File | What it does |
|---|---|
| `core/kiosk/KioskPrefs.kt` (new) | Synchronous prefs: kiosk mode, code, PIN hash, printer |
| `core/kiosk/KioskBook.kt` (new) | The kiosk's side of the wire: menu, pictures, placing, waiting for the answer |
| `core/kiosk/KioskSlip.kt` (new) | The slip as ESC/POS bytes, and the paper check |
| `feature/kiosk/KioskActivity.kt` (new) | Portrait, no ScreenFit, lock task, screen on |
| `feature/kiosk/KioskViewModel.kt` (new) | Screens' state, the 60 s idle rule, the 15 s Done |
| `feature/kiosk/KioskScreens.kt` (new) | Welcome, Dining, Menu, Dish, Review, Done, Set-up, Leave |
| `core/kiosk/KioskOwner.kt` (new), `core/kiosk/KioskAdmin.kt` (new), `res/xml/kiosk_admin.xml` (new) | Device owner: Home, lock task, keyguard, stay on, update window |
| `core/kiosk/KioskUpdater.kt` (new) | Quiet self-update at night |
| `AndroidManifest.xml` | `KioskActivity`, the `KioskHome` alias (fallback), `KioskAdmin` receiver |
| `app/MainActivity.kt`, `app/AppNav.kt`, `feature/auth/…` | "Set up as a kiosk"; forward to `KioskActivity` |

---

# Phase 1: Server and back office

*Ends with: a restaurant on trial, or with the extra ticked in /admin, can add a kiosk under Printers. A shop and a Premium restaurant without the extra cannot. The suite passes.*

### Task 1: The failing suite

**Files:** create `db/tests/kiosk.test.cjs`.

- [ ] **Step 1: Write the suite.** Copy the scaffold of `db/tests/customer-display.test.cjs` lines 1-64 exactly (the `check`, `op`, `lib`, `asApp`, `failed`, `said` helpers and the `BEGIN … ROLLBACK` frame), changing the header comment to the kiosk. Then this body:

```js
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-ks@example.com')`, [admin]);
    const make = async (name, code, plan) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,$5) as r`, [admin, name, code, crypto.randomUUID(), plan])).r;
    const trial = await make('Kiosk Trial', 'KS1', 'trial');
    const prem = await make('Kiosk Premium', 'KS2', 'premium');
    const off = await make('Kiosk Offline', 'KS3', 'offline');
    const shop = await make('Kiosk Shop', 'KS4', 'trial');
    await one(`update tenants set business_type = 'retail' where id = $1 returning id`, [shop.tenant_id]);
    const has = async (t) => (await one(`select has_feature($1, 'kiosk') as h`, [t])).h;

    // ---- the extra ----
    check('F1 trial carries the kiosk', (await has(trial.tenant_id)) === true);
    check('F1 premium does not', (await has(prem.tenant_id)) === false);
    check('F1 the offline edition does not', (await has(off.tenant_id)) === false);
    check('F1 a shop never has it, even on trial', (await has(shop.tenant_id)) === false);
    check('F1 premium still carries deposits', (await one(`select has_feature($1, 'deposits') as h`, [prem.tenant_id])).h === true);
    const setF = (t, f) => c.query(`select platform.set_tenant_features($1, $2, $3::text[])`, [admin, t, f]).then(() => 'ok', (e) => e.message);
    let r = await setF(prem.tenant_id, ['kiosk']);
    check('F2 the admin switches it on for a premium restaurant', r === 'ok' && (await has(prem.tenant_id)) === true, r);
    r = await setF(off.tenant_id, ['kiosk', 'deposits']);
    check('F2 with another extra beside it', r === 'ok' && (await has(off.tenant_id)) === true, r);
    const data = (await one(`select data from pos_settings where tenant_id = $1`, [off.tenant_id])).data;
    check('F2 the tills are told (pos_settings.data.features)', JSON.stringify(data.features) === JSON.stringify(['deposits', 'kiosk']), JSON.stringify(data.features));
    r = await setF(shop.tenant_id, ['kiosk']);
    check('F3 a shop is refused it', r === 'bad-feature', r);
    r = await setF(off.tenant_id, ['kiosk', 'nonsense']);
    check('F3 an unknown extra is still refused', r === 'bad-feature', r);

    // ---- the row ----
    const tid = trial.tenant_id, store = trial.store_id, owner = trial.employee_id;
    const device = async (t, s, code) => (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, $3, $3) returning id`, [t, s, code])).id;
    const till = await device(tid, store, 'T1');
    const premTill = await device(prem.tenant_id, prem.store_id, 'T1');
    const put = (t, s, o) => asApp(t, () => c.query(
      `insert into printers (tenant_id, store_id, name, kind, address, pair_code, device_id, message, is_receipt)
       values ($1, $2, $3, 'kiosk', $4, $5, $6, $7, $8) returning id`,
      [t, s, o.name ?? 'Kiosk 1', o.address === undefined ? '192.168.1.81' : o.address, o.code === undefined ? 'KYSK2345' : o.code,
        o.device === undefined ? till : o.device, o.message ?? null, o.receipt ?? false]));
    r = await put(tid, store, { message: 'Order here, pay at the counter' });
    check('K1 a trial restaurant adds a kiosk', !failed(r), said(r));
    r = await put(tid, store, { code: null });
    check('K2 a kiosk has its code', failed(r) && said(r).includes('printers_display_check'), said(r));
    r = await put(tid, store, { device: null });
    check('K2 a kiosk sends to a till', failed(r) && (said(r) === 'bad-device' || said(r).includes('printers_display_check')), said(r));
    r = await put(tid, store, { receipt: true });
    check('K2 a kiosk never prints the receipts', failed(r) && said(r).includes('printers_display_check'), said(r));
    // premium was given the extra above (F2); take it away again and try
    await setF(prem.tenant_id, []);
    r = await put(prem.tenant_id, prem.store_id, { device: premTill });
    check('K3 premium without the extra cannot add one', failed(r) && said(r) === 'no-kiosk', said(r));
    await setF(prem.tenant_id, ['kiosk']);
    r = await put(prem.tenant_id, prem.store_id, { device: premTill });
    check('K3 premium with the extra can', !failed(r), said(r));

    // ---- from a till: printer.save ----
    const push = (t, emp, ops) => asApp(t, async () => (await c.query('select sync_push($1, $2::jsonb) as r', [emp, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const save = async (t, emp, payload) => { const res = await push(t, emp, [op('printer.save', payload)]); return failed(res) ? 'error ' + said(res) : tag(res[0]); };
    const kid = crypto.randomUUID();
    const kiosk = (o = {}) => ({ id: kid, store_id: store, name: 'Kiosk 2', kind: 'kiosk', address: '10.0.2.16', paper_mm: 80, pair_code: 'kysk-2345', device_id: till, message: 'Hi', ...o });
    let s = await save(tid, owner, kiosk());
    await as(tid);
    let row = await one(`select kind, pair_code, device_id, is_receipt from printers where id = $1`, [kid]);
    check('P1 a till adds a kiosk', s === 'applied' && row && row.kind === 'kiosk' && row.pair_code === 'KYSK2345' && !row.is_receipt, s + ' ' + JSON.stringify(row));
    s = await save(tid, owner, kiosk({ kind: 'display' }));
    check('P2 a kiosk is not turned into a display', s === 'rejected:bad-printer', s);
    s = await save(tid, owner, kiosk({ kind: 'network', pair_code: null, device_id: null }));
    check('P2 nor into a printer', s === 'rejected:bad-printer', s);
    const offTill = await device(off.tenant_id, off.store_id, 'T1');
    await setF(off.tenant_id, ['deposits']);
    s = await save(off.tenant_id, off.employee_id, { id: crypto.randomUUID(), store_id: off.store_id, name: 'K', kind: 'kiosk', address: '10.0.2.17', paper_mm: 80, pair_code: 'KYSK2345', device_id: offTill });
    check('P3 a till without the extra is refused', s === 'rejected:bad-printer', s);
    const pulled = await asApp(tid, async () => (await c.query(`select kind, device_id, message from printers where id = $1`, [kid])).rows[0]);
    check('P4 the till is sent it with its till and its words', pulled && pulled.kind === 'kiosk' && pulled.device_id === till, JSON.stringify(pulled));
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
```

Check the closing lines against the end of `customer-display.test.cjs` and use the same ending. `create_tenant`'s returned `employee_id` is the owner, as in that suite.

- [ ] **Step 2: Run it and watch it fail.**
  Run: `node db/tests/kiosk.test.cjs`
  Expected: F1 "trial carries the kiosk" FAIL, F2 FAIL (`bad-feature`), K1 FAIL (`printers_kind_check`), and the rest FAIL or error.

- [ ] **Step 3: Commit the failing suite.**
```bash
git add db/tests/kiosk.test.cjs
git commit -m "Kiosk: the suite for the extra and the kiosk row (failing)"
```

### Task 2: Migration 0160

**Files:** create `db/migrations/0160_kiosk.sql`.

- [ ] **Step 1: Check the live `push_printer_save` against 0130's.**
  Run: `node db/scripts/dump-function.cjs push_printer_save > /tmp/pps.sql`. Diff it by eye against `db/migrations/0130_customer_displays.sql` lines 77-160.
  Expected: the same body. If it differs, a later migration changed it: start from the live text and make the same four changes listed in Step 2.

- [ ] **Step 2: Write the migration.**

```sql
-- 0160: the self-order kiosk (spec 2026-11-18-self-order-kiosk-design.md).
--
-- A kiosk is a printer row of kind 'kiosk', as a customer display is (0130):
-- the kiosk's address on the Wi-Fi, the pairing code it shows, the till it
-- sends its orders to (device_id), and an optional line of welcome words
-- (message, at most 120). It prints nothing the till sends: never the receipt
-- printer, never a store's first printer.
--
-- It is a paid extra, 'kiosk' in tenants.features, set in /admin. Trial
-- carries it for demonstrations. PREMIUM DOES NOT, unlike deposits and
-- accounts (the owner, 2026-11-18: "Paid extra even for Premium"). A shop
-- never has it. A kiosk row is refused without the extra ('no-kiosk' from the
-- table; 'bad-printer' from a till's printer.save, a code sync_push knows).
--
-- The release that carries this raises MIN_TILL_VERSION to the till build
-- that knows kiosks: an older till lists a kiosk as a printer that never
-- answers.

-- the extra ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_feature(p_tenant uuid, p_name text)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select case
      when p_name = 'kiosk' then business_type <> 'retail' and (lower(btrim(plan)) = 'trial' or 'kiosk' = any (features))
      else (p_name in ('deposits', 'accounts') and lower(btrim(plan)) in ('premium', 'trial')) or p_name = any (features)
    end
    from tenants where id = p_tenant), false)
$function$;

CREATE OR REPLACE FUNCTION platform.set_tenant_features(p_admin uuid, p_tenant uuid, p_features text[])
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare v_old text[]; v_new text[]; v_type text;
begin
  perform platform.require_admin(p_admin);
  select coalesce(array_agg(distinct f order by f), '{}') into v_new
    from unnest(coalesce(p_features, '{}')) f where btrim(f) <> '';
  if exists (select 1 from unnest(v_new) f where f not in ('deposits', 'accounts', 'kiosk')) then raise exception 'bad-feature'; end if;
  select features, business_type into v_old, v_type from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  -- a kiosk is a restaurant's
  if 'kiosk' = any (v_new) and v_type = 'retail' then raise exception 'bad-feature'; end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set features = v_new where id = p_tenant;
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('features', to_jsonb(v_new)))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.features', p_tenant, jsonb_build_object('from', to_jsonb(v_old), 'to', to_jsonb(v_new)));
end $function$;

-- the row --------------------------------------------------------------------
alter table printers drop constraint if exists printers_kind_check;
alter table printers add constraint printers_kind_check check (kind in ('network', 'usb', 'bluetooth', 'screen', 'display', 'kiosk'));

alter table printers drop constraint if exists printers_display_check;
alter table printers add constraint printers_display_check
  check (
    (kind in ('display', 'kiosk') and not is_receipt and pair_code is not null and btrim(pair_code) <> ''
       and address is not null and btrim(address) <> '' and device_id is not null
       and (message is null or char_length(message) <= 120))
    or (kind not in ('display', 'kiosk') and device_id is null and message is null)
  );

-- a display's or a kiosk's till is one of its own store's; a kiosk needs the extra
create or replace function printers_display_device() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.kind = 'kiosk' and new.deleted_at is null
     and (tg_op = 'INSERT' or old.kind <> 'kiosk' or old.deleted_at is not null)
     and not has_feature(new.tenant_id, 'kiosk') then
    raise exception 'no-kiosk';
  end if;
  if new.kind in ('display', 'kiosk') and new.deleted_at is null
     and (tg_op = 'INSERT' or new.device_id is distinct from old.device_id or old.kind <> new.kind or new.store_id <> old.store_id)
     and not exists (select 1 from pos_devices d where d.id = new.device_id and d.tenant_id = new.tenant_id
                       and d.store_id = new.store_id and d.deleted_at is null) then
    raise exception 'bad-device';
  end if;
  return new;
end $fn$;
```

  Then `push_printer_save`: paste 0130's whole `CREATE OR REPLACE FUNCTION public.push_printer_save … $function$;` (or the live text from Step 1) and make exactly these four changes:

  1. The kind list: `v_kind not in ('network', 'usb', 'bluetooth', 'display')` becomes `v_kind not in ('network', 'usb', 'bluetooth', 'display', 'kiosk')`.
  2. The address rule: `v_kind in ('network', 'display') and v_address !~ ip` becomes `v_kind in ('network', 'display', 'kiosk') and v_address !~ ip`.
  3. Every `v_kind = 'display'` in the code/device/message block, the update's `pair_code = case when …` and the insert's `v_first := v_kind <> 'display' and …` become `v_kind in ('display', 'kiosk')` (or `not in` for `v_first`). In `v_first`'s subquery, `kind not in ('screen', 'display')` becomes `kind not in ('screen', 'display', 'kiosk')`.
  4. Right after `if not may(p_emp, p, 'settings.device') then raise exception 'forbidden'; end if;`, add:

```sql
  -- a kiosk is a paid extra (0160): refused with a code sync_push already knows
  if v_kind = 'kiosk' and not has_feature(p_tenant, 'kiosk') then raise exception 'bad-printer'; end if;
```

  And the kind-change rule `or (v_was.kind = 'display') <> (v_kind = 'display')` becomes:

```sql
       or ((v_was.kind in ('display', 'kiosk') or v_kind in ('display', 'kiosk')) and v_was.kind <> v_kind) then
```

- [ ] **Step 3: Apply to dev and run the suite.**
  Run: `node db/migrate.cjs`, then `node db/tests/kiosk.test.cjs`.
  Expected: every line `PASS`, last line `all passed`.

- [ ] **Step 4: Make sure displays still pass.**
  Run: `node db/tests/customer-display.test.cjs` (alone, after the kiosk suite has finished).
  Expected: `all passed`.

- [ ] **Step 5: Commit.**
```bash
git add db/migrations/0160_kiosk.sql
git commit -m "Kiosk: the paid extra (trial, not premium, never a shop) and the kiosk printer row (0160)"
```

### Task 3: /admin, the Kiosk extra for a restaurant

**Files:** modify `web/app/admin/tenants/[id]/page.tsx:150-165` and `web/app/admin/tenants/[id]/view.tsx:510-530`.

- [ ] **Step 1: Make the action keep the other extras.** In `page.tsx`, `setFeatures` builds the whole array from `["deposits","accounts"]`, so a restaurant's Kiosk form would wipe a shop's extras and the other way round. Replace its first line with:

```ts
  // each form names the extras it shows (`shown`); the others the client has are kept
  const shown = String(formData.get("shown") ?? "deposits,accounts").split(",").filter((f) => ["deposits", "accounts", "kiosk"].includes(f));
  const had = ((await db().query(`select features from tenants where id = $1`, [tenantId])).rows[0]?.features ?? []) as string[];
  const features = [...had.filter((f) => !shown.includes(f)), ...shown.filter((f) => formData.get(f) === "on")];
```

  In the message that follows, name the kiosk: change `(f === "accounts" ? "customer accounts" : f)` to `(f === "accounts" ? "customer accounts" : f === "kiosk" ? "self-order kiosk" : f)`.

- [ ] **Step 2: Add `shown` to the shop's form and a restaurant form.** In `view.tsx`, inside the retail Extras form, after `{which}` add `<input type="hidden" name="shown" value="deposits,accounts" />`. After that form's closing `)}`, add:

```tsx
              {tenant.business_type !== "retail" && (
                <form action={actions.setFeatures} className="adm-part">
                  {which}
                  <input type="hidden" name="shown" value="kiosk" />
                  <strong>Extras</strong>
                  <span className="help">
                    Self-order kiosk: customers order on a big screen and pay at the counter. A paid extra on every plan, Premium too; trial has
                    it for demonstrations. The restaurant then adds its kiosks under Printers.
                  </span>
                  <label className="check">
                    <input type="checkbox" name="kiosk" defaultChecked={(tenant.features ?? []).includes("kiosk")} /> Self-order kiosk
                  </label>
                  <div className="inline">
                    <Submit className="btn-quiet">Save extras</Submit>
                  </div>
                </form>
              )}
```

- [ ] **Step 3: Type-check.** Run `cd web && npx tsc --noEmit`. Expected: no errors.
- [ ] **Step 4: Look at it.** Start the `web` preview (port 3000) and open `/admin/tenants/<a dev restaurant's id>`. Expected: the Extras box with "Self-order kiosk". Tick it and save: the message says "Extras now: self-order kiosk." Untick it again so dev is left as found.
- [ ] **Step 5: Commit.**
```bash
git add "web/app/admin/tenants/[id]/page.tsx" "web/app/admin/tenants/[id]/view.tsx"
git commit -m "/admin: a restaurant's Self-order kiosk extra; each extras form keeps the others"
```

### Task 4: Back office, Printers → Kiosks

**Files:** modify `web/lib/printers.ts`, `web/lib/saves.ts`, `web/app/backoffice/printers/page.tsx`.

- [ ] **Step 1: `printers.ts`.** In `PrinterRow`'s `kind` union add `| "kiosk"`. Change `silent` to `return kind === "screen" || kind === "display" || kind === "kiosk";`.

- [ ] **Step 2: `saves.ts`.** In `PrinterForm.kind` add `| "kiosk"`. In `addPrinter`:

```ts
  const screen = v.kind === "screen";
  // a display or a kiosk (0130, 0160): a tablet paired to one till, which prints nothing the till sends
  const paired = v.kind === "display" || v.kind === "kiosk";
  const silent = screen || paired;
```

  Then replace `display ?` with `paired ?` in its values, and `kind not in ('screen', 'display')` with `kind not in ('screen', 'display', 'kiosk')`.

  In `setReceiptPrinter`: `own.rows[0].kind === "display"` becomes `["display", "kiosk"].includes(own.rows[0].kind)`.

  In `savePrinter`:

```ts
  const screen = v.kind === "screen";
  const paired = v.kind === "display" || v.kind === "kiosk";
  if (screen || paired) { /* unchanged body */ }
```

  Then its `where` clause's last condition, `(kind = 'display') = ($4 = 'display')`, becomes:

```sql
and (kind = $4 or (kind not in ('display', 'kiosk') and $4 not in ('display', 'kiosk')))
```

  Replace `display ?` with `paired ?` in the values.

- [ ] **Step 3: The page.** In `printers/page.tsx`:
  - Read the extra with the page's other data: `const kioskOn = !shop && (await c.query(`select has_feature($1, 'kiosk') as h`, [ctx.tenantId])).rows[0].h === true;`. Use the page's own client and tenant variable names.
  - Add `const kiosks = all.filter((p) => p.kind === "kiosk");` next to `displays`.
  - Add a server action pair `addKiosk` / `saveKiosk`. Copy `addDisplay` / `saveDisplay` (lines 65-95) with these differences, written out:

```ts
// A self-order kiosk (0160): a big portrait screen where customers order and
// then pay at the counter. Set up from EasyPay's first screen as a kiosk; it
// shows its address and pairing code, typed here with the till that takes
// its orders. A paid extra (/admin).
async function kioskFields(c: import("pg").PoolClient, tenantId: string, store: string, f: FormData): Promise<saves.PrinterForm> {
  const v = await displayFields(c, tenantId, store, f);
  return { ...v, kind: "kiosk", message: String(f.get("welcome") ?? "").trim().slice(0, 120) || null };
}
```

    In `addKiosk` / `saveKiosk` use `kioskFields`, `kind = 'kiosk'` in the two queries, and these words:
    - "Kiosk removed."
    - "That kiosk is no longer there. Reload the page."
    - A refusal with `no-kiosk` (caught as the error's message) becomes `throw new Refused("This restaurant does not have the self-order kiosk. EasyPay switches it on.")`.

    `displayFields`' words say "display". Pass a `what` argument (`"display" | "kiosk"`) into it and use `the ${what === "kiosk" ? "kiosk" : "customer display"}` in its four sentences instead of copying it.
  - Render, after the Customer displays block (after line ~700), only when `kioskOn`:

```tsx
      {kioskOn && (
        <>
          <h2 style={{ marginTop: 28 }}>Kiosks</h2>
          <p className="muted">
            On the kiosk, install EasyPay and choose <strong>Set up as a kiosk</strong> on its first screen. It shows its address and pairing code: type
            both here and choose the till that takes its orders. Several kiosks can send to the same till; the till gives every order its number.
          </p>
          {/* the add form: DisplayFields' address, code and till, plus one line of welcome words */}
          <form action={addKiosk}>
            {/* same store picker and <DisplayFields tills=…/> as the Add a customer display form */}
            <label className="field">
              <span>Welcome words (optional)</span>
              <input name="welcome" maxLength={120} placeholder="Order here, pay at the counter" />
            </label>
            <Submit>Add kiosk</Submit>
          </form>
          {kiosks.map((p) => (
            <form key={p.id} action={saveKiosk}>
              <input type="hidden" name="id" value={p.id} />
              <strong>{p.name}</strong> <span className="muted">Kiosk · {p.address}</span>
              <DisplayFields p={p} tills={tills.filter((t) => t.store_id === p.store_id)} />
              <label className="field"><span>Welcome words (optional)</span><input name="welcome" maxLength={120} defaultValue={p.message ?? ""} /></label>
              <Submit>Save kiosk</Submit>
            </form>
          ))}
        </>
      )}
```

    Build the add form's store picker and sheet wrapper from the Add a customer display block (lines 626-672): same markup, with "kiosk" for "display" in every visible word. Also keep the kiosks out of the printers list and its warnings, the way `displays` are kept out (line ~416: `all.filter((p) => !silent(p.kind))` already does this once `silent` knows `kiosk`).

- [ ] **Step 4: Type-check and look.** Run `cd web && npx tsc --noEmit` (no errors). On the preview, as a dev **trial** restaurant: a Kiosks heading; add one at `10.0.2.16` with code `KYSK2345` and a till, and it is listed. As a dev **shop**: no Kiosks heading. Remove the test kiosk afterwards.
- [ ] **Step 5: Commit.**
```bash
git add web/lib/printers.ts web/lib/saves.ts web/app/backoffice/printers/page.tsx
git commit -m "Back office: Printers, Kiosks (a restaurant with the extra)"
```

**Checkpoint 1.** Report to the owner: the server and back office are done, shown on the preview, not live. Wait for a go-ahead before Phase 2 only if they asked to see each phase.

---

# Phase 2: The till's side

*Ends with: JVM tests for every rule. A till that knows kiosks, and how to take, number, open, hold, pay and cancel their orders.*

### Task 5: `kioskPaid` and the kiosk kind in routing

**Files:**
- Modify `core/data/PosSettings.kt` (beside `depositsPaid`, ~line 101 and ~line 207) and `core/data/Routing.kt`.
- Test: `android/app/src/test/java/com/restopos/core/data/PosSettingsTest.kt` and `RoutingTest.kt`.

- [ ] **Step 1: The failing tests.** Add to `PosSettingsTest`:

```kotlin
    @Test fun `a kiosk is trial or the extra, never premium alone, never a shop`() {
        assertTrue(PosSettings.parse("""{"plan":"trial"}""").kioskPaid)
        assertFalse(PosSettings.parse("""{"plan":"premium"}""").kioskPaid)
        assertTrue(PosSettings.parse("""{"plan":"premium","features":["kiosk"]}""").kioskPaid)
        assertTrue(PosSettings.parse("""{"plan":"offline","features":["deposits","kiosk"]}""").kioskPaid)
        assertFalse(PosSettings.parse("""{"plan":"trial","businessType":"retail"}""").kioskPaid)
        assertTrue(PosSettings.parse("""{"plan":"premium"}""").depositsPaid) // unchanged
    }
```

  And to `RoutingTest`:

```kotlin
    @Test fun `a kiosk prints nothing and is found by its till`() {
        val k = printer("k", kind = Routing.KIOSK).copy(device_id = "till-1", pair_code = "KYSK2345", address = "10.0.2.16")
        assertTrue(Routing.silent(Routing.KIOSK))
        assertTrue(Routing.paper(listOf(k)).isEmpty())
        assertEquals(listOf(k), Routing.kiosks(listOf(k), "till-1"))
        assertTrue(Routing.kiosks(listOf(k), "till-2").isEmpty())
    }
```

  Use the file's existing `printer(...)` helper. If its name differs, use the one the other tests in `RoutingTest` use.

- [ ] **Step 2: Run them.** `android/gradlew -p android :app:testDebugUnitTest --tests '*PosSettingsTest*' --tests '*RoutingTest*'`. Expected: FAIL, unresolved `kioskPaid` / `KIOSK` / `kiosks`.

- [ ] **Step 3: Implement.** In `PosSettings`, next to `val depositsPaid: Boolean = false,`:

```kotlin
    // the self-order kiosk (server 0160): trial, or the paid extra; Premium does not carry it, a shop never has it
    val kioskPaid: Boolean = false,
```

  In `parse`, next to `depositsPaid = …`:

```kotlin
                kioskPaid = d.str("businessType") != "retail" && (
                    d.str("plan")?.trim()?.lowercase() == "trial" ||
                        runCatching { d["features"]?.jsonArray?.any { it.jsonPrimitive.contentOrNull == "kiosk" } }.getOrNull() == true
                    ),
```

  In `Routing`:

```kotlin
    const val KIOSK = "kiosk"
    // A self-order kiosk (server 0160) is kept with the printers too: a tablet
    // where customers order, paired to the till that takes its orders.
    fun kiosks(all: List<PrinterEntity>, device: String?): List<PrinterEntity> =
        if (device == null) emptyList() else all.filter { it.kind == KIOSK && it.is_active && it.deleted_at == null && it.device_id == device }
```

  Then change `fun silent(kind: String): Boolean = kind == SCREEN || kind == DISPLAY` to `… || kind == KIOSK`, and line 146's port to `when (p.kind) { SCREEN -> 9310; DISPLAY -> 9311; KIOSK -> 9312; else -> 9100 }`. Grep `Routing.DISPLAY` and `"display"` across `feature/settings` and `core/data/PrinterForm.kt`: every place that keeps displays out of a printer list keeps `KIOSK` out too.

- [ ] **Step 4: Run them again.** Same command. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/data/PosSettings.kt android/app/src/main/java/com/restopos/core/data/Routing.kt android/app/src/test/java/com/restopos/core/data/PosSettingsTest.kt android/app/src/test/java/com/restopos/core/data/RoutingTest.kt
git commit -m "Till: kioskPaid (trial or the extra, not premium) and the kiosk kind"
```

### Task 6: The wire

**Files:**
- Create `core/kiosk/KioskWire.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskWireTest.kt`.

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import org.junit.Assert.*
import org.junit.Test

class KioskWireTest {
    private val menu = KioskMenu(name = "Star Grill", dining = listOf(KioskDining("d1", "Eat in")), categories = emptyList(), items = emptyList(), groups = emptyList())

    @Test fun `a request signed with the code is read back, with any other code it is not`() {
        val req = KioskRequest(till = "t1", tillName = "Till 1", kiosk = "Kiosk 1", open = true, menuHash = "h", menu = menu, answers = listOf(KioskAnswer("o1", number = 23)))
        val text = KioskWire.encode(req, "KYSK2345")
        val (first, second) = text.trimEnd('\n').split('\n')
        assertEquals(req, KioskWire.decode(first, second, "KYSK2345"))
        assertNull(KioskWire.decode(first, second, "OTHER234"))
        assertNull(KioskWire.decode(first.replace("23", "24"), second, "KYSK2345"))
    }

    @Test fun `a reply goes and comes back whole`() {
        val r = KioskReply(ok = true, menuHash = "h", pictures = listOf("i1@5"), orders = listOf(KioskPlaced("o1", "d1", listOf(KioskLine("i1", 2, listOf("m1"))), 49000, 7L)), gaveUp = listOf("o0"), printer = "No paper")
        assertEquals(r, KioskWire.decodeReply(KioskWire.encode(r).trimEnd('\n')))
    }

    @Test fun `a newer kiosk's extra words are read past`() {
        val line = """{"ok":true,"v":1,"build":5,"menuHash":"","pictures":[],"orders":[],"gaveUp":[],"later":"x"}"""
        assertEquals(true, KioskWire.decodeReply(line)?.ok)
    }
}
```

- [ ] **Step 2: Run it.** `--tests '*KioskWireTest*'`. Expected: FAIL, unresolved references.

- [ ] **Step 3: Implement.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.display.Poster
import com.restopos.core.kitchen.Wire
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.security.MessageDigest

// What a till and a self-order kiosk say to each other over the restaurant's
// own Wi-Fi. Framed and signed as a till and a kitchen screen are (Wire): the
// till opens a short connection to the kiosk's address about once a second,
// writes one request and reads one reply.
//
//   till   -> kiosk  <the request, one line of JSON>\n<its signature>\n
//   kiosk  -> till   <the reply, one line of JSON>\n
//
// The kiosk never calls the till: it is reached at the address the back
// office was given, so it needs nothing of the till's own address.

// What the kiosk offers. Prices in cents, as the till keeps them.
@Serializable data class KioskDining(val id: String, val name: String)
@Serializable data class KioskCategory(val id: String, val name: String)
@Serializable data class KioskOption(val id: String, val name: String, val price: Long, val alone: Boolean = false)
@Serializable data class KioskGroup(val id: String, val name: String, val min: Int, val max: Int, val options: List<KioskOption>)
// `picture` is "<item id>@<the time it was set>", or "" for none; `soldOut` greys it
@Serializable data class KioskItem(
    val id: String, val category: String, val name: String, val price: Long,
    val picture: String = "", val soldOut: Boolean = false, val groups: List<String> = emptyList(),
)
// `logo` is the business's logo as on the receipts (a data URL); `welcome` its words for the Welcome screen
// (the kiosk row's message); `welcomePicture` the key of its welcome picture, sent as the dishes' are, or ""
@Serializable data class KioskMenu(
    val name: String, val logo: String = "", val welcome: String = "", val welcomePicture: String = "",
    val dining: List<KioskDining>, val categories: List<KioskCategory>, val items: List<KioskItem>, val groups: List<KioskGroup>,
)

// An order as the kiosk placed it: dishes, how many, the options picked. No
// price is trusted: the till works the total out from its own menu.
@Serializable data class KioskLine(val item: String, val qty: Int, val mods: List<String>)
@Serializable data class KioskPlaced(val id: String, val dining: String, val lines: List<KioskLine>, val total: Long, val at: Long)

// The till's answer to one placed order: its number, or why not (words for the customer).
@Serializable data class KioskAnswer(val id: String, val number: Int? = null, val refused: String? = null)

// `open`: the till takes orders now (day open, not Look only). `menu` is
// sent whole only when the kiosk said it holds another hash. `picture`: one
// picture the kiosk lacks, whole, one per exchange (as a display's posters).
@Serializable
data class KioskRequest(
    val v: Int = KioskWire.VERSION,
    val till: String,
    val tillName: String,
    val kiosk: String,
    val open: Boolean,
    val menuHash: String,
    val menu: KioskMenu? = null,
    val picture: Poster? = null,
    val answers: List<KioskAnswer> = emptyList(),
    val now: Long = 0,
)

// `orders`: placed and not answered yet. `gaveUp`: orders it stopped waiting
// for (5 s with no answer): the till cancels any of them it took. `printer`:
// trouble with its own printer, in words ("No paper"), or null.
@Serializable
data class KioskReply(
    val ok: Boolean,
    val error: String? = null,
    val v: Int = KioskWire.VERSION,
    val build: Int = 0,
    val menuHash: String = "",
    val pictures: List<String> = emptyList(),
    val orders: List<KioskPlaced> = emptyList(),
    val gaveUp: List<String> = emptyList(),
    val printer: String? = null,
)

object KioskWire {
    const val VERSION = 1
    const val PORT = 9312
    const val REFUSED = "refused"
    const val OTHER_VERSION = "version"

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun encode(req: KioskRequest, code: String): String {
        val line = json.encodeToString(KioskRequest.serializer(), req)
        return line + "\n" + Wire.sign(code, line) + "\n"
    }

    fun decode(first: String, second: String, code: String): KioskRequest? {
        val want = Wire.sign(code, first).toByteArray(Charsets.UTF_8)
        if (!MessageDigest.isEqual(want, second.trim().toByteArray(Charsets.UTF_8))) return null
        return runCatching { json.decodeFromString(KioskRequest.serializer(), first) }.getOrNull()
    }

    fun encode(reply: KioskReply): String = json.encodeToString(KioskReply.serializer(), reply) + "\n"
    fun decodeReply(line: String): KioskReply? = runCatching { json.decodeFromString(KioskReply.serializer(), line) }.getOrNull()

    fun encodeMenu(m: KioskMenu): String = json.encodeToString(KioskMenu.serializer(), m)
    fun decodeMenu(text: String): KioskMenu? = runCatching { json.decodeFromString(KioskMenu.serializer(), text) }.getOrNull()
    fun encodePlaced(p: KioskPlaced): String = json.encodeToString(KioskPlaced.serializer(), p)
    fun decodePlaced(text: String): KioskPlaced? = runCatching { json.decodeFromString(KioskPlaced.serializer(), text) }.getOrNull()

    // the hash both ends compare, so the menu is sent only when it changed
    fun hash(m: KioskMenu): String =
        MessageDigest.getInstance("SHA-256").digest(encodeMenu(m).toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }.take(16)

    // What a till that cannot reach a kiosk says on its Printers page.
    fun trouble(name: String, address: String?, reply: KioskReply?): String? = when {
        reply == null -> "$name is not answering at $address. Check it is on and on the same Wi-Fi."
        reply.error == REFUSED -> "$name refused this till: check its pairing code."
        reply.error == OTHER_VERSION -> "$name runs another EasyPay version: update both to the same one."
        reply.printer != null -> "$name: ${reply.printer}"
        else -> null
    }
}
```

  `Poster` is `com.restopos.core.display.Poster(hash, jpeg)` (DisplayWire.kt line 43). Check that it is `@Serializable` and public; it is used inside `DisplayRequest`, so it is.

- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskWire.kt android/app/src/test/java/com/restopos/core/kiosk/KioskWireTest.kt
git commit -m "Kiosk: the wire between a till and its kiosks"
```

### Task 7: The menu the till sends

**Files:**
- Create `core/kiosk/KioskMenus.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskMenusTest.kt`.

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.database.*
import org.junit.Assert.*
import org.junit.Test

class KioskMenusTest {
    private val cats = listOf(CategoryEntity("c2", "t", "Drinks", sort_order = 2), CategoryEntity("c1", "t", "Burgers", sort_order = 1), CategoryEntity("c3", "t", "Empty", sort_order = 3))
    private val items = listOf(
        ItemEntity("i1", "t", category_id = "c1", name = "Classic", price = 24500),
        ItemEntity("i2", "t", category_id = "c1", name = "Fish", price = 21000, is_available = false),
        ItemEntity("i3", "t", category_id = "c2", name = "Cola", price = 6000),
        ItemEntity("i4", "t", category_id = "c2", name = "Gone", price = 1, deleted_at = "2026-01-01"),
        ItemEntity("i5", "t", category_id = null, name = "No category", price = 1),
        ItemEntity("i6", "t", category_id = "c2", name = "Open price", price = 0).copy(open_price = true),
    )
    private val dining = listOf(
        DiningOptionEntity("d1", "t", "Eat in", kind = "dine", needs_table = true, sort_order = 1),
        DiningOptionEntity("d2", "t", "Take away", kind = "takeaway", sort_order = 2),
        DiningOptionEntity("d3", "t", "Delivery", kind = "delivery", sort_order = 3),
    )
    private val size = ModifierGroupEntity("g1", "t", "Size", min_select = 1, max_select = 1)
    private val opts = mapOf("g1" to listOf(ModifierEntity("m1", "t", "g1", "Regular"), ModifierEntity("m2", "t", "g1", "Double", price = 7500)))

    private fun build() = KioskMenus.build(
        name = "Star Grill", logo = "", welcome = "Hi", welcomePicture = "", dining = dining, categories = cats, items = items,
        groupsOf = mapOf("i1" to listOf(size)), optionsOf = opts, pictures = mapOf("i1" to 5L),
    )

    @Test fun `what a kiosk offers`() {
        val m = build()
        assertEquals(listOf("Burgers", "Drinks"), m.categories.map { it.name }) // in order, none empty
        assertEquals(listOf("i1", "i2", "i3"), m.items.map { it.id })          // no deleted, no category-less, no open price
        assertTrue(m.items.first { it.id == "i2" }.soldOut)
        assertEquals("i1@5", m.items.first { it.id == "i1" }.picture)
        assertEquals("", m.items.first { it.id == "i3" }.picture)
        assertEquals(listOf("g1"), m.items.first { it.id == "i1" }.groups)
        assertEquals(listOf("Regular", "Double"), m.groups.single().options.map { it.name })
        assertEquals(listOf("Eat in", "Take away"), m.dining.map { it.name })  // never delivery
    }

    @Test fun `the same menu has the same hash, a price change another`() {
        assertEquals(KioskWire.hash(build()), KioskWire.hash(build()))
        val dearer = build().let { it.copy(items = it.items.map { i -> if (i.id == "i1") i.copy(price = 25000) else i }) }
        assertNotEquals(KioskWire.hash(build()), KioskWire.hash(dearer))
    }
}
```

  Check the entity constructors' argument order against `core/database/Entities.kt` (`CategoryEntity(id, tenant_id, name, …)`, `ItemEntity(id, tenant_id, category_id, name, price, …)`) and use named arguments where the order differs. `open_price` is on `ItemEntity` (`GuestCheck` reads `item.open_price`).

- [ ] **Step 2: Run it.** Expected: FAIL, unresolved `KioskMenus`.

- [ ] **Step 3: Implement.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.database.*

// The menu a till sends its kiosks, made from the till's own catalog as it is
// now. The kiosk shows only this, and the till checks every order against its
// catalog again (KioskRules), so a moment-old menu does no harm.
object KioskMenus {
    fun build(
        name: String, logo: String, welcome: String, welcomePicture: String,
        dining: List<DiningOptionEntity>, categories: List<CategoryEntity>, items: List<ItemEntity>,
        groupsOf: Map<String, List<ModifierGroupEntity>>, optionsOf: Map<String, List<ModifierEntity>>,
        pictures: Map<String, Long>, // item id -> when its picture was set
    ): KioskMenu {
        val cats = categories.filter { it.deleted_at == null }.sortedWith(compareBy({ it.sort_order }, { it.name }))
        val catIds = cats.map { it.id }.toSet()
        val offered = items.filter { it.deleted_at == null && !it.open_price && it.category_id in catIds }
            .sortedBy { i -> cats.indexOfFirst { it.id == i.category_id } }
        val used = offered.flatMap { groupsOf[it.id].orEmpty() }.filter { it.deleted_at == null }.distinctBy { it.id }
        return KioskMenu(
            name = name, logo = logo, welcome = welcome, welcomePicture = welcomePicture,
            dining = KioskRules.dining(dining).map { KioskDining(it.id, it.name) },
            categories = cats.filter { c -> offered.any { it.category_id == c.id } }.map { KioskCategory(it.id, it.name) },
            items = offered.map { i ->
                KioskItem(
                    id = i.id, category = i.category_id!!, name = i.name, price = i.price,
                    picture = pictures[i.id]?.let { "${i.id}@$it" }.orEmpty(),
                    soldOut = !i.is_available,
                    groups = groupsOf[i.id].orEmpty().filter { it.deleted_at == null }.map { it.id },
                )
            },
            groups = used.map { g ->
                KioskGroup(g.id, g.name, g.min_select, g.max_select,
                    optionsOf[g.id].orEmpty().filter { it.deleted_at == null }.map { KioskOption(it.id, it.name, it.price, it.alone) })
            },
        )
    }
}
```

  `KioskRules.dining` comes in Task 8. Write Task 8's `dining` first if the build complains, or run this test after Task 8.

- [ ] **Step 4: Run it (after Task 8 Step 3 if needed).** Expected: PASS.
- [ ] **Step 5: Commit** (with Task 8, as one commit, if they were run together).

### Task 8: The till's rules for a kiosk order

**Files:**
- Modify `core/guest/GuestOrders.kt` (split `GuestCheck.of`).
- Create `core/kiosk/KioskRules.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskRulesTest.kt`. Keep the existing `GuestCheck` tests passing.

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.database.*
import com.restopos.core.guest.Checked
import com.restopos.core.guest.MenuBook
import org.junit.Assert.*
import org.junit.Test

class KioskRulesTest {
    private val burger = ItemEntity("i1", "t", category_id = "c1", name = "Classic", price = 24500)
    private val fish = ItemEntity("i2", "t", category_id = "c1", name = "Fish", price = 21000, is_available = false)
    private val size = ModifierGroupEntity("g1", "t", "Size", min_select = 1, max_select = 1)
    private val book = MenuBook(
        tables = emptyMap(), items = mapOf("i1" to burger, "i2" to fish),
        groupsOf = mapOf("i1" to listOf(size)),
        optionsOf = mapOf("g1" to listOf(ModifierEntity("m1", "t", "g1", "Regular"), ModifierEntity("m2", "t", "g1", "Double", price = 7500))),
    )
    private val dining = listOf(DiningOptionEntity("d1", "t", "Eat in", kind = "dine"), DiningOptionEntity("d3", "t", "Delivery", kind = "delivery"))
    private fun order(vararg l: KioskLine, d: String = "d1") = KioskPlaced("o1", d, l.toList(), total = 1, at = 0)

    @Test fun `an order is priced by the till, never by the kiosk`() {
        val c = KioskRules.check(order(KioskLine("i1", 2, listOf("m2"))), book, dining)
        assertTrue(c is Checked.Ready)
        assertEquals(2 * (24500 + 7500L), (c as Checked.Ready).total)
    }

    @Test fun `what is refused, in words for the customer`() {
        assertEquals("Fish is sold out.", (KioskRules.check(order(KioskLine("i2", 1, emptyList())), book, dining) as Checked.Fault).why)
        assertTrue(KioskRules.check(order(KioskLine("i1", 1, emptyList())), book, dining) is Checked.Fault) // size not chosen
        assertTrue(KioskRules.check(order(KioskLine("i1", 1, listOf("m1")), d = "d3"), book, dining) is Checked.Fault) // delivery
        assertTrue(KioskRules.check(order(KioskLine("i1", 1, listOf("m1")), d = "gone"), book, dining) is Checked.Fault)
        assertTrue(KioskRules.check(order(), book, dining) is Checked.Fault)
    }

    @Test fun `numbers start at one each day and follow the highest`() {
        assertEquals(1, KioskRules.next(null))
        assertEquals(24, KioskRules.next(23))
        assertEquals(1, KioskRules.next(999)) // after 999, back to 1: three figures on the slip
    }

    @Test fun `every dining option but delivery`() {
        assertEquals(listOf("d1"), KioskRules.dining(dining).map { it.id })
    }
}
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Split `GuestCheck.of`.** In `core/guest/GuestOrders.kt`, move the body after the table check into a new function, and have `of` call it:

```kotlin
    fun of(order: GuestOrder, book: MenuBook): Checked {
        if (order.table !in book.tables) return Checked.Fault("This table is no longer on the floor plan.")
        return lines(order.table, order.lines, book, phone = true)
    }

    // The lines of an order held against the menu, for a table's phone or a
    // kiosk (`phone` false: there is no table and the words are the kiosk's).
    fun lines(table: String, lines: List<GuestLine>, book: MenuBook, phone: Boolean = true): Checked {
        if (lines.isEmpty()) return Checked.Fault("The order is empty.")
        // … the existing loop from `if (order.lines.size > MOST_LINES)` to `return Checked.Ready(order.table, ready)`,
        //   with `order.lines` -> `lines`, `order.table` -> `table`,
        //   and the open-price words: if (phone) "…cannot be ordered from a table." else "${item.name} cannot be ordered here."
    }
```

  Move the loop as it stands; change only the names listed. `Checked.Ready(table, …)` takes `""` for a kiosk.

  Then `KioskRules.kt`:

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.database.DiningOptionEntity
import com.restopos.core.guest.Checked
import com.restopos.core.guest.GuestCheck
import com.restopos.core.guest.GuestLine
import com.restopos.core.guest.MenuBook

// What the till holds a kiosk order to. The kiosk's own total is never used.
object KioskRules {
    // every dining option but delivery, in their order (spec: unticking per kiosk is a later piece)
    fun dining(all: List<DiningOptionEntity>): List<DiningOptionEntity> =
        all.filter { it.deleted_at == null && it.kind != "delivery" }.sortedWith(compareBy({ it.sort_order }, { it.name }))

    fun check(o: KioskPlaced, book: MenuBook, dining: List<DiningOptionEntity>): Checked {
        if (dining(dining).none { it.id == o.dining }) return Checked.Fault("Please order at the counter.")
        return GuestCheck.lines("", o.lines.map { GuestLine(it.item, it.qty, it.mods, "") }, book, phone = false)
    }

    // the next number of the day after the highest given so far today
    fun next(highest: Int?): Int = if (highest == null || highest >= 999) 1 else highest + 1
}
```

  If `Checked.Ready` has no `total`, it does: `val total: Long get() = lines.sumOf { it.total }` (GuestOrders.kt).

- [ ] **Step 4: Run the kiosk tests and the guest tests.** `--tests '*KioskRulesTest*' --tests '*KioskMenusTest*' --tests '*Guest*'`. Expected: PASS, and no guest test changed.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/guest/GuestOrders.kt android/app/src/main/java/com/restopos/core/kiosk/KioskRules.kt android/app/src/main/java/com/restopos/core/kiosk/KioskMenus.kt android/app/src/test/java/com/restopos/core/kiosk/
git commit -m "Kiosk: the menu a till sends and the rules it holds an order to"
```

### Task 9: Room 40, `kiosk_orders`

**Files:**
- Create `core/database/Kiosk.kt`.
- Modify `core/database/TillDatabase.kt` (entities, `version = 40`, `fun kiosk(): KioskDao`) and `core/database/Migrations.kt` (`V39_V40`, added to `ALL`).
- Test: the app's Room migration test, if there is one (`grep -rl "MigrationTestHelper" android/app/src`); otherwise the build itself plus Task 10's tests.

- [ ] **Step 1: The entity and DAO.**

```kotlin
package com.restopos.core.database

import androidx.room.*
import kotlinx.coroutines.flow.Flow

// An order placed on a self-order kiosk and given its number by this till.
// Not a ticket: it never blocks Close day and never syncs as a sale. Open
// turns it into an ordinary order (ticket_id), Cancel or the day's close
// ends it. `day` is the open day's shift id: numbers start at 1 each day.
@Entity(tableName = "kiosk_orders", indices = [Index("day"), Index("status")])
data class KioskOrderEntity(
    @PrimaryKey val id: String,       // the kiosk's own id for it: a second placing of the same order is the same row
    val kiosk_id: String,             // the kiosk's printer row
    val kiosk_name: String,
    val day: String,
    val number: Int,
    val dining_option_id: String,
    val lines: String,                // the order's lines as the kiosk sent them (KioskWire.encodePlaced)
    val total: Long,                  // as the till priced it
    val placed_at: Long,              // by this till's clock
    val status: String = "waiting",   // waiting, taken, cancelled
    val ticket_id: String? = null,    // the order it became
    val ended_at: Long? = null,
)

@Dao
interface KioskDao {
    @Query("SELECT * FROM kiosk_orders WHERE status = 'waiting' ORDER BY number") fun waiting(): Flow<List<KioskOrderEntity>>
    @Query("SELECT * FROM kiosk_orders WHERE id = :id") suspend fun order(id: String): KioskOrderEntity?
    @Query("SELECT * FROM kiosk_orders WHERE day = :day AND number = :number AND status = 'waiting'") suspend fun byNumber(day: String, number: Int): KioskOrderEntity?
    @Query("SELECT MAX(number) FROM kiosk_orders WHERE day = :day") suspend fun highest(day: String): Int?
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun insert(row: KioskOrderEntity): Long
    @Query("UPDATE kiosk_orders SET status = 'taken', ticket_id = :ticket, ended_at = :at WHERE id = :id AND status = 'waiting'") suspend fun take(id: String, ticket: String?, at: Long): Int
    @Query("UPDATE kiosk_orders SET ticket_id = :ticket WHERE id = :id") suspend fun setTicket(id: String, ticket: String)
    @Query("UPDATE kiosk_orders SET status = 'cancelled', ended_at = :at WHERE id = :id AND status = 'waiting'") suspend fun cancel(id: String, at: Long): Int
    @Query("UPDATE kiosk_orders SET status = 'cancelled', ended_at = :at WHERE day = :day AND status = 'waiting'") suspend fun cancelDay(day: String, at: Long): Int
    // a kiosk order opened on the till and not paid yet: the kitchen waits for its payment
    @Query("SELECT COUNT(*) > 0 FROM kiosk_orders WHERE ticket_id = :ticket") suspend fun fromKiosk(ticket: String): Boolean
}
```

- [ ] **Step 2: Room 40.** In `TillDatabase.kt` add `KioskOrderEntity::class` to `entities`, set `version = 40`, and add `abstract fun kiosk(): KioskDao`. In `Migrations.kt`:

```kotlin
    // 40: orders from the self-order kiosks (server 0160), held on the till apart from its tickets
    val V39_V40 = object : Migration(39, 40) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `kiosk_orders` (`id` TEXT NOT NULL, `kiosk_id` TEXT NOT NULL, `kiosk_name` TEXT NOT NULL, `day` TEXT NOT NULL, `number` INTEGER NOT NULL, `dining_option_id` TEXT NOT NULL, `lines` TEXT NOT NULL, `total` INTEGER NOT NULL, `placed_at` INTEGER NOT NULL, `status` TEXT NOT NULL, `ticket_id` TEXT, `ended_at` INTEGER, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_kiosk_orders_day` ON `kiosk_orders` (`day`)")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_kiosk_orders_status` ON `kiosk_orders` (`status`)")
        }
    }
```

  Add `V39_V40` to the end of `ALL`. Do **not** reset `sync_state`: nothing pulled changed.

- [ ] **Step 3: Build.** `android/gradlew -p android :app:compileDebugKotlin`. Expected: success. Room checks the schema at compile time with `exportSchema`: if the project exports schemas (`android/app/schemas/`), the new `40.json` is generated. Add it to the commit.
- [ ] **Step 4: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/database/Kiosk.kt android/app/src/main/java/com/restopos/core/database/TillDatabase.kt android/app/src/main/java/com/restopos/core/database/Migrations.kt android/app/schemas
git commit -m "Till: kiosk_orders (Room 40)"
```

### Task 10: `KioskDesk`, the till taking, numbering, opening and cancelling

**Files:**
- Create `core/kiosk/KioskDesk.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskNumbersTest.kt`, for the one rule that needs a lock (numbers).

The desk needs Room, the session and the ticket repository. Its numbering is the double-number risk with four kiosks, so it is pulled out into a small class that the test drives with a fake store.

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class KioskNumbersTest {
    // a store as Room would be: the highest number of a day, and a row put once by its id
    private class FakeStore : KioskNumbers.Store {
        val rows = java.util.concurrent.ConcurrentHashMap<String, Pair<String, Int>>()
        override suspend fun highest(day: String) = rows.values.filter { it.first == day }.maxOfOrNull { it.second }
        override suspend fun numberOf(id: String) = rows[id]?.second
        suspend fun put(id: String, day: String, number: Int): Boolean { yield(); return rows.putIfAbsent(id, day to number) == null }
    }
    private suspend fun KioskNumbers.giveTo(store: FakeStore, id: String, day: String) = give(id, day) { n -> store.put(id, day, n) }

    @Test fun `four kiosks at once never get the same number`() = runTest {
        val store = FakeStore()
        val numbers = KioskNumbers(store)
        val got = (1..40).map { i -> async(Dispatchers.Default) { numbers.giveTo(store, "o$i", "day1") } }.awaitAll()
        assertEquals((1..40).toList(), got.sorted())
    }

    @Test fun `the same order placed twice keeps its number`() = runTest {
        val store = FakeStore(); val numbers = KioskNumbers(store)
        assertEquals(1, numbers.giveTo(store, "o1", "day1"))
        assertEquals(1, numbers.giveTo(store, "o1", "day1"))
        assertEquals(2, numbers.giveTo(store, "o2", "day1"))
    }

    @Test fun `a new day starts at one`() = runTest {
        val store = FakeStore(); val numbers = KioskNumbers(store)
        numbers.giveTo(store, "o1", "day1"); numbers.giveTo(store, "o2", "day1")
        assertEquals(1, numbers.giveTo(store, "o3", "day2"))
    }
}
```

  If `kotlinx-coroutines-test` is not yet a test dependency, check `android/app/build.gradle.kts` (`testImplementation`). It is used by other tests if `runTest` appears anywhere (`grep -rl runTest android/app/src/test`). If not, use `runBlocking` instead of `runTest`.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.** In `core/kiosk/KioskDesk.kt`:

```kotlin
package com.restopos.core.kiosk

import androidx.room.withTransaction
import com.restopos.core.common.Uuid7
import com.restopos.core.data.PosSettings
import com.restopos.core.data.SellCheck
import com.restopos.core.data.TicketRepository
import com.restopos.core.database.KioskOrderEntity
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.guest.Checked
import com.restopos.core.guest.GuestBook
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import javax.inject.Inject
import javax.inject.Singleton

// One number at a time for the whole till, whichever kiosk asks: four kiosks
// placing at the same moment get four numbers. An order placed twice (its
// answer was lost and the kiosk asked again) keeps the number it was given.
class KioskNumbers(private val store: Store) {
    interface Store {
        suspend fun highest(day: String): Int?
        suspend fun numberOf(id: String): Int?
    }
    private val lock = Mutex()
    // `put` writes the row with the number it is given; false when a row of that id is there already
    suspend fun give(id: String, day: String, put: suspend (Int) -> Boolean): Int = lock.withLock {
        store.numberOf(id)?.let { return@withLock it }
        val n = KioskRules.next(store.highest(day))
        check(put(n)) { "kiosk order $id was put twice" }
        n
    }
}

// The till's side of its kiosks' orders.
@Singleton
class KioskDesk @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val tickets: TicketRepository,
    private val guests: GuestBook,   // its MenuBook is the till's catalog as orders are held to it
    private val sell: SellCheck,
) {
    fun waiting(): Flow<List<KioskOrderEntity>> = db.kiosk().waiting()

    // the open day, or null: the kiosk is told to send customers to the counter
    suspend fun openDay(): String? = runCatching {
        sell.check("ticket.add_line")   // Look only, the day not open, the day closing by itself
        session.deviceId()?.let { db.staff().openShift(it)?.id }
    }.getOrNull()

    // Takes one placed order: its number, or why not. Never throws.
    suspend fun take(kiosk: PrinterEntity, o: KioskPlaced, now: Long = System.currentTimeMillis()): KioskAnswer {
        db.kiosk().order(o.id)?.let { return KioskAnswer(o.id, number = it.number) }
        val day = openDay() ?: return KioskAnswer(o.id, refused = "Please order at the counter.")
        val ready = when (val c = KioskRules.check(o, guests.book(), db.catalog().diningOptions())) {
            is Checked.Fault -> return KioskAnswer(o.id, refused = c.why)
            is Checked.Ready -> c
        }
        val n = numbers.give(o.id, day) { number ->
            db.kiosk().insert(KioskOrderEntity(o.id, kiosk.id, kiosk.name, day, number, o.dining, KioskWire.encodePlaced(o), ready.total, now)) != -1L
        }
        return KioskAnswer(o.id, number = n)
    }

    // one numbering for the whole till, whichever kiosk asks
    private val numbers = KioskNumbers(object : KioskNumbers.Store {
        override suspend fun highest(day: String) = db.kiosk().highest(day)
        override suspend fun numberOf(id: String) = db.kiosk().order(id)?.number
    })

    suspend fun book() = guests.book()

    // The kiosk stopped waiting for this one (no answer within 5 s): if it was taken, nobody has its slip.
    suspend fun gaveUp(id: String) { db.kiosk().cancel(id, System.currentTimeMillis()) }

    // Open: it becomes an ordinary new order on the register, with its dining option and lines.
    suspend fun open(id: String): Result<Unit> = runCatching {
        sell.check("ticket.add_line")
        val row = db.kiosk().order(id)?.takeIf { it.status == "waiting" } ?: error("This kiosk order was already opened or cancelled.")
        val placed = KioskWire.decodePlaced(row.lines) ?: error("This kiosk order cannot be read.")
        val ready = when (val c = KioskRules.check(placed, guests.book(), db.catalog().diningOptions())) {
            is Checked.Fault -> error(c.why)
            is Checked.Ready -> c
        }
        if (db.kiosk().take(id, null, System.currentTimeMillis()) == 0) error("This kiosk order was already opened or cancelled.")
        tickets.startOrder(row.dining_option_id)
        for (l in ready.lines) tickets.addItem(l.item.id, l.thousandths, l.mods, null).getOrThrow()
        tickets.activeTicket()?.id?.let { db.kiosk().setTicket(id, it) }
    }

    suspend fun cancel(id: String): Boolean = db.kiosk().cancel(id, System.currentTimeMillis()) > 0

    // Called by each of the three day closes, inside or before their transaction: the count goes on the Z.
    suspend fun closeDay(day: String, at: Long): Int = db.kiosk().cancelDay(day, at)

    suspend fun byNumber(number: Int): KioskOrderEntity? = openDay()?.let { db.kiosk().byNumber(it, number) }
}
```

  Check `tickets.activeTicket()` exists with that name (`OrderOps.saveNow` calls `tickets.activeTicket()`), and that `db.staff().openShift(device)` returns an entity with `id` (`CashOps.closeDay` uses `open.id` through `.copy`, so it does).

- [ ] **Step 4: Run it.** `--tests '*KioskNumbersTest*'`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskDesk.kt android/app/src/test/java/com/restopos/core/kiosk/KioskNumbersTest.kt
git commit -m "Till: the kiosk desk takes, numbers (one at a time), opens and cancels kiosk orders"
```

### Task 11: The kitchen waits for the payment; the day close cancels and counts

**Files:**
- Modify `core/data/OrderOps.kt` (`saveNow`, ~line 117) and `core/data/CashOps.kt` (`closeDay` ~437, `closeDayAsked` ~538, `closeDayAuto` ~603).
- Modify the Z document (`ZDoc`, where `carried` is declared) and the paper that prints `carried`.
- Test: `android/app/src/test/java/com/restopos/core/data/AutoCloseRulesTest.kt`, for the notice words.

- [ ] **Step 1: The failing test.** In `AutoCloseRulesTest` add:

```kotlin
    @Test fun `kiosk orders not paid are named in the notice`() {
        val n = AutoCloseRules.notice(4, 0L, carried = 0, zone = java.time.ZoneId.of("Indian/Mauritius"), kiosk = 3)
        assertTrue(n, n.contains("3 kiosk orders not paid were cancelled."))
        val one = AutoCloseRules.notice(4, 0L, carried = 0, zone = java.time.ZoneId.of("Indian/Mauritius"), kiosk = 1)
        assertTrue(one, one.contains("1 kiosk order not paid was cancelled."))
    }
```

- [ ] **Step 2: Run it.** Expected: FAIL (no `kiosk` parameter).

- [ ] **Step 3: Implement.**
  - **`AutoCloseRules.notice`:** add `kiosk: Int = 0` and append, after the carried words:

```kotlin
        val kioskWords = when (kiosk) { 0 -> ""; 1 -> " 1 kiosk order not paid was cancelled."; else -> " $kiosk kiosk orders not paid were cancelled." }
```

  - **`ZDoc`:** add `val kioskCancelled: Int = 0`. Where the Z paper prints `carried` (grep `carried` in `core/print/Docs.kt` and `Papers.kt`), print, when above 0, a line `Kiosk orders not paid: $kioskCancelled` the same way.
  - **`CashOps`:** inject `KioskDesk` (constructor). In `closeDay`, after `unpaidNow()?.let { throw … }` and before `val z = dayDoc(…)`:

```kotlin
        // kiosk orders nobody paid for end with the day (they are not tickets: they never block it)
        val kioskCancelled = kiosk.closeDay(open.id, now)
```

    and `val z = dayDoc(now).withDrawer(closed).copy(kioskCancelled = kioskCancelled)`. Do the same in `closeDayAsked` (with its `at`) and in `closeDayAuto` (`.copy(carried = carried, kioskCancelled = kiosk.closeDay(open.id, at))`). In `AutoClose.kt:82` pass `kiosk = z.kioskCancelled` to `notice`.

    `KioskDesk` takes `TicketRepository` and `GuestBook`, not `CashOps`, so injecting it into `CashOps` makes no cycle. If Hilt reports one, inject `TillDatabase` and call `db.kiosk().cancelDay(open.id, now)` directly instead.
  - **`OrderOps.saveNow`:** right after `if (mode == "off") return@run …`:

```kotlin
        // an order from a kiosk goes to the kitchen when it is paid (sendOnPay), not on Save (spec 2026-11-18)
        if (db.kiosk().fromKiosk(t.id)) return@run SaveResult(0, emptyList(), onDisplay = display)
```

    `sendOnPayNow` is left as it is: after a payment it sends every paid line the kitchen has not had, whatever the dining option's kitchen setting is, except "off". So a kiosk order reaches the kitchen once, on Pay, and a failed Pay sends nothing (`afterPay` runs only after a receipt is written).

- [ ] **Step 4: Run.** `--tests '*AutoCloseRulesTest*'`, then the whole suite once: `android/gradlew -p android :app:testDebugUnitTest`. Expected: all PASS.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/data/OrderOps.kt android/app/src/main/java/com/restopos/core/data/CashOps.kt android/app/src/main/java/com/restopos/core/data/AutoClose.kt android/app/src/main/java/com/restopos/core/data/AutoCloseRules.kt android/app/src/main/java/com/restopos/core/print android/app/src/test/java/com/restopos/core/data/AutoCloseRulesTest.kt
git commit -m "Till: a kiosk order goes to the kitchen on Pay; the day's close cancels and counts the waiting ones"
```

### Task 12: `KioskLink`, the till calling its kiosks

**Files:**
- Create `core/kiosk/KioskLink.kt`.
- Modify where `DisplayLink.start()` is called (grep `displayLink.start\|DisplayLink` in `app/` and `feature/main`) to also start `KioskLink`.

- [ ] **Step 1: Implement.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.data.PosSettings
import com.restopos.core.data.Routing
import com.restopos.core.database.PrinterEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.display.DisplayPictures
import com.restopos.core.display.Poster
import com.restopos.core.kitchen.ScreenClient
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.util.concurrent.ConcurrentHashMap
import javax.inject.Inject
import javax.inject.Singleton

data class KioskStatus(val answering: Boolean, val trouble: String?, val heardAt: Long?)

// The till's side of its kiosks, at work: about once a second each kiosk
// paired to this till is asked for what was placed on it, and handed back
// the numbers. The menu goes only when its hash changed; pictures one per
// call, as a display's do. Over the restaurant's Wi-Fi only.
@Singleton
class KioskLink @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val desk: KioskDesk,
    private val posters: DisplayPictures, // a kiosk's welcome picture is kept as a display's pictures are, by its row
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val _status = MutableStateFlow<Map<String, KioskStatus>>(emptyMap())
    val status: StateFlow<Map<String, KioskStatus>> = _status
    // answers owed to each kiosk until it stops listing the order
    private val owed = ConcurrentHashMap<String, Map<String, KioskAnswer>>()
    private val holdsMenu = ConcurrentHashMap<String, String>()
    private val holdsPictures = ConcurrentHashMap<String, Set<String>>()

    suspend fun kiosks(): List<PrinterEntity> {
        val settings = PosSettings.parse(db.ops().settings())
        if (!settings.kioskPaid) return emptyList()
        val store = session.storeId() ?: return emptyList()
        return Routing.kiosks(Routing.usable(db.ops().printers(store), store), session.deviceId())
    }

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                val all = runCatching { kiosks() }.getOrDefault(emptyList())
                if (all.isNotEmpty()) runCatching { coroutineScope { all.map { k -> async { call(k) } }.awaitAll() } }
                delay(if (all.isEmpty()) LOOK_AGAIN else EVERY_MS)
            }
        }
    }

    private suspend fun call(k: PrinterEntity) {
        val at = com.restopos.core.kitchen.Wire.address(k.address, KioskWire.PORT)
        val menu = menuFor(k)
        val hash = KioskWire.hash(menu)
        val lacking = (listOf(menu.welcomePicture) + menu.items.map { it.picture }).filter { it.isNotEmpty() }
            .firstOrNull { it !in holdsPictures[k.id].orEmpty() }
        val req = KioskRequest(
            till = session.deviceId().orEmpty(), tillName = session.deviceId()?.let { db.catalog().device(it)?.name } ?: "Till",
            kiosk = k.name, open = desk.openDay() != null, menuHash = hash,
            menu = if (holdsMenu[k.id] != hash) menu else null,
            picture = lacking?.let { picture(k, it) },
            answers = owed[k.id].orEmpty().values.toList(), now = System.currentTimeMillis(),
        )
        val reply = if (at == null) null else withContext(Dispatchers.IO) {
            runCatching { ScreenClient.exchange(at.first, at.second, KioskWire.encode(req, k.pair_code.orEmpty()), connectMs = 800, readMs = 2500) }.getOrNull()
        }?.let { KioskWire.decodeReply(it) }
        if (reply?.ok == true) {
            holdsMenu[k.id] = reply.menuHash
            holdsPictures[k.id] = reply.pictures.toSet()
            reply.gaveUp.forEach { desk.gaveUp(it) }
            // answers it no longer lists are delivered; new orders are taken now and answered on the next call
            val listed = reply.orders.map { it.id }.toSet()
            val keep = owed[k.id].orEmpty().filterKeys { it in listed }.toMutableMap()
            for (o in reply.orders) if (o.id !in keep && o.id !in reply.gaveUp) keep[o.id] = desk.take(k, o)
            owed[k.id] = keep
        } else {
            holdsMenu.remove(k.id); holdsPictures.remove(k.id)
        }
        val was = _status.value[k.id]
        _status.value = _status.value + (k.id to KioskStatus(reply?.ok == true, KioskWire.trouble(k.name, k.address, reply), if (reply?.ok == true) System.currentTimeMillis() else was?.heardAt))
    }

    private suspend fun menuFor(k: PrinterEntity): KioskMenu {
        val s = PosSettings.parse(db.ops().settings())
        val book = desk.book()
        return KioskMenus.build(
            name = s.name ?: "", logo = s.logo.orEmpty(), welcome = k.message.orEmpty(),
            // the kiosk's welcome picture: the first picture picked for its row, kept as a display's are
            welcomePicture = posters.all(k.id).firstOrNull()?.hash.orEmpty(),
            dining = db.catalog().diningOptions(), categories = db.catalog().categories(), items = book.items.values.toList(),
            groupsOf = book.groupsOf, optionsOf = book.optionsOf,
            pictures = db.pictures().stampsNow().associate { it.item_id to it.updated_at },
        )
    }

    private suspend fun picture(k: PrinterEntity, key: String): Poster? {
        val item = key.substringBefore('@')
        val jpeg = db.pictures().jpeg(item) ?: posters.all(k.id).firstOrNull { it.hash == key }?.jpeg ?: return null
        return Poster(key, java.util.Base64.getEncoder().encodeToString(jpeg))
    }

    private companion object {
        const val EVERY_MS = 1_000L
        const val LOOK_AGAIN = 15_000L
    }
}
```

  Two helpers this needs, each a one-liner (`KioskDesk.book()` is in Task 10). Add them, then check the names against the code:
  - `PictureDao.stampsNow()`: `@Query("SELECT item_id, updated_at FROM item_pictures") suspend fun stampsNow(): List<PictureStamp>`.
  - `db.catalog().categories()`: use the catalog DAO's existing suspend list of categories. Grep `fun categories` in `core/database`. If only a `Flow` exists, add a suspend twin.

  `PosSettings.name` / `logo`: `DisplayLink` reads `PosSettings.parse(...).logo`. Use the business name field the receipts use (grep `\.name` in `Printing.shop()`).

  **The welcome picture** is picked on the till for the kiosk's row the way a display's pictures are (`DisplayPictures`, by the row's id). In Settings → Printers, the kiosk's row gets the same "Pictures" picker a display's has, limited to one. `picture()` looks for a dish first, then the row's pictures, by key.

- [ ] **Step 2: Start it with the till.** Next to where `DisplayLink.start()` is called, add `kioskLink.start()` (inject it the same way).
- [ ] **Step 3: Build and run the unit tests.** `android/gradlew -p android :app:testDebugUnitTest`. Expected: PASS.
- [ ] **Step 4: Commit.**
```bash
# and the file found in Step 2 that starts DisplayLink, by its path
git add android/app/src/main/java/com/restopos/core/kiosk/ android/app/src/main/java/com/restopos/core/database/Pictures.kt
git commit -m "Till: calls its kiosks every second for their orders and hands back the numbers"
```

### Task 13: The till's screens: the kiosk key, the Kiosk list, Settings → Printers

**Files:**
- Modify `feature/main/MainShell.kt` (~lines 317 and 683-695, next to the phone key).
- The Orders screen (grep `GuestShown\|guestCount` in `feature/orders` for the guest list's place).
- `core/data/PrinterForm.kt` and Settings → Printers (grep `PrinterForm.DISPLAY` in `feature/settings`).

- [ ] **Step 1: The key.** In the shell's view model, beside `guestCount`:

```kotlin
    val kioskWaiting: StateFlow<Int> = kioskDesk.waiting().map { it.size }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), 0)
    init { viewModelScope.launch { var before = 0; kioskWaiting.collect { n -> if (n > before) com.restopos.core.common.Chime.order(); before = n } } }
```

  Draw the key beside the phone key, only when `settings.kioskPaid` and a kiosk faces this till. Copy the phone key's `Box` (lines 683-695): a `VIcon` (use the existing receipt or list icon in `core/ui`; there is no kiosk glyph), the count as a blue `Badge`, and a tap that opens the Kiosk list.

- [ ] **Step 2: The Kiosk list.** A sheet, or a tab beside the guest orders, whichever the guest list is. For each waiting row: **number** (large), time, `kiosk_name`, dining option name, lines (decode `lines`, names from the catalog), the total, "Not paid", and two buttons:
  - **Open:** `kioskDesk.open(id)`; on success, go to the register. On failure, toast the words.
  - **Cancel:** confirm "Cancel kiosk order 23? The customer has not paid.", then `kioskDesk.cancel(id)`.

  Above the list, a number field: typing a number opens that order (`kioskDesk.byNumber(n)` then `open`). Under each kiosk's name, `KioskLink.status`'s `trouble`, when set (for example "Kiosk 2: No paper"). Keep it to the till's existing V components (`VBtn`, `T`, `Badge`).

- [ ] **Step 3: Offline Settings → Printers.** In `PrinterForm.kt`, beside the display form (lines 81-105):

```kotlin
    // ---- a self-order kiosk (0160), added on a tablet that works on its own ----
    const val KIOSK = "kiosk"
    data class Kiosk(val name: String, val address: String, val code: String, val welcome: String?)
    fun kiosk(name: String, address: String, code: String, welcome: String): Kiosk {
        val called = name.trim()
        require(called.isNotEmpty()) { "Give the kiosk a name, for example Kiosk 1" }
        val at = address.trim()
        require(IP.matches(at)) { "Type the address the kiosk shows, for example 192.168.1.81" }
        val tidy = PairCode.tidy(code)
        require(tidy != null) { "Type the pairing code the kiosk shows: eight letters and digits" }
        return Kiosk(called, at, tidy, welcome.trim().take(120).ifEmpty { null })
    }
```

  Use the display's own helpers by name if they differ (`IP`, `PairCode.tidy`). In Settings → Printers, show an **Add a kiosk** button only when `settings.kioskPaid && !settings.retail`. The form: name, address, code, welcome words. It saves through the same `printer.save` op as a display, with `kind = "kiosk"` and `device_id` = this till. Copy the display's add call (grep where `PrinterForm.display(` is used) and change only the kind and the words. A refusal `bad-printer` reads: "This restaurant does not have the self-order kiosk, or the kiosk's address or code was not taken."

- [ ] **Step 4: Build and unit tests.** `android/gradlew -p android :app:testDebugUnitTest`. Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/feature/main/MainShell.kt android/app/src/main/java/com/restopos/feature/orders android/app/src/main/java/com/restopos/core/data/PrinterForm.kt android/app/src/main/java/com/restopos/feature/settings
git commit -m "Till: the kiosk key, the Kiosk list (Open, Cancel, by number), a kiosk added from Settings"
```

**Checkpoint 2.** The till side is done and unit-tested. It has not been run against a kiosk yet: that comes in Phase 4.

---

# Phase 3: The kiosk's screens

*Ends with: a tablet set up as a kiosk shows its code, is reached by its till, and takes an order from Welcome to the slip.*

### Task 14: `KioskPrefs` and "Set up as a kiosk"

**Files:**
- Create `core/kiosk/KioskPrefs.kt`.
- Modify `app/AppNav.kt` (~line 90, the `onKitchen` / `onDisplay` pair), the sign-in screen that shows those two buttons (grep `Set up as a customer display` in `feature/auth`), and `app/MainActivity.kt` (`onCreate`).

- [ ] **Step 1: The prefs**, synchronous so that `MainActivity.onCreate` can read them before drawing anything:

```kotlin
package com.restopos.core.kiosk

import android.content.Context
import com.restopos.core.common.PinHash

// What a kiosk keeps of itself: that it is one, its pairing code, the PIN that
// leaves kiosk mode (hashed), and its own printer. SharedPreferences, read at
// once: the app decides which activity to show before anything is drawn.
class KioskPrefs(context: Context) {
    private val p = context.getSharedPreferences("kiosk", Context.MODE_PRIVATE)
    val isKiosk: Boolean get() = p.getBoolean("on", false)
    val code: String get() = p.getString("code", "").orEmpty()
    val printerKind: String get() = p.getString("printerKind", "").orEmpty()      // "", network, usb, bluetooth
    val printerAddress: String get() = p.getString("printerAddress", "").orEmpty()
    val paper: Int get() = p.getInt("paper", 80)
    val hasPin: Boolean get() = p.contains("pin")

    fun become(code: String) = p.edit().putBoolean("on", true).putString("code", code).apply()
    fun leave() = p.edit().clear().apply()
    fun setPin(pin: String) = p.edit().putString("pin", PinHash.hash(pin)).apply()
    fun pinIs(pin: String): Boolean = p.getString("pin", null)?.let { PinHash.matches(pin, it) } == true
    fun setPrinter(kind: String, address: String, paper: Int) = p.edit().putString("printerKind", kind).putString("printerAddress", address.trim()).putInt("paper", paper).apply()
}
```

  Use `PinHash`'s real function names (`core/common/PinHash.kt`, tested by `PinHashTest`).

- [ ] **Step 2: The button.** On the first screen, under "Set up as a customer display", add "Set up as a kiosk" with the same look. In `AppNav`, beside `onDisplay`:

```kotlin
                onKiosk = {
                    // as the kitchen screen and the display: a debug build's code is always the same one
                    KioskPrefs(context).become(if (BuildConfig.DEBUG) "KYSK2345" else PairCode.make())
                    context.startActivity(android.content.Intent(context, com.restopos.feature.kiosk.KioskActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
                },
```

  Grep `onDisplay` in `feature/auth` and add `onKiosk: () -> Unit` beside it, through to the button.

- [ ] **Step 3: Forward at start.** First thing in `MainActivity.onCreate`, before `super.onCreate`'s content is set:

```kotlin
        // a kiosk is drawn by its own portrait activity, never by the till's (ScreenFit is landscape)
        if (com.restopos.core.kiosk.KioskPrefs(this).isKiosk) {
            super.onCreate(savedInstanceState)
            startActivity(android.content.Intent(this, com.restopos.feature.kiosk.KioskActivity::class.java))
            finish()
            return
        }
```

  Put it at the very top of `onCreate`, replacing the first `super.onCreate(savedInstanceState)` call for this branch only.

- [ ] **Step 4: Commit** (with Task 15; this does not build without `KioskActivity`).

### Task 15: `KioskActivity`

**Files:**
- Create `feature/kiosk/KioskActivity.kt`.
- Modify `android/app/src/main/AndroidManifest.xml`.

- [ ] **Step 1: The activity.**

```kotlin
package com.restopos.feature.kiosk

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.restopos.core.kiosk.KioskOwner
import com.restopos.core.ui.PosTheme
import dagger.hilt.android.AndroidEntryPoint

// The whole of a tablet set up as a self-order kiosk: portrait, drawn at the
// kiosk's own sizes (no ScreenFit), screen always on, bars hidden, and held
// in lock task so a customer cannot leave it. As device owner (KioskOwner)
// the lock is full and silent; without it Android pins the screen and says so once.
@AndroidEntryPoint
class KioskActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
        KioskOwner.prepare(this)   // device owner: Home, lock task list, keyguard, stay on, update window (Task 21)
        setContent { PosTheme { KioskRoot(onLeave = ::leave) } }
    }

    override fun onResume() {
        super.onResume()
        if (com.restopos.core.kiosk.KioskPrefs(this).isKiosk) runCatching { startLockTask() }
    }

    // Back does nothing on a kiosk.
    @Deprecated("Back on a kiosk") override fun onBackPressed() {}

    private fun leave() {
        runCatching { stopLockTask() }
        KioskOwner.release(this)
        com.restopos.core.kiosk.KioskPrefs(this).leave()
        startActivity(android.content.Intent(this, com.restopos.app.MainActivity::class.java).addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_CLEAR_TASK))
        finish()
    }
}
```

  Until Task 21, give `KioskOwner` two empty functions (`fun prepare(a: Activity) {}`, `fun release(a: Activity) {}`) in `core/kiosk/KioskOwner.kt` so this builds.

- [ ] **Step 2: The manifest.** Inside `<application>`:

```xml
        <!-- A self-order kiosk (2026-11-18): portrait, its own task, nothing in Recents. -->
        <activity
            android:name="com.restopos.feature.kiosk.KioskActivity"
            android:exported="true"
            android:screenOrientation="portrait"
            android:launchMode="singleTask"
            android:excludeFromRecents="true"
            android:lockTaskMode="if_whitelisted"
            android:theme="@style/Theme.RestoPos" />
        <!-- The kiosk as the tablet's Home, switched on only on a kiosk that is not device owner (KioskOwner.fallbackHome). -->
        <activity-alias
            android:name="com.restopos.feature.kiosk.KioskHome"
            android:targetActivity="com.restopos.feature.kiosk.KioskActivity"
            android:enabled="false"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.HOME" />
                <category android:name="android.intent.category.DEFAULT" />
            </intent-filter>
        </activity-alias>
```

  Use the theme name `MainActivity` uses in the manifest.

- [ ] **Step 3: Build.** `android/gradlew -p android :app:assembleDebug`. Expected: success, once `KioskRoot` exists. Give it a one-line placeholder that draws `Text("Kiosk")` until Task 17; Task 17 replaces it.
- [ ] **Step 4: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskPrefs.kt android/app/src/main/java/com/restopos/core/kiosk/KioskOwner.kt android/app/src/main/java/com/restopos/feature/kiosk/ android/app/src/main/AndroidManifest.xml android/app/src/main/java/com/restopos/app/AppNav.kt android/app/src/main/java/com/restopos/app/MainActivity.kt android/app/src/main/java/com/restopos/feature/auth
git commit -m "Kiosk: Set up as a kiosk, and its own portrait activity"
```

### Task 16: `KioskBook`, the kiosk's side of the wire

**Files:**
- Create `core/kiosk/KioskBook.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskBookTest.kt`.

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import kotlinx.coroutines.*
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

class KioskBookTest {
    private val menu = KioskMenu(name = "Star Grill", dining = listOf(KioskDining("d1", "Eat in")), categories = emptyList(), items = emptyList(), groups = emptyList())
    private fun book() = KioskBook(code = { "KYSK2345" }, build = 50, store = KioskBook.MemoryStore())
    private fun ask(b: KioskBook, req: KioskRequest, code: String = "KYSK2345"): KioskReply = runBlocking {
        val (first, second) = KioskWire.encode(req, code).trimEnd('\n').split('\n')
        KioskWire.decodeReply(b.answer(first, second).trimEnd('\n'))!!
    }
    private fun req(menu: KioskMenu? = null, answers: List<KioskAnswer> = emptyList(), open: Boolean = true) =
        KioskRequest(till = "t1", tillName = "Till 1", kiosk = "Kiosk 1", open = open, menuHash = KioskWire.hash(this.menu), menu = menu, answers = answers)

    @Test fun `a till with another code is refused`() {
        assertEquals(KioskWire.REFUSED, ask(book(), req(), code = "OTHER234").error)
    }

    @Test fun `the menu is kept and its hash said back`() {
        val b = book()
        assertEquals("", ask(b, req()).menuHash)
        assertEquals(KioskWire.hash(menu), ask(b, req(menu = menu)).menuHash)
        assertEquals(menu, b.menu.value)
    }

    @Test fun `an order placed is listed until the till answers it, and the answer is given back`() = runTest {
        val b = book(); ask(b, req(menu = menu))
        val waiting = async { b.place(KioskPlaced("o1", "d1", listOf(KioskLine("i1", 1, emptyList())), 24500, 0), timeoutMs = 5_000) }
        yield()
        assertEquals(listOf("o1"), ask(b, req()).orders.map { it.id })
        ask(b, req(answers = listOf(KioskAnswer("o1", number = 23))))
        assertEquals(KioskAnswer("o1", number = 23), waiting.await())
        assertTrue(ask(b, req()).orders.isEmpty())
    }

    @Test fun `no answer in time: given up, and the till is told for 30 seconds`() = runTest {
        var clock = 1_000L
        val b = KioskBook(code = { "KYSK2345" }, build = 50, store = KioskBook.MemoryStore(), now = { clock })
        ask(b, req(menu = menu))
        assertNull(b.place(KioskPlaced("o2", "d1", emptyList(), 0, 0), timeoutMs = 10))
        val r = ask(b, req())
        assertTrue(r.orders.isEmpty())
        assertEquals(listOf("o2"), r.gaveUp)
        // an answer that comes too late changes nothing; the till is still told
        assertEquals(listOf("o2"), ask(b, req(answers = listOf(KioskAnswer("o2", number = 9)))).gaveUp)
        clock += 31_000
        assertTrue(ask(b, req()).gaveUp.isEmpty())
    }

    @Test fun `the till says whether it takes orders`() {
        val b = book()
        ask(b, req(menu = menu, open = false)); assertFalse(b.open.value)
        ask(b, req(open = true)); assertTrue(b.open.value)
    }
}
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**

```kotlin
package com.restopos.core.kiosk

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

// The kiosk's side of the wire: it keeps the menu and the pictures its till
// sends, lists the orders placed on it until the till answers them, and
// tells the till of any it stopped waiting for. Nothing here knows Android:
// the screens call `place`, the server (ScreenServer on KioskWire.PORT) calls `answer`.
class KioskBook(
    private val code: suspend () -> String,
    private val build: Int,
    private val store: Store,
    private val now: () -> Long = System::currentTimeMillis,
) {
    interface Store {
        suspend fun menu(): String?                     // the menu as JSON, kept across a restart
        suspend fun putMenu(json: String)
        suspend fun pictures(): Set<String>
        suspend fun putPicture(key: String, jpeg: ByteArray)
        suspend fun keepOnly(keys: Set<String>)
    }
    class MemoryStore : Store {
        private var m: String? = null; private val p = HashMap<String, ByteArray>()
        override suspend fun menu() = m
        override suspend fun putMenu(json: String) { m = json }
        override suspend fun pictures() = p.keys.toSet()
        override suspend fun putPicture(key: String, jpeg: ByteArray) { p[key] = jpeg }
        override suspend fun keepOnly(keys: Set<String>) { p.keys.retainAll(keys) }
    }

    private val _menu = MutableStateFlow<KioskMenu?>(null)
    val menu: StateFlow<KioskMenu?> = _menu
    private val _open = MutableStateFlow(false)
    val open: StateFlow<Boolean> = _open
    // when the till last spoke: the screens say "Ordering opens in a moment" while it has not, lately
    private val _heardAt = MutableStateFlow(0L)
    val heardAt: StateFlow<Long> = _heardAt
    // what is wrong with this kiosk's printer, told to the till
    @Volatile var printer: String? = null

    private val lock = Mutex()
    private val placed = LinkedHashMap<String, Pair<KioskPlaced, CompletableDeferred<KioskAnswer>>>()
    // orders it stopped waiting for, and when: told to the till for TELL_MS (its cancel is harmless twice)
    private val gaveUp = LinkedHashMap<String, Long>()
    private var loaded = false

    suspend fun answer(first: String, second: String): String {
        val req = KioskWire.decode(first, second, code()) ?: return KioskWire.encode(KioskReply(ok = false, error = KioskWire.REFUSED, build = build))
        if (req.v != KioskWire.VERSION) return KioskWire.encode(KioskReply(ok = false, error = KioskWire.OTHER_VERSION, build = build))
        return lock.withLock {
            if (!loaded) { loaded = true; store.menu()?.let { KioskWire.decodeMenu(it) }?.let { _menu.value = it } }
            req.menu?.let { _menu.value = it; store.putMenu(KioskWire.encodeMenu(it)) }
            req.picture?.let { store.putPicture(it.hash, java.util.Base64.getDecoder().decode(it.jpeg)) }
            _menu.value?.let { m -> store.keepOnly((m.items.map { it.picture } + m.welcomePicture).filter { it.isNotEmpty() }.toSet()) }
            _open.value = req.open
            _heardAt.value = now()
            for (a in req.answers) placed.remove(a.id)?.second?.complete(a)
            gaveUp.entries.removeAll { now() - it.value > TELL_MS }
            KioskWire.encode(KioskReply(
                ok = true, build = build, menuHash = _menu.value?.let { KioskWire.hash(it) }.orEmpty(),
                pictures = store.pictures().toList(), orders = placed.values.map { it.first },
                gaveUp = gaveUp.keys.toList(), printer = printer,
            ))
        }
    }

    // Places an order and waits for its number. Null when the till did not answer in time:
    // the order is given up, and the till is told so it cancels it if it took it.
    suspend fun place(o: KioskPlaced, timeoutMs: Long = 5_000): KioskAnswer? {
        val done = CompletableDeferred<KioskAnswer>()
        lock.withLock { placed[o.id] = o to done }
        val got = withTimeoutOrNull(timeoutMs) { done.await() }
        if (got == null) lock.withLock { placed.remove(o.id); gaveUp[o.id] = now() }
        return got
    }

    private companion object { const val TELL_MS = 30_000L }
}
```

  How this meets the till (`KioskLink.call`):
  - For 30 s the kiosk lists o2 in `gaveUp`, and on each call the till cancels it if it took it. `KioskDao.cancel` touches only a `waiting` row, so repeating it does nothing more.
  - The till keeps an answer only for orders the kiosk still lists in `orders`, so its late answer for o2 stops on the next call.
  - The kiosk ignores that late answer: `place` has already returned.

- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskBook.kt android/app/src/test/java/com/restopos/core/kiosk/KioskBookTest.kt
git commit -m "Kiosk: its side of the wire (menu, pictures, placing and waiting, giving up)"
```

### Task 17: The kiosk's view model and screens

**Files:**
- Create `feature/kiosk/KioskViewModel.kt` and `feature/kiosk/KioskScreens.kt`. Replace the placeholder `KioskRoot`.
- Test: `android/app/src/test/java/com/restopos/feature/kiosk/KioskBasketTest.kt`, for the basket and the idle rule (pure).

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.feature.kiosk

import com.restopos.core.kiosk.*
import org.junit.Assert.*
import org.junit.Test

class KioskBasketTest {
    private val size = KioskGroup("g1", "Size", 1, 1, listOf(KioskOption("m1", "Regular", 0), KioskOption("m2", "Double", 7500)))
    private val burger = KioskItem("i1", "c1", "Classic", 24500, groups = listOf("g1"))

    @Test fun `a line's price is the dish and its options`() {
        assertEquals(2 * (24500 + 7500L), Basket.Line(burger, 2, listOf(size.options[1])).total)
    }

    @Test fun `the same dish with the same options adds up, other options make a line of their own`() {
        var b = Basket()
        b = b.add(Basket.Line(burger, 1, listOf(size.options[0])))
        b = b.add(Basket.Line(burger, 1, listOf(size.options[0])))
        b = b.add(Basket.Line(burger, 1, listOf(size.options[1])))
        assertEquals(listOf(2, 1), b.lines.map { it.qty })
        assertEquals(3, b.count)
    }

    @Test fun `Add is offered only once every group has what it needs`() {
        assertFalse(Basket.ready(burger, listOf(size), emptyList()))
        assertTrue(Basket.ready(burger, listOf(size), listOf("m1")))
    }

    @Test fun `still there after 60 seconds untouched, back to Welcome 20 seconds later`() {
        assertEquals(Idle.Fine, Idle.of(lastTouch = 0, now = 59_000, basketEmpty = false))
        assertEquals(Idle.Ask, Idle.of(lastTouch = 0, now = 60_000, basketEmpty = false))
        assertEquals(Idle.Reset, Idle.of(lastTouch = 0, now = 80_000, basketEmpty = false))
        assertEquals(Idle.Reset, Idle.of(lastTouch = 0, now = 60_000, basketEmpty = true)) // nothing to keep: no question
    }

    @Test fun `what is sent to the till`() {
        val b = Basket().add(Basket.Line(burger, 2, listOf(size.options[1])))
        val p = b.placed("o1", "d1", at = 7)
        assertEquals(KioskPlaced("o1", "d1", listOf(KioskLine("i1", 2, listOf("m2"))), 64000, 7), p)
    }
}
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement the pure part** at the top of `KioskViewModel.kt`:

```kotlin
package com.restopos.feature.kiosk

import com.restopos.core.guest.OptionRules
import com.restopos.core.kiosk.*

// The customer's basket: lines of a dish, how many, the options picked.
data class Basket(val lines: List<Line> = emptyList()) {
    data class Line(val item: KioskItem, val qty: Int, val options: List<KioskOption>) {
        val total: Long get() = (item.price + options.sumOf { it.price }) * qty
        fun same(o: Line) = item.id == o.item.id && options.map { it.id }.sorted() == o.options.map { it.id }.sorted()
    }
    val count: Int get() = lines.sumOf { it.qty }
    val total: Long get() = lines.sumOf { it.total }
    fun add(l: Line): Basket = lines.indexOfFirst { it.same(l) }.let { i ->
        if (i < 0) copy(lines = lines + l) else copy(lines = lines.mapIndexed { j, x -> if (j == i) x.copy(qty = (x.qty + l.qty).coerceAtMost(20)) else x })
    }
    fun change(i: Int, qty: Int): Basket = if (qty <= 0) copy(lines = lines.filterIndexed { j, _ -> j != i }) else copy(lines = lines.mapIndexed { j, x -> if (j == i) x.copy(qty = qty.coerceAtMost(20)) else x })
    fun placed(id: String, dining: String, at: Long) = KioskPlaced(id, dining, lines.map { KioskLine(it.item.id, it.qty, it.options.map { o -> o.id }) }, total, at)

    companion object {
        // every group has at least its least
        fun ready(item: KioskItem, groups: List<KioskGroup>, picked: List<String>): Boolean =
            groups.filter { it.id in item.groups }.all { g -> !OptionRules.tooFew(g.min, g.options.count { it.id in picked }) }
    }
}

// The rule for a kiosk nobody is using: after 60 s untouched it asks "Still there?", 20 s later it starts over.
enum class Idle { Fine, Ask, Reset;
    companion object {
        const val ASK_MS = 60_000L
        const val RESET_MS = 80_000L
        fun of(lastTouch: Long, now: Long, basketEmpty: Boolean): Idle = when {
            now - lastTouch < ASK_MS -> Fine
            basketEmpty || now - lastTouch >= RESET_MS -> Reset
            else -> Ask
        }
    }
}
```

  The option taps use `OptionRules.tap(picked, option, g.min, g.max, alone)` with counts of 1 (`mostOnAPhone`). Keep the picked options as a `Map<String, Int>` in the Dish screen's state and turn the keys into `KioskOption`s on Add.

- [ ] **Step 4: Run the test.** Expected: PASS.

- [ ] **Step 5: The view model** (same file, below):

```kotlin
@dagger.hilt.android.lifecycle.HiltViewModel
class KioskViewModel @javax.inject.Inject constructor(
    @dagger.hilt.android.qualifiers.ApplicationContext private val context: android.content.Context,
    private val printing: com.restopos.core.print.Printing,
) : androidx.lifecycle.ViewModel() {
    val prefs = KioskPrefs(context)
    private val dir = java.io.File(context.filesDir, "kiosk")
    private val store = object : KioskBook.Store {
        override suspend fun menu() = runCatching { java.io.File(dir, "menu.json").readText() }.getOrNull()
        override suspend fun putMenu(json: String) { dir.mkdirs(); java.io.File(dir, "menu.json").writeText(json) }
        override suspend fun pictures() = java.io.File(dir, "pics").listFiles()?.map { it.name.removeSuffix(".jpg") }?.toSet().orEmpty()
        override suspend fun putPicture(key: String, jpeg: ByteArray) { java.io.File(dir, "pics").mkdirs(); java.io.File(dir, "pics/$key.jpg").writeBytes(jpeg) }
        override suspend fun keepOnly(keys: Set<String>) { java.io.File(dir, "pics").listFiles()?.filter { it.name.removeSuffix(".jpg") !in keys }?.forEach { it.delete() } }
    }
    val book = KioskBook(code = { prefs.code }, build = com.restopos.app.BuildConfig.VERSION_CODE, store = store)
    private val server = com.restopos.core.kitchen.ScreenServer(KioskWire.PORT) { a, b -> book.answer(a, b) }
    val problem = kotlinx.coroutines.flow.MutableStateFlow<String?>(null)
    init { listen() }
    fun listen() { problem.value = runCatching { server.start(viewModelScope) }.exceptionOrNull()?.let { "Port ${KioskWire.PORT} is taken: restart the kiosk." } }
    override fun onCleared() { server.stop() }

    fun picture(key: String): android.graphics.Bitmap? = runCatching { android.graphics.BitmapFactory.decodeFile(java.io.File(dir, "pics/$key.jpg").path) }.getOrNull()
    fun address(): String = com.restopos.core.common.Net.wifiAddress(context) ?: "(no Wi-Fi)"

    // Place order: the slip prints only once the till has given a number.
    suspend fun place(basket: Basket, dining: String): Placing {
        val id = com.restopos.core.common.Uuid7.next()
        val answer = book.place(basket.placed(id, dining, System.currentTimeMillis())) ?: return Placing.Counter
        val number = answer.number ?: return Placing.Refused(answer.refused ?: "Please order at the counter.")
        val printed = KioskSlip.print(printing, prefs, book.menu.value?.name.orEmpty(), number, book.menu.value?.dining?.firstOrNull { it.id == dining }?.name.orEmpty(), basket)
        book.printer = printed.exceptionOrNull()?.message
        return Placing.Done(number, printed.isSuccess)
    }
}

sealed interface Placing {
    data class Done(val number: Int, val printed: Boolean) : Placing
    data class Refused(val why: String) : Placing
    data object Counter : Placing
}
```

  `ScreenServer.start(scope)` takes a `CoroutineScope`, so pass `viewModelScope`. Grep `DisplayModeViewModel.listen` (DisplayMode.kt) for how the display calls it and how it shows its own address (the display's first screen shows it; reuse that helper by name instead of `Net.wifiAddress`).

- [ ] **Step 6: The screens** in `KioskScreens.kt`. One `@Composable fun KioskRoot(onLeave: () -> Unit, vm: KioskViewModel = hiltViewModel())` with a `when` over a `Screen` state (`Welcome, Dining, Menu, Dish(item), Review, Done(number, printed), Counter(why), Setup, Leave`). Follow the mockup (https://claude.ai/artifact/AGwPhH5UbBPcVcY9cwTVAK; its six `*.dc.html` files give the exact sizes and colours, drawn at half size: double every number). Build each screen from the till's V tokens (`core/ui/V2.kt`: `V.Green` = #3F8443, `V.GreenText`, `V.Text`, `V.Text2`, `V.Line`, `V.Bg`) and plain `Box`/`Column`/`Row`/`Text`. These rules are what the screens must do; the mockup is how they look:
  - **Not paired yet** (`book.heardAt == 0` and `book.menu == null`): the Set-up screen (Task 18).
  - **Welcome:** dark (#1A1C21). Logo (decode `menu.logo` as the display does), the restaurant name, the welcome picture if any (`vm.picture(menu.welcomePicture)`), the welcome words, a large green "Touch to order" and "Order here, pay at the counter". When `!book.open.value` or the till has not been heard for 10 s: the button reads "Ordering opens in a moment" and does nothing. A long press of 3 s in the top-left 120 dp corner opens Leave.
  - **Dining:** skipped with one option. Otherwise one big card per option, "Where will you eat today?", Start over.
  - **Menu:** categories down the left (132 dp at half size, so 264 px on the real kiosk; use dp as the mockup does, doubled), two columns of tiles, a sold-out tile greyed and not tappable, the count on a tile in the basket. The dark bar at the bottom shows only with something in the basket: "Your order · N items", total, "View order".
  - **Dish:** a bottom sheet. Picture, name, price; each group with "Choose N" or "One, if you like" (`min`/`max` words as the till's options pop-up says them; grep `Choose 1` in `feature/order`); a quantity stepper 1-20; "Add · Rs …" enabled only when `Basket.ready`. A dish with no groups is added at once from the Menu tile, with no sheet.
  - **Review:** lines with options, − / + and Remove, the total, "Place order" (96 dp at half size), "You pay at the counter". "Add more" goes back. While placing: the button reads "Sending…" and nothing else is tappable.
  - **Done:** green tick, "Your number is", the number at 150 sp, "Please pay at the counter". If `!printed`: "Your ticket did not print. Remember your number." Back to Welcome after 15 s, or on a touch.
  - **Counter(why):** "Please order at the counter." plus `why` when it says more. Back to Welcome after 10 s.
  - **Idle:** every touch anywhere (a `pointerInput` on the root) records `lastTouch`. A 1 s ticker applies `Idle.of`: Ask shows "Still there?" with "Yes, I'm here"; Reset empties the basket and shows Welcome. Not on Welcome, Done or Counter.
  - Money as the till writes it: `Money.format(cents)` (`core/common/Money.kt`), "Rs" before it.

- [ ] **Step 7: Build.** `android/gradlew -p android :app:assembleDebug`, then `:app:testDebugUnitTest`. Expected: both pass.
- [ ] **Step 8: Commit.**
```bash
git add android/app/src/main/java/com/restopos/feature/kiosk/ android/app/src/test/java/com/restopos/feature/kiosk/
git commit -m "Kiosk: the customer's screens, Welcome to the number"
```

### Task 18: Set-up, Leave and the slip

**Files:**
- Create `core/kiosk/KioskSlip.kt`.
- Add the `Setup` and `Leave` screens to `KioskScreens.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskSlipTest.kt`.

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.feature.kiosk.Basket
import org.junit.Assert.*
import org.junit.Test

class KioskSlipTest {
    @Test fun `the slip says its number, NOT PAID, and is not a receipt`() {
        val burger = KioskItem("i1", "c1", "Classic beef burger", 24500)
        val b = Basket().add(Basket.Line(burger, 1, listOf(KioskOption("m1", "Cheese", 2500))))
        val text = KioskSlip.text("Star Grill", 23, "Eat in", b, columns = 42, at = java.time.LocalDateTime.of(2026, 11, 18, 12, 41))
        listOf("STAR GRILL", "KIOSK ORDER - EAT IN", "23", "1 Classic beef burger", "Cheese", "270.00", "NOT PAID", "Please pay at the counter", "This is not a receipt", "18/11/2026 12:41")
            .forEach { assertTrue("missing $it in\n$text", text.contains(it)) }
        assertFalse(text.contains("VAT"))
    }

    @Test fun `paper is out when the printer says so`() {
        assertTrue(KioskSlip.paperOut(0x60))
        assertTrue(KioskSlip.paperOut(0x0C))
        assertFalse(KioskSlip.paperOut(0x12))
    }
}
```

  `Money.format` of 27000 cents is `270.00`. Check against `MoneyTest` and use what it says.

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**

```kotlin
package com.restopos.core.kiosk

import com.restopos.core.common.Money
import com.restopos.core.database.PrinterEntity
import com.restopos.core.print.EscPos
import com.restopos.core.print.Printing
import com.restopos.feature.kiosk.Basket
import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

// The kiosk's slip: the customer's number for the counter. Not a receipt: no
// bill number, no VAT, nothing for the MRA. The till's receipt comes on payment.
object KioskSlip {
    fun build(p: EscPos, name: String, number: Int, dining: String, basket: Basket, at: LocalDateTime): EscPos = p.apply {
        bold(true); center(name.uppercase()); bold(false)
        center("KIOSK ORDER - ${dining.uppercase()}")
        big(true); bold(true); center(number.toString()); bold(false); big(false)
        center(at.format(DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm")))
        rule()
        for (l in basket.lines) {
            row("${l.qty} ${l.item.name}", Money.format(l.total))
            if (l.options.isNotEmpty()) line("   " + l.options.joinToString(", ") { it.name })
        }
        rule()
        bold(true); row("TOTAL Rs", Money.format(basket.total)); bold(false)
        feed(1)
        big(true); center("NOT PAID"); big(false)
        center("Please pay at the counter")
        center("This is not a receipt")
        feed(3); cut()
    }

    fun text(name: String, number: Int, dining: String, basket: Basket, columns: Int, at: LocalDateTime): String =
        String(build(EscPos(columns), name, number, dining, basket, at).bytes(), Charsets.ISO_8859_1)

    // DLE EOT 4 (the paper roll sensor): bits 2-3 near the end, bits 5-6 out.
    fun paperOut(status: Int): Boolean = status and 0x60 != 0 || status and 0x0C == 0x0C

    // The kiosk's own printer, as the till would reach one of its own.
    fun printer(prefs: KioskPrefs): PrinterEntity? =
        if (prefs.printerKind.isEmpty()) null
        else PrinterEntity(id = "kiosk", tenant_id = "", store_id = "", name = "The kiosk's printer", kind = prefs.printerKind,
            address = prefs.printerAddress.ifEmpty { null }, paper_mm = prefs.paper)

    suspend fun print(printing: Printing, prefs: KioskPrefs, name: String, number: Int, dining: String, basket: Basket): Result<Unit> {
        val p = printer(prefs) ?: return Result.failure(IllegalStateException("No printer is set on this kiosk"))
        val columns = if (prefs.paper == 80) 42 else 32
        return printing.trial(p, build(EscPos(columns), name, number, dining, basket, LocalDateTime.now()).bytes())
    }

    // A network printer asked for its paper; null when it cannot be asked (USB, Bluetooth) or did not answer.
    fun askPaper(prefs: KioskPrefs): Boolean? {
        if (prefs.printerKind != "network") return null
        val at = com.restopos.core.kitchen.Wire.address(prefs.printerAddress, 9100) ?: return null
        return runCatching {
            java.net.Socket().use { s ->
                s.connect(java.net.InetSocketAddress(at.first, at.second), 1500); s.soTimeout = 1500
                s.getOutputStream().apply { write(byteArrayOf(0x10, 0x04, 0x04)); flush() }
                paperOut(s.getInputStream().read())
            }
        }.getOrNull()
    }
}
```

  Check `EscPos` method names against the file (`bold`, `big`, `center`, `rule`, `row`, `line`, `feed`, `cut`, `bytes`: all seen at EscPos.kt lines 79-152). Check that `PrinterEntity` has defaults for every field not named here (it does for kind, paper_mm and the rest). Make `Printing.trial` `suspend fun trial(p, bytes)`; it is public already (Printing.kt:207).

  **Paper on Welcome.** In `KioskViewModel`, every 60 s while on Welcome:
  - Call `KioskSlip.askPaper(prefs)` on `Dispatchers.IO`.
  - When it is `true`, set `book.printer = "No paper"` and show the Welcome button as "Please order at the counter" (not tappable).
  - When it is `false`, clear both.

- [ ] **Step 4: The Set-up screen** (shown until the till first speaks, and from Leave):
  - The kiosk's address (`vm.address()`) and pairing code (`prefs.code`, grouped 4-4), large, with "Type these in the back office under Printers, Kiosks, or on the till under Settings, Printers."
  - A **PIN** section while `!prefs.hasPin`: PIN and PIN again, 4-6 digits, "This PIN leaves kiosk mode. Keep it with the restaurant's papers." Save calls `prefs.setPin`.
  - A **Printer** section: Network (address), USB, Bluetooth (name), paper 80 / 58 mm, and "Print a test slip" (`KioskSlip.print` with number 0 and an empty basket). Save calls `prefs.setPrinter`.
  - A status line: "Waiting for the till…" until `book.heardAt > 0`, then "Paired with <tillName>". It goes to Welcome by itself once paired, a PIN is set and the menu has come.

- [ ] **Step 5: The Leave screen** (after the 3 s corner press): a PIN pad.
  - A wrong PIN says "Wrong PIN" and goes back to Welcome after 10 s.
  - The right PIN offers three keys:
    - **Back to kiosk.**
    - **Kiosk set-up:** the Set-up screen, with its PIN section showing "Change the PIN".
    - **Leave kiosk mode:** confirm "This tablet stops being a kiosk and shows EasyPay's first screen.", then `onLeave()`.

- [ ] **Step 6: Run the tests and build.** `:app:testDebugUnitTest` and `:app:assembleDebug`. Expected: pass.
- [ ] **Step 7: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskSlip.kt android/app/src/main/java/com/restopos/feature/kiosk/ android/app/src/main/java/com/restopos/core/print/Printing.kt android/app/src/test/java/com/restopos/core/kiosk/KioskSlipTest.kt
git commit -m "Kiosk: set-up (code, PIN, printer), Leave with the PIN, the slip and the paper check"
```

---

# Phase 4: The kiosk runs itself

*Ends with: on an emulator made device owner, the kiosk comes back to Welcome by itself after a restart and after the app is killed, locked, with nothing asked. It reconnects to its till alone and updates itself at night.*

### Task 19: The device admin receiver

**Files:**
- Create `core/kiosk/KioskAdmin.kt` and `android/app/src/main/res/xml/kiosk_admin.xml`.
- Modify `AndroidManifest.xml`.

- [ ] **Step 1: Write them.**

```kotlin
package com.restopos.core.kiosk

import android.app.admin.DeviceAdminReceiver

// What makes EasyPay a kiosk's device owner, set once on install day:
//   adb shell dpm set-device-owner com.restopos.app/com.restopos.core.kiosk.KioskAdmin
// Nothing to do here: the policies are set by KioskOwner when the kiosk starts.
class KioskAdmin : DeviceAdminReceiver()
```

```xml
<?xml version="1.0" encoding="utf-8"?>
<device-admin xmlns:android="http://schemas.android.com/apk/res/android">
    <uses-policies />
</device-admin>
```

```xml
        <receiver
            android:name="com.restopos.core.kiosk.KioskAdmin"
            android:exported="true"
            android:permission="android.permission.BIND_DEVICE_ADMIN">
            <meta-data android:name="android.app.device_admin" android:resource="@xml/kiosk_admin" />
            <intent-filter>
                <action android:name="android.app.action.DEVICE_ADMIN_ENABLED" />
            </intent-filter>
        </receiver>
```

  Check the applicationId: `grep applicationId android/app/build.gradle*`. The debug build may add a suffix (`.debug`). The `dpm` command in Task 23 uses the real one.

- [ ] **Step 2: Build.** Expected: success.
- [ ] **Step 3: Commit.** `git commit -m "Kiosk: the device admin that makes it EasyPay's own device"` (with the three files).

### Task 20: `KioskOwner`, the policies

**Files:**
- Replace the stub `core/kiosk/KioskOwner.kt`.
- Test: `android/app/src/test/java/com/restopos/core/kiosk/KioskOwnerTest.kt`, for the update window (pure).

- [ ] **Step 1: The failing test.**

```kotlin
package com.restopos.core.kiosk

import org.junit.Assert.*
import org.junit.Test

class KioskOwnerTest {
    @Test fun `system updates and our own wait for the night, 02 00 to 04 00`() {
        assertEquals(120, KioskOwner.WINDOW_START_MIN)
        assertEquals(240, KioskOwner.WINDOW_END_MIN)
        assertTrue(KioskOwner.inWindow(java.time.LocalTime.of(2, 0)))
        assertTrue(KioskOwner.inWindow(java.time.LocalTime.of(3, 59)))
        assertFalse(KioskOwner.inWindow(java.time.LocalTime.of(4, 0)))
        assertFalse(KioskOwner.inWindow(java.time.LocalTime.of(12, 0)))
    }
}
```

- [ ] **Step 2: Run it.** Expected: FAIL.

- [ ] **Step 3: Implement.**

```kotlin
package com.restopos.core.kiosk

import android.app.Activity
import android.app.admin.DevicePolicyManager
import android.app.admin.SystemUpdatePolicy
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.provider.Settings
import java.time.LocalTime

// The kiosk running itself. As device owner (set on install day) EasyPay:
//  - is the tablet's Home, so it opens at every start and comes back if it stops
//  - is let into full lock task: no Home, no Back, no notifications, no way out
//  - has no lock screen, and keeps the screen on while plugged in
//  - holds Android's own updates to the night window
// Without device owner (a maker's management holds the tablet) the fallback is
// the KioskHome alias: the installer picks EasyPay as Home once, and lock task
// is Android's screen pinning.
object KioskOwner {
    const val WINDOW_START_MIN = 120 // 02:00
    const val WINDOW_END_MIN = 240   // 04:00
    fun inWindow(t: LocalTime): Boolean = (t.hour * 60 + t.minute).let { it in WINDOW_START_MIN until WINDOW_END_MIN }

    private fun dpm(c: Context) = c.getSystemService(DevicePolicyManager::class.java)
    private fun admin(c: Context) = ComponentName(c, KioskAdmin::class.java)
    fun isOwner(c: Context): Boolean = dpm(c)?.isDeviceOwnerApp(c.packageName) == true

    fun prepare(a: Activity) {
        if (!isOwner(a)) { fallbackHome(a, on = true); return }
        val d = dpm(a); val who = admin(a)
        runCatching {
            d.setLockTaskPackages(who, arrayOf(a.packageName))
            d.setLockTaskFeatures(who, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
            val home = IntentFilter(Intent.ACTION_MAIN).apply { addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT) }
            d.addPersistentPreferredActivity(who, home, ComponentName(a, com.restopos.feature.kiosk.KioskActivity::class.java))
            d.setKeyguardDisabled(who, true)
            d.setStatusBarDisabled(who, true)
            d.setGlobalSetting(who, Settings.Global.STAY_ON_WHILE_PLUGGED_IN,
                (BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB or BatteryManager.BATTERY_PLUGGED_WIRELESS).toString())
            d.setSystemUpdatePolicy(who, SystemUpdatePolicy.createWindowedInstallPolicy(WINDOW_START_MIN, WINDOW_END_MIN))
        }
        fallbackHome(a, on = false)
    }

    // Leaving kiosk mode: the tablet gets its own Home back, and its bars and lock screen.
    fun release(a: Activity) {
        if (isOwner(a)) runCatching {
            val d = dpm(a); val who = admin(a)
            d.clearPackagePersistentPreferredActivities(who, a.packageName)
            d.setStatusBarDisabled(who, false)
            d.setKeyguardDisabled(who, false)
        }
        fallbackHome(a, on = false)
    }

    // the KioskHome alias: Home only on a kiosk that is not device owner
    private fun fallbackHome(c: Context, on: Boolean) {
        val alias = ComponentName(c, "com.restopos.feature.kiosk.KioskHome")
        val want = if (on) PackageManager.COMPONENT_ENABLED_STATE_ENABLED else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
        if (c.packageManager.getComponentEnabledSetting(alias) != want)
            c.packageManager.setComponentEnabledSetting(alias, want, PackageManager.DONT_KILL_APP)
    }
}
```

  On the fallback, the first press of Home after set-up makes Android ask which Home to use. That one "EasyPay, Always" is the installer's, on install day. Add to the Set-up screen, shown only when `!KioskOwner.isOwner`: "This kiosk is not EasyPay's own device. Press the tablet's Home key once and choose EasyPay, Always."

- [ ] **Step 4: Run the test and build.** Expected: PASS, build succeeds. `minSdk` must be 28 or more for `setLockTaskFeatures`, `setKeyguardDisabled` and `setStatusBarDisabled` (23). Check `minSdk` in `android/app/build.gradle*`, and wrap calls above it in `if (Build.VERSION.SDK_INT >= …)`.
- [ ] **Step 5: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskOwner.kt android/app/src/test/java/com/restopos/core/kiosk/KioskOwnerTest.kt
git commit -m "Kiosk: as device owner, its own Home, full lock, no lock screen, screen on, updates at night"
```

### Task 21: Quiet self-update

**Files:**
- Create `core/kiosk/KioskUpdater.kt`.
- Modify `KioskViewModel` to run it.

- [ ] **Step 1: Implement.**

```kotlin
package com.restopos.core.kiosk

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import com.restopos.core.network.ApiClient
import com.restopos.core.sync.AppUpdater
import com.restopos.core.sync.Download
import kotlinx.coroutines.delay
import java.time.LocalTime

// A kiosk updates itself, at night, with nobody there: a device owner may
// install without asking. It asks our server once an hour whether a newer
// EasyPay exists (as a display does) and, in the night window, fetches and
// installs it. Not device owner: nothing here (the Set-up screen offers the update).
class KioskUpdater(private val context: Context, private val api: ApiClient, private val updater: AppUpdater) {
    suspend fun run() {
        while (true) {
            runCatching { if (KioskOwner.isOwner(context) && KioskOwner.inWindow(LocalTime.now())) once() }
            delay(60 * 60_000L)
        }
    }

    private suspend fun once() {
        val r = api.latestTill() ?: return       // the same call DisplayModeViewModel makes (grep it there)
        if (r.version <= com.restopos.app.BuildConfig.VERSION_CODE) return
        if (!updater.start(r.version, r.url)) return
        while (true) {
            when (val d = updater.poll()) {
                is Download.Ready -> { install(d.apk); return }
                is Download.Failed -> return
                else -> delay(5_000)
            }
        }
    }

    private fun install(apk: android.net.Uri) {
        val pi = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply { setAppPackageName(context.packageName) }
        val id = pi.createSession(params)
        pi.openSession(id).use { s ->
            context.contentResolver.openInputStream(apk)!!.use { input -> s.openWrite("easypay.apk", 0, -1).use { out -> input.copyTo(out); s.fsync(out) } }
            val done = PendingIntent.getBroadcast(context, id, Intent("com.restopos.app.KIOSK_UPDATED").setPackage(context.packageName), PendingIntent.FLAG_IMMUTABLE)
            s.commit(done.intentSender)
        }
    }
}
```

  Use the real names from `DisplayModeViewModel`'s update check (DisplayMode.kt lines ~75-100): the API call and the release fields (`r.version`, `r.url`), and `Download`'s states (`Ready(apk)`, and whatever its failure state is called). After the install, Android restarts the app. As Home it comes back to Welcome by itself.

- [ ] **Step 2: Start it** in `KioskViewModel.init`: `viewModelScope.launch(Dispatchers.IO) { KioskUpdater(context, api, updater).run() }`, injecting `ApiClient` and `AppUpdater`.
- [ ] **Step 3: Build.** Expected: success.
- [ ] **Step 4: Commit.**
```bash
git add android/app/src/main/java/com/restopos/core/kiosk/KioskUpdater.kt android/app/src/main/java/com/restopos/feature/kiosk/KioskViewModel.kt
git commit -m "Kiosk: updates itself at night when it is device owner"
```

### Task 22: Release notes in the code

**Files:** `android/README.md` (the MIN_TILL_VERSION paragraph, ~line 183) and the till's build number in `android/app/build.gradle*` (`versionCode`, `versionName`).

- [ ] **Step 1:** Raise `versionCode` by one and `versionName` to the next 0.9.x (read both first).
- [ ] **Step 2:** Under the README's MIN_TILL_VERSION paragraph, add one line: "Kiosks (0160): set MIN_TILL_VERSION to the build that carries them (build N) when that release goes live; an older till lists a kiosk as a printer that never answers."
- [ ] **Step 3: Commit.** `git commit -m "Till build N: kiosks"` (with the two files).

---

# Phase 5: Seen working (emulators)

### Task 23: Install day, written for real kiosks

**Files:** create `docs/kiosk-install-day.md`.

- [ ] **Step 1: Write it** for whoever installs kiosks (EasyPay, not the restaurant). Plain steps:
  1. Factory-fresh kiosk: no Google account added.
  2. Install EasyPay: USB debugging on, `adb install easypay.apk`.
  3. `adb shell dpm set-device-owner com.restopos.app/com.restopos.core.kiosk.KioskAdmin`. It must say "Success". If it says an account exists, remove it, or factory-reset and skip adding one.
  4. Open EasyPay, then **Set up as a kiosk**. Set the PIN and the printer, and print a test slip.
  5. Fix the kiosk's address on the router (as for printers). Type the address and code in the back office under Printers, Kiosks, choosing the till.
  6. Switch the kiosk off and on: it must come back to Welcome with nobody touching it.
  7. Repeat for each kiosk.

  Also a section **"If set-device-owner is refused"** (the maker's management holds it): the Home fallback, with the one "EasyPay, Always" press and the maker's "start at boot" setting if it has one. And a section **"QR set-up (later)"**: not built. It needs `android.app.extra.PROVISIONING_DEVICE_ADMIN_COMPONENT_NAME`, the APK's download URL and checksum in a QR code scanned at the first-start screen, and is tested only on a real kiosk.
- [ ] **Step 2: Commit.** `git add docs/kiosk-install-day.md && git commit -m "Kiosk: install day, step by step"`

### Task 24: Two emulators, a till and a kiosk

**Read `restopos-emulator-is-shared` whole first.** Say each step to the owner before doing it.

- [ ] **Step 1: Build, then free the memory.** `android/gradlew -p android :app:assembleDebug`, then stop **only your own** idle Gradle and Kotlin daemons (not `gradlew --stop` if another session is building). Check free memory: two emulators need about 3.6 GB.
- [ ] **Step 2: Make the kiosk AVD** `easypay_claude_kiosk`. Copy `easypay_claude_size`'s `config.ini` into a new `.avd` folder, change its name, and set `hw.lcd.width=1080`, `hw.lcd.height=1920`, `hw.lcd.density=240`, with no Google account. Write its `.ini`. **This AVD is the only one device owner is ever set on.**
- [ ] **Step 3: Start both.** Say first. Then:
  - The till: `easypay_claude_size` on 5598, with its window. Read the business on it first; if it is someone else's, use a fresh AVD instead.
  - The kiosk: `easypay_claude_kiosk` with its window, `-port 5600 -memory 1792 -no-audio -no-boot-anim -gpu swiftshader_indirect`.
- [ ] **Step 4: The till.** `adb -s emulator-5598 install -r <windows path to app-debug.apk>`, then the made-up restaurant on **trial** (it carries the kiosk): `pm clear` only if it holds nothing of anyone's; `DEMO_SHOP --es type restaurant --es plan trial` (check the debug receiver takes `trial`; if not, `premium` and the extra via the debug build's settings). Open the day.
- [ ] **Step 5: The kiosk, as device owner.**
  - `adb -s emulator-5600 install -r <apk>`
  - `adb -s emulator-5600 shell dpm set-device-owner com.restopos.app/com.restopos.core.kiosk.KioskAdmin`. Expect "Success"; if it is refused for an account, wipe this AVD only and repeat.
  - Open the app, tap **Set up as a kiosk**, set the PIN `2468`, and set the printer to Network `10.0.2.2:9101` with the stand-in printer running there (see `restopos-environments`).
- [ ] **Step 6: Pair.** On the till, Settings, Printers, Add a kiosk: the kiosk's own 10.0.2.x address as it shows it, code `KYSK2345`, name Kiosk 1. Within about 2 s the kiosk shows Welcome with the restaurant's name. Expected: yes.
- [ ] **Step 7: Order, and check each of these:**
  - Touch to order, Eat in, a dish with options, Add, View order, Place order.
  - Expected: "Your number is 1". The stand-in printer shows a slip with "1", NOT PAID and "This is not a receipt".
  - The till chimes, and its kiosk key shows 1.
- [ ] **Step 8: The till's side.**
  - Kiosk list, Open 1. Then the register's Save: nothing goes to the kitchen (no kitchen paper at the stand-in).
  - Pay cash: a kitchen paper prints once.
  - A second order, then Cancel it: it leaves the list.
  - A third order, then Close day: the Z says "Kiosk orders not paid: 1".
- [ ] **Step 9: Runs itself.** Each of these, with no tap on the kiosk:
  - `adb -s emulator-5600 reboot` → Welcome comes back. No lock screen, no Android Home, no question asked.
  - `adb -s emulator-5600 shell am force-stop com.restopos.app` → Welcome is back within seconds.
  - Close the app on the till, start it again → the kiosk shows "Ordering opens in a moment", then ordering again by itself.
  - Swipe down from the top, press Home and Back on the kiosk → nothing leaves the app.
  - The corner press for 3 s, PIN `2468`, Back to kiosk → Welcome.
- [ ] **Step 10: Two kiosks at once.** The race is covered by the JVM test (`KioskNumbersTest`). On the emulators, place two orders back to back from the kiosk and see 2 and 3. A second kiosk AVD is not needed.
- [ ] **Step 11: Leave things tidy.** Shut both emulators down (`shell sync`, `emu kill`). Write in the memory note `restopos-emulator-is-shared` what is left on each: the build, the made-up restaurant, and that `easypay_claude_kiosk` is device owner (only `-wipe-data` undoes that).
- [ ] **Step 12: Report** to the owner what was seen, and what could not be: a real kiosk, its built-in printer, a 21-32" touchscreen, whether the maker allows device owner, the quiet update on real hardware (it can be forced on the emulator by setting its clock to 02:30 and a newer build on dev, but only if the owner asks).

---

## Self-review against the spec (done while writing)

| Spec | Task |
|---|---|
| §1 Welcome, Eat in/Take away, Menu, Dish (the pop-up's rules), Basket bar, Review, Done, 60 s Still there, English only | 17 |
| §1 slip not a receipt | 18 |
| §2 till link, signed, own port; menu on connect and on change; till checks prices; slip only after the answer; 5 s → counter | 6, 7, 12, 16, 17 |
| §2 held apart in `kiosk_orders`; key, chime, Kiosk tab; Open; Pay sends to the kitchen; failed Pay sends nothing; Cancel; numbers per day; day close (by hand, asked, auto) cancels and counts | 9, 10, 11, 13 |
| §3 paid extra: `kiosk` feature, `set_tenant_features`, `has_feature` trial yes / premium no / retail no; `kioskPaid` not copying deposits | 2, 3, 5 |
| §3 offline path for the extra | settled at the top; 5 reads it |
| §3 pairing: printer kind `kiosk`, 0160, `printer.save` refuses without the extra; Set up as a kiosk; Printers → Kiosks; Settings → Printers offline; MIN_TILL_VERSION | 2, 4, 13, 14, 22 |
| §3 printing on the kiosk's own printer; built-in printer unknown | 18; 24 Step 12 |
| §3 runs itself: device owner on install day, Home, full lock, restarts itself, screen on, no pop-ups, connects itself, "Ordering opens in a moment", day by day, updates itself, support PIN, paper → counter and the till told, fallback, several kiosks to one till | 12, 16-21, 23, 24 |
| §4 testing: JVM rules, a database suite, emulators | 1, 5-11, 16-18, 20, 24 |
| Deferred: per-kiosk dining untick, VAT on Review, several of one add-on, QR set-up | named at the top |
