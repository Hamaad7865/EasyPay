# The day closes itself, and Look only: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a till closes a day nobody closed at a time the business sets, and anyone with a PIN can get into the till to look without opening the day or clocking in.

**Architecture:** the till does the closing itself (`AutoClose`, ticking like `DueReminders`), dated by a pure rule (`AutoCloseRules`) from the day's start, the set time, the last money written and the quiet stretch it looks at. The server (0133) stores an automatic closing with no closer and no count, which every back-office page already reads as "not counted". Look only is a flag on the signed-in session; a pure gate (`SellGate`) decides, and `SellCheck` applies it in every op helper that writes an order or money, and drives a strip along the top of the till.

**Tech stack:** Kotlin, Compose, Room (no schema change), Hilt, kotlinx.serialization; Postgres (plpgsql) migration; Next.js back office (TypeScript, node:test-style `.mjs` checks).

**Spec:** `docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md`.

---

## Where it is built, and what was decided while planning

- Built in the worktree `C:\Projects\RestoPOS\.claude\worktrees\auto-close`, branch `claude/auto-close`, cut from `restopos` at `98f1ce0b` (till 0.9.22 build 34, Room 35, migration 0132: the MRA session's). Another session works in the main checkout at the same time; it has uncommitted edits in `TicketRepository.kt` and `OrderOps.kt`. Nothing here is pushed.
- **No Room change.** The spec added `auto` and `carried` columns to the tablet's day closings. Instead the server keeps an automatic closing's shift with **no closer and no count** (0133), and the tablet does the same locally: a closed shift with `closed_by` and `counted_cash` both null is a day that closed itself. The back office already says "Not counted" for a shift with no count, on every page. `carried` lives in the closing's `totals` (back office) and on the Z printed at the time; a Z printed again on the tablet does not repeat it.
- **No `PullWorker` hook.** WorkManager starts the app's process to pull; `RestoPosApp.onCreate` starts `AutoClose`, whose first look covers the time the app was not running.
- The day-close report has no CSV: nothing to change there.
- **Quiet** is no touch, no key and no scan (`MainActivity.used()`, which also writes `SessionStore.lastUse` once a minute), and nothing that moved money. Opening the app in the morning is a touch, so the rule looks for a quiet stretch **after the cut-off**, not for quiet now: the stretch from the last touch before this run of the app to its start counts.
- `AUTO_CLOSE_BUILD` (back office) is 35, the build after `98f1ce0b`'s 34. If `v0.9.22` is tagged after this work is merged into `restopos`, set it to 34 at that merge (Task 12).

## Files

Server
- Create `db/migrations/0133_auto_close.sql`: `push_settings_save` (from 0128) + `autoClose`; `push_shift_close`, `push_day_close` (from 0054) + automatic closings.
- Create `db/tests/auto-close.test.cjs`.

Till, rules (pure, unit-tested)
- Create `core/data/AutoCloseRules.kt`, `core/data/SellGate.kt`.
- Tests: `AutoCloseRulesTest.kt`, `SellGateTest.kt`; extend `PosSettingsTest`-style parse check inside `AutoCloseRulesTest`; extend `core/print/DocsTest.kt`.

Till, closing
- Modify `core/data/PosSettings.kt` (`autoClose`), `core/print/Docs.kt` (`ZDoc.auto`, `ZDoc.carried`, `Docs.z`), `core/data/CashOps.kt` (`closeDayAuto`, `closeUnclosedAuto`, `lastWritten`, `unclosedSince`, `withDrawer`, `dayCloseOp`), `core/data/StaffRepository.kt` (`suggestedFloat`), `core/data/ReportsRepository.kt` and `feature/reports/Views.kt`, `feature/reports/Print.kt` (not counted, automatically), `core/sync/Sync.kt` (`SessionStore.autoClosed`).
- Create `core/data/AutoClose.kt`; modify `app/RestoPosApp.kt`, `app/MainActivity.kt`.

Till, Look only
- Modify `core/data/StaffRepository.kt` (`StaffSession.lookOnly`); create `core/data/SellCheck.kt`; guard the `op()` helpers of `TicketRepository`, `OrderOps`, `RetailSales`, `Deposits`, `Accounts`, `CashOps`, and `CashOps.openDrawer`.
- Modify `feature/staff/StaffViewModel.kt`, `feature/start/StartScreen.kt`, `feature/staff/ClockScreen.kt`, `feature/main/MainShell.kt`.

Till, setting
- Modify `core/data/OfficePayloads.kt`, `core/data/Service.kt`, `core/data/LocalAnswers.kt`, `feature/settings/BusinessPages.kt`, `feature/settings/SettingsScreen.kt` (Cash drawer page).
- Debug: `src/debug/java/com/restopos/debug/DemoReceiver.kt`, `src/debug/AndroidManifest.xml` (`DEMO_NIGHT`).

Back office
- Modify `web/lib/settings.ts`, `web/app/backoffice/settings/page.tsx`, `web/lib/pos.ts`, `web/app/backoffice/reports/day-close/page.tsx`; tests `web/lib/pos.test.mjs`, create `web/lib/settings.test.mjs`.

All till paths are under `android/app/src/main/java/com/restopos/` unless said.

---

### Task 1: migration 0133 and its test

**Files:** create `db/migrations/0133_auto_close.sql`, `db/tests/auto-close.test.cjs`.

- [ ] **Step 1: write the test** (`db/tests/auto-close.test.cjs`), in one transaction rolled back, on the dev branch only:

```js
// auto-close.test.cjs — migration 0133: a till closes its own day.
//   A1 settings.save takes autoClose "HH:MM", null switches it off, anything else is bad-value
//   A2 shift.close marked auto keeps no count and no closer, whatever count it carries
//   A3 day.close with totals.auto keeps no closer, and its totals as sent
//   A4 a closing that is not automatic is as before: a count is needed, the closer is kept
//   A5 a login that may set up tills (settings.device) may push an automatic closing; one that may do neither may not
//   A6 the pull brings both back as they are kept
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/auto-close.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload, employee) => ({ op_id: crypto.randomUUID(), type, payload, ...(employee ? { employee_id: employee } : {}) });

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-autoclose@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant_of_type($1,'Auto Close Test','Main',$3,'Owner',$2,'offline','restaurant') as r`, [admin, id(), 'AC' + crypto.randomInt(1000, 9999)])).r;
    const tid = made.tenant_id, store = made.store_id, owner = made.employee_id;
    await c.query(`select platform.set_tenant_plan($1,$2,'premium')`, [admin, tid]);
    async function asApp(fn) {
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { return await fn(); } finally { await c.query('RESET ROLE'); }
    }
    const push = (ops, as = owner) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [as, JSON.stringify(ops)])).rows[0].r);
    const pull = () => asApp(async () => (await c.query('select sync_pull($1, 0, 1000) as r', [store])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    const data = async () => (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
    const dev = (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1,$2,'T1','T1') returning id`, [tid, store])).id;
    const at = (min) => new Date(Date.UTC(2026, 0, 1, 20, 0) + min * 60_000).toISOString();

    // ---- A1 the setting ----
    {
      const save = (p) => push([op('settings.save', p)]);
      let o = await save({ autoClose: '05:00', servicePct: 10 });
      let d = await data();
      check('A1 settings.save takes autoClose', tag(o[0]) === 'applied' && d.autoClose === '05:00' && d.servicePct === 10, tag(o[0]) + ' ' + JSON.stringify(d.autoClose));
      o = await save({ autoClose: '00:00' });
      check('A1 midnight is a time', tag(o[0]) === 'applied' && (await data()).autoClose === '00:00', tag(o[0]));
      for (const [label, v] of [['24:00', '24:00'], ['5:00', '5:00'], ['words', 'midnight'], ['a number', 5], ['00:60', '00:60']]) {
        const r = await save({ autoClose: v });
        check('A1 ' + label + ' is refused', tag(r[0]) === 'rejected:bad-value', tag(r[0]));
      }
      o = await save({ autoClose: null });
      d = await data();
      check('A1 null switches it off, the other keys untouched', tag(o[0]) === 'applied' && d.autoClose === null && d.servicePct === 10, JSON.stringify({ a: d.autoClose, s: d.servicePct }));
    }

    // ---- A2, A3 a day closed by itself ----
    const shift = id();
    check('A2 the day opens', tag((await push([op('shift.open', { id: shift, device_id: dev, opening_float: 10000, opened_at: at(0) })]))[0]) === 'applied');
    {
      // pushed as the till pushes it: no employee on the op, so it is the login's
      const o = await push([op('shift.close', { id: shift, counted_cash: 10000, closed_at: at(240), auto: true })]);
      const s = await one(`select closed_by, counted_cash, expected_cash, closed_at from shifts where id = $1`, [shift]);
      check('A2 an automatic shift.close keeps no count and no closer', tag(o[0]) === 'applied' && s.closed_by === null && s.counted_cash === null && Number(s.expected_cash) === 10000 && s.closed_at.toISOString() === at(240),
        tag(o[0]) + ' ' + JSON.stringify(s));
      const dc = id();
      const o2 = await push([op('day.close', { id: dc, store_id: store, device_id: dev, closed_at: at(240), totals: { sales: 0, expected: 10000, auto: true, carried: 2 } })]);
      const row = await one(`select closed_by, totals from day_closes where id = $1`, [dc]);
      check('A3 an automatic day.close keeps no closer, and its totals as sent', tag(o2[0]) === 'applied' && row.closed_by === null && row.totals.auto === true && row.totals.carried === 2,
        tag(o2[0]) + ' ' + JSON.stringify(row));
      // ---- A6 the pull ----
      const p = await pull();
      const ps = p.changes.shifts.find((x) => x.id === shift), pd = p.changes.day_closes.find((x) => x.id === dc);
      check('A6 the pull brings the shift with no count and the closing with totals.auto', ps && ps.counted_cash === null && ps.closed_by === null && pd && pd.totals.auto === true && pd.closed_by === null,
        JSON.stringify({ ps: ps && { c: ps.counted_cash, b: ps.closed_by }, pd: pd && pd.totals }));
    }

    // ---- A4 as before ----
    {
      const s2 = id();
      await push([op('shift.open', { id: s2, device_id: dev, opening_float: 5000, opened_at: at(300) })]);
      const no = await push([op('shift.close', { id: s2, closed_at: at(400) })]);
      check('A4 a shift.close that is not automatic needs a count', tag(no[0]) === 'rejected:bad-payload', tag(no[0]));
      const ok = await push([op('shift.close', { id: s2, counted_cash: 4900, closed_at: at(400) })]);
      const s = await one(`select closed_by, counted_cash from shifts where id = $1`, [s2]);
      check('A4 and keeps who closed it and what they counted', tag(ok[0]) === 'applied' && s.closed_by === owner && Number(s.counted_cash) === 4900, JSON.stringify(s));
      const dc = id();
      await push([op('day.close', { id: dc, store_id: store, device_id: dev, closed_at: at(400), totals: { sales: 0 } })]);
      check('A4 a day.close that is not automatic keeps its closer', (await one(`select closed_by from day_closes where id = $1`, [dc])).closed_by === owner);
    }

    // ---- A5 who may ----
    {
      const setter = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Sets up','["settings.device"]'::jsonb) returning id`, [tid])).id;
      const waiter = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Waiter','["sale.create"]'::jsonb) returning id`, [tid])).id;
      const sam = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Sam',$2) returning id`, [tid, setter])).id;
      const wes = (await one(`insert into employees (tenant_id, name, role_id) values ($1,'Wes',$2) returning id`, [tid, waiter])).id;
      const s3 = id();
      await push([op('shift.open', { id: s3, device_id: dev, opening_float: 0, opened_at: at(500) })]);
      const refused = await push([op('shift.close', { id: s3, counted_cash: 0, closed_at: at(600), auto: true })], wes);
      check('A5 a login that may neither close a day nor set up tills may not', tag(refused[0]) === 'rejected:forbidden', tag(refused[0]));
      const taken = await push([op('shift.close', { id: s3, counted_cash: 0, closed_at: at(600), auto: true })], sam);
      check('A5 a login that may set up tills may push an automatic closing', tag(taken[0]) === 'applied', tag(taken[0]));
      const notAuto = await push([op('day.close', { id: id(), store_id: store, device_id: dev, closed_at: at(600), totals: {} })], sam);
      check('A5 but not a closing that is not automatic', tag(notAuto[0]) === 'rejected:forbidden', tag(notAuto[0]));
    }
  } catch (e) {
    failures++;
    console.log('FAIL ' + e.message);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'ALL PASS' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
```

- [ ] **Step 2: run it, alone**: `node db/tests/auto-close.test.cjs` (from the worktree). Expected: A1 and A2 FAIL (no `autoClose`, a shift.close with `auto` still keeps a count and a closer).

- [ ] **Step 3: write the migration.** Take the live definitions first, so nothing applied since the files were written is lost:
`node -e` with `pg` running `select pg_get_functiondef('push_settings_save(uuid,uuid,jsonb)'::regprocedure)`, and the same for `push_shift_close` and `push_day_close`, against dev. Compare each with 0128 / 0054; they must match. Then `db/migrations/0133_auto_close.sql` is a header and the three functions with these edits:

```sql
-- 0133_auto_close.sql — a till closes its own day at a time the business sets
-- (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
-- Source: push_settings_save (last written by 0128_loyalty_points.sql),
-- push_shift_close and push_day_close (0054_approval_and_drawer_count.sql)
-- are the live definitions on dev (pg_get_functiondef) with the edits listed
-- here. Earlier migrations untouched.
--
-- What changes:
--   - settings.save takes autoClose: "HH:MM" from 00:00 to 23:59, the time
--     each till closes a day nobody closed; null switches it off. Anything
--     else is bad-value.
--   - A closing the till made by itself is marked: shift.close with
--     "auto": true, day.close with totals.auto = true. Nobody closed it, so
--     closed_by is left empty; nobody counted the drawer, so the shift keeps
--     no count (counted_cash null), whatever count the op carries (a till
--     sends what it expected, for a server without this migration). Every
--     page already reads a shift with no count as not counted.
--   - The till sends those two ops with no employee: they are its login's.
--     A login that may close a day (shift.open_close) may, as before, and so
--     may one that may set up tills (settings.device): it is the till doing
--     what its business set, not a person.
--   - sync_pull sends whole rows already: no change.
-- Never edit after merge.
```

In `push_settings_save`, before `if v_patch <> '{}'::jsonb then`:

```sql
  -- the time each till closes a day nobody closed (0133): "HH:MM", or null for off
  if p ? 'autoClose' then
    if jsonb_typeof(p->'autoClose') = 'null' then
      v_patch := v_patch || jsonb_build_object('autoClose', null);
    elsif jsonb_typeof(p->'autoClose') <> 'string' or (p->>'autoClose') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'bad-value';
    else
      v_patch := v_patch || jsonb_build_object('autoClose', p->>'autoClose');
    end if;
  end if;
```

`push_shift_close`: declare `v_auto boolean;`, and

```sql
  v_id := (p->>'id')::uuid;
  -- closed by the till itself (0133): no count is kept, and nobody closed it
  v_auto := coalesce(p->>'auto', '') = 'true';
  v_counted := case when v_auto then null else (p->>'counted_cash')::bigint end;
  v_at := coalesce((p->>'closed_at')::timestamptz, now());
  if v_id is null or (not v_auto and (v_counted is null or v_counted < 0)) then raise exception 'bad-payload'; end if;
  if not (may(p_emp, p, 'shift.open_close') or (v_auto and has_perm(p_emp, 'settings.device'))) then raise exception 'forbidden'; end if;
  ...
  update shifts set closed_by = case when v_auto then null else p_emp end, closed_at = v_at, counted_cash = v_counted,
      expected_cash = v_float + v_cash
    where id = v_id and tenant_id = p_tenant;
```

`push_day_close`: declare `v_auto boolean;`, and

```sql
  -- closed by the till itself (0133): nobody closed it
  v_auto := coalesce(p->'totals'->>'auto', '') = 'true';
  if not (may(p_emp, p, 'shift.open_close') or (v_auto and has_perm(p_emp, 'settings.device'))) then raise exception 'forbidden'; end if;
  ...
    values (v_id, p_tenant, v_store, v_device, v_no, case when v_auto then null else p_emp end, v_from, v_at, coalesce(p->'totals', '{}'::jsonb));
```

- [ ] **Step 4: apply to dev and run the test, alone**: `node db/migrate.cjs` (it applies what dev has not had: 0133, and 0132 if the MRA session has not applied it yet; both are additive and touch different functions), then `node db/tests/auto-close.test.cjs`. Expected: ALL PASS. Then the suites that push these ops, one at a time: `node db/tests/approval-count.test.cjs`, `node db/tests/staff-shifts.test.cjs`, `node db/tests/loyalty.test.cjs`, `node db/tests/till-requests.test.cjs`, `node db/tests/pos-pages.test.cjs`. Expected: ALL PASS each.
- [ ] **Step 5: commit** `database: a till closes its own day (0133), with no closer and no count kept`.

### Task 2: the rule of when a day closes itself

**Files:** create `core/data/AutoCloseRules.kt`, `src/test/java/com/restopos/core/data/AutoCloseRulesTest.kt`.

- [ ] **Step 1: the test.**

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

// When a till closes a day nobody closed, and as of what moment
// (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
class AutoCloseRulesTest {
    private val zone = ZoneId.of("Indian/Mauritius")
    private fun t(day: Int, h: Int, m: Int = 0): Long = LocalDate.of(2026, 1, day).atTime(h, m).atZone(zone).toInstant().toEpochMilli()
    private val midnight = LocalTime.MIDNIGHT
    private val opened = t(1, 9)
    private fun decide(lastMoney: Long?, from: Long, to: Long, at: LocalTime = midnight, dayFrom: Long = opened) =
        AutoCloseRules.decide(dayFrom, at, zone, lastMoney, from, to)

    @Test fun the_cut_off_is_the_first_set_time_after_the_day_opened() {
        assertEquals(t(2, 0), AutoCloseRules.cutoff(opened, midnight, zone))
        assertEquals(t(2, 5), AutoCloseRules.cutoff(opened, LocalTime.of(5, 0), zone))
        // a day opened after five in the morning closes at five the next morning
        assertEquals(t(2, 5), AutoCloseRules.cutoff(t(1, 6), LocalTime.of(5, 0), zone))
        // and one opened at four closes at five the same morning
        assertEquals(t(1, 5), AutoCloseRules.cutoff(t(1, 4), LocalTime.of(5, 0), zone))
    }

    @Test fun before_the_cut_off_nothing_happens() {
        assertNull(decide(t(1, 22), t(1, 22), t(1, 23, 50)))
    }

    @Test fun a_till_left_alone_overnight_is_closed_as_of_the_cut_off() {
        // last sale at 22:00, last touch 23:10, the app opened again at 08:00
        assertEquals(t(2, 0), decide(t(1, 22), t(1, 23, 10), t(2, 8)))
        // or the till stayed on and the minute's look came at 00:30
        assertEquals(t(2, 0), decide(t(1, 22), t(1, 23, 10), t(2, 0, 30)))
    }

    @Test fun not_quiet_for_thirty_minutes_after_the_cut_off_is_not_closed_yet() {
        assertNull(decide(t(1, 22), t(1, 23, 10), t(2, 0, 29)))
        // touched at 00:10: quiet only since then
        assertNull(decide(t(1, 22), t(2, 0, 10), t(2, 0, 39)))
    }

    @Test fun a_bar_still_selling_after_midnight_closes_thirty_minutes_after_its_last_sale() {
        // last sale 01:35, last touch 01:40, looked at 02:10
        assertEquals(t(2, 2, 5), decide(t(2, 1, 35), t(2, 1, 40), t(2, 2, 10)))
        // the stretch begins no earlier than the sale: the same when the last touch was the sale
        assertEquals(t(2, 2, 5), decide(t(2, 1, 35), t(2, 1, 35), t(2, 2, 10)))
    }

    @Test fun drinks_added_after_midnight_with_no_payment_wait_then_close_as_of_the_cut_off() {
        // tabs open, drinks added until 01:00 (touches), nothing paid since 23:20
        assertNull(decide(t(1, 23, 20), t(2, 1), t(2, 1, 20)))
        assertEquals(t(2, 0), decide(t(1, 23, 20), t(2, 1), t(2, 1, 30)))
    }

    @Test fun a_till_off_for_three_days_gets_one_closing_as_of_the_first_cut_off() {
        assertEquals(t(2, 0), decide(t(1, 20), t(1, 21), t(4, 9)))
    }

    @Test fun a_day_opened_at_ten_to_midnight_follows_the_same_rules() {
        assertEquals(t(2, 0), decide(null, t(1, 23, 50), t(2, 0, 30), dayFrom = t(1, 23, 50)))
    }

    @Test fun the_set_time_is_read_as_hours_and_minutes_only() {
        assertEquals(LocalTime.of(5, 0), AutoCloseRules.parse("05:00"))
        assertEquals(LocalTime.MIDNIGHT, AutoCloseRules.parse("00:00"))
        assertEquals(LocalTime.of(23, 59), AutoCloseRules.parse("23:59"))
        listOf(null, "", "5:00", "24:00", "00:60", "midnight", "05:00:00").forEach { assertNull(it, AutoCloseRules.parse(it)) }
        assertEquals("05:00", AutoCloseRules.format(LocalTime.of(5, 0)))
    }

    @Test fun the_settings_carry_it_or_say_it_is_off() {
        assertEquals(LocalTime.of(5, 0), PosSettings.parse("""{"autoClose":"05:00"}""").autoClose)
        assertNull(PosSettings.parse("""{"autoClose":null}""").autoClose)
        assertNull(PosSettings.parse("""{}""").autoClose)
        assertNull(PosSettings.parse("""{"autoClose":"25:00"}""").autoClose)
    }

    @Test fun the_next_person_is_told_what_happened() {
        assertEquals(
            "The day was closed automatically (2 Jan, 00:00, no. 42). The drawer was not counted. 3 orders still unpaid were carried over.",
            AutoCloseRules.notice(42, t(2, 0), 3, zone),
        )
        assertEquals("The day was closed automatically (2 Jan, 00:00, no. 7). The drawer was not counted.", AutoCloseRules.notice(7, t(2, 0), 0, zone))
        assertEquals(
            "The day was closed automatically (2 Jan, 00:00, no. 7). 1 order still unpaid was carried over.",
            AutoCloseRules.notice(7, t(2, 0), 1, zone, counted = false),
        )
    }
}
```

- [ ] **Step 2: run it**: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.AutoCloseRulesTest"` → FAIL (unresolved `AutoCloseRules`, `autoClose`).

- [ ] **Step 3: the rule.**

```kotlin
package com.restopos.core.data

import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

// When a till closes a day nobody closed, and as of what moment
// (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
//
// The cut-off is the first moment at the set time after the day began (it
// was opened, or, with no PINs, its first sale). The day closes once the
// till has been quiet for thirty minutes after the cut-off: no touch, no key
// and nothing that moved money. It is dated by money: at the cut-off when
// nothing moved money since, else thirty minutes after the last thing that
// did, never later than the stretch it was found in. Nothing is written in
// between, so the figures are the same either way.
object AutoCloseRules {
    const val QUIET_MS = 30 * 60_000L
    private val TIME = Regex("^([01][0-9]|2[0-3]):([0-5][0-9])$")

    fun parse(text: String?): LocalTime? = text?.let { TIME.matchEntire(it) }?.let { LocalTime.of(it.groupValues[1].toInt(), it.groupValues[2].toInt()) }

    fun format(at: LocalTime): String = "%02d:%02d".format(at.hour, at.minute)

    fun cutoff(dayFrom: Long, at: LocalTime, zone: ZoneId): Long {
        val start = Instant.ofEpochMilli(dayFrom).atZone(zone)
        var cut = start.toLocalDate().atTime(at).atZone(zone)
        if (!cut.isAfter(start)) cut = cut.plusDays(1)
        return cut.toInstant().toEpochMilli()
    }

    // `lastMoney`: the last sale, refund, cash in or out or count since the
    // day began, or null. `quietFrom` to `quietTo`: a stretch with no touch
    // in it. The moment to close the day as of, or null for not yet.
    fun decide(dayFrom: Long, at: LocalTime, zone: ZoneId, lastMoney: Long?, quietFrom: Long, quietTo: Long): Long? {
        val cut = cutoff(dayFrom, at, zone)
        val wrote = lastMoney?.takeIf { it > cut }
        val from = maxOf(quietFrom, cut, wrote ?: Long.MIN_VALUE)
        if (quietTo - from < QUIET_MS) return null
        return if (wrote == null) cut else minOf(wrote + QUIET_MS, quietTo)
    }

    // What the next person at the till is told, once. `counted` is false for
    // a till with no days, which has no drawer to count.
    fun notice(number: Int, at: Long, carried: Int, zone: ZoneId, counted: Boolean = true): String {
        val time = DateTimeFormatter.ofPattern("d MMM, HH:mm", Locale.UK).format(Instant.ofEpochMilli(at).atZone(zone))
        val drawer = if (counted) " The drawer was not counted." else ""
        val orders = when (carried) {
            0 -> ""
            1 -> " 1 order still unpaid was carried over."
            else -> " $carried orders still unpaid were carried over."
        }
        return "The day was closed automatically ($time, no. $number).$drawer$orders"
    }
}
```

In `PosSettings`: the field, after `loyaltyBp`:

```kotlin
    // The time each till closes a day nobody closed (server 0133), on the
    // tablet's clock; null, and a missing key, is off.
    val autoClose: java.time.LocalTime? = null,
```

and in `parse`, after `loyaltyBp = ...`:

```kotlin
                autoClose = AutoCloseRules.parse(d.str("autoClose")),
```

- [ ] **Step 4: run it** → PASS.
- [ ] **Step 5: commit** `till: when a day closes itself, as a rule held to tests`.

### Task 3: the Z of a day that closed itself

**Files:** modify `core/print/Docs.kt`; test `src/test/java/com/restopos/core/print/DocsTest.kt`.

- [ ] **Step 1: the test**, after `theDayClosingCarriesTheDrawerItWasClosedWith`:

```kotlin
    // A day the till closed by itself (AutoClose): nobody closed it and nobody
    // counted, so the Z says so in place of a count and a difference, and how
    // many unpaid orders went on into the next day.
    @Test
    fun aDayClosedAutomaticallySaysTheDrawerWasNotCounted() {
        val z = ZDoc(
            9, "T1", 1_790_000_000_000, 1_790_000_300_000, null, 6, 250000, 0, 0, 0, 32609,
            listOf(DocAmount("Cash", 250000, 6)), emptyList(), emptyList(), 0, 0, emptyList(), "S1-T1-000113", "S1-T1-000118",
            openedAt = 1_790_000_000_000, openedBy = "Asha", float = 100000, cashTaken = 250000, expected = 350000, auto = true, carried = 2,
        )
        val all = read(Docs.z(z, shop, Paper(48, 3, true), 2, detailed = true)).lines
        assertTrue(all.any { it.startsWith("Closed by") && it.endsWith("Automatically") })
        assertTrue(all.any { it.startsWith("Orders carried over") && it.endsWith("2") })
        assertTrue(all.any { it.startsWith("Expected in drawer") && it.endsWith("3,500.00") })
        assertTrue(all.any { it.startsWith("NOT COUNTED") })
        assertFalse(all.any { it.startsWith("COUNTED") })
        assertFalse(all.any { it.startsWith("Difference") || it.startsWith("SHORT") || it.startsWith("OVER") })
        assertFalse(all.any { it.startsWith("Signature") })
        // a till with no days: no drawer, but who closed it and what was carried
        val noDays = read(Docs.z(z.copy(openedAt = null, float = null, cashTaken = null, expected = null), shop, Paper(48, 3, true), 2, detailed = true)).lines
        assertFalse(noDays.any { it.contains("CASH DRAWER") })
        assertTrue(noDays.any { it.startsWith("Closed by") && it.endsWith("Automatically") })
    }
```

- [ ] **Step 2: run** `--tests "com.restopos.core.print.DocsTest"` → FAIL (no `auto`, `carried`).
- [ ] **Step 3:** in `ZDoc`, after `accounts`:

```kotlin
    // closed by the till itself at the time the business set (AutoClose):
    // nobody closed it and nobody counted the drawer
    val auto: Boolean = false,
    // orders still unpaid when it closed, which went on into the next day
    val carried: Int = 0,
```

In `Docs.z`: `d.closedBy?.let { p.row("Closed by", it) }` becomes

```kotlin
        if (d.auto) p.row("Closed by", "Automatically") else d.closedBy?.let { p.row("Closed by", it) }
```

after the no-shows block:

```kotlin
        if (d.carried > 0) p.row("Orders carried over", d.carried.toString())
```

and the drawer block:

```kotlin
        // the drawer, counted to close the day; or not, when the day closed by itself
        if (d.expected != null && (d.counted != null || d.auto)) {
            p.rule()
            p.bold(true).line("CASH DRAWER").bold(false)
            d.float?.let { p.row("Opening float", n(it)) }
            d.cashTaken?.let { p.row("Cash taken", n(it)) }
            if (d.deposits.cash != 0L) p.row("Deposit cash", n(d.deposits.cash))
            if (d.accounts.cash != 0L) p.row("Account payments cash", n(d.accounts.cash))
            p.row("Expected in drawer", n(d.expected))
            if (d.counted == null) {
                p.bold(true).line("NOT COUNTED").bold(false)
                p.line("The day closed by itself.")
            } else {
                p.bold(true).row("COUNTED", "Rs " + n(d.counted)).bold(false)
                val diff = d.counted - d.expected
                p.bold(true).row(if (diff == 0L) "Difference" else if (diff < 0) "SHORT" else "OVER", n(diff)).bold(false)
                p.feed(2)
                p.line("Signature: " + "_".repeat((paper.columns - 11).coerceAtLeast(4)))
            }
        }
```

- [ ] **Step 4: run** → PASS. **Step 5: commit** `till: the Z of a day that closed itself`.

### Task 4: closing the day by itself, in CashOps

**Files:** modify `core/data/CashOps.kt`, `core/data/StaffRepository.kt`, `core/data/ReportsRepository.kt`, `feature/reports/Views.kt`, `feature/reports/Print.kt`.

No unit test: `CashOps` needs Room. It is seen on the emulator (Task 11).

- [ ] **Step 1:** `withDrawer` reads a shift with no closer and no count as one that closed itself:

```kotlin
    private suspend fun ZDoc.withDrawer(shift: ShiftEntity?): ZDoc {
        val expected = shift?.expected_cash ?: return this
        val sp = period(shift.device_id, shift.opened_at - 1, shift.closed_at ?: to)
        // closed by itself (AutoClose): nobody closed it, nobody counted
        if (shift.closed_by == null && shift.counted_cash == null) {
            return copy(openedAt = shift.opened_at, openedBy = name(shift.opened_by), float = shift.opening_float, cashTaken = sp.cashTaken, expected = expected, counted = null, auto = true)
        }
        val counted = shift.counted_cash ?: return this
        return copy(openedAt = shift.opened_at, openedBy = name(shift.opened_by), float = shift.opening_float, cashTaken = sp.cashTaken, expected = expected, counted = counted)
    }
```

- [ ] **Step 2:** `dayCloseOp` carries the two marks in `totals`, after the no-shows line:

```kotlin
            if (z.auto) put("auto", true)
            if (z.carried > 0) put("carried", z.carried)
```

- [ ] **Step 3:** the closing itself, after `closeDayAsked`:

```kotlin
    // ---- the day closed by itself (AutoClose, server 0133) ----

    // The last thing on this till since `since` that moved money or counted
    // it: a sale, a refund, cash in or out, a drawer count. The drawer opened
    // with no sale moved nothing. Null: nothing.
    suspend fun lastWritten(since: Long): Long? {
        val device = session.deviceId() ?: return null
        val now = System.currentTimeMillis()
        val shift = db.staff().openShift(device)
        return listOfNotNull(
            db.ops().receiptsBetween(device, since, now).maxOfOrNull { it.device_time },
            db.ops().cashMoves(device, since, now).filter { it.type != "drawer" }.maxOfOrNull { it.device_time },
            shift?.let { s -> db.ops().drawerCounts(s.id).maxOfOrNull { it.device_time } },
        ).maxOrNull()
    }

    // When the sales no closing covers began, with no day open (see
    // unclosed); null when there are none.
    suspend fun unclosedSince(): Long? {
        val device = session.deviceId() ?: return null
        if (db.staff().openShift(device) != null) return null
        return db.ops().receiptsBetween(device, db.ops().lastDayClose(device)?.closed_at ?: 0, System.currentTimeMillis()).firstOrNull()?.device_time
    }

    // The day closed by the till itself at the time its business set: what
    // closeDay does, as of `at`, with nobody closing it and the drawer not
    // counted. Orders still unpaid go on into the next day. The two ops carry
    // no employee: whoever is signed in may not be allowed to close a day,
    // and an op the server refuses is set aside for good; with none, the
    // server takes them as the till's own login's. shift.close carries what
    // the till expected as its count, for a server without 0133, which needs
    // one; 0133 keeps none. The Z prints if a printer answers: nobody is
    // there to be told when it does not, and it is under Day closing.
    suspend fun closeDayAuto(at: Long): ZDoc {
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val open = db.staff().openShift(device) ?: error("The day is not open")
        val expected = expectedCash(open, at)
        val closed = open.copy(closed_by = null, closed_at = at, counted_cash = null, expected_cash = expected)
        val last = db.ops().lastDayClose(device)
        val carried = db.tickets().unpaidOrderCount().toInt()
        val z = dayDoc(at, by = null).withDrawer(closed).copy(carried = carried)
        val row = DayCloseEntity(Uuid7.next(), tenant, store, device, z.number, null, last?.closed_at, at)
        val leaving = stillIn(store, device)
        db.withTransaction {
            clockOut(leaving, tenant, store, device, at)
            db.staff().upsertShifts(listOf(closed))
            db.ops().upsertDayCloses(listOf(row))
            db.outbox().enqueue(OutboxEntity(Uuid7.next(), "shift.close", buildJsonObject {
                put("id", closed.id); put("counted_cash", expected); put("auto", true)
                put("closed_at", Instant.ofEpochMilli(at).toString())
            }.toString(), employee_id = null))
            db.outbox().enqueue(dayCloseOp(row, z, null).copy(employee_id = null))
        }
        session.dayClosed()
        pushNow(context)
        printing.scope.launch { runCatching { printZ(z) } }
        return z
    }

    // The same for a till with no days (no PINs, see unclosed): its sales
    // closed as of `at`, with nobody closing them; unpaid orders go on.
    suspend fun closeUnclosedAuto(at: Long): ZDoc {
        val tenant = session.tenantId() ?: error("no tenant")
        val store = session.storeId() ?: error("no store")
        val device = session.deviceId() ?: error("no device")
        val last = db.ops().lastDayClose(device)
        val carried = db.tickets().unpaidOrderCount().toInt()
        val z = dayDoc(at, by = null).copy(auto = true, carried = carried)
        val row = DayCloseEntity(Uuid7.next(), tenant, store, device, z.number, null, last?.closed_at, at)
        db.withTransaction {
            db.ops().upsertDayCloses(listOf(row))
            db.outbox().enqueue(dayCloseOp(row, z, null).copy(employee_id = null))
        }
        session.dayClosed()
        pushNow(context)
        printing.scope.launch { runCatching { printZ(z) } }
        return z
    }
```

- [ ] **Step 4:** `StaffRepository.suggestedFloat`: a day that closed itself has no count; what it expected stands in:

```kotlin
        return db.staff().lastClosedShift(device)?.let { it.counted_cash ?: it.expected_cash } ?: 0
```

- [ ] **Step 5:** reports. `ReportsRepository.ShiftRow` gains `val auto: Boolean = false`, and `days()` builds it with

```kotlin
            val auto = shift != null && shift.closed_by == null && shift.counted_cash == null
            ShiftRow(row, shift?.opened_at, cash.employeeName(shift?.opened_by), if (auto) "Automatically" else cash.employeeName(row.closed_by), shift?.opening_float, shift?.expected_cash, shift?.counted_cash, auto)
```

`Views.kt` `Shifts`: the label is `when { s.auto -> "Not counted"; diff == null -> ""; ... }`. `DaySheet`: after the float line,

```kotlin
        if (z.auto) Line("Counted", "Not counted: the day closed by itself")
```

`Print.kt` `Report.Shifts`: after the float line, `if (s.auto) add(ReportLine("Counted", "Not counted"))`.

- [ ] **Step 6:** `android/gradlew -p android :app:compileDebugKotlin` → BUILD SUCCESSFUL; all unit tests `:app:testDebugUnitTest` → PASS. **Commit** `till: closing a day by itself, with no count and nobody closing it`.

### Task 5: AutoClose, the till looking every minute

**Files:** create `core/data/AutoClose.kt`; modify `core/sync/Sync.kt` (`SessionStore`), `app/RestoPosApp.kt`, `app/MainActivity.kt`, `feature/main/MainShell.kt`.

- [ ] **Step 1:** `SessionStore`, beside `lastUse`:

```kotlin
private val AUTO_CLOSED = stringPreferencesKey("auto_closed")
...
    // What the till did when it closed a day by itself (AutoClose), kept
    // until the next person in has been told: a restart does not lose it.
    suspend fun autoClosed(): String? = store.data.map { it[AUTO_CLOSED] }.first()
    suspend fun setAutoClosed(text: String?) { store.edit { if (text == null) it.remove(AUTO_CLOSED) else it[AUTO_CLOSED] = text } }
```

- [ ] **Step 2:** `core/data/AutoClose.kt`:

```kotlin
package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.time.ZoneId
import javax.inject.Inject
import javax.inject.Singleton

// A day nobody closed is closed by the till at the time its business set
// (AutoCloseRules has when, and as of what moment). Looked at from the
// moment the app is up, every minute, and at the first touch after a quiet
// stretch: a till left alone overnight, asleep or with the app closed, finds
// its quiet stretch when it is next touched or started. Nothing here hangs
// off a sync: an offline tablet does it too.
@Singleton
class AutoClose @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val cash: CashOps,
    private val sell: SellCheck,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val lock = Mutex()
    private var job: Job? = null
    private val startedAt = System.currentTimeMillis()
    // the last touch, key or scan in this run of the app
    @Volatile private var quietSince = startedAt
    private val first = CompletableDeferred<Unit>()

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            // the stretch before this run of the app: from the last touch it
            // wrote down (MainActivity, once a minute) to now. One written
            // since the app started is this run's, and already in quietSince.
            val before = session.lastUse()?.takeIf { it < startedAt } ?: startedAt
            runCatching { look(before, startedAt) }
            first.complete(Unit)
            while (isActive) {
                delay(60_000)
                runCatching { look(quietSince, System.currentTimeMillis()) }
            }
        }
    }

    // A touch, a key, a scan, the app back in front: the quiet that ends here
    // is looked at first, then a new one starts.
    fun touched(now: Long) {
        val from = quietSince
        quietSince = now
        if (now - from >= AutoCloseRules.QUIET_MS) scope.launch { runCatching { look(from, now) } }
    }

    // A sign-in waits, a few seconds at most, for the look made as the app
    // started: the day left open last night is closed before anyone sells.
    suspend fun settled() { withTimeoutOrNull(5_000) { first.await() } }

    // The day closed if this quiet stretch closes it. Internal for the debug
    // build's DEMO_NIGHT, which looks at a stretch it names.
    internal suspend fun look(quietFrom: Long, quietTo: Long) = lock.withLock {
        val at = PosSettings.parse(db.ops().settings()).autoClose ?: return@withLock
        val device = session.deviceId() ?: return@withLock
        val open = db.staff().openShift(device)
        val dayFrom = open?.opened_at ?: cash.unclosedSince() ?: return@withLock
        val zone = ZoneId.systemDefault()
        val moment = AutoCloseRules.decide(dayFrom, at, zone, cash.lastWritten(dayFrom), quietFrom, quietTo)
            ?.coerceAtMost(System.currentTimeMillis()) ?: return@withLock
        sell.closing(true)
        try {
            val z = if (open != null) cash.closeDayAuto(moment) else cash.closeUnclosedAuto(moment)
            session.setAutoClosed(AutoCloseRules.notice(z.number, moment, z.carried, zone, counted = open != null))
        } finally {
            sell.closing(false)
        }
    }
}
```

- [ ] **Step 3:** `RestoPosApp`: `@Inject lateinit var autoClose: com.restopos.core.data.AutoClose` and, after `dueReminders.start()`,

```kotlin
        // A day nobody closed is closed at the time the business set, from the
        // moment the app is up, whichever screen is open (AutoClose).
        autoClose.start()
```

`MainActivity`: `@Inject lateinit var autoClose: com.restopos.core.data.AutoClose`; in `used()`, before `seen = now`: `autoClose.touched(now)`.

- [ ] **Step 4:** `ShellViewModel` injects `SessionStore` already; add

```kotlin
    // A day this till closed by itself, said once to whoever comes in next (AutoClose).
    fun autoClosed(say: (String) -> Unit) = viewModelScope.launch {
        session.autoClosed()?.let { session.setAutoClosed(null); say(it) }
    }
```

and in `MainShell`, after the `asked` lines: `LaunchedEffect(Unit) { shell.autoClosed { Toaster.say(it) } }`.

- [ ] **Step 5:** `StaffViewModel` injects `AutoClose`; `signIn`, `clockIn` and the new `lookOnly` (Task 7) call `autoClose.settled()` first.

- [ ] **Step 6:** compile, all unit tests. **Commit** `till: the day closes itself at the time the business set`.

### Task 6: the gate, and Look only in the data

**Files:** create `core/data/SellGate.kt`, `core/data/SellCheck.kt`, `src/test/java/com/restopos/core/data/SellGateTest.kt`; modify `core/data/StaffRepository.kt` (`StaffSession`), the `op()` helpers.

- [ ] **Step 1: the test.**

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Whether the till takes orders and money now, and what gets it going
// (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md, Look only).
class SellGateTest {
    @Test fun a_till_with_no_pins_has_no_days_and_always_sells() {
        assertNull(SellGate.why(usesDays = false, dayOpen = false, lookOnly = false, mayOpen = false))
        assertNull(SellGate.why(usesDays = false, dayOpen = false, lookOnly = false, mayOpen = false, closing = true))
    }

    @Test fun clocked_in_with_the_day_open_it_sells() {
        assertNull(SellGate.why(usesDays = true, dayOpen = true, lookOnly = false, mayOpen = false))
    }

    @Test fun clocked_in_with_no_day_open_it_offers_to_open_it_to_whoever_may() {
        assertEquals(Blocked(SellGate.NOT_OPEN, Offer.OpenDay), SellGate.why(usesDays = true, dayOpen = false, lookOnly = false, mayOpen = true))
        assertEquals(Blocked(SellGate.NOT_OPEN_ASK, Offer.None), SellGate.why(usesDays = true, dayOpen = false, lookOnly = false, mayOpen = false))
    }

    @Test fun in_to_look_it_offers_to_clock_in_open_day_or_not() {
        assertEquals(Blocked(SellGate.LOOKING, Offer.ClockIn), SellGate.why(usesDays = true, dayOpen = false, lookOnly = true, mayOpen = true))
        assertEquals(Blocked(SellGate.LOOKING, Offer.ClockIn), SellGate.why(usesDays = true, dayOpen = true, lookOnly = true, mayOpen = false))
    }

    @Test fun while_the_day_closes_itself_nothing_is_sold() {
        assertEquals(Blocked(SellGate.CLOSING, Offer.None), SellGate.why(usesDays = true, dayOpen = true, lookOnly = false, mayOpen = true, closing = true))
    }

    @Test fun what_is_held_back_is_what_takes_an_order_or_moves_money() {
        listOf("ticket.create", "ticket.add_line", "ticket.send", "ticket.void_line", "receipt.create", "refund.create", "cash.move",
            "drawer.count", "payment.correct", "deposit.pay", "account.pay").forEach { assertTrue(it, it in SellGate.SELLING) }
        listOf("customer.upsert", "item.set_available", "stock.adjust", "kitchen.mark", "shift.close", "day.close", "timeclock.punch",
            "settings.save", "booking.upsert").forEach { assertTrue(it, it !in SellGate.SELLING) }
    }
}
```

- [ ] **Step 2: run** → FAIL. **Step 3:** `core/data/SellGate.kt`:

```kotlin
package com.restopos.core.data

// Whether this till takes orders and money now, and if not, why and what
// gets it going (docs/superpowers/specs/2026-10-21-auto-close-and-look-only-design.md).
// A till with no PINs has no days, and sells. Otherwise it sells while its
// day is open, to someone who came in by clocking in. Someone in to look
// only, a day not open, or a day closing itself at this moment, waits.
data class Blocked(val text: String, val offer: Offer)

enum class Offer { OpenDay, ClockIn, None }

class NotSelling(val blocked: Blocked) : Exception(blocked.text)

object SellGate {
    const val CLOSING = "The day is closing by itself. Try again in a moment."
    const val LOOKING = "You came in to look. Clock in to take orders."
    const val NOT_OPEN = "The day is not open."
    const val NOT_OPEN_ASK = "The day is not open. Someone allowed to open it has to."

    // What takes an order or moves money: the ops held back while the gate
    // is shut. Customers, the menu, stock, bookings, settings and the
    // kitchen go on.
    val SELLING = setOf(
        "ticket.create", "ticket.add_line", "ticket.edit_line", "ticket.void_line", "ticket.cancel", "ticket.update_meta",
        "ticket.merge", "ticket.move_lines", "ticket.place_lines", "ticket.split_line", "ticket.split_merge", "ticket.stage", "ticket.send",
        "receipt.create", "refund.create", "payment.correct", "cash.move", "drawer.count",
        "deposit.create", "deposit.pay", "deposit.give_back", "deposit.cancel", "account.pay",
    )

    fun why(usesDays: Boolean, dayOpen: Boolean, lookOnly: Boolean, mayOpen: Boolean, closing: Boolean = false): Blocked? = when {
        !usesDays -> null
        closing -> Blocked(CLOSING, Offer.None)
        lookOnly -> Blocked(LOOKING, Offer.ClockIn)
        !dayOpen -> if (mayOpen) Blocked(NOT_OPEN, Offer.OpenDay) else Blocked(NOT_OPEN_ASK, Offer.None)
        else -> null
    }
}
```

- [ ] **Step 4:** `StaffSession` keeps who came in to look:

```kotlin
    // In to look only (the start screen's Look only, with no clocking in):
    // nothing that takes an order or moves money until they clock in (SellGate).
    private val _lookOnly = MutableStateFlow(false)
    val lookOnly: StateFlow<Boolean> = _lookOnly
    fun signIn(member: StaffMember, lookOnly: Boolean = false) { _lookOnly.value = lookOnly; _current.value = member }
    fun signOut() { _current.value = null; _lookOnly.value = false }
```

- [ ] **Step 5:** `core/data/SellCheck.kt`:

```kotlin
package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import javax.inject.Inject
import javax.inject.Singleton

// The gate (SellGate) as this till stands: the strip along the top of the
// till reads `blocked`; every op helper that writes an order or money calls
// check, which reads the day afresh and refuses with NotSelling, so no
// screen can get past it, missed in a list or not.
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
@Singleton
class SellCheck @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val staff: StaffSession,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val closing = MutableStateFlow(false)
    fun closing(on: Boolean) { closing.value = on }

    // whether anyone here has a PIN: until then the till has no days (StartScreen)
    private val usesDays: StateFlow<Boolean?> = flow { emit(session.storeId()) }
        .flatMapLatest { s -> if (s == null) flowOf(false) else db.staff().staff(s).map { list -> list.any { it.pin_hash != null } } }
        .stateIn(scope, SharingStarted.Eagerly, null)
    private val dayOpen = flow { emit(session.deviceId()) }
        .flatMapLatest { d -> if (d == null) flowOf(false) else db.staff().openShiftFlow(d).map { it != null } }

    // what the strip says, or null while the till sells
    val blocked: StateFlow<Blocked?> = combine(usesDays, dayOpen, staff.current, staff.lookOnly, closing) { uses, open, who, look, shut ->
        SellGate.why(uses ?: false, open, look, who?.can("shift.open_close") == true, shut)
    }.stateIn(scope, SharingStarted.Eagerly, null)

    // Before an op is written. Whether PINs are in use is taken from what was
    // last read (a PIN set or cleared is rare); the day is read now. Not yet
    // read is taken for PINs in use: the day decides.
    suspend fun check(type: String) {
        if (type !in SellGate.SELLING) return
        val device = session.deviceId() ?: return
        val b = SellGate.why(
            usesDays.value ?: true, db.staff().openShift(device) != null, staff.lookOnly.value,
            staff.current.value?.can("shift.open_close") == true, closing.value,
        )
        if (b != null) throw NotSelling(b)
    }
}
```

- [ ] **Step 6:** every `op()` helper that can write a selling op calls it. In `TicketRepository`, `OrderOps`, `RetailSales`, `Deposits`, `Accounts`: inject `private val sell: SellCheck` and make the helper

```kotlin
    // every op carries who was signed in at the till when it was made; one that takes an order or moves money waits for the gate (SellCheck)
    private suspend fun op(type: String, payload: JsonObject): OutboxEntity {
        sell.check(type)
        return OutboxEntity(Uuid7.next(), type, payload.toString(), employee_id = staff.id())
    }
```

(`TicketRepository` keeps its fully qualified `com.restopos.core.database.OutboxEntity`.) `CashOps`: the same for its `op()`; and `openDrawer` checks before the drawer is kicked open: `sell.check("cash.move")` after `staff.allow(...)`. A call site the compiler then refuses (a helper called outside a suspend function) is made suspend in turn; every one found by grep is inside a `suspend fun` or a `db.withTransaction {}` block.
`TillRequests`' `cashOutAsked` and `closeDayAsked` write their ops directly, not through `op()`: the back office's requests are not held back.

- [ ] **Step 7:** compile; all unit tests. **Commit** `till: nothing that takes an order or moves money while the day is not open or someone is in to look`.

### Task 7: Look only on the start screen and the strip

**Files:** modify `feature/staff/StaffViewModel.kt`, `feature/start/StartScreen.kt`, `feature/staff/ClockScreen.kt`, `feature/main/MainShell.kt`.

- [ ] **Step 1:** `StaffViewModel`:

```kotlin
    // In to look, with no clocking in and no day open: everything that takes
    // no order and moves no money, as their role allows (SellGate).
    fun lookOnly(member: StaffMember, then: () -> Unit) = viewModelScope.launch {
        autoClose.settled()
        session.setPendingDiscount(null)
        staffSession.signIn(member, lookOnly = true)
        then()
    }
```

`clockIn`: someone who may not open the day is let in (the strip says the day is not open), in place of being turned away:

```kotlin
                when {
                    open != null -> { session.setPendingDiscount(null); staffSession.signIn(member); toRegister() }
                    member.can("shift.open_close") -> offerOpen()
                    else -> { session.setPendingDiscount(null); staffSession.signIn(member); toRegister() }
                }
```

- [ ] **Step 2:** `StartScreen`. State: `var lookPick by remember { mutableStateOf(false) }`, `var lookPin by remember { mutableStateOf<StaffMember?>(null) }`, `var openOrLook by remember { mutableStateOf<StaffMember?>(null) }`. `Closed(...)` gains `onLook: (() -> Unit)? = null`, shown under the big button as a text key "Look only" (`Pos.NavOn`, 15.sp, Medium, as "Sign in" is); the "nobody clocked in" call passes `onLook = { lookPick = true }`, the no-PIN one passes nothing. `Users(...)` gains `onLook: () -> Unit`, a text key "Look only" beside "Clock in/out". The PIN of a clocked-in person:

```kotlin
                when {
                    shift != null -> vm.signIn(member, onOpen)
                    member.can("shift.open_close") -> openOrLook = member
                    // the day is not open and they may not open it: in all the same, and the strip says so
                    else -> vm.signIn(member, onOpen)
                }
```

The three dialogs:

```kotlin
    // Look only: everyone with a PIN, clocked in or not
    if (lookPick) {
        AlertDialog(
            onDismissRequest = { lookPick = false },
            title = { Text("Look only") },
            text = {
                Column(Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState())) {
                    Text("Check something without opening the day or clocking in. Nothing can be sold or paid until you clock in.", Modifier.padding(bottom = 12.dp))
                    all.orEmpty().filter { it.hasPin }.forEach { m ->
                        Text(m.employee.name, Modifier.fillMaxWidth().clickable { lookPick = false; lookPin = m }.padding(vertical = 12.dp), fontSize = 17.sp)
                    }
                }
            },
            confirmButton = {},
            dismissButton = { OutlinedButton(onClick = { lookPick = false }) { Text("Cancel") } },
        )
    }
    lookPin?.let { member ->
        PinPad(member, check = { vm.checkPin(member, it) }, onOk = { lookPin = null; vm.lookOnly(member, onOpen) }, onDismiss = { lookPin = null })
    }
    // someone who may open the day: open it, or look first
    openOrLook?.let { member ->
        AlertDialog(
            onDismissRequest = { openOrLook = null },
            title = { Text("The day is not open") },
            text = { Text("Opening it counts the cash in the drawer, and the till sells from then on. Look only lets you in to check something first: nothing is sold until the day is open.") },
            confirmButton = { Button(onClick = { openOrLook = null; vm.signIn(member, onCashCount) }) { Text("Open the day") } },
            dismissButton = { OutlinedButton(onClick = { openOrLook = null; vm.signIn(member, onOpen) }) { Text("Look only") } },
        )
    }
```

- [ ] **Step 3:** `ClockScreen`: the dialog's "Not now" becomes "Look only": `OutlinedButton(onClick = { openFor = null; vm.signIn(member, onRegister) }) { Text("Look only") }`.

- [ ] **Step 4:** `ShellViewModel` injects `SellCheck`:

```kotlin
    // what holds the till back from selling now, for the strip (SellGate)
    val blocked: StateFlow<com.restopos.core.data.Blocked?> = sell.blocked

    // Clock in from the strip, after Look only: as at the start screen, then
    // on to open the day when it is not open and they may (then(true)).
    fun clockIn(then: (Boolean) -> Unit) = viewModelScope.launch {
        val who = staff.current.value ?: return@launch
        staffRepo.punch(who, "in").onFailure { Toaster.say(it.message); return@launch }
        staff.signIn(who.copy(clockedInAt = System.currentTimeMillis()), lookOnly = false)
        val device = session.deviceId()
        val open = device != null && db.staff().openShift(device) != null
        then(!open && who.can("shift.open_close"))
    }
```

`MainShell`: after `if (settingUp) SettingUpStrip { ... }`:

```kotlin
            val blocked by shell.blocked.collectAsState()
            blocked?.let { b -> DayStrip(b, onOpenDay = onOpenPeriod, onClockIn = { shell.clockIn { open -> if (open) onOpenPeriod() } }) }
```

and beside `SettingUpStrip`:

```kotlin
// What holds the till back from selling (SellGate): the day not open, or
// someone in to look only. The way out is on the strip.
@Composable
private fun DayStrip(b: com.restopos.core.data.Blocked, onOpenDay: () -> Unit, onClockIn: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(V.AmberWash).padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        T(b.text, 13.sp, 600, V.AmberText, Modifier.weight(1f), lines = 2)
        when (b.offer) {
            com.restopos.core.data.Offer.OpenDay -> VBtn("Open the day", height = 34.dp, radius = 10.dp, size = 14.sp, onClick = onOpenDay)
            com.restopos.core.data.Offer.ClockIn -> VBtn("Clock in", height = 34.dp, radius = 10.dp, size = 14.sp, onClick = onClockIn)
            com.restopos.core.data.Offer.None -> Unit
        }
    }
}
```

A blocked action says why through the screen's own message (`NotSelling`'s text), as any refusal does; the strip carries the way out.

- [ ] **Step 5:** compile, unit tests, debug build `:app:assembleDebug`. **Commit** `till: Look only, and the strip that says why the till does not sell`.

### Task 8: the setting on the tablet

**Files:** modify `core/data/OfficePayloads.kt`, `core/data/Service.kt`, `core/data/LocalAnswers.kt`, `feature/settings/BusinessPages.kt`, `feature/settings/SettingsScreen.kt`.

- [ ] **Step 1:** `OfficePayloads`:

```kotlin
    // The time each till closes a day nobody closed, "HH:MM", or null for off (server 0133).
    fun autoCloseSave(at: String?, approvedBy: String?): JsonObject = buildJsonObject {
        put("autoClose", at)
        approvedBy?.let { put("approved_by", it) }
    }
```

`Service`:

```kotlin
    // The time each till closes a day nobody closed (server 0133): "HH:MM",
    // or null for off. The same for every till of the business.
    suspend fun saveAutoClose(at: String?, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the settings", approver)
        ask("settings.save", { code ->
            when (code) {
                "bad-value" -> "Type the time as HH:MM, from 00:00 to 23:59."
                "forbidden" -> "You are not allowed to change the settings. Ask a manager."
                "unknown-op" -> "The server has to be updated before this can be changed from a till."
                null -> "The server refused it."
                else -> "The server refused it ($code)."
            }
        }, OfficePayloads.autoCloseSave(at, staff.approvedBy("settings.device", approver)))
    }
```

`LocalAnswers.settingsSave`, before `if (patch.isNotEmpty())`:

```kotlin
        // the time each till closes a day nobody closed (0133): "HH:MM", or null for off
        if ("autoClose" in p) {
            val v = p["autoClose"]
            patch = if (v == null || v is JsonNull) JsonObject(patch + ("autoClose" to JsonNull))
            else {
                val s = p.str("autoClose")
                if (s == null || AutoCloseRules.parse(s) == null) throw Refused("bad-value")
                JsonObject(patch + ("autoClose" to JsonPrimitive(s)))
            }
        }
```

- [ ] **Step 2:** `BusinessViewModel`:

```kotlin
    // the time each till closes a day nobody closed (0133): off, or a time
    fun saveAutoClose(was: java.time.LocalTime?, on: Boolean, time: String) {
        val at = if (!on) null else AutoCloseRules.parse(time.trim())
            ?: run { Toaster.say("Type the time as HH:MM, from 00:00 to 23:59"); return }
        if (at == was) { Toaster.say("Nothing was changed."); return }
        go("Saved. Every till of the business takes it.", {}) { by -> service.saveAutoClose(at?.let { AutoCloseRules.format(it) }, by) }
    }
```

and the panel:

```kotlin
// ---- Settings > Cash drawer: the day closing by itself (0133, every business) ----
@Composable
internal fun AutoClosePanel(vm: BusinessViewModel = hiltViewModel()) {
    val st by vm.settings.collectAsState()
    val busy by vm.busy.collectAsState()
    var on by remember(st.autoClose) { mutableStateOf(st.autoClose != null) }
    var time by remember(st.autoClose) { mutableStateOf(st.autoClose?.let { AutoCloseRules.format(it) } ?: "00:00") }
    Note("A day nobody closed is closed by the till at this time, as of this time. The drawer is marked not counted, and orders still unpaid go on into the next day. Open past midnight? Pick an hour when you are closed, 05:00 say. The same for every till of the business.")
    Panel {
        Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Choice("Close the day automatically", listOf("on" to "On", "off" to "Off"), if (on) "on" else "off") { on = it == "on" }
            if (on) Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f)) {
                    T("At", 15.sp, 700)
                    T("HH:MM, on the tablet's clock.", 13.sp, 500, V.Text2)
                }
                Field(time, { v -> time = v.filter { it.isDigit() || it == ':' }.take(5) }, "00:00", Modifier.fillMaxWidth(0.25f), height = 50.dp, size = 17.sp)
            }
        }
    }
    Row { VBtn(if (busy) "Saving..." else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { vm.saveAutoClose(st.autoClose, on, time) } }
}
```

`SettingsScreen.CashPage`: at its end, `Heading("Close the day automatically")` then `AutoClosePanel()`.

- [ ] **Step 3:** compile, unit tests. **Commit** `till: the day's closing time, set from the tablet too (an offline tablet has nowhere else)`.

### Task 9: DEMO_NIGHT, for the emulator

**Files:** `src/debug/java/com/restopos/debug/DemoReceiver.kt`, `src/debug/AndroidManifest.xml`.

- [ ] **Step 1:** the action `com.restopos.app.DEMO_NIGHT` in the manifest's filter and `NIGHT` in the companion; `Deps` gains `fun autoClose(): com.restopos.core.data.AutoClose`; in `onReceive`, beside `PULL`:

```kotlin
                } else if (intent.action == NIGHT) {
                    // A quiet stretch, as if the till had been left alone: the
                    // day closes if it closes it (AutoClose). Times in minutes from now, either side.
                    //   adb shell am broadcast -n com.restopos.app/com.restopos.debug.DemoReceiver -a com.restopos.app.DEMO_NIGHT --ei from -5 --ei to 31
                    // Only on the made-up business.
                    val shop = Json.parseToJsonElement(context.assets.open("demo-shop.json").bufferedReader().use { it.readText() })
                    if (deps.session().tenantId() != shop.str("tenant")) Log.w(TAG, "refused: this tablet is not the made-up business")
                    else {
                        val now = System.currentTimeMillis()
                        deps.autoClose().look(now + intent.getIntExtra("from", 0) * 60_000L, now + intent.getIntExtra("to", 31) * 60_000L)
                        Log.i(TAG, "night looked at")
                    }
```

`look` is internal and the debug source set is the same module: it is reachable.

- [ ] **Step 2:** `:app:assembleDebug`. **Commit** `till (debug): DEMO_NIGHT, a quiet stretch on the emulator`.

### Task 10: the back office

**Files:** `web/lib/settings.ts`, `web/app/backoffice/settings/page.tsx`, `web/lib/pos.ts`, `web/app/backoffice/reports/day-close/page.tsx`, `web/lib/pos.test.mjs`, create `web/lib/settings.test.mjs`.

- [ ] **Step 1: tests.** `web/lib/settings.test.mjs`:

```js
// settings.test.mjs — what the settings say when read (web/lib/settings.ts).
// Usage: node web/lib/settings.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { AUTO_CLOSE_TIME, withDefaults } from "./settings.ts";

let failures = 0;
function check(name, fn) {
  try { fn(); console.log("PASS " + name); } catch (e) { failures += 1; console.log("FAIL " + name + " " + e.message); }
}

check("the day closes by itself at a time, or not at all", () => {
  assert.equal(withDefaults({}).autoClose, null);
  assert.equal(withDefaults({ autoClose: "05:00" }).autoClose, "05:00");
  assert.equal(withDefaults({ autoClose: null }).autoClose, null);
  for (const bad of ["24:00", "5:00", "00:60", 5, "midnight"]) assert.equal(withDefaults({ autoClose: bad }).autoClose, null, String(bad));
  assert.ok(AUTO_CLOSE_TIME.test("23:59") && !AUTO_CLOSE_TIME.test("23:5"));
});

console.log(failures === 0 ? "ALL PASS" : failures + " FAILED");
process.exit(failures === 0 ? 0 : 1);
```

`web/lib/pos.test.mjs`, a check (and `AUTO_CLOSE_BUILD` in its import):

```js
check("a day that closed by itself says so, with no count", () => {
  const m = (v) => "Rs " + v;
  const e = { at: "2026-01-02T00:00:00Z", kind: "close", device_id: TILL, till: "T1", code: "T1", who: null, ref: "42", words: "auto", amount: null, extra: null, late: 0 };
  assert.equal(eventDetail(e, m), "Day closing no. 42, closed automatically. Drawer not counted");
  assert.equal(AUTO_CLOSE_BUILD, 35);
});
```

- [ ] **Step 2: run** `node web/lib/settings.test.mjs` and `node web/lib/pos.test.mjs` → FAIL.
- [ ] **Step 3: settings.** `web/lib/settings.ts`: in `PosSettings`, `// the time each till closes a day nobody closed, "HH:MM" (0133); null is off` `autoClose: string | null;`; in `DEFAULT_SETTINGS` `autoClose: null,`; `export const AUTO_CLOSE_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;`; in `withDefaults` `autoClose: typeof d.autoClose === "string" && AUTO_CLOSE_TIME.test(d.autoClose) ? d.autoClose : null,`.
  `web/lib/pos.ts`: `export const AUTO_CLOSE_BUILD = 35;` (the first build of the till that closes its day by itself) beside `REQUEST_BUILD`; in `ACTIVITY` the `close` row's `words` is `case when dc.totals->>'auto' = 'true' then 'auto' end`; `eventDetail`:

```ts
    case "close": return `Day closing no. ${e.ref}` + (e.words === "auto" ? ", closed automatically. Drawer not counted" : e.amount !== null && e.extra !== null ? `. ${counted()}` : "");
```

  `DAYS` and `CLOSURES`: `cb.name as closed_by` becomes `coalesce(cb.name, case when sh.closed_at is not null and sh.closed_by is null and sh.counted_cash is null then 'Automatically' end) as closed_by`.
- [ ] **Step 4: the settings page.** `saveGeneral`, after `lockMinutes`:

```ts
      // the time each till closes a day nobody closed (0133); a form from before the setting leaves it as it is
      ...(f.has("autoCloseAt") ? { autoClose: autoClose(f) } : {}),
```

with, beside `loyaltyBp`:

```ts
// The day closing by itself (0133): off, or the time typed as HH:MM.
function autoClose(f: FormData): string | null {
  if (!on(f, "autoCloseOn")) return null;
  const t = String(f.get("autoCloseAt") ?? "").trim();
  if (!AUTO_CLOSE_TIME.test(t)) throw new Refused("Type the time the day closes as HH:MM, from 00:00 to 23:59.");
  return t;
}
```

The loader reads the tills on a build that does not close itself (known, active, older):

```ts
    oldTills: (
      await c.query(
        `select d.name from pos_devices d join device_activity a on a.tenant_id = d.tenant_id and a.device_id = d.id
          where d.tenant_id = $1 and d.deleted_at is null and a.till_version is not null and a.till_version < $2 order by d.name`,
        [ctx.tenantId, AUTO_CLOSE_BUILD],
      )
    ).rows.map((r) => r.name as string),
```

and the "Closing the day" card gains, first:

```tsx
            <div className="setting">
              <div>
                <strong>Close the day automatically</strong>
                <small>
                  A day nobody closed is closed by the till at this time, as of this time. The drawer is marked not counted, and
                  orders still unpaid go on into the next day. Open past midnight? Pick an hour when you are closed, 05:00 say.
                  {data.oldTills.length > 0 && ` Not on ${data.oldTills.join(", ")} until ${data.oldTills.length === 1 ? "it is" : "they are"} updated.`}
                </small>
              </div>
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <label className="check" style={{ margin: 0 }}>
                  <input type="checkbox" name="autoCloseOn" defaultChecked={s.autoClose !== null} />
                  On, at
                </label>
                <input type="time" name="autoCloseAt" defaultValue={s.autoClose ?? "00:00"} className="narrow" aria-label="Close the day at" />
              </div>
            </div>
```

- [ ] **Step 5: the Day closing report.** In `closedSql`'s select: `dc.totals->>'auto' = 'true' as auto, coalesce((dc.totals->>'carried')::int, 0) as carried,`; `Close` gains `auto: boolean; carried: number;`. The card head: `{z.auto ? ", automatically" : z.closed_by ? ` by ${z.closed_by}` : ""}` after the closed time; the Sales list, after the no-shows: `{z.carried > 0 && (<><dt>Orders carried to the next day</dt><dd>{z.carried}</dd></>)}`; the drawer's Counted: `{w.counted === null ? (z.auto ? "Not counted (closed automatically)" : "") : m(w.counted)}`.
- [ ] **Step 6:** run both test files → ALL PASS; `npm --prefix web run typecheck` → no errors; `node db/tests/pos-pages.test.cjs` (draws the till pages, reports included) → ALL PASS. **Commit** `back office: the day closing by itself, set in POS settings and said everywhere a closing shows`.

### Task 11: seen on the emulator

Read `[[restopos-emulator-is-shared]]` whole first, and follow it (check the screen before every tap; say "I need to shadow" first; no Gradle while it runs).

- [ ] Install the debug build over what is there; the made-up restaurant (DEMO_SHOP if the tablet was never set up).
- [ ] Set the closing time on the tablet (Settings, Cash drawer), on the minute ahead.
- [ ] Open the day; `DEMO_NIGHT --ei from -1 --ei to 31` once the set time has passed: the day closes as of it, the strip says the day is not open, the notice shows at the next sign-in, Reports shows "Not counted" and "Automatically", the stand-in printer gets a Z with NOT COUNTED.
- [ ] A sale after the set time, then `DEMO_NIGHT` from after it: closed 30 minutes after the sale (clamped to now).
- [ ] An open table at the time: the Z says "Orders carried over 1", the table is still taken.
- [ ] Look only from the start screen with nobody clocked in: Settings, Reports, Menu open; tapping a table or an item says "You came in to look"; Clock in on the strip leads to Open the day.
- [ ] A clocked-in waiter who may not open the day: in, with "Someone allowed to open it has to".
- [ ] Not seen, said so: a real printer at midnight; a real till syncing 0133 on a real server.

### Task 12: merge into restopos, and the record

- [ ] `git fetch github`; in the worktree `git rebase restopos`; resolve against the MRA session's work (`TicketRepository.kt`, `OrderOps.kt`: their changes and the `op()` guard both stay); build, unit tests again.
- [ ] If `v0.9.22` (build 34) was tagged after these commits went into `restopos`, `AUTO_CLOSE_BUILD` and its test become 34; else 35 stays, the build after.
- [ ] Spec: "What was built" notes (no Room change; the server keeps no count; no CSV; no PullWorker hook).
- [ ] `git -C C:/Projects/RestoPOS merge --ff-only claude/auto-close` only when the main checkout's uncommitted files are not among this branch's; else hand the user the branch.
- [ ] Not pushed, not tagged: the user's. Production needs 0133 before any till on the new build closes a day (the one-tag release runs migrations first).
