# Kitchen screen on a second tablet: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task, inline in one session. No subagent per task: the owner pays per token, and each subagent would start cold on a codebase this size. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tablet in the kitchen, running the same EasyPay APK set up as a kitchen screen, shows each order the moment Send to kitchen is pressed on the till, over the restaurant's own Wi-Fi; ticks and bumps come back to the till.

**Architecture:** The till opens a short connection to the kitchen tablet's address, as it does to a printer, sends one signed JSON message and reads one answer. The kitchen tablet only answers; it keeps what it was sent in a small database of its own. The till writes down what each screen is owed and keeps trying until it is confirmed, so nothing depends on one message arriving. A kitchen screen is a row in `printers` of kind `screen`, routed by the same category ticks as a printer.

**Tech stack:** Kotlin, Compose, Room, kotlinx.serialization, `java.net` sockets, `javax.crypto.Mac` on the till; Next.js and Postgres for the back office. No new library.

**Spec:** `docs/superpowers/specs/2026-10-09-kitchen-screen-and-premium-design.md`, sections 4 to 7. This plan is piece 2 of 2 and comes after `2026-10-09-premium-gate.md`: it uses `has_premium` (migration 0085), `ctx.premium` and `PosSettings.premium`.

**Written lean on purpose**, as the gate's plan is: code where it fixes a contract, words for screens. The same house rules apply (branch `restopos`, one commit per task, read the committed file before editing, fix-forward migrations from live definitions, dev only, never the owner's emulator).

---

## File map

| File | What it is |
|---|---|
| `db/tests/kitchen-screens.test.cjs` | New suite, written first. |
| `db/migrations/0086_kitchen_screens.sql` | `printers`: kind `screen`, `pair_code`, `all_items`, the checks, the premium guard. |
| `web/lib/saves.ts`, `web/lib/printers.ts`, `web/app/backoffice/printers/page.tsx`, `categories/` | The kitchen screen's form, its row, its ticks. |
| `android/.../core/kitchen/Wire.kt` | The messages, their JSON, the signature, the address. No Android. |
| `android/.../core/kitchen/PairCode.kt` | Making and tidying a pairing code. |
| `android/.../core/kitchen/ScreenBook.kt` | The kitchen side's rules: a request in, a reply out, against a `ScreenStore`. |
| `android/.../core/kitchen/ScreenServer.kt` | The listening socket and `ScreenClient`, the till's one exchange. |
| `android/.../core/kitchen/KitchenDatabase.kt` | `kitchen.db`: tickets, lines, marks; the Room `ScreenStore`. |
| `android/.../core/kitchen/Parts.kt` | The till side's rules: what a screen is still owed, when a ticket is bumped, how often to ask. |
| `android/.../core/kitchen/ScreenLink.kt` | The till side at work: writes parts, exchanges, applies marks through `Kitchen`. |
| `android/.../core/kitchen/KitchenPrefs.kt` | Late minutes, what a ticket shows, sound, text size. |
| `android/.../core/data/Routing.kt`, `Kitchen.kt`, `OrderOps.kt`, `DocBuilder.kt` | Screens in the routing; parts in bump and recall; parts written at a send; a void marked. |
| `android/.../core/print/Printing.kt` | `printers()` is paper only; `screens()`. |
| `android/.../core/database/*` | Version 11: two columns on `printers`, two on `kds_tickets`, three tables. |
| `android/.../core/sync/PullApplier.kt`, `Sync.kt` | The two printer columns; the tablet's mode, code and epoch in `SessionStore`. |
| `android/.../feature/kds/Kds.kt` | The board, taking what it shows from outside. |
| `android/.../feature/kds/KitchenMode.kt` | The kitchen tablet: waiting page, board, settings. |
| `android/.../feature/auth/AuthScreens.kt`, `app/AppNav.kt` | "Set up as a kitchen screen"; opening on `Routes.KDS`. |
| `android/.../feature/settings/SettingsScreen.kt` | Kitchen screens under Printers (answering, waiting, Test); Help. |
| `android/app/src/test/.../core/kitchen/*Test.kt`, `core/data/RoutingTest.kt` | Tests, written first. |

---

### Task 1: the server suite, failing

**Files:** Create `db/tests/kitchen-screens.test.cjs` (one transaction, rolled back; shape of `business-type.test.cjs`; `web/lib/saves.ts` loaded the way `pos-pages.test.cjs` loads `pos.ts`).

- [ ] **Step 1: write it.** Checks:

```
K1 a premium restaurant's printer may be of kind screen, with an address and a code
K1 a screen with no code, or with no address, is refused
K2 a screen marked as the receipt printer is refused
K3 a standard restaurant cannot be given a screen (not-premium); a network printer it can
K3 a screen entered while premium can still be switched off and removed after the plan went down
K3 after the plan went down the restaurant can still choose another receipt printer (that save writes the screen's row too)
K3 and a screen switched off then cannot be switched on again until the plan is back
K4 a pull hands a till the screen's row with pair_code and all_items
K5 a category keeps a screen's id among its printer_ids
K6 saves.addPrinter: a store's first entry being a screen is not its receipt printer, and the printer entered next is
K6 saves: choosing a screen as the receipt printer is refused
K7 platform: a plan set from premium to standard leaves the screen's row as it was
```

- [ ] **Step 2: run, see it fail** (`node db/tests/kitchen-screens.test.cjs`): K1 stops on the `kind` check.
- [ ] **Step 3: commit.**

### Task 2: migration 0086 and the back office

**Files:** Create `db/migrations/0086_kitchen_screens.sql`. Modify `web/lib/saves.ts`, `web/lib/printers.ts`, `web/app/backoffice/printers/page.tsx`, the Categories page's table.

- [ ] **Step 1: the migration.** Find the existing check's real name first (`select conname from pg_constraint where conrelid = 'printers'::regclass`).

```sql
alter table printers drop constraint if exists printers_kind_check;
alter table printers add constraint printers_kind_check check (kind in ('network', 'usb', 'screen'));
alter table printers add column if not exists pair_code text;
alter table printers add column if not exists all_items boolean not null default false;
-- a kitchen screen is somewhere to show, never somewhere to print a receipt
alter table printers add constraint printers_screen_check
  check (kind <> 'screen' or (not is_receipt and pair_code is not null and address is not null));

-- A row may become a working kitchen screen only for a restaurant whose plan
-- carries it. One that already is a working screen is left alone, whatever
-- else is written to it: choosing the receipt printer writes every printer
-- row of the store, and must still work after the plan went down.
create or replace function printers_screen_plan() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if new.kind = 'screen' and new.is_active and new.deleted_at is null
     and (tg_op = 'INSERT' or not (old.kind = 'screen' and old.is_active and old.deleted_at is null))
     and not has_premium(new.tenant_id) then
    raise exception 'not-premium';
  end if;
  return new;
end $fn$;
drop trigger if exists printers_screen_plan on printers;
create trigger printers_screen_plan before insert or update on printers
  for each row execute function printers_screen_plan();
```

K7 needs the trigger not to fire on a plan change: it does not, the plan change does not write `printers`. If `sync_pull` lists columns instead of handing whole rows, add the two; K4 says which.

- [ ] **Step 2: apply to dev** (`node db/migrate.cjs`), run the suite. Expected: K1 to K5 and K7 pass; K6 fails (the saves).
- [ ] **Step 3: `web/lib/saves.ts`.** `PrinterForm` becomes `{ name; kind: "network" | "usb" | "screen"; address; paper; feed; cut; pair: string | null; all: boolean }`. In the insert, `is_receipt` is true only for a store's first entry **that is not a screen, when the store has no other non-screen printer**. The receipt switch answers `"screen"` (the page turns it into "A kitchen screen cannot print receipts.") when the row chosen is a screen. The update writes `pair_code` and `all_items`, and never lets a row become a screen while it is the receipt printer.
- [ ] **Step 4: the Printers page.**
  - The kind select gains "Kitchen screen (a tablet in the kitchen)" only when `ctx.premium`.
  - For a screen the form asks: name; address (the IP the tablet shows, with an optional `:port`); pairing code (the tablet shows it; spaces and dashes are dropped, letters made capital, and it must be 8 of `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`); "Shows" as two radios, Everything, or Only the categories ticked for it. Paper, feed and cut are not shown.
  - Its row reads "Kitchen screen · 192.168.1.60 · Everything" (or "· 3 categories").
  - Under the form: "A kitchen screen needs EasyPay 0.6.0 or later on every till. An older till takes it for a printer." and one line on where the tablet shows its address and code.
  - A restaurant that is not premium sees its existing screens listed as "Off: part of Premium", with Remove only.
  - `web/lib/printers.ts`: the "same printer entered twice" note and the receipt-printer notes leave screens out.
- [ ] **Step 5: Categories.** The ticks list screens after the printers, named "Grill (screen)". Nothing else changes: `printer_ids` already takes any of the tenant's `printers` rows.
- [ ] **Step 6: check.** `node db/tests/kitchen-screens.test.cjs` all pass; `npx tsc --noEmit` in `web/`; `backoffice-saves` passes. See the form with the preview route (deleted before the commit).
- [ ] **Step 7: commit** (migration and back office as two commits).

### Task 3: the wire, tested first

**Files:** Create `core/kitchen/Wire.kt`, `core/kitchen/PairCode.kt`, and `WireTest.kt`, `PairCodeTest.kt` under `android/app/src/test/java/com/restopos/core/kitchen/`.

- [ ] **Step 1: the tests.**

```
WireTest
  aRequestGoesOutAndComesBackTheSame
  aWrongCodeIsNotRead                      // decode(...) == null
  aChangedBodyIsNotRead                    // one character altered after signing
  theSignatureIsHmacSha256Hex              // a known vector: code "KTCHN234", line "{}" -> the hex worked out once and pinned
  aReplyGoesOutAndComesBackTheSame
  unknownFieldsAreReadPast                 // a reply with an extra key still decodes
  anAddressWithNoPortUses9310; anAddressWithAPortUsesIt; rubbishIsNoAddress
PairCodeTest
  aCodeIsEightOfTheAllowedCharacters       // 200 made, each matches ^[A-HJ-NP-Z2-9]{8}$
  whatIsTypedIsTidied                      // " ktch-n234 " -> "KTCHN234"; "KTCHN23" -> null; "KTCHN2O4" -> null
```

- [ ] **Step 2: see them fail** (`android/gradlew -p android :app:testDebugUnitTest --tests "*kitchen*"`).
- [ ] **Step 3: implement.** The contract:

```kotlin
package com.restopos.core.kitchen

@Serializable data class WireLine(val id: String, val qty: Int, val name: String, val detail: String = "")

// One screen's part of one send: what the cooks at that screen are to make.
@Serializable data class WireTicket(
    val id: String, val no: Int, val label: String, val kind: String, val covers: Int? = null,
    val waiter: String? = null, val remark: String? = null, val sentAt: Long, val lines: List<WireLine>,
)

// What a thing is now, never "flip it": the same mark twice changes nothing.
// Exactly one of line and ticket is set.
@Serializable data class WireMark(
    val line: String? = null, val ticket: String? = null,
    val done: Boolean? = null, val voided: Boolean? = null, val bumped: Boolean? = null,
)

@Serializable data class WireRequest(
    val v: Int = Wire.VERSION, val till: String, val tillName: String, val tillCode: String,
    val screen: String,                       // the screen's name in the back office, for its header
    val put: List<WireTicket> = emptyList(), val marks: List<WireMark> = emptyList(), val after: Long = 0,
)

@Serializable data class WireReply(
    val ok: Boolean, val error: String? = null,   // "refused": wrong code; "version": the link's versions differ
    val v: Int = Wire.VERSION, val build: Int = 0, val epoch: String = "",
    val seq: Long = 0, val marks: List<WireMark> = emptyList(), val have: List<String> = emptyList(),
)

object Wire {
    const val VERSION = 1
    const val PORT = 9310
    fun sign(code: String, line: String): String                  // HMAC-SHA256, lower-case hex
    fun encode(req: WireRequest, code: String): String             // "<json>\n<signature>\n"
    fun decode(first: String, second: String, code: String): WireRequest?   // null: not signed with this code, or not a request
    fun encode(reply: WireReply): String                           // "<json>\n"
    fun decodeReply(line: String): WireReply?
    fun address(text: String?): Pair<String, Int>?                 // "192.168.1.60" or "192.168.1.60:9400"
}

object PairCode {
    const val ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    fun make(random: java.util.Random = java.security.SecureRandom()): String
    fun tidy(typed: String?): String?
}
```

JSON with `ignoreUnknownKeys = true, encodeDefaults = true`. The signature is compared in constant time (`MessageDigest.isEqual`).

- [ ] **Step 4: see them pass. Step 5: commit.**

### Task 4: the kitchen side's rules, tested first

**Files:** Create `core/kitchen/ScreenBook.kt`, `ScreenBookTest.kt` (with an in-memory `ScreenStore` in the test file).

```kotlin
// What the kitchen tablet keeps. The Room one is KitchenDatabase; the test's is a map.
interface ScreenStore {
    suspend fun epoch(): String
    suspend fun put(req: WireRequest)                                  // tickets replace by id; a line keeps its done and voided
    suspend fun fromTill(till: String, marks: List<WireMark>)          // applied, never written to the list below
    suspend fun cooks(till: String, after: Long): Pair<Long, List<WireMark>>   // what the cooks did since, and the latest number
    suspend fun have(till: String): List<String>
    suspend fun tap(lineId: String)                                    // a cook taps a line
    suspend fun bump(ticketId: String)
    suspend fun recallLast(): String?                                  // the label of what came back
}

class ScreenBook(private val store: ScreenStore, private val code: suspend () -> String, private val build: Int) {
    suspend fun answer(first: String, second: String): String          // always a reply line
}
```

- [ ] **Step 1: tests.**

```
aWrongCodeIsRefusedAndNothingIsKept
anotherLinkVersionIsRefusedWithBothVersions
aTicketPutTwiceIsOneTicket
aTicketPutAgainKeepsWhatTheCookTicked
aCooksTapComesBackOnceAskedAfter            // after = 0 gives it; after = seq gives nothing
aMarkFromTheTillIsNotSentBackToIt
aVoidFromTheTillStrikesTheLine
twoTillsEachGetOnlyTheirOwn
bumpAndRecallAreMarksOfTheTicket
haveListsWhatThisTillSent
```

- [ ] **Steps 2 to 5:** fail, implement, pass, commit.

### Task 5: the socket, tested over 127.0.0.1

**Files:** Create `core/kitchen/ScreenServer.kt` (holds `ScreenServer` and `ScreenClient`), `ScreenServerTest.kt`.

```kotlin
class ScreenServer(private val wanted: Int = Wire.PORT, private val answer: suspend (String, String) -> String) {
    val port: Int                              // the port really bound (0 asks for any, for tests)
    fun start(scope: CoroutineScope)           // accept loop on Dispatchers.IO; one connection: 5 s to read two lines, each at most 256 KB; reply; close
    fun stop()
}
object ScreenClient {
    // One exchange. Throws IOException when nothing answers in time.
    fun exchange(host: String, port: Int, payload: String, connectMs: Int = 1500, readMs: Int = 4000): String
}
```

- [ ] **Step 1: tests** (`ScreenBook` over the in-memory store behind a real `ScreenServer` on port 0):

```
aPutArrivesAndIsAnswered
aTapOnTheScreenReachesTheTillAtItsNextExchange
nothingListeningIsAnIOException              // a port that was closed
aLineLongerThanTheLimitIsDroppedNotRead
twoExchangesAtOnceBothAnswer
aStoppedServerStopsAnswering
```

- [ ] **Steps 2 to 5:** fail, implement, pass, commit.

### Task 6: the till's database, version 11

**Files:** Modify `core/database/Ops.kt` (`PrinterEntity`), `Service.kt` (`KdsTicketEntity`, the DAO), `TillDatabase.kt`, `Migrations.kt`, `core/sync/PullApplier.kt`; the exported schema `android/app/schemas/.../11.json` is generated.

- [ ] **Step 1: entities.**
  - `PrinterEntity`: `val pair_code: String? = null`, `val all_items: Boolean = false`; its `kind` comment becomes `network | usb | screen`.
  - `KdsTicketEntity`: `val waiter: String? = null`, `val remark: String? = null`.
  - New, in `Service.kt`:

```kotlin
// One screen's part of a kitchen ticket: what it was sent, whether it has it, whether it bumped it.
@Entity(tableName = "kds_parts", primaryKeys = ["kds_id", "screen_id"], indices = [Index("screen_id")])
data class KdsPartEntity(
    val kds_id: String, val screen_id: String,
    val payload: String,            // the WireTicket as sent, frozen
    val line_ids: String,           // JSON list
    val delivered: Boolean = false, val bumped_at: Long? = null,
    val created_at: Long = System.currentTimeMillis(),
)

// A mark the till owes a screen: a void, or a tick or bump made on the till's own Kitchen tab.
@Entity(tableName = "kds_out", indices = [Index("screen_id")])
data class KdsOutEntity(@PrimaryKey(autoGenerate = true) val id: Long = 0, val screen_id: String, val mark: String)

// What the till knows of each screen: which set-up it last spoke to, how far it has read, when it last answered.
@Entity(tableName = "kds_screens")
data class KdsScreenEntity(@PrimaryKey val screen_id: String, val epoch: String = "", val after: Long = 0, val heard_at: Long? = null, val error: String? = null)
```

  - DAO: `upsertParts`, `partsOpen()` (not bumped, as a `Flow`), `partsOf(kds)`, `partsWaiting(screen)`, `setDelivered(kds, screen)`, `setPartBumped(kds, screen, at)`, `undeliver(screen)` (a new epoch), `addOut`, `outOf(screen)`, `removeOut(ids)`, `screenState(screen)`, `saveScreenState`, and `pruneParts(before)` called where `pruneKds` is.
- [ ] **Step 2: version 11 and `V10_V11`.** Build once so Room writes `11.json`, and copy each `CREATE TABLE` and `CREATE INDEX` from it word for word:

```kotlin
    // 10 -> 11: kitchen screens (server 0086).
    val V10_V11 = object : Migration(10, 11) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("ALTER TABLE `printers` ADD COLUMN `pair_code` TEXT")
            db.execSQL("ALTER TABLE `printers` ADD COLUMN `all_items` INTEGER NOT NULL DEFAULT 0")
            db.execSQL("ALTER TABLE `kds_tickets` ADD COLUMN `waiter` TEXT")
            db.execSQL("ALTER TABLE `kds_tickets` ADD COLUMN `remark` TEXT")
            // kds_parts, kds_out, kds_screens: from 11.json
            // A screen pulled before this build has no code: pull again from the start.
            db.execSQL("UPDATE `sync_state` SET `cursor` = 0")
        }
    }
```

  No destructive fallback, as before. Compare `11.json` with `10.json`: the difference must be these columns and tables and nothing else.
- [ ] **Step 3: `PullApplier`** reads `pair_code` and `all_items` into `PrinterEntity`.
- [ ] **Step 4:** unit tests and `assembleDebug` pass. **Step 5: commit.**

### Task 7: screens in the routing, tested first

**Files:** Modify `RoutingTest.kt`, `Routing.kt`, `core/print/Printing.kt`, and every caller of `printing.printers()`.

- [ ] **Step 1: tests added to `RoutingTest`** (a `screen(id, all = false)` helper beside `printer(...)`):

```
aScreenNeverPrints                  // ticked, or first in the list, or the only entry: tickets(), printersFor() and single() leave it out
aScreenSetToEverythingGetsEveryLine // the line with no category included
aScreenWithTicksGetsItsCategories
paperAndAScreenForTheSameCategory   // the line is on the paper and on the screen
aSendWithNothingForAScreenSendsItNothing
everyScreenIsAStation               // with one printer for everything the screens are the only stations
aLineShowsUnderAnEverythingScreensStation
aSwitchedOffScreenGetsNothing
```

- [ ] **Step 2: fail. Step 3: implement.**

```kotlin
    fun paper(all: List<PrinterEntity>): List<PrinterEntity> = all.filter { it.kind != "screen" }
    fun screens(all: List<PrinterEntity>): List<PrinterEntity> = all.filter { it.kind == "screen" }

    // An order's lines as each screen's part: screen to its lines, in the order rung up.
    fun <L> screenLines(lines: List<Pair<L, List<String>?>>, screens: List<PrinterEntity>): Map<String, List<L>>
```

  `single`, `printersFor`, `tickets`, `nowhere` and `heading` work on `paper(...)` whatever they are handed. `stations(...)` returns the paper stations as today followed by every screen; `stationsFor(...)` puts every line under a screen whose `all_items` is set.
- [ ] **Step 4: `Printing`.** `printers()` returns `Routing.paper(...)` of the usable ones; new `screens()` returns `Routing.screens(...)`. Read every caller of `printers()` and of `db.ops().printers(` (`grep -rn "printers()" android/app/src/main`): the settings page, the standing checks ("No printer is set up"), `answers`, the Kitchen tab's stations. Each either wants paper (most) or all usable (the stations).
- [ ] **Step 5: pass, whole unit suite, commit.**

### Task 8: the till's rules for parts, tested first

**Files:** Create `core/kitchen/Parts.kt`, `PartsTest.kt`.

```kotlin
object Parts {
    // What one exchange should put: the parts not confirmed, and any the screen says it does not hold.
    fun toPut(open: List<KdsPartEntity>, have: Set<String>?): List<KdsPartEntity>
    // A kitchen ticket leaves the till's tab when it has parts and every one is bumped.
    fun ticketBumped(parts: List<KdsPartEntity>): Boolean
    // How long to wait before asking a screen again.
    fun pause(openParts: Int, failures: Int): Long     // 3 s with open parts, 15 s without; after failures 3, 5, 10 then 15 s
    // What is said when a screen does not answer, refused the code, or is on another version.
    fun trouble(name: String, address: String?, reply: WireReply?, waiting: Int): String?
}
```

- [ ] **Step 1: tests.**

```
whatWasNeverConfirmedIsPut
whatTheScreenNoLongerHoldsIsPutAgain        // delivered, not bumped, missing from have
whatItBumpedIsNotPutAgain
aTicketWithTwoPartsIsBumpedWhenBothAre
aTicketWithNoPartIsNotBumpedByThisRule
thePauseIsShortWhileOrdersAreOpenAndBacksOffWhenNothingAnswers
theWordsForNotAnswering                     // "Grill screen is not answering at 192.168.1.60. 2 orders are waiting for it. Check that the kitchen tablet is on, has EasyPay open and is on the same Wi-Fi."
theWordsForARefusedCode                     // "Grill screen refused the code. Check the code in the back office, under Printers."
theWordsForAnotherVersion                   // names which of the two to update, from v and build
```

- [ ] **Steps 2 to 5:** fail, implement, pass, commit.

### Task 9: the till side at work

**Files:** Create `core/kitchen/ScreenLink.kt`. Modify `core/data/Kitchen.kt`, `OrderOps.kt`, `DocBuilder.kt`, the Hilt module that provides singletons, `MainActivity.kt` or `MainShell` (where the loop starts).

- [ ] **Step 1: `Kitchen` learns states and parts.**
  - `setDone(lineId, done)`: what `toggle` does, to a given state; `toggle` calls it. Both add a `KdsOutEntity` for each screen whose part holds the line, unless the change came from that screen.
  - `bump(kdsId)` and `recall()` (the till's own tab) also mark every part bumped or not, and add the out-marks.
  - `bumpPart(kdsId, screenId, at)`: marks the part, sends `kitchen.mark` "bumped" for that part's lines, and when `Parts.ticketBumped` is true does what `bump` does to the ticket (off the tab; a takeaway to Ready when its last ticket is bumped).
  - `recallPart(kdsId, screenId)`: the reverse, as `recall` does for the ticket.
  - `prepare(ticketId)` fills `waiter` and `remark`; `DocBuilder` exposes the two it already works out (`employee(t.opened_by)`, `remark(t)`) through one internal function.
- [ ] **Step 2: `ScreenLink`.**

```kotlin
@Singleton
class ScreenLink @Inject constructor(db: TillDatabase, session: SessionStore, kitchen: Kitchen, printing: Printing, service: ServiceRepository) {
    // Inside the transaction that marks the lines sent: one part per screen that has lines of this send.
    suspend fun write(ticket: KdsTicketEntity, lines: List<TicketLineEntity>)
    fun kick()                                   // something new to send: exchange now
    fun start(scope: CoroutineScope)             // the loop; idle unless the plan is premium and the store has a screen
    suspend fun test(screenId: String): String   // for Settings, Printers
    val status: StateFlow<Map<String, ScreenStatus>>   // per screen: answering, waiting, trouble
}
data class ScreenStatus(val answering: Boolean, val waiting: Int, val trouble: String?)
```

  One exchange with one screen: read its state row; build the request (`Parts.toPut`, the out-marks, `after`); `ScreenClient.exchange`; on a reply that is `ok`: a changed epoch calls `undeliver(screen)`, zeroes `after` and exchanges again at once; otherwise mark what was put as delivered, remove the out-marks sent, apply the reply's marks (`done` to `kitchen.setDone`, `bumped` to `bumpPart` or `recallPart`), save `seq` and `heard_at`. On failure or a refusal: save the words from `Parts.trouble`, report them once through `printing.report` (not every three seconds), keep everything queued. One exchange at a time per screen (a `Mutex` keyed by `Routing.line(screen)`, as `Printing.turns` is).
- [ ] **Step 3: hook the send.** `OrderOps.markSent`: inside the transaction, after `kitchen.put(onScreen, ids)`, `screens.write(onScreen, lines)` when the settings say premium; after it, `screens.kick()`. `SaveResult.errors` gains the trouble of a screen that is known not to be answering.
- [ ] **Step 4: hook the void.** Where a sent line is voided (`OrderOps`, about line 190) and where an order is cancelled: an out-mark `{line, voided: true}` for each screen holding it, then `kick()`.
- [ ] **Step 5: start the loop** when the till's shell is up (where `SyncScheduler.startPeriodic` or `Printing` is first used); it must not run on a tablet set up as a kitchen screen.
- [ ] **Step 6: a test that joins the two sides,** `LinkTest.kt`: the real `ScreenBook`, `ScreenServer` on port 0 and `ScreenClient`, with the till's steps driven by `Parts` and plain lists in place of Room:

```
aSendReachesTheScreenAndIsMarkedDelivered
theScreenOffThenOnGetsWhatWaited
aScreenSetUpAfreshIsSentEveryOpenPartAgain      // new epoch
aTapAndABumpComeBackAndAreAppliedOnce           // a second exchange brings nothing more
aVoidReachesTheScreen
```

- [ ] **Step 7:** unit suite and `assembleDebug` pass. **Step 8: commit.**

### Task 10: the board, shared by the till and the kitchen tablet

**Files:** Create `core/kitchen/KitchenPrefs.kt`, `KitchenPrefsTest.kt`. Modify `feature/kds/Kds.kt`, `MainShell.kt` (the call).

- [ ] **Step 1: prefs, tested first.**

```kotlin
data class KitchenPrefs(
    val amberMin: Int = 8, val redMin: Int = 15,
    val covers: Boolean = true, val waiter: Boolean = true, val kind: Boolean = true, val remark: Boolean = true,
    val sound: Boolean = true, val largeText: Boolean = false,
) {
    enum class Tone { Fresh, Amber, Red }
    fun tone(ageMs: Long): Tone
    companion object { fun tidy(amber: Int, red: Int): Pair<Int, Int> }   // 1..120, red at least a minute after amber
}
```

  Tests: `aTicketIsFreshThenAmberThenRed`, `redNeverComesBeforeAmber`, `theMinutesStayInRange`. Kept in a DataStore of its own (`kitchen_prefs`), one per tablet.
- [ ] **Step 2: `Kds.kt`.** `KdsScreen(vm)` becomes a thin caller of

```kotlin
data class KdsLine(val id: String, val units: Int, val name: String, val detail: String, val done: Boolean, val voided: Boolean, val stations: Set<String>)
data class KdsCard(val id: String, val no: String, val label: String, val kind: String, val covers: Int?, val waiter: String?, val remark: String?, val createdAt: Long, val lines: List<KdsLine>)
data class KdsUi(val cards: List<KdsCard> = emptyList(), val stations: List<Station> = emptyList(), val canRecall: Boolean = false, val loaded: Boolean = false, val title: String = "Kitchen display", val heard: String? = null)

@Composable
fun KdsBoard(ui: KdsUi, prefs: KitchenPrefs, onTap: (String) -> Unit, onBump: (String) -> Unit, onRecall: () -> Unit, onSettings: () -> Unit)
```

  The board is what the screen is today, with: the header colours from `prefs.tone`; covers, order type, waiter and remark shown as the prefs say; a voided line struck through with VOID in red, never tappable; text a step larger with `largeText`; a settings key in the header; `heard` under the title when it is set. The sound and the "all day" panel stay.
- [ ] **Step 3: the till's tab** maps its rows to these classes (its `no` is `#12`), keeps its sound from the POS setting, and opens a small sheet from the settings key: the two minutes and the four "a ticket shows" switches.
- [ ] **Step 4:** unit suite, `assembleDebug`, and the tab seen on the test emulator as it was before (a send, a tick, a bump, recall). **Step 5: commit.**

### Task 11: the kitchen tablet

**Files:** Create `core/kitchen/KitchenDatabase.kt`, `feature/kds/KitchenMode.kt`. Modify `core/sync/Sync.kt` (`SessionStore`), `feature/auth/AuthScreens.kt`, `app/AppNav.kt`, the Hilt module.

- [ ] **Step 1: `SessionStore`.** `isKitchen()`, `setKitchen()` (writes the mode, makes the pairing code and the epoch if there is none), `pairCode()`, `newPairCode()`, `epoch()`, `leaveKitchen()` (clears the three). In a debug build the code is the constant `KTCHN234`, so two emulators can be paired without typing.
- [ ] **Step 2: `KitchenDatabase`** (`kitchen.db`, version 1, its own schema folder): `screen_tickets` (id, till, till_name, till_code, screen, no, label, kind, covers, waiter, remark, sent_at, received_at, bumped_at), `screen_lines` (id, ticket_id, position, qty, name, detail, done, voided), `screen_marks` (seq autogenerated, till, line, ticket, done, bumped, at). `RoomScreenStore` implements `ScreenStore`; `ScreenBookTest`'s rules are its contract. Tickets older than three days are cleared on start.
- [ ] **Step 3: the sign-in screen.** On `AuthScreen` when it is not a re-sign-in: under the main key, a quiet key "Set up as a kitchen screen", and one line under it: "For a tablet in the kitchen. It needs no login." Pressed: `session.setKitchen()`, then `Routes.KDS`.
- [ ] **Step 4: `AppNav`.** The start route is `Routes.KDS` when `session.isKitchen()`; `composable(Routes.KDS) { KitchenModeScreen(onBecomeTill = { ...to Routes.AUTH, nothing behind it }) }`. The periodic sync is not started on a kitchen tablet. Read `MainActivity` and the Application class for anything else started whatever the tablet is (WorkManager jobs, the crash upload, the "last use" note, the screen lock, `ScreenLink`'s loop) and keep each off a kitchen tablet: it has no store and no login, and must send our server nothing but the update question.
- [ ] **Step 5: `KitchenModeScreen`.** Its view model owns the `ScreenServer` (started when the screen is shown, stopped when it goes), the store and the prefs.
  - **Waiting page**, until a till has put something: the EasyPay wordmark, "Kitchen screen", the address (the tablet's own IPv4 on the Wi-Fi, from `NetworkInterface`; "Not on a Wi-Fi network" when there is none), the pairing code in large spaced letters, and "In the back office, under Printers, add a Kitchen screen with this address and this code."
  - **The board:** `KdsBoard` over the store's open tickets. A ticket's age is counted from when this tablet received it (`received_at`), on this tablet's own clock, never from the till's `sentAt`: two tablets' clocks drift apart, most of all with the internet down, and a ticket would arrive already red or stay green too long. The title is the screen's name as the till sent it. With more than one till on it, a ticket's number carries its till's code ("T2 #12"). `heard` reads "Terminal 01 · just now" or "No till for 2 min".
  - **Settings sheet** (the key in the header): the two minutes; the four switches; sound; text size; light or dark and language (the tablet's existing `SessionStore` settings); the address and the code with "Make a new code" behind a question that says the back office must be given the new one; "Use this tablet as a till instead" behind a question, which clears `kitchen.db` and the mode.
  - The window keeps the screen on while this screen is shown. Back does not leave it.
  - **Updates:** ask `ApiClient.latestTill()` when the screen opens and once a day; when it names a newer build, show the till's own update key. Read how `MainShell` does it (`sealed interface Update`) and share that code; do not write a second downloader.
- [ ] **Step 6:** unit suite and `assembleDebug`. **Step 7: commit.**

### Task 12: the till's Settings, and Help

**Files:** Modify `feature/settings/SettingsScreen.kt`.

- [ ] **Step 1: Settings, Printers.** After the printers, a "Kitchen screens" group when the store has any: each with its name, address, what it shows, and from `ScreenLink.status` "Answering", or its trouble in red with "2 orders waiting"; a **Test** key that calls `ScreenLink.test` and says the answer. A restaurant that is not premium sees the group with "Kitchen screens are part of Premium." The dot on Printers also lights for a screen in trouble.
- [ ] **Step 2: Help** (a restaurant's, premium only): "A kitchen screen on another tablet": set-up in four steps; that it works without the internet; what to check when the till says it is not answering (on, EasyPay open, same Wi-Fi, the address unchanged); that Bump on a screen clears that screen's part.
- [ ] **Step 3: commit.**

### Task 13: two emulators

The owner's emulator is never used. Say before installing anything.

- [ ] **Step 1:** the till runs on `easypay_claude_till` (made for the gate; `-no-window -port 5586`). A second AVD of the same kind for the kitchen, `easypay_claude_kitchen` (`-port 5588`): copy the first one's `config.ini` into a new `.avd` folder and write its `.ini` beside it. `easypay_claude_test` (5584) and 5554 are the owner's and are not touched. Two emulators and a build are heavy for this PC: build first, then start them.
- [ ] **Step 2:** join them through the PC: `adb -s <kitchen serial> forward tcp:9310 tcp:9310`. From the till's emulator the PC is `10.0.2.2`, so the debug build's made-up restaurant (`DemoReceiver`, `--es type restaurant --es plan premium`) is given, by a further extra, a kitchen screen at `10.0.2.2:9310` with the code `KTCHN234`, set to everything. The address the kitchen emulator shows (`10.0.2.15`) is its own inside the emulator and is not the one to type; say so in the notes.
- [ ] **Step 3: the path, each seen on both screens:**
  1. The kitchen tablet: fresh install, "Set up as a kitchen screen", the waiting page with a code.
  2. A table's order sent: on the kitchen screen within a second or two, with its number, table, covers and items.
  3. A cook's tick: on the till's Kitchen tab within a few seconds.
  4. Bump on the screen: gone from the till's tab; a takeaway sent the same way turns Ready on the board.
  5. Recall last: back on both.
  6. A sent line voided on the till: struck through on the screen.
  7. The kitchen app closed, two orders sent: the till says the screen is not answering and that 2 wait; reopened, both arrive, once each.
  8. The kitchen tablet's data cleared and set up again: the open orders come back.
  9. The settings: late minutes changed and seen; covers switched off and gone; large text.
  10. The plan set to standard in the made-up settings: the till sends nothing and hides the tabs.
- [ ] **Step 4:** the device logs of both read for a crash. Write down what was and was not seen. Two emulators share this PC's clock, so tablets whose clocks disagree cannot be seen here; that the kitchen tablet counts from its own clock is covered by a unit test of the view model's mapping.

### Task 14: the version, and what is the owner's

- [ ] **Step 1:** `android/app/build.gradle.kts`: the next build number and `0.6.0`. Read the file first: 0.5.1 took build 6 while this plan was being written, so it is 7 unless another release came in between. Unit suite and `assembleDebug`. Commit, in the style of the 0.5.0 commit: what it carries, what production needs.
- [ ] **Step 2: the closing message to the owner** lists, in order, what only they can do:
  1. Each restaurant that is to keep Bookings and the Kitchen tab set to Premium in `/admin`. This comes first and works today; the migration copies it into the settings.
  2. Production: migrations 0085 and 0086 (`node db/migrate-production.cjs`, then `--apply`).
  3. The back office redeployed.
  4. The tag `v0.6.0` when they say "release", which builds and publishes the APK.
  5. The till API deployed with `LATEST_TILL_VERSION` and `MIN_TILL_VERSION` both set to that build's number (7 as this is written), `LATEST_TILL_NAME=0.6.0` and the APK's address, so that no older till meets the gate or a kitchen screen. Between steps 2 and 5 a till on 0.5.0 has its bookings refused for a Standard restaurant, so the steps follow one another the same day.
  6. A trial on two real tablets on one Wi-Fi, with the kitchen tablet's address fixed on the router.

---

## Self-review against the spec

| Spec section | Task |
|---|---|
| 4.2 set-up, waiting page, no login, updates | 11 |
| 4.3 back office form; never the receipt printer; old tills | 1, 2; 7 (paper only); 14 (`MIN_TILL_VERSION`) |
| 4.4 which lines go to which screen; stations | 7 |
| 4.5 the link, signature, repeat-safe, epoch, version | 3, 4, 5 |
| 4.6 sending, retry, what the till says, Test, the pace | 8, 9, 12 |
| 4.7 ticks, bumps, recall, voids; a screen bumps its part | 4, 8, 9 |
| 4.8 the kitchen tablet's settings; the till's tab gets the same two | 10, 11 |
| 4.9 what the kitchen tablet keeps; two tills | 4, 11 |
| 5 units | file map |
| 6 what goes wrong | 8 (words), 9, 13 |
| 7 testing | each task's tests; 13 |
| 3 kitchen screens not offered or saved for Standard | 2 (trigger, form), 12 |

Not covered here, as the spec says: Firebase or the server as the route, the till finding the tablet by itself, a browser or television screen, a listener that survives another app in front.
