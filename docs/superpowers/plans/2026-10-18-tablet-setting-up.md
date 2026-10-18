# Setting up on an offline tablet, then Go live: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An offline tablet set up before its business sells for real rings up for trying (a strip says so, every paper says TEST, NOT A RECEIPT), and its owner's Go live clears what was rung up and keeps what was set up.

**Architecture:** One copy of the data. A flag in the tablet's preferences (`setting_up`, carried by a backup) counts only while the tablet works on its own. While it is on, `moveStock` also writes each product's move down as a stock movement marked `trial`. Go live is one Room transaction (put the noted stock back by `GoLiveRules`, delete the rung-up tables, take the rung-up kinds out of the queue, number receipts from 1), then one preferences write that ends with the flag. No server change, no migration, no Room version.

**Tech Stack:** Kotlin, Jetpack Compose, Room, DataStore, Hilt; JUnit 4 on the JVM. Web: Next.js (one sentence in `/admin`).

Spec: `docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md`.

Commands (from `android/`): unit tests `./gradlew --priority low --max-workers 2 :app:testDebugUnitTest --tests '<class>'`; build `./gradlew --priority low --max-workers 2 :app:assembleDebug`; then `./gradlew --stop` (an emulator and Gradle do not fit in this PC's memory together).

---

## Files

| File | What it is for |
|---|---|
| `core/data/GoLiveRules.kt` (new) | Plain rules: which queued kinds were rung up, and what goes back on each shelf. |
| `core/data/SettingUp.kt` (new) | `tryingOut()` and `settingUpFlow()`: the flag, counted only while the tablet works on its own. |
| `core/data/GoLive.kt` (new) | Go live itself: counts for the sheet, and the clearing. |
| `core/database/GoLive.kt` (new) | `GoLiveDao`: the reads and deletes Go live needs. |
| `core/database/TillDatabase.kt` | `abstract fun goLive(): GoLiveDao` (a DAO, no schema change). |
| `core/sync/Sync.kt` | `SessionStore.settingUp`, `setSettingUp`, `wentLive`; `PullWorker` ends the flag on a cloud plan. |
| `core/data/PosSettings.kt` | `cloud`: the settings name the plan premium or trial. |
| `core/data/RetailSales.kt` | `moveStock(..., noted)`. |
| `core/data/TicketRepository.kt`, `OrderOps.kt`, `Deposits.kt` | pass `noted` while trying out. |
| `core/print/Docs.kt`, `core/print/Printing.kt` | `Paper.trial`, the mark at a page's top and foot. |
| `feature/auth/AuthScreens.kt`, `AuthViewModels.kt`, `SetupParts.kt` | the question on the code card. |
| `feature/settings/GoLivePage.kt` (new), `SettingsScreen.kt` | the Setting up card, the sheet, one call in This till, Help. |
| `feature/main/MainShell.kt` | the strip under the top bar. |
| `src/debug/.../DemoReceiver.kt` | `--ez setting_up true`. |
| `web/app/admin/tenants/[id]/view.tsx` | one sentence on an offline client's card. |
| tests: `GoLiveRulesTest`, `PosSettingsTest`, `DocsTest` | |

---

### Task 1: The rules (queue kinds, stock put back)

**Files:** Create `android/app/src/main/java/com/restopos/core/data/GoLiveRules.kt`; Test `android/app/src/test/java/com/restopos/core/data/GoLiveRulesTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.restopos.core.data

import com.restopos.core.data.GoLiveRules.Noted
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GoLiveRulesTest {
    @Test
    fun noKindIsInBothLists() = assertEquals(emptySet<String>(), GoLiveRules.RUNG_UP intersect GoLiveRules.SET_UP)

    // Every kind of change the code puts in the queue, read from the code
    // itself: op("…"), OutboxEntity(Uuid7.next(), "…") (across lines too),
    // and what the tablet answers by itself. A new kind fails here until it
    // is said to be rung up or set up.
    @Test
    fun everyKindQueuedIsInOneList() {
        val code = File("src/main/java").walkTopDown().filter { it.isFile && it.extension == "kt" }.joinToString("\n") { it.readText() }
        val queued = Regex("""(?:\bop\(\s*|OutboxEntity\(\s*Uuid7\.next\(\),\s*)"([a-z_]+\.[a-z_]+)"""").findAll(code).map { it.groupValues[1] }.toSet() + LocalAnswers.KINDS
        assertTrue("found ${queued.size}: too few to be the whole code", queued.size > 60)
        assertEquals(emptySet<String>(), queued - GoLiveRules.RUNG_UP - GoLiveRules.SET_UP)
    }

    @Test
    fun aKindNotKnownStays() {
        assertTrue(GoLiveRules.goes("receipt.create"))
        assertTrue(GoLiveRules.goes("request.answer"))
        assertFalse(GoLiveRules.goes("item.save"))
        assertFalse(GoLiveRules.goes("count.complete"))
        assertFalse(GoLiveRules.goes("something.new"))
    }

    @Test
    fun salesAndRefundsAreUndone() {
        val back = GoLiveRules.putBack(listOf(Noted("mug", "", -2000, 10), Noted("mug", "", 1000, 20), Noted("tea", "v1", -500, 30)), emptyMap())
        assertEquals(mapOf(("mug" to "") to 1000, ("tea" to "v1") to 500), back)
    }

    // the count found what was there and set the level: a sale before it is no longer in the level
    @Test
    fun aSaleBeforeACountStaysOut() {
        val back = GoLiveRules.putBack(listOf(Noted("mug", "", -1000, 10), Noted("mug", "", -3000, 50)), mapOf(("mug" to "") to 30L))
        assertEquals(mapOf(("mug" to "") to 3000), back)
    }

    @Test
    fun aCountOfOneVariantLeavesTheOthers() {
        val back = GoLiveRules.putBack(listOf(Noted("shirt", "s", -1000, 10), Noted("shirt", "m", -1000, 10)), mapOf(("shirt" to "s") to 30L))
        assertEquals(mapOf(("shirt" to "m") to 1000), back)
    }

    @Test
    fun whatCancelsOutIsNotWritten() =
        assertEquals(emptyMap<Pair<String, String>, Int>(), GoLiveRules.putBack(listOf(Noted("mug", "", -1000, 10), Noted("mug", "", 1000, 20)), emptyMap()))
}
```

- [ ] **Step 2: Run it, expect a compile failure** (`GoLiveRules` unknown): `./gradlew --priority low --max-workers 2 :app:testDebugUnitTest --tests 'com.restopos.core.data.GoLiveRulesTest'`

- [ ] **Step 3: Write `GoLiveRules.kt`**

```kotlin
package com.restopos.core.data

// What Go live does to what a tablet holds, as plain rules (GoLiveRulesTest):
// which kinds of change in its queue were rung up, and so go with the sales,
// and what of each product the sales noted while it was setting up goes back
// on the shelf. docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
object GoLiveRules {
    // the mark on a stock movement noted while setting up (stock_movements.ref_type)
    const val TRIAL = "trial"

    // What was rung up: taken out of the queue at Go live, with the sales.
    val RUNG_UP = setOf(
        "ticket.create", "ticket.add_line", "ticket.edit_line", "ticket.void_line", "ticket.send", "ticket.stage",
        "ticket.place_lines", "ticket.split_line", "ticket.merge", "ticket.move_lines", "ticket.update_meta", "ticket.cancel",
        "receipt.create", "refund.create", "payment.correct",
        "shift.open", "shift.close", "day.close", "drawer.count", "cash.move", "timeclock.punch",
        "kitchen.mark", "booking.upsert", "request.answer",
        "deposit.create", "deposit.pay", "deposit.cancel", "deposit.give_back", "account.pay",
    )

    // What was set up: stays in the queue, in its order, for the day the business is connected to the cloud.
    val SET_UP = LocalAnswers.KINDS + setOf("customer.upsert", "item.set_available", "item.set_price", "setup.finish")

    // A kind in neither list stays: a sale left in can still be cleared then;
    // a set-up change taken out could not be had back.
    fun goes(kind: String): Boolean = kind in RUNG_UP

    // A move of stock noted while setting up: the product, its variant ("" for
    // none), how much in thousandths (minus for a sale), and when.
    data class Noted(val item: String, val variant: String, val qty: Int, val at: Long)

    // What goes back on each shelf: every noted move undone, except one made
    // before a count of that product was completed here. The count found what
    // was there and set the level to it, so that sale is no longer in it; and
    // the count's own "moved", kept for the cloud, was worked out at the same
    // moment, so the server lands where the tablet is.
    fun putBack(noted: List<Noted>, countedAt: Map<Pair<String, String>, Long>): Map<Pair<String, String>, Int> {
        val out = LinkedHashMap<Pair<String, String>, Int>()
        for (n in noted) {
            val key = n.item to n.variant
            val counted = countedAt[key]
            if (counted != null && n.at <= counted) continue
            out.merge(key, -n.qty, Int::plus)
        }
        return out.filterValues { it != 0 }
    }
}
```

- [ ] **Step 4: Run the test, expect PASS.** If `everyKindQueuedIsInOneList` names kinds, put each in `RUNG_UP` or `SET_UP` by what it is (a sale's or a day's: rung up; anything set up: set up).
- [ ] **Step 5: Commit** `GoLiveRules.kt`, `GoLiveRulesTest.kt`.

### Task 2: The flag

**Files:** Modify `core/sync/Sync.kt`, `core/data/PosSettings.kt`; Create `core/data/SettingUp.kt`; Test `PosSettingsTest.kt`

- [ ] **Step 1: Failing test in `PosSettingsTest`**

```kotlin
    // only a plan named premium or trial says the business is in the cloud: no plan is no answer
    @Test
    fun cloudIsANamedPlan() {
        assertTrue(PosSettings.parse("""{"plan":"premium"}""").cloud)
        assertTrue(PosSettings.parse("""{"plan":"Trial"}""").cloud)
        assertFalse(PosSettings.parse("""{"plan":"offline"}""").cloud)
        assertFalse(PosSettings.parse("""{}""").cloud)
        assertFalse(PosSettings.parse(null).cloud)
    }
```

- [ ] **Step 2: Run, expect a compile failure.**
- [ ] **Step 3:** In `PosSettings` add the field beside `alone` and its reading beside `alone = isAlone(...)`:

```kotlin
    // The settings name the plan premium or trial: the business is in the
    // cloud. Unlike premium, no plan at all is not taken for it: it ends a
    // tablet's setting up (SettingUp), which no missing word should do.
    val cloud: Boolean = false,
```
```kotlin
                cloud = d.str("plan")?.trim()?.lowercase().let { it == "premium" || it == "trial" },
```

In `Sync.kt`, beside the other keys: `private val SETTING_UP = booleanPreferencesKey("setting_up")`; in `SessionStore.save` remove it with `SETUP_CLOSED` (`it.remove(SETTING_UP)`); and add:

```kotlin
    // ---- setting up, then Go live (an offline tablet's: core/data/GoLive) ----
    // The business was not selling yet when this tablet was set up with its
    // code: what is rung up on it is for trying, and goes at Go live. Kept
    // here, so a backup carries it. It counts only while the tablet works on
    // its own (tryingOut).
    val settingUp: Flow<Boolean> = store.data.map { it[SETTING_UP] ?: false }
    suspend fun setSettingUp(on: Boolean) { store.edit { if (on) it[SETTING_UP] = true else it.remove(SETTING_UP) } }

    // Go live, the tablet's own side, written after the database: the day's
    // bill numbers, the customer and kitchen numbers, the order on the
    // screen and what waited to go on one, the reminders rung, all of them
    // of the sales that went, start again; and the tablet is setting up no
    // more. One write, so it is all or nothing.
    suspend fun wentLive() {
        store.edit {
            listOf(ACTIVE_TICKET, PENDING_DISCOUNT, PENDING_TABLE, PENDING_DINING, SPLIT_SHARES, SEQ_DAY, DUE_RUNG).forEach { k -> it.remove(k) }
            listOf(PENDING_COVERS, PAY_CHECK, SEQ_CUSTOMER).forEach { k -> it.remove(k) }
            listOf("C", "A", "D", "K").forEach { s -> it.remove(intPreferencesKey("seq_$s")) }
            it[PERIOD_SEQ] = 0
            it.remove(SETTING_UP)
        }
    }
```

Create `core/data/SettingUp.kt`:

```kotlin
package com.restopos.core.data

import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first

// Whether what is rung up on this tablet now is for trying: it was set up
// before its business sold for real (SessionStore.settingUp), and it works on
// its own. A business in the cloud is cleared from /admin instead (0104).
// docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
suspend fun TillDatabase.tryingOut(session: SessionStore): Boolean =
    session.settingUp.first() && PosSettings.parse(ops().settings()).alone

fun settingUpFlow(db: TillDatabase, session: SessionStore): Flow<Boolean> =
    combine(session.settingUp, db.ops().settingsFlow()) { on, settings -> on && PosSettings.parse(settings).alone }
```

In `PullWorker.doWork`, right after `session.setLastPull(System.currentTimeMillis())`:

```kotlin
            // Made Premium, or a trial: the business is the cloud's from now on,
            // and /admin clears what it was tried with. A tablet that was setting
            // up is so no more, and what it noted of its sales' stock is the
            // server's to say. Only a plan named so ends it: settings naming
            // none are not an answer.
            if (com.restopos.core.data.PosSettings.parse(db.ops().settings()).cloud && session.settingUp.first()) {
                db.goLive().dropNoted()
                session.setSettingUp(false)
            }
```
(`goLive()` comes in Task 5; this compiles once it is there.)

- [ ] **Step 4: Run `PosSettingsTest`, expect PASS.**
- [ ] **Step 5: Commit.**

### Task 3: Stock noted while trying out

**Files:** Modify `core/data/RetailSales.kt`, `TicketRepository.kt` (pay, near line 713 and 768), `OrderOps.kt` (refund, near 505 and 515), `Deposits.kt` (create near 113 and 119, cancel near 257 and 265)

- [ ] **Step 1:** `moveStock` takes `noted: String? = null` and writes, per product after the parts are added up:

```kotlin
// noted: on a tablet that is setting up (tryingOut), each product's move is
// written down as well, under this reason (sale, refund, deposit,
// deposit_release) and marked trial, so that Go live puts it back exactly
// (GoLive): the shelf moves by these and nothing else on the tablet says so.
suspend fun TillDatabase.moveStock(store: String, lines: List<Pair<TicketLineEntity, Int>>, noted: String? = null) {
    …as before…
    val at = System.currentTimeMillis()
    moves.forEach { (key, by) ->
        val (itemId, variant) = key
        if (retail().moveLevel(store, itemId, variant, by) == 0) retail().upsertLevels(listOf(StockLevelEntity(store, itemId, variant, by)))
        if (noted != null && by != 0) stock().upsertMovements(listOf(StockMovementEntity(Uuid7.next(), store, itemId, variant, by, noted, ref_type = GoLiveRules.TRIAL, created_at = at)))
    }
}
```

- [ ] **Step 2:** each caller reads `val trial = db.tryingOut(session)` before its `db.withTransaction` and passes `noted = if (trial) "sale" else null` (pay), `"refund"` (refund, inside `if (restock)`), `"deposit"` (deposit created), `"deposit_release"` (deposit cancelled).
- [ ] **Step 3:** build the debug variant's Kotlin (`:app:compileDebugKotlin`), expect success.
- [ ] **Step 4: Commit.**

### Task 4: TEST, NOT A RECEIPT

**Files:** Modify `core/print/Docs.kt`, `core/print/Printing.kt`; Test `core/print/DocsTest.kt`

- [ ] **Step 1: Failing test** in `DocsTest` (use its own reader of a page's lines):

```kotlin
    // a tablet that is setting up says so at the top and at the foot of a paper, and only then
    @Test
    fun aTrialPaperSaysSoTopAndFoot() {
        val trial = Docs.reportLook(sampleReport(), shop, Paper(trial = true))
        assertEquals(Docs.TRIAL_MARK, trial.first().trim())
        assertEquals(Docs.TRIAL_MARK, trial.last().trim())
        assertFalse(Docs.reportLook(sampleReport(), shop, Paper()).any { it.contains("TEST") })
    }
```
(`sampleReport()` and `shop`: the ones the file already builds a report with; if it has none, a `ReportDoc` with a title and one line.)

- [ ] **Step 2: Run, expect a compile failure.**
- [ ] **Step 3:** `Paper` gets `val trial: Boolean = false`. In `Docs`:

```kotlin
    // what a paper printed while the tablet is setting up says it is not (GoLive)
    const val TRIAL_MARK = "TEST, NOT A RECEIPT"

    // A page. On a tablet that is setting up it starts with the mark, and end() puts it at its foot too.
    private fun page(paper: Paper): EscPos = EscPos(paper.columns).also { if (paper.trial) it.trialMark() }
    private fun EscPos.trialMark() { align(EscPos.Align.Center).bold(true).line(TRIAL_MARK).bold(false).align(EscPos.Align.Left) }
```
`end(paper)` begins with `if (paper.trial) { line(); trialMark() }`. Every `EscPos(paper.columns)` in `Docs.kt` becomes `page(paper)`.

`Printing`: `@Volatile private var trial = false`, kept by `init { scope.launch { com.restopos.core.data.settingUpFlow(db, session).collect { trial = it } } }`, and `fun paper(p: PrinterEntity) = Paper(EscPos.columnsFor(p.paper_mm), p.feed_lines, p.cut, trial)`.

- [ ] **Step 4: Run `DocsTest` and `PapersFixtureTest`, expect PASS** (the fixtures use `Paper()`: unchanged).
- [ ] **Step 5: Commit.**

### Task 5: Go live

**Files:** Create `core/database/GoLive.kt`, `core/data/GoLive.kt`; Modify `core/database/TillDatabase.kt`

- [ ] **Step 1:** `GoLiveDao`:

```kotlin
package com.restopos.core.database

import androidx.room.Dao
import androidx.room.Query
import androidx.room.Transaction

// What Go live reads and clears on a tablet that was setting up
// (core/data/GoLive). Every table that holds what was rung up is named here,
// and no table of what was set up.
@Dao
interface GoLiveDao {
    // how much was rung up, for the sheet that asks
    @Query("SELECT COUNT(*) FROM receipts") suspend fun receipts(): Int
    @Query("SELECT COUNT(*) FROM tickets") suspend fun orders(): Int
    @Query("SELECT COUNT(*) FROM shifts") suspend fun days(): Int

    // what the sales moved on the shelf while setting up (moveStock, noted)
    @Query("SELECT * FROM stock_movements WHERE ref_type = 'trial'") suspend fun noted(): List<StockMovementEntity>
    @Query("DELETE FROM stock_movements WHERE ref_type = 'trial'") suspend fun dropNoted()
    // when each product was last set by a count completed here: counted, or set to nothing as not counted
    @Query(
        """SELECT l.item_id AS item_id, l.variant_id AS variant_id, MAX(c.completed_at) AS at
           FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id
           WHERE c.status = 'completed' AND c.completed_at IS NOT NULL AND l.left_out = 0 AND l.counted IS NOT NULL
           GROUP BY l.item_id, l.variant_id""",
    )
    suspend fun countedAt(): List<CountedAt>

    @Query("DELETE FROM outbox WHERE type IN (:kinds)") suspend fun dropQueued(kinds: List<String>)
    @Query("UPDATE pos_devices SET last_receipt_seq = 0 WHERE id = :device") suspend fun numbersFromOne(device: String)

    // children before what they belong to
    @Transaction
    suspend fun clearRungUp() {
        tickets1(); tickets2(); tickets3(); receipts1(); receipts2(); receipts3(); receipts4(); receipts5()
        kitchen1(); kitchen2(); kitchen3(); tickets4()
        accounts1(); accounts2(); accounts3(); deposits1(); deposits2(); deposits3(); notes()
        cash(); counts(); closes(); shifts(); punches(); bookings(); requests(); guests(); log()
    }
    @Query("DELETE FROM ticket_line_modifiers") suspend fun tickets1()
    @Query("DELETE FROM ticket_line_taxes") suspend fun tickets2()
    @Query("DELETE FROM ticket_lines") suspend fun tickets3()
    @Query("DELETE FROM receipt_line_taxes") suspend fun receipts1()
    @Query("DELETE FROM receipt_line_mods") suspend fun receipts2()
    @Query("DELETE FROM receipt_lines") suspend fun receipts3()
    @Query("DELETE FROM receipt_payments") suspend fun receipts4()
    @Query("DELETE FROM receipts") suspend fun receipts5()
    @Query("DELETE FROM kds_parts") suspend fun kitchen1()
    @Query("DELETE FROM kds_out") suspend fun kitchen2()
    @Query("DELETE FROM kds_tickets") suspend fun kitchen3()
    @Query("DELETE FROM tickets") suspend fun tickets4()
    @Query("DELETE FROM account_payment_lines") suspend fun accounts1()
    @Query("DELETE FROM account_payments") suspend fun accounts2()
    @Query("DELETE FROM account_bills") suspend fun accounts3()
    @Query("DELETE FROM deposit_payments") suspend fun deposits1()
    @Query("DELETE FROM deposit_lines") suspend fun deposits2()
    @Query("DELETE FROM deposits") suspend fun deposits3()
    @Query("DELETE FROM credit_notes") suspend fun notes()
    @Query("DELETE FROM cash_movements") suspend fun cash()
    @Query("DELETE FROM drawer_counts") suspend fun counts()
    @Query("DELETE FROM day_closes") suspend fun closes()
    @Query("DELETE FROM shifts") suspend fun shifts()
    @Query("DELETE FROM timeclock_punches") suspend fun punches()
    @Query("DELETE FROM bookings") suspend fun bookings()
    @Query("DELETE FROM till_requests") suspend fun requests()
    @Query("DELETE FROM guest_orders") suspend fun guests()
    @Query("DELETE FROM till_log") suspend fun log()
}

data class CountedAt(val item_id: String, val variant_id: String, val at: Long)
```
`TillDatabase`: `abstract fun goLive(): GoLiveDao` (a DAO is not part of the schema: the version stays 31).

- [ ] **Step 2:** `core/data/GoLive.kt`:

```kotlin
package com.restopos.core.data

import androidx.room.withTransaction
import com.restopos.core.database.StockLevelEntity
import com.restopos.core.database.TillDatabase
import com.restopos.core.print.Printing
import com.restopos.core.sync.SessionStore
import javax.inject.Inject
import javax.inject.Singleton

// Go live, on a tablet that was setting up (SettingUp): what was rung up goes,
// what was set up stays. One transaction for the database, then the tablet's
// own numbers, then the flag, last: a Go live cut short is finished by
// pressing it again. docs/superpowers/specs/2026-10-18-tablet-setting-up-design.md
@Singleton
class GoLive @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
    private val printing: Printing,
) {
    // what the sheet says goes
    data class Rung(val receipts: Int, val orders: Int, val days: Int)
    suspend fun rung(): Rung = db.goLive().let { Rung(it.receipts(), it.orders(), it.days()) }

    suspend fun go(): Result<Unit> = runCatching {
        check(db.tryingOut(session)) { "This till is not being set up." }
        val store = session.storeId() ?: error("This tablet is not set up.")
        val device = session.deviceId() ?: error("This tablet is not set up.")
        val dao = db.goLive()
        db.withTransaction {
            // the shelf first, while what the sales noted is still there to read
            val counted = dao.countedAt().associate { (it.item_id to it.variant_id) to it.at }
            GoLiveRules.putBack(dao.noted().map { GoLiveRules.Noted(it.item_id, it.variant_id, it.qty, it.created_at) }, counted).forEach { (key, by) ->
                val (item, variant) = key
                if (db.retail().moveLevel(store, item, variant, by) == 0) db.retail().upsertLevels(listOf(StockLevelEntity(store, item, variant, by)))
            }
            dao.dropNoted()
            dao.clearRungUp()
            dao.dropQueued(GoLiveRules.RUNG_UP.toList())
            dao.numbersFromOne(device)
        }
        // Try again on a test receipt would print it as a real one
        printing.clearJobs()
        session.wentLive()
    }
}
```

- [ ] **Step 3:** `:app:compileDebugKotlin` (Room checks every query against the schema here), expect success.
- [ ] **Step 4: Commit.**

### Task 6: The question on the code card

**Files:** Modify `feature/auth/SetupParts.kt`, `AuthScreens.kt` (the `byCode` card), `AuthViewModels.kt` (`useCode`)

- [ ] **Step 1:** `SetupParts.kt`:

```kotlin
// One of two answers, side by side: the one picked is lit.
@Composable
internal fun Choice(label: String, on: Boolean, modifier: Modifier = Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    Box(
        modifier.heightIn(min = 54.dp).clip(RoundedCornerShape(12.dp)).background(if (on) V.Blue else V.Well)
            .border(1.dp, if (on) V.Blue else V.Stroke, RoundedCornerShape(12.dp))
            .then(if (enabled) Modifier.press(0.98f, onClick) else Modifier).padding(horizontal = 12.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
    ) { T(label, 14.sp, 700, if (on) Color.White else V.Text, lines = 2, align = TextAlign.Center) }
}
```

- [ ] **Step 2:** In the code card, `var selling by remember { mutableStateOf<Boolean?>(null) }`; when `!reauth`, under the code:

```kotlin
                T("Is this business already selling with EasyPay?", 13.sp, 600, V.Text2)
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    Choice("Not yet: it is being set up", selling == false, Modifier.weight(1f), enabled = !busy) { selling = false }
                    Choice("Yes: this tablet sells for real", selling == true, Modifier.weight(1f), enabled = !busy) { selling = true }
                }
                selling?.let {
                    T(
                        if (!it) "What is rung up on it is for trying: it prints TEST, and goes when the owner taps Go live, under Settings, This till. What is set up stays."
                        else "Every sale on it is real from the first one.",
                        13.sp, 500, V.Text2, lines = 3, height = 18.sp,
                    )
                }
```
The key is ready only with an answer: `ready = CodeForm.ready(code) && (reauth || selling != null)`, its words `"Say whether the business is selling"` while the code is typed and no answer is picked; `vm.useCode(code, trying = selling == false)`.

- [ ] **Step 3:** `useCode(code: String, trying: Boolean = false)`; in the new tablet's path, after `session.setRegisteredAt(...)`: `session.setSettingUp(trying)`.
- [ ] **Step 4:** `:app:compileDebugKotlin`. **Commit.**

### Task 7: Settings, This till: the card and the sheet

**Files:** Create `feature/settings/GoLivePage.kt`; Modify `SettingsScreen.kt` (TillPage gets `onLive`, calls `SettingUpCard(onLive)` after the alerts; its caller passes `onLock`; one Help entry for the restaurant's and the shop's lists)

- [ ] **Step 1:** `GoLivePage.kt`:

```kotlin
package com.restopos.feature.settings

// imports as the code needs them

// Settings, This till, on a tablet that is setting up: what that means, and
// Go live (core/data/GoLive). The owner's to do; anyone else is asked for the
// owner's PIN. The sheet says what goes, with how many, and what stays.
@HiltViewModel
class GoLiveViewModel @Inject constructor(
    private val goLive: GoLive,
    db: TillDatabase,
    session: SessionStore,
    private val staff: StaffSession,
    private val approvals: Approvals,
) : ViewModel() {
    val settingUp: StateFlow<Boolean> = settingUpFlow(db, session).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)
    // the sheet, open with what would go
    val rung = MutableStateFlow<GoLive.Rung?>(null)
    val busy = MutableStateFlow(false)

    fun ask() {
        val open: () -> Unit = { viewModelScope.launch { rung.value = goLive.rung() } }
        if (staff.can("*")) open() else approvals.ask("*", "put this till live") { open() }
    }
    fun close() { if (!busy.value) rung.value = null }
    fun go(then: () -> Unit) = viewModelScope.launch {
        if (busy.value) return@launch
        busy.value = true
        goLive.go().fold(
            { rung.value = null; Toaster.say("This till is live. Receipts start again at 1: open the day to start selling."); then() },
            { Toaster.say(it.message ?: "That did not work.") },
        )
        busy.value = false
    }
}

@Composable
internal fun SettingUpCard(onLive: () -> Unit, vm: GoLiveViewModel = hiltViewModel()) {
    val on by vm.settingUp.collectAsState()
    val rung by vm.rung.collectAsState()
    val busy by vm.busy.collectAsState()
    if (!on) return
    Row(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(V.AmberWash).padding(horizontal = 18.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 14.dp), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            T("This till is being set up", 16.sp, 800, V.AmberText)
            T("What is rung up here is for trying: it prints TEST, and goes when the business goes live. The menu, the staff, the stock and all that is set up stay.", 13.sp, 500, V.Text2, lines = 3)
        }
        VBtn("Go live", bg = V.Blue, fg = Color.White, height = 46.dp, weight = 800) { vm.ask() }
    }
    rung?.let { r -> GoLiveSheet(r, busy, onClose = vm::close, onGo = { vm.go(onLive) }) }
}

@Composable
private fun GoLiveSheet(r: GoLive.Rung, busy: Boolean, onClose: () -> Unit, onGo: () -> Unit) {
    Sheet(onDismiss = onClose, width = 600.dp, pad = 24.dp, gap = 12.dp) {
        SheetHead("Go live?", "From now on what is sold here is real: its receipts, its days and its stock.", onClose)
        Caps("What goes", V.Text2)
        T(listOf(many(r.receipts, "receipt"), many(r.orders, "order"), many(r.days, "day")).joinToString(", ") + ", with their payments, refunds, cash in and out, clock-ins, deposits, credit notes and account bills.", 15.sp, 600, lines = 4)
        Caps("What stays", V.Text2)
        T("The menu, the staff and their PINs, the tables, the printers, the settings, the customers, the suppliers and the stock. What the sales took off the shelf goes back on it.", 15.sp, 500, lines = 4)
        T("Receipts start again at 1. This cannot be undone.", 13.sp, 600, V.AmberText, lines = 2)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f))
            VBtn("Cancel", height = 50.dp, enabled = !busy, onClick = onClose)
            VBtn(if (busy) "Going live…" else "Go live", bg = V.Blue, fg = Color.White, height = 50.dp, weight = 800, enabled = !busy, onClick = onGo)
        }
    }
}

private fun many(n: Int, one: String) = "$n $one" + if (n == 1) "" else "s"
```

- [ ] **Step 2:** `SettingsScreen.kt`: `Page.Till -> TillPage(vm, keys, network, standing, shop, onSignIn, onRejected, onSetUp, onLive = onLock) { page = it }`; TillPage gets `onLive: () -> Unit` and calls `SettingUpCard(onLive)` right after `standing.forEach { Alert(it) }`. Help, both lists: "Trying the till before opening" — "A tablet set up with a code for a business that is not selling yet is being set up: an amber strip says so, and everything it prints says TEST. Ring up whatever you like to try it. The day the business opens, the owner taps Go live under Settings, This till: what was rung up goes (orders, receipts, days, cash, clock-ins), what was set up stays, and receipts start again at 1. Each tablet goes live on its own."
- [ ] **Step 3:** compile. **Commit.**

### Task 8: The strip

**Files:** Modify `feature/main/MainShell.kt`

- [ ] **Step 1:** `ShellViewModel`: `val settingUp: StateFlow<Boolean> = com.restopos.core.data.settingUpFlow(db, session).stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), false)`. In the shell, after `SyncNotices(...)`: `if (settingUp) SettingUpStrip { shell.go(Screen.Settings) }`, and:

```kotlin
// A tablet being set up says so on every screen (core/data/GoLive): what is
// rung up on it is for trying, and goes at Go live.
@Composable
private fun SettingUpStrip(onGoLive: () -> Unit) {
    Row(Modifier.fillMaxWidth().background(V.AmberWash).padding(horizontal = 16.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        T("Setting up. What is rung up here is for trying, and goes when the business goes live.", 13.sp, 600, V.AmberText, Modifier.weight(1f), lines = 2)
        VBtn("Go live", height = 34.dp, radius = 10.dp, size = 14.sp, onClick = onGoLive)
    }
}
```
- [ ] **Step 2:** compile. **Commit.**

### Task 9: Debug seed, /admin's sentence

- [ ] `DemoReceiver`, after `seed(...)`: `// --ez setting_up true: the tablet is being set up (GoLive), as one set up with "Not yet"` then `if (intent.getBooleanExtra("setting_up", false)) deps.session().setSettingUp(true)`.
- [ ] `view.tsx`, an offline client's "What it was tried with": add "A tablet set up with its code before the business sold for real (Not yet) is being set up on its own: its owner clears what was rung up on it with Go live, under Settings, This till, and keeps what was set up." Check with `npx tsc --noEmit` in `web/`.
- [ ] **Commit.**

### Task 10: Run it

- [ ] All unit tests: `:app:testDebugUnitTest`, expect PASS; `:app:assembleDebug`; `./gradlew --stop`.
- [ ] Emulator (`easypay_claude_size`, 5598, with its window, said first; `adb devices` and free memory checked before): `pm clear`, `DEMO_SHOP --es type restaurant --es plan offline --ez setting_up true`, the stand-in printer at `10.0.2.2`. Watch: the strip; a sale, a refund that puts back, a sale of an item made of others, cash out, a day closed, a delivery and a count (shop seed if the restaurant has no stock papers); the papers in `prints/` say TEST at top and foot; Go live as the owner; read the tablet (`run-as … sqlite3 -readonly`): no receipts, tickets, shifts; the queue holds only set-up kinds; stock as before the sales; the next receipt is …-000001 and prints no TEST; the strip is gone.
- [ ] `node db/scripts/read-till-state.cjs` then `node db/scripts/replay-demo-outbox.cjs <file> [restaurant]` against dev: REPLAY PASS.
- [ ] Record what was seen and not, at the foot of this file. **Commit.**

---

## Record: what was built, run and seen (2026-10-18)

Built as planned, on `claude/tablet-golive` (rebased on `restopos` after the other session's commits of that afternoon), plus one thing the run showed: **Go live on the start screen** too. Reaching Settings needs an open day, so the owner would have opened the first real day, pressed Go live (which takes that day away with the rest) and opened it again. On the start screen nobody is signed in, so the owner's PIN is always asked for there; a till with no staff PINs has no such key there (its Settings opens with one tap).

**Unit tests:** 675 pass (`GoLiveRulesTest` 7, `PosSettingsTest` cloud, `DocsTest` the mark). The debug app builds. `tsc` clean.

**Run on `easypay_claude_size` (5598), with its window**, the made-up shop on the offline plan set up with `--ez setting_up true` (and deposits), the stand-in printer at `10.0.2.2`:
- The strip under the top bar; the Setting up card in This till; the sell screen still whole at 1280 x 800.
- Set up while trying: the printer (Set-up, Printer), Postcard set's price to Rs 160, 5 Woven baskets added.
- Rung up: a sale of 2 mugs and a scarf; an exchange of 1 mug for 2 postcards (the mug back on the shelf); a deposit of 2 candles for a new customer; a count of Home (candles 29 counted 30, the others left); a delivery of 10 chocolates; a sale of a candle and a chocolate after the count and the delivery; cash out Rs 100; the day closed.
- Every paper printed (receipt, cash-out slip, Z report) said TEST, NOT A RECEIPT at its top and at its foot. The set-up's own "Print a test page" does not (it is built with a paper of its own, before the printer is saved).
- Go live tried as Ben (cashier): approval asked, only Aisha (owner) offered; with her PIN the sheet said "4 receipts, 4 orders, 2 days".
- After it, read off the tablet: no receipts, orders, lines, shifts, closings, cash, clock-ins, deposits or noted moves; the customer, the count, the deliveries and the price kept; the queue held printer.save, item.set_price, stock.adjust, customer.upsert, count.complete, delivery.receive; stock exactly as worked out beforehand (mug 26, scarf 6, postcards 40, candle 30: the deposit before the count stayed out, the sale after it went back; chocolate 28; basket 9); the receipt number at 0 and no `setting_up` in the preferences. The strip was gone; the next sale was DM-T1-000001, customer C-01, with no mark.
- `read-till-state.cjs` and `replay-demo-outbox.cjs` against dev: the server took all 11 operations (the six kept, then the first real sale), the sale's figures, lines and payment the same, and its 19 stock figures the tablet's. **REPLAY PASS**, rolled back.
- Second run after the start-screen key: seeded again, a sale, Log out, Go live on the start screen: owner's PIN asked, sale, day and clock-in gone, the mug back, the queue empty.

**Not seen:** a restaurant (only the shop was run; a restaurant's tables, kitchen tickets and made-of items go through the same code: the shop's product sheet has no Made of, so parts were not run); a real tablet and a real printer; a tablet filled from a backup of one setting up; the flag ending at a Connect to the cloud (needs a server that says premium); a till with no staff PINs; screenshots of the sheets (the emulator's graphics tore twice: the words were read instead).
