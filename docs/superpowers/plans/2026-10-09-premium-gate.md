# Premium gate: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in one session. No subagent per task: the owner pays per token, and each subagent would start cold on a codebase this size. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** For a restaurant, the Kitchen tab on the till and Bookings exist only on the Premium and Trial plans; a Standard restaurant keeps Send to kitchen and printed kitchen tickets.

**Architecture:** `tenants.plan` stays the one source of truth. The platform functions that set it copy it into `pos_settings.data.plan`, which every till already pulls, so the till learns it the way it learns the business type. The back office reads it in `tenantContext()`. The server refuses a booking from a restaurant that is not premium, so hiding a screen is never the only guard.

**Tech stack:** Postgres on Neon (dev branch `dev-review`), Next.js back office in `web/`, Android till (Kotlin, Compose, Room) in `android/`.

**Spec:** `docs/superpowers/specs/2026-10-09-kitchen-screen-and-premium-design.md`, section 3. This plan is piece 1 of 2; the kitchen screen is `2026-10-09-kitchen-screen.md`.

**Written lean on purpose.** The owner pays for every token, and whoever executes this has the repository open. Code is given where it fixes a contract (SQL, a key's name, a signature, a test's checks). Screens are described by what they must show and where.

**House rules that apply to every task.**
- Work on branch `restopos`, one commit per task, message in the repository's style (what and why, in sentences). Never push unless asked; never to `origin`.
- Before editing a file, read its committed version; another session may have changed it.
- A migration is fix-forward: a new numbered file, each function taken from its live definition (`node db/scripts/dump-function.cjs <name>`), its header naming what changed.
- Dev only. Production migrations, deploys and `MIN_TILL_VERSION` are the owner's to run.
- `web/next-env.d.ts` and `.claude/` stay out of commits.
- Another session works in this folder. While this plan was being written it released 0.5.1 (build 6). Before each task: `git status` and `git log -3`; before naming a migration or a build number, read what the last one is. Files that are not this plan's are left alone.

---

## File map

| File | Change |
|---|---|
| `db/tests/premium-gate.test.cjs` | New suite, written first. |
| `db/scripts/dump-function.cjs` | Accepts `schema.name` so `platform.*` functions can be dumped. |
| `db/migrations/0085_premium_gate.sql` | `has_premium`, the plan in the settings, the booking refusal, the new code in `sync_push`. |
| `db/tests/service-v2.test.cjs`, and any other suite that makes a booking | Their probe restaurant is made premium. |
| `web/lib/plan.ts` | New: `hasPremium(plan)`. |
| `web/lib/tenant.ts` | `premium` in `TenantContext`. |
| `web/app/backoffice/nav.ts`, `side.tsx`, `layout.tsx` | A link may be premium-only; the menu and the search filter by it. |
| `web/app/backoffice/bookings/page.tsx` | A notice in place of the page, and the saves refused, when not premium. |
| `web/app/backoffice/page.tsx`, `counts/route.ts` | The booking cards and the booking count only when premium. |
| `web/app/admin/view.tsx`, `web/app/admin/tenants/[id]/view.tsx` | One line beside the plan saying what Premium switches on. |
| `android/.../core/data/PosSettings.kt` | `premium`. |
| `android/.../core/data/Routing.kt` | `nowhere(...)` and `nowhereText(...)`: the lines that reach no printer, and the sentence for them. |
| `android/.../core/data/DocBuilder.kt`, `OrderOps.kt` | Send names those lines for a restaurant without the Kitchen tab. |
| `android/.../feature/main/MainShell.kt` | Kitchen and Bookings entries and badges only when premium. |
| `android/.../feature/floor/*.kt` | No "reserved" and no booking seated when not premium. |
| `android/.../feature/settings/SettingsScreen.kt` | Help and the failed-print wording do not speak of a kitchen display the restaurant does not have. |
| `android/app/src/test/.../core/data/PosSettingsTest.kt`, `RoutingTest.kt` | Tests, written first. |
| `android/app/src/debug/assets/demo-restaurant.json`, `debug/DemoReceiver.kt` | A made-up restaurant for the debug build, so the till can be tried with no login. |

---

### Task 1: the server suite, failing

**Files:** Create `db/tests/premium-gate.test.cjs`.

- [ ] **Step 1: write the suite.** One transaction, rolled back, in the shape of `db/tests/business-type.test.cjs` (its `check`, `failsWith`, `one`, the dev guard). The probe restaurants are made with `platform.create_tenant` so that the function itself is under test. To push as a till, use the `asApp` / `sync_push` pattern of `db/tests/service-v2.test.cjs` lines 36 to 45, with savepoints in place of its `BEGIN`/`COMMIT` since this suite stays in one transaction.

The checks, by name:

```
P1 a tenant made standard carries plan "standard" in its settings
P1 a tenant made premium carries "premium"; made trial carries "trial"
P2 set_tenant_plan(standard -> premium) writes the settings and keeps what they held (servicePct 10 stays)
P2 the change is logged once, with from and to (as before)
P3 has_premium: true for premium and trial, false for standard, free, an unknown tenant
P4 booking.upsert for a standard restaurant: status rejected, code not-premium, no booking row
P4 the same booking after the plan is set to premium: applied, one row
P4 a trial restaurant's booking: applied
P5 every tenant's settings carry its plan (count of tenants whose pos_settings.data->>'plan' is not their plan = 0)
P6 a till is sent the settings row after a plan change (its server_seq went up)
```

The booking payload for P4 (the fields `push_booking_upsert` requires):

```js
const booking = (store) => ({ id: crypto.randomUUID(), store_id: store, booked_for: '2026-12-01T19:00:00+04:00', name: 'Ramgoolam', size: 4, status: 'confirmed' });
```

- [ ] **Step 2: run it and see it fail.**

Run: `node db/tests/premium-gate.test.cjs`
Expected: FAIL at P1 (the settings hold no `plan`), and P3 stops on `function has_premium(uuid) does not exist`.

- [ ] **Step 3: commit** the suite alone ("db: the premium gate's suite, written first...").

### Task 2: migration 0085

**Files:** Modify `db/scripts/dump-function.cjs`. Create `db/migrations/0085_premium_gate.sql`.

- [ ] **Step 1: let the dump script take a schema and a number of arguments.** Split the first argument on a dot, default schema `public`, pass both to the query (`n.nspname = $2`). `platform.create_tenant` exists twice, with 7 arguments and, since 0066, with 8 (the one that also takes the type and calls the other); the script stops on anything but one match, so an optional second argument narrows by `p.pronargs`: `node db/scripts/dump-function.cjs platform.create_tenant 7`. Only the 7-argument one gets the settings write; the other calls it.

- [ ] **Step 2: write the migration.** Header comment in the style of `0084_item_ops.sql`: what the owner asked ("the kitchen and the bookings will be on the premium tier for restaurant customers"), what each function gains, that each is its live definition with those lines changed.

```sql
-- true for the plans that carry the premium features
create or replace function has_premium(p_tenant uuid) returns boolean
language sql stable set search_path = public as $fn$
  select coalesce((select lower(btrim(plan)) in ('premium', 'trial') from tenants where id = p_tenant), false)
$fn$;
```

`platform.set_tenant_plan`: its live definition, with these lines after `update tenants set plan = v_plan ...`:

```sql
  -- the tills learn the plan through the settings they already pull
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('plan', v_plan))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
```

`platform.create_tenant`: its live definition (dump it; 0077 is not necessarily the last word), with the same two statements after the tenant's basics are made, using `v_tenant` and `v_plan`. Check where in the function `app.tenant_id` is set and place them after it.

`push_booking_upsert`: its live definition, with this as the first statement of the body:

```sql
  if not has_premium(p_tenant) then raise exception 'not-premium'; end if;
```

`sync_push`: its live definition with `'not-premium'` added to the `codes` array, nothing else.

Backfill, at the end:

```sql
do $$
declare r record;
begin
  for r in select id, plan from tenants loop
    perform set_config('app.tenant_id', r.id::text, true);
    insert into pos_settings (tenant_id, data) values (r.id, jsonb_build_object('plan', r.plan))
      on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  end loop;
end $$;
```

If `pos_settings` has no trigger that raises `server_seq` on update, P6 will say so: find how `platform.set_tenant_business_type`'s write reaches a till (0066) and do the same.

If P4's premium case fails as `app_user` because `has_premium` cannot read `tenants` under row security, make the function `security definer` with its fixed search path. Do not loosen the test.

- [ ] **Step 3: ask the owner before applying to dev.** The moment 0085 is on dev, every restaurant there is Standard. Their emulator runs 0.5.1 or older, which still shows Kitchen and Bookings: a booking made on it comes back refused, and a refused change blocks Sign out on that build until it is cleared. So first tell them, and with their yes set the restaurants they test with to Premium on dev (in `/admin`, which works today; the migration's backfill then copies it into the settings). Only then apply.

- [ ] **Step 4: apply to dev.** Check `.env.local` names the dev branch first (`NEON_BRANCH`, host `ep-falling-surf`).

Run: `node db/migrate.cjs`
Expected: `0085_premium_gate.sql` applied, no error.

- [ ] **Step 5: run the suite.**

Run: `node db/tests/premium-gate.test.cjs`
Expected: every line PASS, exit code 0.

- [ ] **Step 6: commit** the script change and the migration.

### Task 3: the suites that make bookings

**Files:** Modify `db/tests/service-v2.test.cjs`; whichever others fail.

- [ ] **Step 1: find them.** Run: `grep -ln "booking" db/tests/*.cjs`. Run each (never `truncate`, `api6`, `signup-lock`, `platform-auth`). Expected before the fix: `service-v2` fails its booking checks with `rejected:not-premium`.

- [ ] **Step 2: make their probe restaurant premium** at the point it is made. `service-v2` inserts into `tenants` directly: add `plan` to that insert (`'premium'`) for the restaurant under test; leave the "other" tenant as it is. A suite that calls `platform.create_tenant(..., 'standard')` and then makes bookings passes `'premium'`.

- [ ] **Step 3: run** those suites and the ones nearest `sync_push` (`pos-operations`, `item-ops`, `open-price`, `seats-customers`, `ticket-merge`, `ticket-cancel`, `retail-till`, `push-policy`). Expected: all pass.

- [ ] **Step 4: commit.**

### Task 4: the back office

**Files:** as in the file map.

- [ ] **Step 1: `web/lib/plan.ts`.**

```ts
// The plans that carry the premium features: the kitchen display, kitchen
// screens and bookings. The database says the same in has_premium (0085).
export const hasPremium = (plan: unknown): boolean => {
  const p = typeof plan === "string" ? plan.trim().toLowerCase() : "";
  return p === "premium" || p === "trial";
};
```

- [ ] **Step 2: `tenantContext()`** selects `t.plan` and returns `premium: hasPremium(row.plan)`; `TenantContext` gains `premium: boolean` with a one-line comment.

- [ ] **Step 3: `nav.ts`.** `NavLink` gains `premium?: true`; Bookings gets it. `groupsFor(mode)` becomes `groupsFor(mode, premium)` and filters `!l.premium || premium` beside the `only` filter; the same for whatever the search box reads. `side.tsx` and `layout.tsx` pass `ctx.premium` down beside `mode`. Run `grep -n "groupsFor\|groupOf\|SearchBox" web/app/backoffice -r` and follow every caller.

- [ ] **Step 4: the Bookings page.** After `onlyFor("restaurant")`: when `!ctx.premium`, return a `PageHead` and one `Card` saying "Bookings are part of EasyPay Premium. The bookings already taken are kept and come back with the plan. Ask EasyPay to switch it on." and nothing else. In `addBooking`, `saveBooking` and any other action of the page: `if (!ctx.premium) throw new Refused("Bookings are part of EasyPay Premium.");` as the first line inside `act`.

- [ ] **Step 5: the dashboard and the counts.** In `web/app/backoffice/page.tsx` the "bookings to confirm" alert (about line 419), the bookings tile (about 615) and the "Next bookings" card (about 645) are drawn only when `ctx.premium`. In `counts/route.ts` the `/backoffice/bookings` count is put only when premium (the route already knows the tenant; read the plan in the same query).

- [ ] **Step 6: the admin pages.** Beside the plan select on `admin/tenants/[id]/view.tsx` and beside the plan radios on `admin/view.tsx`: "Premium and Trial switch on the kitchen display, kitchen screens and Bookings for a restaurant. Standard keeps printed kitchen tickets."

- [ ] **Step 7: check.**

Run (in `web/`): `npx tsc --noEmit`
Expected: no errors.

Run: `node db/tests/backoffice-saves.test.cjs` and `node db/tests/pos-pages.test.cjs`
Expected: pass (make their restaurant premium if a booking save is among their checks).

The pages themselves need a login to be seen. Use the preview route described in the project notes (`web/app/zz-preview`, deleted before the commit) to see the side menu with and without `premium`, and the Bookings notice; say in the commit what was and was not seen.

- [ ] **Step 8: commit.**

### Task 5: the till knows the plan

**Files:** Create `android/app/src/test/java/com/restopos/core/data/PosSettingsTest.kt`. Modify `PosSettings.kt`.

- [ ] **Step 1: the failing test.**

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Which restaurants have the premium screens. A till that cannot tell must
// not show them: the server would refuse what they send.
class PosSettingsTest {
    @Test fun premiumAndTrialHaveThem() {
        assertTrue(PosSettings.parse("""{"plan":"premium"}""").premium)
        assertTrue(PosSettings.parse("""{"plan":" Trial "}""").premium)
    }
    @Test fun standardAndUnknownDoNot() {
        assertFalse(PosSettings.parse("""{"plan":"standard"}""").premium)
        assertFalse(PosSettings.parse("""{"plan":"free"}""").premium)
        assertFalse(PosSettings.parse("{}").premium)
        assertFalse(PosSettings.parse(null).premium)
        assertFalse(PosSettings.parse("not json").premium)
    }
}
```

- [ ] **Step 2: see it fail.** Run: `android/gradlew -p android :app:testDebugUnitTest --tests "*PosSettingsTest*"` (add `--priority low --max-workers 2` while an emulator is open). Expected: does not compile, `premium` unresolved.

- [ ] **Step 3: implement.** In `PosSettings`: `val premium: Boolean = false, // the plan carries the kitchen display and bookings (server 0085)`; in `parse`: `premium = d.str("plan")?.trim()?.lowercase().let { it == "premium" || it == "trial" },`.

- [ ] **Step 4: see it pass.** Same command. Expected: 2 tests pass.

- [ ] **Step 5: commit.**

### Task 6: an item that reaches no printer is named

**Files:** Modify `RoutingTest.kt`, `Routing.kt`, `DocBuilder.kt`, `OrderOps.kt`.

- [ ] **Step 1: failing tests** added to `RoutingTest` (it has `order` and `three` already):

```kotlin
    @Test
    fun aLineWithNoPrinterIsNamed() {
        assertEquals(listOf("gift card"), Routing.nowhere(order, three, onePrinter = false))
        // one printer for everything prints everything
        assertEquals(emptyList<String>(), Routing.nowhere(order, three, onePrinter = true))
    }

    @Test
    fun theSentenceForThem() {
        assertNull(Routing.nowhereText(emptyList()))
        assertEquals("1 item went to no printer: Water. Tick a printer for its category in the back office.", Routing.nowhereText(listOf("Water")))
        assertEquals("3 items went to no printer: Water, Cola. Tick a printer for their category in the back office.", Routing.nowhereText(listOf("Water", "Cola", "Water")))
    }
```

- [ ] **Step 2: see them fail** (`--tests "*RoutingTest*"`): `nowhere` and `nowhereText` unresolved.

- [ ] **Step 3: implement in `Routing`.**

```kotlin
    // The lines that print nowhere: no printer ticked for their category, or
    // none of the ticked ones usable. With a kitchen display they are still
    // on it; without one nobody would be told, so the till names them.
    fun <L> nowhere(lines: List<Pair<L, List<String>?>>, printers: List<PrinterEntity>, onePrinter: Boolean): List<L> =
        lines.filter { (_, ticked) -> printersFor(ticked, printers, onePrinter).isEmpty() }.map { it.first }

    fun nowhereText(names: List<String>): String? {
        if (names.isEmpty()) return null
        val n = names.size
        return "$n ${if (n == 1) "item" else "items"} went to no printer: ${names.distinct().joinToString(", ")}. " +
            "Tick a printer for ${if (n == 1) "its" else "their"} category in the back office."
    }
```

- [ ] **Step 4: use it.** `KitchenOutcome` gains `val nowhere: List<String> = emptyList()` (the lines' `name_snapshot`), filled in `DocBuilder.kitchen` from the same `rows`, printers and `one` it already has. In `OrderOps.save` and `sendOnPay`: when `!settings.premium`, add `Routing.nowhereText(out.nowhere)` to the errors that are shown. Voids and reprints are left alone.

- [ ] **Step 5: see them pass**, and the whole unit suite: `android/gradlew -p android :app:testDebugUnitTest`. Expected: all pass. Note the count before starting; it must go up by the new tests and by nothing else.

- [ ] **Step 6: commit.**

### Task 7: the till shows the premium screens only to premium

**Files:** Modify `feature/main/MainShell.kt`, `feature/floor/*.kt`, `feature/settings/SettingsScreen.kt`.

- [ ] **Step 1: `MainShell.kt`.**
  - `private val PREMIUM_ONLY = setOf(Screen.Kitchen, Screen.Bookings)` beside `RESTAURANT_ONLY`.
  - `ShellViewModel` gets `val premium: StateFlow<Boolean>` from `db.ops().settingsFlow()` the way `retail` is made; where `retail.collect` sends a shop away from restaurant screens, a restaurant that is not premium on a `PREMIUM_ONLY` screen is sent to `Screen.Floor`.
  - Both places that list the entries (the top bar, about line 503, and `SideMenu`, about line 692) leave out `PREMIUM_ONLY` screens when not premium.
  - `Badges` (about line 222): `kitchen` and `bookings` are 0 when not premium.
  - Old kitchen tickets are cleared when the till's shell starts (`kitchen.prune()`), not only when the Kitchen tab is opened (`KdsViewModel.init` today): a Standard restaurant never opens that tab, and its tickets would pile up for good.
- [ ] **Step 2: the floor.** In the floor's view model (about line 146) the bookings are an empty list when not premium, so no table reads "reserved"; and seating a table (about line 172) does not touch a booking when not premium (it would push a `booking.upsert` the server now refuses).
- [ ] **Step 3: Help and wording** in `SettingsScreen.kt`: the Help entry "The kitchen display" and any entry about bookings are left out when not premium; the failed kitchen print's line (about 880) and "A printer does not print" (about 965) drop their sentence about the kitchen display when not premium. Find every other mention: `grep -n "kitchen display\|Kitchen\b\|ooking" android/app/src/main/java/com/restopos/feature -r`.
- [ ] **Step 4: build and test.**

Run: `android/gradlew -p android :app:testDebugUnitTest :app:assembleDebug`
Expected: tests pass, the debug build assembles.

- [x] **Step 5: the made-up restaurant carries a plan.** As built: the debug build could already set a tablet up as a restaurant (`DemoReceiver`, `--es type restaurant`, from the same `demo-shop.json`), so no second asset was needed. It now takes `--es plan premium`; with none, its settings carry no plan. It has no printers, so every line it sends prints nowhere.
- [x] **Step 6: on an emulator.** As run: the older test emulator (`easypay_claude_test`, port 5584) holds the owner's client Hamaad Retail, so it was left as it was and a new one made, `easypay_claude_till` (started with `-no-window -port 5586`, always `adb -s emulator-5586`). With no plan: no Kitchen or Bookings along the top or in the side menu, a send names the items that went to no printer, a takeaway moves to Ready with Mark ready, Help has no kitchen display entry. On the premium plan: both screens back, a send says "sent to kitchen", the ticket is on the Kitchen display. What a send says had to be put right on the way (`SaveResult.trouble`): the order screen and the takeaway board both added "The order is on the kitchen display" to whatever went wrong.
- [ ] **Step 7: commit** (the made-up restaurant as a commit of its own).

### Task 8: dev deploys, and what is the owner's

- [ ] **Step 1:** nothing in the till API (`hello.ts`) changes in this plan, so no API deploy.
- [ ] **Step 2:** deploy the back office to dev only if the owner asks to see it there.
- [ ] **Step 3: tell the owner**, in the closing message:
  - every restaurant on dev is now Standard unless it was set to Premium in `/admin`, the demo ones included;
  - a till on 0.5.1 or older still shows Kitchen and Bookings, and a booking it makes for a Standard restaurant comes back refused;
  - **production does not get this plan by itself.** Migration 0085 alone would refuse the bookings of every till on 0.5.1 or older, and the back office alone would hide Bookings from everyone. It goes out with the kitchen screen, in this order, each step on their word:
    1. set to Premium, in `/admin`, each restaurant that is to keep Bookings and the Kitchen tab (this works today);
    2. migrations 0085 and 0086;
    3. the back office;
    4. the till release `v0.6.0`;
    5. the till API with `MIN_TILL_VERSION` raised to that release's build number (7 as this is written: 0.5.1 is build 6).

---

## Self-review against the spec (section 3)

| Spec | Task |
|---|---|
| Plan reaches the back office | 4, steps 1 to 3 |
| Plan reaches the till through the settings; backfill | 2 |
| Till: Kitchen and Bookings hidden, badges, floor | 5, 7 |
| Till Help | 7, step 3 |
| Back office: Bookings hidden, notice, dashboard | 4 |
| Server refuses `booking.upsert` and booking saves | 2; 4, step 4 |
| An item that reaches no one | 6 |
| Every existing restaurant becomes Standard; admin says what Premium is | 2 (backfill), 4 step 6, 8 |
| Old tills, `MIN_TILL_VERSION` | 8 (the owner's step) |
| Kitchen screens not offered or saved for Standard | Plan 2 (the screens do not exist yet) |
