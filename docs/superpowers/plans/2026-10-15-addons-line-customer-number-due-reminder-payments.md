# Add-ons on one line, customer number, due reminder, day's payments: build plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build part 1 of the owner's 2026-10-15 restaurant asks, as agreed in `docs/superpowers/specs/2026-10-15-addons-line-customer-number-due-reminder-payments-design.md`:
- a line's add-ons on one line on the customer's paper;
- a customer number (01, 02 … back to 01 when the till's day is closed), large on the receipt, the bill and the kitchen ticket;
- a sound and a banner before an order for later is due, with the minutes set by the restaurant;
- "See the day's payments" as a permission of its own, taken off Cashiers.

**Architecture:**
- The papers are laid out in `core/print/Docs.kt` from plain data (`ReceiptDoc`, `KitchenDoc`) that `core/data/DocBuilder.kt` fills.
- The customer number lives in the order's existing `order_no` (`A-05`), counted by `SessionStore` and reset where a day closing already resets the bill count.
- The reminder:
  - its rule is a pure object (`DueReminder`);
  - an app-wide singleton (`DueReminders`) watches the board every 30 seconds, rings `Chime.due()` and holds the banners that `MainShell` draws;
  - its minutes are a business setting (`dueReminderMinutes`), saved from the back office or from the tablet through `settings.save`.
- The permission split:
  - the three permission lists (`Perms.kt`, `web/lib/perms.ts`, `db/tests/fixtures/till-office/perms.json`) and the Payments page;
  - migration 0111 (grant to every role that sees the day's figures, new clients' Manager);
  - the tablet's database 27 → 28 (the same grant for a tablet that works on its own).

**Tech Stack:**
- Till: Kotlin, Jetpack Compose, Room, DataStore; JUnit 4 for unit tests (plain JVM, no Robolectric).
- Server: PostgreSQL (Neon) plpgsql migrations, with suites in `db/tests/*.cjs` run with node on the dev branch.
- Back office: Next.js / TypeScript, with node `.mjs` tests and `tsc`.

**Ground rules for whoever runs this:**
- Work on branch `restopos`. Commit after each task. **Never push, never tag**: pushing and tagging are the owner's (memory: one tag puts production live).
- Before starting, `git fetch github` and compare with `github/restopos`: another session may have pushed since this plan was written. Re-read a file before editing it.
- Dev database only: `.env.local` points at the `dev-review` branch. Never run anything against production.
- Gradle and an emulator do not fit in memory together on this PC: close the emulator before a Gradle build, or build with `--priority low --max-workers 2`.
- Unit test command (from `C:\Projects\RestoPOS`): `android/gradlew -p android :app:testDebugUnitTest --tests "<class>"`. Compile check: `android/gradlew -p android :app:compileDebugKotlin`.
- All paths below are from the repository root. The till's sources are under `android/app/src/main/java/com/restopos/` (written `app/` below), its tests under `android/app/src/test/java/com/restopos/` (written `test/`).

---

### Task 0: One line of the spec said wrong

The spec says the count is not reset by "a sign-out". It is: signing a tablet out clears everything the tablet holds (`SessionStore.clear`), the count included.

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-addons-line-customer-number-due-reminder-payments-design.md`

- [ ] **Step 1: Correct the line**

Replace:

```
Nothing else resets it: not midnight, not a restart, not a sign-out. A till left open for two days counts on.
```

with:

```
Nothing else resets it: not midnight, not a restart. A till left open for two days counts on. Signing the tablet out clears everything it holds, so a tablet signed in again starts at 01.
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-10-15-addons-line-customer-number-due-reminder-payments-design.md
git commit -m "spec: a sign-out clears the customer count with everything else the tablet holds" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 1: A line's add-ons on one line, on the customer's paper

**Files:**
- Modify: `app/core/print/Docs.kt:273` (in `page`)
- Modify: `app/core/data/OrderOps.kt:293` (in `receiptText`)
- Modify: `app/core/data/Kitchen.kt:36-39` (comment only)
- Test: `test/core/print/DocsTest.kt`

- [ ] **Step 1: Write the failing test**

Add to `DocsTest`, after `theAmountSitsAtTheEndOfItsLine`:

```kotlin
    // The owner: "for client receipt the add ons are in vertical. For each add on it should be horizantal".
    @Test
    fun aLinesAddOnsAreOneLineOnTheCustomersPaper() {
        val burger = receipt.copy(lines = listOf(DocLine(1000, "Burger", 25000, listOf("Cheese", "Bacon", "2 x Egg"))))
        val lines = read(Docs.receipt(burger, shop, Paper(48, 3, true), 2)).lines
        assertTrue(lines.any { it == "  + Cheese, Bacon, 2 x Egg" })
        assertEquals(1, lines.count { it.trimStart().startsWith("+") })
        // too long for 58 mm paper, it goes on under the +
        val long = burger.copy(lines = listOf(DocLine(1000, "Burger", 25000, listOf("Cheese", "Bacon", "Extra sauce", "Grilled onions", "Jalapenos"))))
        val narrow = read(Docs.receipt(long, shop, Paper(32, 3, true), 2)).lines
        val at = narrow.indexOfFirst { it.startsWith("  + Cheese, Bacon") }
        assertTrue(at >= 0)
        assertTrue(narrow[at + 1].startsWith("  ") && !narrow[at + 1].trimStart().startsWith("+"))
        assertTrue(narrow.all { it.length <= 32 })
        // the kitchen's paper keeps a line for each add-on group
        val kitchen = read(Docs.kitchen(KitchenDoc("ORDER", "Table 4", 1_790_000_000_000, null, null, null, null, burger.lines.map { it.copy(mods = listOf("Cheese, Bacon", "2 x Egg")) }, "Kitchen"), Paper(32, 2, true))).lines
        assertEquals(2, kitchen.count { it.trimStart().startsWith("*") })
    }
```

- [ ] **Step 2: Run it to see it fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.print.DocsTest"`
Expected: FAIL in `aLinesAddOnsAreOneLineOnTheCustomersPaper` (three lines start with "+").

- [ ] **Step 3: Put the add-ons on one line**

In `Docs.kt`, in `page`, replace:

```kotlin
            l.mods.forEach { m -> p.wrapped("+ $m", indent = "  ") }
```

with:

```kotlin
            // all of a line's add-ons on one line, wrapped under the + when too long (the owner, 2026-10-15)
            if (l.mods.isNotEmpty()) p.wrapped("+ " + l.mods.joinToString(", "), indent = "  ")
```

In `OrderOps.kt`, in `receiptText`, replace:

```kotlin
            l.mods.forEach { m -> out += "   + $m" }
```

with:

```kotlin
            if (l.mods.isNotEmpty()) out += "   + " + l.mods.joinToString(", ")
```

In `Kitchen.kt`, replace the comment's last sentence:

```kotlin
// own line. The customer's receipt keeps one add-on a line.
```

with:

```kotlin
// own line. The customer's receipt has them all on one line (Docs.page).
```

- [ ] **Step 4: Run the tests to see them pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.print.DocsTest"`
Expected: PASS, the existing `aReceiptFitsBothPaperWidths` included (it looks for `+ Achard`).

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/print/Docs.kt android/app/src/main/java/com/restopos/core/data/OrderOps.kt android/app/src/main/java/com/restopos/core/data/Kitchen.kt android/app/src/test/java/com/restopos/core/print/DocsTest.kt
git commit -m "till: a line's add-ons on one line on the receipt, the bill and the receipt sent as text, wrapped under the + on narrow paper; the kitchen's paper keeps a line per add-on group" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The customer number's rules

**Files:**
- Create: `app/core/data/CustomerNumber.kt`
- Test: `test/core/data/CustomerNumberTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// The owner: "if the customer comes in first it should be customer number 01
// then if we have last customer we can make it customer number 10".
class CustomerNumberTest {
    @Test fun `two digits at least, the letter of its kind in front`() {
        assertEquals("C-01", CustomerNumber.label("C", 1))
        assertEquals("A-10", CustomerNumber.label("A", 10))
        assertEquals("D-100", CustomerNumber.label("D", 100))
    }

    @Test fun `the papers print the number alone`() {
        assertEquals("05", CustomerNumber.digits("A-05"))
        // an order numbered before this build
        assertEquals("7", CustomerNumber.digits("A-7"))
        assertNull(CustomerNumber.digits(null))
        assertNull(CustomerNumber.digits("Table 4"))
        assertNull(CustomerNumber.digits("A-"))
    }

    @Test fun `an order whose kind changes keeps its number`() {
        assertEquals("A-05", CustomerNumber.relabel("C-05", "A"))
        assertEquals("weird", CustomerNumber.relabel("weird", "A"))
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.CustomerNumberTest"`
Expected: FAIL to compile, `CustomerNumber` is not defined.

- [ ] **Step 3: Write the object**

`app/core/data/CustomerNumber.kt`:

```kotlin
package com.restopos.core.data

// The number a customer is called by when the order is ready (the owner,
// 2026-10-15: "customer number 01 ... closing the register resets this
// number"). One count on each till, from 1, back to 1 when the till's day is
// closed (SessionStore.nextCustomer, dayClosed). It is kept in the order's
// number with the letter of its kind in front: C-01 at the counter, A-05 a
// takeaway, D-12 a delivery. An order at a table has none.
object CustomerNumber {
    fun label(letter: String, n: Int): String = "$letter-${n.toString().padStart(2, '0')}"

    // the number alone, as the papers print it: "05" of "A-05"; null when the order has none
    fun digits(orderNo: String?): String? =
        orderNo?.substringAfterLast('-', "")?.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }

    // the same number under the letter of another kind: C-05 becomes A-05
    fun relabel(orderNo: String, letter: String): String = digits(orderNo)?.let { "$letter-$it" } ?: orderNo
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.CustomerNumberTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/data/CustomerNumber.kt android/app/src/test/java/com/restopos/core/data/CustomerNumberTest.kt
git commit -m "till: the customer number's rules: C-01, two digits at least, the number alone for the papers, the letter changed with the kind" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: One count per till, reset by the day closing

These are DataStore and Room calls. No plain-JVM test reaches them, so they are checked by compiling here and on the emulator in Task 13.

**Files:**
- Modify: `app/core/sync/Sync.kt`: keys near line 290; `nextNumber` near line 445; new `nextCustomer` and `dayClosed`
- Modify: `app/core/data/TicketRepository.kt:95-98` (`ensureTicket`) and `:215-223` (`setType`)
- Modify: `app/core/data/CashOps.kt:397,420,492` (the three closings)

- [ ] **Step 1: The count in `SessionStore`**

In `Sync.kt`, after `private val SEQ_DAY = stringPreferencesKey("seq_day")`, add:

```kotlin
// the customer number this till gave last (CustomerNumber); a day closing removes it
private val SEQ_CUSTOMER = intPreferencesKey("seq_customer")
```

Replace the comment above `nextNumber`:

```kotlin
    // A number that counts up through the day and starts again the next:
    // "C" for counter orders, "A" takeaways, "D" deliveries, "K" kitchen tickets.
```

with:

```kotlin
    // A number that counts up through the day and starts again the next: "K"
    // for kitchen tickets. (C, A and D counted the orders until the customer
    // number, nextCustomer.)
```

After `nextNumber`, add:

```kotlin
    // The customer number this till gives next (CustomerNumber): one count
    // for every order without a table, from 1, started again only by a day
    // closing (dayClosed), not at midnight. The owner: "closing the register
    // resets this number".
    suspend fun nextCustomer(): Int {
        var out = 1
        store.edit {
            out = (it[SEQ_CUSTOMER] ?: 0) + 1
            it[SEQ_CUSTOMER] = out
        }
        return out
    }

    // This till's day is closed: the bills since the closing, and the
    // customer numbers, start again.
    suspend fun dayClosed() {
        store.edit {
            it[PERIOD_SEQ] = 0
            it.remove(SEQ_CUSTOMER)
        }
    }
```

- [ ] **Step 2: Orders take the customer number**

In `TicketRepository.ensureTicket`, replace:

```kotlin
        // An order with no table is known by a short number that counts up
        // through the day. A takeaway or delivery also goes on the board: new,
        // and due when the kitchen has had its time.
        val no = if (table == null) series(kind).let { "$it-${session.nextNumber(it)}" } else null
```

with:

```kotlin
        // An order with no table is known by its customer number
        // (CustomerNumber): one count on this till, back to 01 once its day is
        // closed. A takeaway or delivery also goes on the board: new, and due
        // when the kitchen has had its time.
        val no = if (table == null) CustomerNumber.label(series(kind), session.nextCustomer()) else null
```

In `TicketRepository.setType`, replace:

```kotlin
        // The number's letter says what kind of order it is. One whose kind
        // changes before the kitchen has had anything takes a number of its
        // new kind (C-7 becomes A-3); once the kitchen knows it by a number,
        // or part of it is paid, it keeps that number.
        val letter = series(type.kind)
        if (t.table_id == null && t.order_no?.startsWith("$letter-") == false && !sent && db.receipts().paidForTicket(t.id) == 0L) {
            val no = "$letter-${session.nextNumber(letter)}"
```

with:

```kotlin
        // The number's letter says what kind of order it is. One whose kind
        // changes before the kitchen has had anything takes the letter of its
        // new kind and keeps its number (C-07 becomes A-07): it is the number
        // the customer was given. Once the kitchen knows it, or part of it is
        // paid, it stays as it is.
        val letter = series(type.kind)
        val was = t.order_no
        if (t.table_id == null && was != null && !was.startsWith("$letter-") && !sent && db.receipts().paidForTicket(t.id) == 0L) {
            val no = CustomerNumber.relabel(was, letter)
```

(The next line, `updateMeta({ it.copy(order_no = no) }) { put("order_no", no) }.getOrThrow()`, stays.)

- [ ] **Step 3: The three closings reset it**

In `CashOps.kt` there are exactly three `session.setPeriodSeq(0)` lines: in `closeDay`, `closeUnclosed` and `closeDayAsked`. Replace each with:

```kotlin
        session.dayClosed()
```

Check none is left: `grep -n "setPeriodSeq(0)" android/app/src/main/java/com/restopos/core/data/CashOps.kt` prints nothing.

- [ ] **Step 4: Compile**

Run: `android/gradlew -p android :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/sync/Sync.kt android/app/src/main/java/com/restopos/core/data/TicketRepository.kt android/app/src/main/java/com/restopos/core/data/CashOps.kt
git commit -m "till: one customer count per till for every order without a table (C-01, A-02, D-03), back to 01 when this till's day is closed, on the till, with no day open or asked from the back office; an order whose kind changes keeps its number under its new letter" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: The customer number on the papers

**Files:**
- Modify: `app/core/print/Docs.kt`: `ReceiptDoc` (line 51 on), `KitchenDoc` (line 85 on), `page`, `kitchen`
- Modify: `app/core/data/DocBuilder.kt`: `receipt` and `kitchen`
- Test: `test/core/print/DocsTest.kt`

- [ ] **Step 1: Write the failing tests**

Add to `DocsTest`:

```kotlin
    // The owner: "a customer counter number so when an order is completed, the cashier can call out the customer order number".
    @Test
    fun theCustomerNumberIsLargeOnTheReceiptAndTheBill() {
        val takeaway = receipt.copy(order = "A-05 · Ravi", customerNo = "05")
        for (cols in listOf(32, 48)) {
            val lines = read(Docs.receipt(takeaway, shop, Paper(cols, 3, true), 2)).lines
            assertTrue("a line is wider than $cols", lines.all { it.length <= cols })
            // under RECEIPT, above the receipt's own number
            val at = lines.indexOfFirst { it.trim() == "CUSTOMER No. 05" }
            assertTrue(at > lines.indexOfFirst { it.trim() == "RECEIPT" })
            assertTrue(at < lines.indexOfFirst { it.startsWith("No.") })
        }
        val bill = read(Docs.receipt(takeaway.copy(kind = "bill", number = "", payments = emptyList()), shop, Paper(), 2)).lines
        assertTrue(bill.any { it.trim() == "CUSTOMER No. 05" })
        // a receipt kept from before has none
        assertFalse(read(Docs.receipt(receipt, shop, Paper(), 2)).lines.any { it.contains("CUSTOMER") })
    }

    @Test
    fun aKitchenTicketCarriesTheCustomerNumberLarge() {
        val doc = KitchenDoc("ORDER", "Ravi", 1_790_000_000_000, "Priya", "Takeaway", null, null, receipt.lines, "Kitchen", pickup = "PICK UP 18:30", customerNo = "05")
        val lines = read(Docs.kitchen(doc, Paper(32, 2, true))).lines
        assertTrue(lines.all { it.length <= 32 })
        val no = lines.indexOfFirst { it.trim() == "No. 05" }
        assertTrue(no > lines.indexOfFirst { it.trim() == "KITCHEN" })
        // who it is for, under it
        assertEquals("Ravi", lines[no + 1].trim())
        // with no name given, the number alone
        val nameless = read(Docs.kitchen(doc.copy(order = ""), Paper(32, 2, true))).lines
        assertTrue(nameless[nameless.indexOfFirst { it.trim() == "No. 05" } + 1].trim().startsWith("PICK UP"))
        // a table's ticket is as it was: the table, large
        val table = read(Docs.kitchen(doc.copy(order = "Table 4", customerNo = null, pickup = null), Paper(32, 2, true))).lines
        assertTrue(table.any { it.trim() == "Table 4" })
        assertFalse(table.any { it.contains("No.") })
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.print.DocsTest"`
Expected: FAIL to compile, no parameter `customerNo`.

- [ ] **Step 3: The data and the layout**

In `Docs.kt`, in `ReceiptDoc`, after `val refundedAll: Boolean = false,` add:

```kotlin
    // The customer number ("05") of an order with no table, printed large so
    // the customer can be called (CustomerNumber). Kept with the receipt, so a
    // reprint carries it; a receipt kept from before has none.
    val customerNo: String? = null,
```

In `KitchenDoc`, after `val pickup: String? = null, ...` add:

```kotlin
    val customerNo: String? = null, // "05": printed large in place of the order's name, which then says who it is for
```

In `page`, replace:

```kotlin
        if (d.refunded > 0) p.line(if (d.refundedAll) "*** REFUNDED ***" else "*** PARTLY REFUNDED: ${n(d.refunded)} ***")
        p.bold(false).align(EscPos.Align.Left)
```

with:

```kotlin
        if (d.refunded > 0) p.line(if (d.refundedAll) "*** REFUNDED ***" else "*** PARTLY REFUNDED: ${n(d.refunded)} ***")
        // the number the customer is called by, large
        d.customerNo?.let { no -> p.big(true); EscPos.wrap("CUSTOMER No. $no", p.columns / 2).forEach { p.line(it) }; p.big(false) }
        p.bold(false).align(EscPos.Align.Left)
```

In `kitchen`, replace:

```kotlin
        p.big(true)
        EscPos.wrap(d.order, paper.columns / 2).forEach { p.line(it) }
        p.big(false)
```

with:

```kotlin
        if (d.customerNo != null) {
            // the customer's number large, then who it is for
            p.big(true).line("No. ${d.customerNo}").big(false)
            if (d.order.isNotBlank()) EscPos.wrap(d.order, paper.columns).forEach { p.line(it) }
        } else {
            p.big(true)
            EscPos.wrap(d.order, paper.columns / 2).forEach { p.line(it) }
            p.big(false)
        }
```

- [ ] **Step 4: Fill them in `DocBuilder`**

After `orderName`, add:

```kotlin
    // The customer number the papers print large ("05"), of an order with no
    // table; a table is served where it sits (CustomerNumber).
    private fun customerNo(t: TicketEntity): String? = if (t.table_id == null) CustomerNumber.digits(t.order_no) else null
```

In `receipt(...)`, change the last argument line:

```kotlin
        rounding = totals.rounding, total = totals.total, payments = payments, service = totals.service,
    )
```

to:

```kotlin
        rounding = totals.rounding, total = totals.total, payments = payments, service = totals.service,
        customerNo = if (kind == "refund") null else customerNo(t),
    )
```

In `kitchen(...)`, replace:

```kotlin
            val doc = KitchenDoc(title, order, System.currentTimeMillis(), waiter, dining(t), t.covers, remark(t), asked, Routing.heading(p, printers, one), pickup)
```

with:

```kotlin
            val doc = KitchenDoc(title, heading, System.currentTimeMillis(), waiter, dining(t), t.covers, remark(t), asked, Routing.heading(p, printers, one), pickup, no)
```

and, before the `for ((pid, ls) in perPrinter)` loop, add:

```kotlin
        // An order with a customer number is headed by it, then who it is for;
        // a table's by the table, as before.
        val no = customerNo(t)
        val heading = if (no != null) (t.name ?: t.customer_id?.let { db.customers().customer(it)?.name }).orEmpty() else order
```

(`order` stays as it is and still names the print job, "Kitchen ticket, A-05 · Ravi".)

- [ ] **Step 5: Run the tests to see them pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.print.DocsTest"`
Expected: PASS, `aKitchenTicketHasNoPrices` and `aTakeawaysKitchenTicketSaysWhenItIsPickedUp` included.

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/print/Docs.kt android/app/src/main/java/com/restopos/core/data/DocBuilder.kt android/app/src/test/java/com/restopos/core/print/DocsTest.kt
git commit -m "till: CUSTOMER No. 05 large under RECEIPT or BILL (not on a refund), kept with the receipt for reprints; the kitchen ticket headed No. 05 large, then who it is for; a table's papers as before" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: When an order was taken, from its id

**Files:**
- Modify: `app/core/common/Common.kt` (`object Uuid7`, line 57 on)
- Test: `test/core/common/Uuid7Test.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.restopos.core.common

import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// An id made on the tablet carries the moment it was made (UUID version 7):
// the reminder before an order is due reads when the order was taken from it.
class Uuid7Test {
    @Test fun anIdKnowsWhenItWasMade() {
        val before = System.currentTimeMillis()
        val id = Uuid7.next()
        val after = System.currentTimeMillis()
        val ms = Uuid7.millis(id)!!
        assertTrue(ms in before..after)
    }

    @Test fun anIdThatIsNotOneOfOursKnowsNothing() {
        // version 4, as the server's gen_random_uuid makes
        assertNull(Uuid7.millis("3f2b8c1e-9d4a-4b6e-8f00-123456789abc"))
        assertNull(Uuid7.millis("not an id"))
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.common.Uuid7Test"`
Expected: FAIL to compile, `millis` is not defined.

- [ ] **Step 3: Add `millis`**

In `object Uuid7`, after `next()`, add:

```kotlin
    // The moment an id made by next() was made: its first 48 bits. Null for
    // an id that is not a version 7 (the server's gen_random_uuid makes 4).
    fun millis(id: String): Long? {
        val hex = id.replace("-", "")
        if (hex.length != 32 || hex[12] != '7') return null
        return hex.take(12).toLongOrNull(16)
    }
```

- [ ] **Step 4: Run it to see it pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.common.Uuid7Test"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/common/Common.kt android/app/src/test/java/com/restopos/core/common/Uuid7Test.kt
git commit -m "till: an id made on the tablet says when it was made" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The reminder's rule

**Files:**
- Create: `app/core/data/DueReminder.kt`
- Test: `test/core/data/DueReminderTest.kt`

- [ ] **Step 1: Write the failing test**

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The owner: "if an order is due 21:00, we need the till to make a sound 10
// mins before", "not all customer wants 10 mins"; only orders for later ring.
class DueReminderTest {
    private val t0 = 1_790_000_000_000L // 20:00, as the cases say it
    private fun at(min: Int) = t0 + min * 60_000L
    private fun order(due: Int?, delivery: Boolean = false, stage: String = "new", id: String = "o1", name: String? = "Ravi", noShow: Boolean = false, taken: Long? = t0) =
        DueReminder.Order(id, "A-05", name, delivery, due?.let { at(it) }, stage, noShow, taken)

    @Test fun `an order for as soon as possible never rings, nor one moved a little later`() {
        assertNull(DueReminder.ringAt(order(15), 15, 10))
        assertNull(DueReminder.ringAt(order(20), 15, 10))
        assertNull(DueReminder.ringAt(order(25), 15, 10))
    }

    @Test fun `an order for later rings the reminder before it is due`() {
        assertEquals(at(50), DueReminder.ringAt(order(60), 15, 10))
        assertEquals(at(16), DueReminder.ringAt(order(26), 15, 10))
    }

    @Test fun `a delivery's usual time is twice the preparation time`() {
        assertNull(DueReminder.ringAt(order(40, delivery = true), 15, 10))
        assertEquals(at(50), DueReminder.ringAt(order(60, delivery = true), 15, 10))
    }

    @Test fun `off, no due time, or not known when it was taken: it never rings`() {
        assertNull(DueReminder.ringAt(order(60), 15, 0))
        assertNull(DueReminder.ringAt(order(null), 15, 10))
        assertNull(DueReminder.ringAt(order(60, taken = null), 15, 10))
    }

    @Test fun `it rings from its moment until it is due, once for each due time`() {
        val o = order(60)
        assertTrue(DueReminder.toRing(listOf(o), at(49), 15, 10, emptySet()).isEmpty())
        assertEquals(listOf("o1"), DueReminder.toRing(listOf(o), at(50), 15, 10, emptySet()).map { it.id })
        // a till started after the moment rings at once, until the order is due
        assertEquals(listOf("o1"), DueReminder.toRing(listOf(o), at(57), 15, 10, emptySet()).map { it.id })
        assertTrue(DueReminder.toRing(listOf(o), at(60), 15, 10, emptySet()).isEmpty())
        // rung already for this due time
        assertTrue(DueReminder.toRing(listOf(o), at(52), 15, 10, setOf(DueReminder.key(o))).isEmpty())
        // moved later, it rings again before the new time
        val moved = order(90)
        assertEquals(listOf("o1"), DueReminder.toRing(listOf(moved), at(80), 15, 10, setOf(DueReminder.key(o))).map { it.id })
    }

    @Test fun `only an order still waiting on the kitchen rings`() {
        val orders = listOf(
            order(60, id = "a"), order(60, stage = "kitchen", id = "b"), order(60, stage = "ready", id = "c"),
            order(60, stage = "done", id = "d"), order(60, id = "e", noShow = true),
        )
        assertEquals(listOf("a", "b"), DueReminder.toRing(orders, at(50), 15, 10, emptySet()).map { it.id })
    }

    @Test fun `what the banner says`() {
        assertEquals("A-05, Ravi, is due at 21:00: in 10 minutes", DueReminder.says(order(60), at(50)) { "21:00" })
        assertEquals("A-05 is due at 21:00: in 1 minute", DueReminder.says(order(60, name = null), at(59) + 30_000) { "21:00" })
    }

    @Test fun `what was rung for is kept, and forgotten two days after it was due`() {
        val kept = mapOf("o1@${at(60)}" to at(60), "o2@${at(-3000)}" to at(-3000))
        assertEquals(mapOf("o1@${at(60)}" to at(60)), DueReminder.read(DueReminder.keep(kept, at(70))))
        assertEquals(emptyMap<String, Long>(), DueReminder.read(null))
        assertEquals(emptyMap<String, Long>(), DueReminder.read("junk"))
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.DueReminderTest"`
Expected: FAIL to compile, `DueReminder` is not defined.

- [ ] **Step 3: Write the object**

`app/core/data/DueReminder.kt`:

```kotlin
package com.restopos.core.data

// When a takeaway or delivery for later rings before it is due (the owner,
// 2026-10-15: "if an order is due 21:00, we need the till to make a sound 10
// mins before", "configurable"). The rule only; DueReminders watches the
// board and rings.
//
// Only an order for later rings: one taken for a time further off than its
// usual time (the preparation time, twice it for a delivery: the due time an
// order is given when nobody chooses one) plus the reminder. An order taken
// for as soon as possible never does, nor one moved a few minutes later. When
// it was taken is read from its id (Uuid7.millis); an order whose id does not
// say is never rung for.
object DueReminder {
    class Order(
        val id: String,
        val label: String, // its number, "A-05"
        val name: String?, // who it is for
        val delivery: Boolean,
        val dueAt: Long?,
        val stage: String?, // new | kitchen | ready | done
        val noShow: Boolean,
        val takenAt: Long?,
    )

    private const val MINUTE = 60_000L

    // what is kept of an order once it has rung: its id and the due time it rang for
    fun key(o: Order): String = "${o.id}@${o.dueAt}"

    // The moment it rings; null when it never does.
    fun ringAt(o: Order, prepMinutes: Int, lead: Int): Long? {
        val due = o.dueAt ?: return null
        val taken = o.takenAt ?: return null
        if (lead <= 0) return null
        val usual = prepMinutes.toLong() * (if (o.delivery) 2 else 1)
        if (due - taken <= (usual + lead) * MINUTE) return null
        return due - lead * MINUTE
    }

    // still waiting on the kitchen: new, or in the kitchen, and not a no-show
    fun waiting(o: Order): Boolean = (o.stage == "new" || o.stage == "kitchen") && !o.noShow

    // The orders to ring for now: from their moment until they are due, once for each due time.
    fun toRing(orders: List<Order>, now: Long, prepMinutes: Int, lead: Int, rung: Set<String>): List<Order> = orders.filter { o ->
        val at = ringAt(o, prepMinutes, lead) ?: return@filter false
        waiting(o) && now >= at && now < o.dueAt!! && key(o) !in rung
    }

    // "A-05, Ravi, is due at 21:00: in 10 minutes"
    fun says(o: Order, now: Long, clock: (Long) -> String): String {
        val due = o.dueAt ?: return o.label
        val left = ((due - now + MINUTE - 1) / MINUTE).coerceAtLeast(1)
        val who = o.label + (o.name?.takeIf { it.isNotBlank() && it != o.label }?.let { ", $it," } ?: "")
        return "$who is due at ${clock(due)}: in $left minute" + if (left == 1L) "" else "s"
    }

    // What the tablet keeps of the orders it rang for, "key=due" by commas;
    // forgotten two days after they were due.
    fun keep(rung: Map<String, Long>, now: Long): String =
        rung.filterValues { it >= now - 2 * 24 * 60 * MINUTE }.entries.joinToString(",") { "${it.key}=${it.value}" }

    fun read(text: String?): Map<String, Long> = text.orEmpty().split(',').mapNotNull { e ->
        val i = e.lastIndexOf('=')
        if (i <= 0) null else e.substring(i + 1).toLongOrNull()?.let { e.substring(0, i) to it }
    }.toMap()
}
```

- [ ] **Step 4: Run it to see it pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.DueReminderTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/data/DueReminder.kt android/app/src/test/java/com/restopos/core/data/DueReminderTest.kt
git commit -m "till: the rule of the reminder before an order is due: only an order for later (further off than its usual time plus the reminder), from its moment until it is due, once for each due time, while it waits on the kitchen; what the banner says; what was rung for, kept two days" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: The setting on the tablet, and its sound

**Files:**
- Modify: `app/core/data/PosSettings.kt`
- Modify: `app/core/common/Chime.kt`
- Test: `test/core/data/PosSettingsTest.kt`, `test/core/common/ChimeTest.kt`

- [ ] **Step 1: Write the failing tests**

In `PosSettingsTest`, add `import org.junit.Assert.assertEquals` and:

```kotlin
    // Off until the restaurant sets it: no restaurant already live starts ringing when this build reaches it.
    @Test
    fun theReminderBeforeAnOrderIsDueIsOffUntilSet() {
        assertEquals(0, PosSettings.parse("{}").dueReminder)
        assertEquals(10, PosSettings.parse("""{"dueReminderMinutes":10}""").dueReminder)
        assertEquals(0, PosSettings.parse("""{"dueReminderMinutes":0}""").dueReminder)
        assertEquals(0, PosSettings.parse("""{"dueReminderMinutes":500}""").dueReminder)
        assertEquals(0, PosSettings.parse("""{"dueReminderMinutes":"ten"}""").dueReminder)
    }
```

In `ChimeTest`, change `for (notes in listOf(Chime.ORDER, Chime.READY))` in `itStartsAndEndsQuietly` to `for (notes in listOf(Chime.ORDER, Chime.READY, Chime.DUE))`, and add:

```kotlin
    // the reminder before an order is due falls where the other two rise, so it is not taken for them
    @Test
    fun theDueSoundFallsWhereTheOthersRise() {
        assertTrue(Chime.DUE.zipWithNext().all { (a, b) -> b.hz < a.hz })
        assertTrue(Chime.ORDER.zipWithNext().all { (a, b) -> b.hz > a.hz })
        assertTrue(Chime.READY.zipWithNext().all { (a, b) -> b.hz > a.hz })
    }
```

- [ ] **Step 2: Run them to see them fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.PosSettingsTest" --tests "com.restopos.core.common.ChimeTest"`
Expected: FAIL to compile, no `dueReminder`, no `Chime.DUE`.

- [ ] **Step 3: Add them**

In `PosSettings`, after `val promoStillDays: Int = 14,` add:

```kotlin
    // Minutes before an order for later is due that the till rings
    // (DueReminder, server 0111). 0, and a missing key, is off.
    val dueReminder: Int = 0,
```

and in `parse`, after the `promoStillDays = ...` line:

```kotlin
                dueReminder = runCatching { d["dueReminderMinutes"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 1..120 } ?: 0,
```

In `Chime`, after `val READY = ...`:

```kotlin
    // An order for later is due soon: three notes, falling, unlike the other two.
    val DUE = listOf(Note(1568.0, 150), Note(1318.5, 150), Note(1046.5, 420))
```

and after `fun ready() = play(READY)`:

```kotlin
    fun due() = play(DUE)
```

- [ ] **Step 4: Run them to see them pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.PosSettingsTest" --tests "com.restopos.core.common.ChimeTest"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/data/PosSettings.kt android/app/src/main/java/com/restopos/core/common/Chime.kt android/app/src/test/java/com/restopos/core/data/PosSettingsTest.kt android/app/src/test/java/com/restopos/core/common/ChimeTest.kt
git commit -m "till: the minutes before an order is due (dueReminderMinutes, off when missing) and a sound of its own, three falling notes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The till watches, rings and shows the banner

The watcher and the banner are Android code, checked by compiling here and on the emulator in Task 13. The rule they use was tested in Task 6.

**Files:**
- Create: `app/core/data/DueReminders.kt`
- Modify: `app/core/sync/Sync.kt` (`SessionStore`: what was rung for)
- Modify: `app/feature/main/MainShell.kt` (`ShellViewModel` at line 195; the shell's `Box` at line 731)
- Create: `app/feature/main/DueBanner.kt`

- [ ] **Step 1: What was rung for, in `SessionStore`**

In `Sync.kt`, after the `SEQ_CUSTOMER` key, add:

```kotlin
// the orders the till rang for before they were due, and their due times (DueReminder.keep)
private val DUE_RUNG = stringPreferencesKey("due_rung")
```

and in `SessionStore`, after `dayClosed`:

```kotlin
    // What the till rang for before it was due (DueReminders), kept so a
    // restart does not ring again.
    suspend fun dueRung(): String? = store.data.map { it[DUE_RUNG] }.first()
    suspend fun setDueRung(text: String) { store.edit { it[DUE_RUNG] = text } }
```

- [ ] **Step 2: The watcher**

`app/core/data/DueReminders.kt`:

```kotlin
package com.restopos.core.data

import com.restopos.core.common.Chime
import com.restopos.core.common.Uuid7
import com.restopos.core.database.TillDatabase
import com.restopos.core.sync.SessionStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import javax.inject.Inject
import javax.inject.Singleton

// A banner across the top of the till: which order is due soon.
data class DueBanner(val ticketId: String, val text: String)

// The till rings before an order for later is due (DueReminder has the rule),
// whichever screen is open and while it is locked, as Kitchen.ready does: it
// is watched from here for as long as the till runs, every 30 seconds, over
// the orders on this till's Takeaway board. What it rang for is kept
// (SessionStore.dueRung), so a restart does not ring again. A banner stays
// until OK is pressed or its order no longer waits on the kitchen.
@Singleton
class DueReminders @Inject constructor(
    private val db: TillDatabase,
    private val session: SessionStore,
) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null
    private val clock = SimpleDateFormat("HH:mm", Locale.UK)
    private val _banners = MutableStateFlow<List<DueBanner>>(emptyList())
    val banners: StateFlow<List<DueBanner>> = _banners

    fun start() {
        if (job?.isActive == true) return
        job = scope.launch {
            while (isActive) {
                runCatching { look() }
                delay(30_000)
            }
        }
    }

    fun dismiss(ticketId: String) { _banners.value = _banners.value.filter { it.ticketId != ticketId } }

    private suspend fun look() {
        val s = PosSettings.parse(db.ops().settings())
        val store = session.storeId()
        if (s.retail || s.dueReminder == 0 || store == null) { _banners.value = emptyList(); return }
        val kinds = db.catalog().diningOptions().associate { it.id to it.kind }
        val orders = db.service().board(store).first().map { t ->
            DueReminder.Order(
                t.id, t.order_no ?: t.name ?: "A takeaway", t.name, t.dining_option_id?.let { kinds[it] } == "delivery",
                t.due_at, t.stage, t.no_show_at != null, Uuid7.millis(t.id),
            )
        }
        val now = System.currentTimeMillis()
        val rung = DueReminder.read(session.dueRung())
        val ring = DueReminder.toRing(orders, now, s.prepMinutes, s.dueReminder, rung.keys)
        if (ring.isNotEmpty()) {
            session.setDueRung(DueReminder.keep(rung + ring.associate { DueReminder.key(it) to it.dueAt!! }, now))
            Chime.due()
            val fresh = ring.map { DueBanner(it.id, DueReminder.says(it, now) { at -> clock.format(Date(at)) }) }
            _banners.value = _banners.value.filter { b -> ring.none { it.id == b.ticketId } } + fresh
        }
        // a banner goes once its order is ready, handed over or gone
        val still = orders.filter { DueReminder.waiting(it) }.map { it.id }.toSet()
        _banners.value = _banners.value.filter { it.ticketId in still }
    }
}
```

- [ ] **Step 3: Start it with the till, and hand its banners to the screen**

In `MainShell.kt`, add this constructor parameter to `ShellViewModel` after `private val requests: com.restopos.core.data.TillRequests,`:

```kotlin
    private val dueReminders: com.restopos.core.data.DueReminders,
```

In its `init`, after `guests.start()`, add:

```kotlin
        // The reminder before an order for later is due (DueReminders): from
        // the moment the till is up, whichever screen is open.
        dueReminders.start()
```

After `fun askedShown() = requests.heard()`, add:

```kotlin
    // the orders for later the till rang for, shown across the top until OK
    val dueBanners: StateFlow<List<com.restopos.core.data.DueBanner>> = dueReminders.banners
    fun dueOk(ticketId: String) = dueReminders.dismiss(ticketId)
```

In `MainShell`, replace:

```kotlin
        ToastHost()
    }
```

(the one at line 731, after `SideMenu(...)`) with:

```kotlin
        DueBannerHost(shell, onOpen = { go(Screen.Takeaway) })
        ToastHost()
    }
```

- [ ] **Step 4: The banner**

`app/feature/main/DueBanner.kt`:

```kotlin
package com.restopos.feature.main

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.restopos.core.ui.T
import com.restopos.core.ui.V
import com.restopos.core.ui.VBtn

private val Ink = Color(0xFF241800)

// The reminder before an order for later is due (DueReminders): a band across
// the top of whichever screen is open, one for each order, until OK is
// pressed or the order is ready. Tapping it opens the Takeaway board.
@Composable
internal fun BoxScope.DueBannerHost(shell: ShellViewModel, onOpen: () -> Unit) {
    val banners by shell.dueBanners.collectAsState()
    if (banners.isEmpty()) return
    Column(
        Modifier.align(Alignment.TopCenter).padding(top = 14.dp, start = 40.dp, end = 40.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        banners.forEach { b ->
            Row(
                Modifier.widthIn(max = 760.dp).shadow(12.dp, RoundedCornerShape(14.dp)).clip(RoundedCornerShape(14.dp)).background(V.Amber)
                    .clickable(onClick = onOpen).padding(start = 20.dp, end = 10.dp, top = 10.dp, bottom = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                T(b.text, 16.sp, 800, Ink, Modifier.weight(1f, fill = false).padding(end = 14.dp), lines = 2)
                VBtn("OK", bg = Ink, fg = V.Amber, height = 44.dp, radius = 10.dp, weight = 800) { shell.dueOk(b.ticketId) }
            }
        }
    }
}
```

- [ ] **Step 5: Compile**

Run: `android/gradlew -p android :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL. (`db.catalog().diningOptions()` is the call `TicketRepository.dineType` already makes.)

- [ ] **Step 6: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/data/DueReminders.kt android/app/src/main/java/com/restopos/core/sync/Sync.kt android/app/src/main/java/com/restopos/feature/main/MainShell.kt android/app/src/main/java/com/restopos/feature/main/DueBanner.kt
git commit -m "till: the reminder before an order for later is due, watched from the moment the till is up: its sound, then a band across the top saying which order and when, until OK or the order is ready; tapped, the Takeaway board; what it rang for kept across a restart" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The minutes set from the tablet (a restaurant on the offline plan has no back office)

**Files:**
- Create: `db/tests/fixtures/till-office/settings-save-due.json`
- Modify: `app/core/data/OfficePayloads.kt` (after `kitchenNotesSave`, line 107)
- Modify: `app/core/data/LocalAnswers.kt` (`settingsSave`, line 956 on)
- Modify: `app/core/data/Service.kt` (after `saveKitchenNotes`, line 475 on)
- Modify: `app/feature/settings/BusinessPages.kt` (`BusinessViewModel`; a new panel)
- Modify: `app/feature/settings/SettingsScreen.kt` (`NoticesPage`, line 837)
- Test: `test/core/data/LocalAnswersTest.kt`

- [ ] **Step 1: The payload both sides are held to**

`db/tests/fixtures/till-office/settings-save-due.json`:

```json
{
  "type": "settings.save",
  "payload": { "dueReminderMinutes": 10 }
}
```

- [ ] **Step 2: Write the failing tests**

In `LocalAnswersTest`, after `the receipt's two notes and the service charge, and nothing else of the settings`:

```kotlin
    @Test fun `the minutes before an order for later is due, and nothing else of the settings`() {
        dao.settings = SettingsEntity(tenant, """{"plan":"offline","servicePct":10}""")
        assertEquals("done", ask("settings.save", OfficeFixtures.payload("settings-save-due").jsonObject))
        assertEquals(listOf(10, 10), PosSettings.parse(dao.settings!!.data).let { listOf(it.dueReminder, it.servicePct) })
        assertEquals("bad-payload", ask("settings.save", """{"dueReminderMinutes":121}"""))
        assertEquals("bad-payload", ask("settings.save", """{"dueReminderMinutes":"ten"}"""))
        assertEquals("done", ask("settings.save", """{"dueReminderMinutes":0}"""))
        assertEquals(0, PosSettings.parse(dao.settings!!.data).dueReminder)
        assertEquals(OfficeFixtures.payload("settings-save-due"), OfficePayloads.dueReminderSave(10, null))
    }
```

- [ ] **Step 3: Run it to see it fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.LocalAnswersTest"`
Expected: FAIL to compile, no `dueReminderSave`.

- [ ] **Step 4: The payload, the offline answer, the call**

In `OfficePayloads.kt`, after `kitchenNotesSave`:

```kotlin
    // The minutes before an order for later is due that the tills ring; 0 is off (server 0111).
    fun dueReminderSave(minutes: Int, approvedBy: String?): JsonObject = buildJsonObject {
        put("dueReminderMinutes", minutes)
        approvedBy?.let { put("approved_by", it) }
    }
```

In `LocalAnswers.settingsSave`, before `if (patch.isNotEmpty()) mergeSettings(tenant, patch)`:

```kotlin
        // the minutes before an order for later is due that the tills ring (0111); 0 is off
        if ("dueReminderMinutes" in p) {
            val m = p.long("dueReminderMinutes")
            if (m == null || m !in 0..120) throw Refused("bad-payload")
            patch = JsonObject(patch + ("dueReminderMinutes" to JsonPrimitive(m.toInt())))
        }
```

and change its heading comment from `// ---- push_settings_save (0096, 0108): the receipt's two notes, the service charge, the kitchen notes ----` to `// ---- push_settings_save (0096, 0108, 0111): the receipt's two notes, the service charge, the kitchen notes, the due reminder ----`.

(`p.long` refuses `"ten"` itself with `bad-payload`: `LocalAnswers.kt:1081`.)

In `Service.kt`, after `saveKitchenNotes`:

```kotlin
    // The minutes before an order for later is due that the tills ring; 0 is
    // off (server 0111). The same for every till of the business.
    suspend fun saveDueReminder(minutes: Int, approver: StaffMember? = null): Result<Unit> = runCatching {
        staff.allow("settings.device", "change the reminder before an order is due", approver)
        ask("settings.save", { code ->
            when (code) {
                "bad-payload" -> "A reminder is a whole number of minutes, from 0 to 120."
                "forbidden" -> "You are not allowed to change the settings. Ask a manager."
                "unknown-op" -> "The server has to be updated before this can be changed from a till."
                null -> "The server refused it."
                else -> "The server refused it ($code)."
            }
        }, OfficePayloads.dueReminderSave(minutes, staff.approvedBy("settings.device", approver)))
    }
```

- [ ] **Step 5: Run the tests to see them pass**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.LocalAnswersTest"`
Expected: PASS.

- [ ] **Step 6: The place on the tablet**

In `BusinessPages.kt`, in `BusinessViewModel`, after `saveReceipt`:

```kotlin
    // the minutes before an order for later is due that the tills ring; empty is off
    fun saveDueReminder(was: PosSettings, typed: String) {
        val m = typed.trim().ifEmpty { "0" }.toIntOrNull()?.takeIf { it in 0..120 }
            ?: run { Toaster.say("A reminder is a whole number of minutes, 1 to 120, or empty for off"); return }
        if (m == was.dueReminder) { Toaster.say("Nothing was changed."); return }
        go(if (m == 0) "The reminder is off." else "Saved. The till rings $m minutes before an order for later is due.", {}) { by -> service.saveDueReminder(m, by) }
    }
```

After `ReceiptPage`, add:

```kotlin
// ---- Settings > Notifications: the reminder before an order for later is due ----
@Composable
internal fun DueReminderPanel(vm: BusinessViewModel = hiltViewModel()) {
    val st by vm.settings.collectAsState()
    val busy by vm.busy.collectAsState()
    var minutes by remember(st.dueReminder) { mutableStateOf(if (st.dueReminder == 0) "" else st.dueReminder.toString()) }

    Note("The till makes a sound and says which order, this many minutes before a takeaway or delivery taken for later is due. One taken for as soon as possible never rings.")
    Panel {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Column(Modifier.weight(1f)) {
                T("Remind before an order is due", 15.sp, 700)
                T("Minutes, 1 to 120. Empty is off. The same for every till.", 13.sp, 500, V.Text2)
            }
            Field(minutes, { v -> minutes = v.filter { it.isDigit() }.take(3) }, "Off", Modifier.padding(start = 8.dp).fillMaxWidth(0.25f), height = 50.dp, number = true, size = 17.sp)
        }
    }
    Row { VBtn(if (busy) "Saving…" else "Save", bg = V.Blue, fg = Color.White, height = 52.dp, radius = 14.dp, weight = 800, enabled = !busy) { vm.saveDueReminder(st, minutes) } }
}
```

In `SettingsScreen.kt`, in `NoticesPage`, add after `val notices by vm.notices.collectAsState()`:

```kotlin
    val retail by vm.retail.collectAsState()
```

and, as the last statement of `NoticesPage`:

```kotlin
    // a restaurant's reminder before an order for later is due (DueReminders)
    if (retail == false) DueReminderPanel()
```

- [ ] **Step 7: Compile**

Run: `android/gradlew -p android :app:compileDebugKotlin`
Expected: BUILD SUCCESSFUL.

- [ ] **Step 8: Commit**

```bash
git add db/tests/fixtures/till-office/settings-save-due.json android/app/src/main/java/com/restopos/core/data/OfficePayloads.kt android/app/src/main/java/com/restopos/core/data/LocalAnswers.kt android/app/src/main/java/com/restopos/core/data/Service.kt android/app/src/main/java/com/restopos/feature/settings/BusinessPages.kt android/app/src/main/java/com/restopos/feature/settings/SettingsScreen.kt android/app/src/test/java/com/restopos/core/data/LocalAnswersTest.kt
git commit -m "till: the minutes before an order for later is due, set on the tablet under Settings, Notifications (a restaurant), saved with settings.save under settings.device and answered by a tablet that works on its own; 0 to 120, empty is off" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: The server (migration 0111)

**Files:**
- Create: `db/migrations/0111_customer_number_due_reminder_payments.sql`
- Create: `db/tests/payments-perm.test.cjs`
- Modify: `db/tests/till-office.test.cjs` (section Z, before the `Z4` check, line 423)

- [ ] **Step 1: Write the failing suite**

`db/tests/payments-perm.test.cjs`:

```js
// payments-perm.test.cjs — migration 0111: "See the day's payments"
// (payments.view) is a permission of its own, apart from "See all receipts".
//   - a new client's Manager has it; its Cashier and Waiter do not, and its
//     Cashier still sees all receipts
//   - grant_payments_perm gives it, once, to a role that sees the day's figures
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/payments-perm.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-pp@example.com')`, [admin]);
    const tid = (await one(`select platform.create_tenant($1,'Payments Test','Main','PP1','Owner',$2,'standard') as r`, [admin, crypto.randomUUID()])).r.tenant_id;
    const has = async (role, perm) => (await one(`select permissions ? $3 as has from roles where tenant_id = $1 and name = $2`, [tid, role, perm])).has;

    check("P1 a new client's Manager sees the day's payments; its Cashier and Waiter do not",
      (await has('Manager', 'payments.view')) === true && (await has('Cashier', 'payments.view')) === false && (await has('Waiter', 'payments.view')) === false);
    check('P1 its Cashier still sees all receipts', (await has('Cashier', 'receipts.view_all')) === true);

    const figures = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Supervisor','["sale.create","shift.view_report"]'::jsonb) returning id`, [tid])).id;
    const plain = (await one(`insert into roles (tenant_id, name, permissions) values ($1,'Till','["sale.create","receipts.view_all"]'::jsonb) returning id`, [tid])).id;
    const n = (await one(`select grant_payments_perm($1) as n`, [tid])).n;
    const of = async (id) => (await one(`select permissions ? 'payments.view' as has from roles where id = $1`, [id])).has;
    const again = (await one(`select grant_payments_perm($1) as n`, [tid])).n;
    check("P2 a role that sees the day's figures is given it, once; one that sees receipts alone is not",
      n === 1 && (await of(figures)) === true && (await of(plain)) === false && again === 0, `${n} ${again}`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'PAYMENTS PERM PASS' : `PAYMENTS PERM FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
```

In `till-office.test.cjs`, before the line `r = await rone('settings.save', { servicePct: 0 }, restoCashier);`, add:

```js
    // the minutes before an order for later is due (0111): 0 to 120, 0 is off
    r = await rone(...ax('settings-save-due'));
    const z11 = await rone('settings.save', { dueReminderMinutes: 121 });
    const z12 = await rone('settings.save', { dueReminderMinutes: 'ten' });
    st = await settings(resto);
    check('Z11 the reminder before an order is due saved, 0 to 120; the rest of the settings left',
      r.said === 'applied' && st.dueReminderMinutes === 10 && st.servicePct === 10 && z11.said === 'rejected:bad-payload' && z12.said === 'rejected:bad-payload',
      r.said + ' ' + z11.said + ' ' + z12.said);
```

- [ ] **Step 2: Run them to see them fail**

Run: `node db/tests/payments-perm.test.cjs`
Expected: `FAIL P1 ...` (the Manager has no `payments.view`), then `TEST_FAILED` at `grant_payments_perm` (no such function).

Run: `node db/tests/till-office.test.cjs`
Expected: `FAIL Z11 ...` (`r.data.saved` is 0, nothing saved); every other check PASS.

- [ ] **Step 3: Start the migration from the live definitions**

```bash
node db/scripts/dump-function.cjs platform.create_tenant 7 > "$TMPDIR/create_tenant.sql"
node db/scripts/dump-function.cjs push_settings_save > "$TMPDIR/push_settings_save.sql"
```

(`$TMPDIR` is any scratch folder outside the repository.) Check each file holds one `CREATE OR REPLACE FUNCTION`, and that `create_tenant.sql` holds the Manager list `"sale.create","sale.apply_discount", ... "sale.change_price"` as `db/migrations/0089_first_run_setup.sql:339-344` has it.

- [ ] **Step 4: Write the migration**

`db/migrations/0111_customer_number_due_reminder_payments.sql`, in this order:

1. The header:

```sql
-- 0111: the reminder before an order is due, and the day's payments kept
-- from cashiers. The owner, 2026-10-15: "We need the till to notify us ... 10
-- mins before ... configurable" and "Payments cannot be seen by cashier", then
-- "Can we have a place in the back office to create rules and permissions
-- instead of coming here and create rules via code".
-- Spec: docs/superpowers/specs/2026-10-15-addons-line-customer-number-due-reminder-payments-design.md
-- (The customer number and the add-ons on one line need nothing here: the
-- number travels in tickets.order_no.)
--
-- 1. payments.view, "See the day's payments" (the till's Settings, Payments),
--    is a permission of its own, apart from receipts.view_all, "See all
--    receipts". Every live role that sees the day's figures
--    (shift.view_report) is given it: Managers keep the page, Cashiers lose
--    it. The owner's "*" holds it. From then on the owner sets it on Roles
--    and permissions.
-- 2. platform.create_tenant: a new client's Manager has it, its Cashier not.
--    Rebuilt from its live definition (dump-function.cjs on dev, 2026-10-15).
-- 3. push_settings_save takes dueReminderMinutes, 0 (off) to 120. Rebuilt
--    from its live definition.

create or replace function grant_payments_perm(p_tenant uuid) returns integer
language plpgsql set search_path = public as $fn$
declare v_n integer;
begin
  with changed as (
    update roles r set permissions = r.permissions || '["payments.view"]'::jsonb
     where (p_tenant is null or r.tenant_id = p_tenant) and r.deleted_at is null
       and r.permissions ? 'shift.view_report' and not r.permissions ? 'payments.view' and not r.permissions ? '*'
    returning 1)
  select count(*)::int into v_n from changed;
  return v_n;
end $fn$;

select grant_payments_perm(null);
```

2. The text of `create_tenant.sql`, with `"payments.view"` added to the Manager's list only: in the `(v_tenant, 'Manager', '[...]')` row, change `"costs.view","sale.change_price"]'` to `"costs.view","sale.change_price","payments.view"]'`. Nothing else changes, and the Cashier's and the Waiter's lists stay as they are. End it with `;` if the dump has none.

3. The text of `push_settings_save.sql`, with this block added just before `  if v_patch <> '{}'::jsonb then`:

```sql
  -- minutes before an order for later is due that the tills ring (0111); 0 is off
  if p ? 'dueReminderMinutes' then
    begin v_int := (p->>'dueReminderMinutes')::int; exception when others then raise exception 'bad-payload'; end;
    if v_int is null or v_int not between 0 and 120 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('dueReminderMinutes', v_int);
  end if;
```

End it with `;` if the dump has none.

Check: `grep -c "payments.view" db/migrations/0111_customer_number_due_reminder_payments.sql` prints `4` or more (the function's two, the header's, the Manager's).

- [ ] **Step 5: Apply it to dev and run the suites**

```bash
node db/migrate.cjs
node db/tests/payments-perm.test.cjs
node db/tests/till-office.test.cjs
node db/tests/business-type.test.cjs
node db/tests/retail-till.test.cjs
```

Expected:
- `migrate.cjs` applies 0111 and only it.
- Each suite ends in its PASS line: `PAYMENTS PERM PASS`, Z11 among till-office's passes, and business-type and retail-till still passing (they create clients through `create_tenant`).

Run the suites one after another, never side by side on one database (memory).

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0111_customer_number_due_reminder_payments.sql db/tests/payments-perm.test.cjs db/tests/till-office.test.cjs
git commit -m "server 0111: payments.view (See the day's payments) apart from receipts.view_all, given to every live role that sees the day's figures and to a new client's Manager, not its Cashier (grant_payments_perm); push_settings_save takes dueReminderMinutes, 0 to 120. Applied on dev; payments-perm, till-office, business-type and retail-till pass" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: The tick on both Roles pages, the Payments page, and a tablet that works on its own

**Files:**
- Modify: `app/core/data/Perms.kt` (both `Receipts` groups; a new function)
- Modify: `web/lib/perms.ts` (the `Receipts` group)
- Modify: `db/tests/fixtures/till-office/perms.json` (both `Receipts` groups)
- Modify: `app/feature/settings/SettingsScreen.kt:1057-1058` (`PaymentsPage`)
- Modify: `app/core/database/Migrations.kt` (new `V27_V28`), `app/core/database/TillDatabase.kt:74` (version), `app/app/di/AppModule.kt:35` (the list)
- Test: `test/core/data/PermsTest.kt`; the existing `LocalAnswersTest` and `web/lib/perms.test.mjs` hold the lists together

- [ ] **Step 1: Write the failing test**

`test/core/data/PermsTest.kt`:

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// "See the day's payments" became a tick of its own (server 0111). A tablet
// that works on its own gives it to the roles it holds by the server's rule.
class PermsTest {
    @Test fun `a role that sees the day's figures is given the day's payments, and no other`() {
        assertEquals("""["sale.create","shift.view_report","payments.view"]""", Perms.grantPayments("""["sale.create","shift.view_report"]"""))
        assertNull(Perms.grantPayments("""["sale.create","receipts.view_all"]"""))
        assertNull(Perms.grantPayments("""["*"]"""))
        assertNull(Perms.grantPayments("""["shift.view_report","payments.view"]"""))
        assertNull(Perms.grantPayments("not a list"))
    }

    @Test fun `both kinds of business offer it beside all receipts`() {
        for (shop in listOf(false, true)) {
            val receipts = Perms.groups(shop).first { it.title == "Receipts" }.perms.map { it.first }
            assertEquals(listOf("receipts.view_all", "payments.view", "receipts.reprint"), receipts)
        }
        assertTrue(Perms.offered(false).contains("payments.view"))
    }
}
```

- [ ] **Step 2: Run it to see it fail**

Run: `android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.PermsTest"`
Expected: FAIL to compile, no `grantPayments`.

- [ ] **Step 3: The three lists**

In `Perms.kt`, in **both** `Group("Receipts", ...)` blocks, replace:

```kotlin
            "receipts.view_all" to "See all receipts and the day’s payments",
```

with:

```kotlin
            "receipts.view_all" to "See all receipts",
            "payments.view" to "See the day’s payments",
```

(The apostrophe is ’, as in the line it replaces.) Then add to `object Perms`, with the imports `kotlinx.serialization.json.Json`, `kotlinx.serialization.json.JsonArray`, `kotlinx.serialization.json.JsonPrimitive`, `kotlinx.serialization.json.jsonArray`, `kotlinx.serialization.json.jsonPrimitive`:

```kotlin
    // "See the day's payments" was part of "See all receipts" until 0111. A
    // role that sees the day's figures is given it, as the server's migration
    // gives it (grant_payments_perm); the owner's "*" holds it already. The
    // role's new list, or null when it is left as it is.
    fun grantPayments(permissions: String): String? {
        val list = runCatching { Json.parseToJsonElement(permissions).jsonArray.map { it.jsonPrimitive.content } }.getOrNull() ?: return null
        if ("*" in list || "payments.view" in list || "shift.view_report" !in list) return null
        return JsonArray((list + "payments.view").map { JsonPrimitive(it) }).toString()
    }
```

In `web/lib/perms.ts`, in the `Receipts` group, replace:

```ts
      ["receipts.view_all", "See all receipts and the day’s payments"],
```

with:

```ts
      ["receipts.view_all", "See all receipts"],
      ["payments.view", "See the day’s payments"],
```

In `perms.json`, in **both** `"title": "Receipts"` groups, replace:

```json
        [
          "receipts.view_all",
          "See all receipts and the day’s payments"
        ],
```

with:

```json
        [
          "receipts.view_all",
          "See all receipts"
        ],
        [
          "payments.view",
          "See the day’s payments"
        ],
```

- [ ] **Step 4: The Payments page asks for it**

In `SettingsScreen.kt`, `PaymentsPage`, replace:

```kotlin
    if (!vm.can("receipts.view_all") && !shown) {
        Locked("The day's payments are for people allowed to see every receipt.") { vm.guard("receipts.view_all", "see the day's payments") { shown = true } }
```

with:

```kotlin
    if (!vm.can("payments.view") && !shown) {
        Locked("The day's payments are for people allowed to see them. The owner gives that on Roles and permissions.") { vm.guard("payments.view", "see the day's payments") { shown = true } }
```

- [ ] **Step 5: The tablet's database, 27 to 28**

In `Migrations.kt`, after `V26_V27`:

```kotlin
    // 27 -> 28: "See the day's payments" became a tick of its own (server
    // 0111). A tablet that works on its own never hears of the server's
    // migration, so the roles it holds are given it here by the same rule
    // (Perms.grantPayments); a tablet that syncs has the server's roles back
    // at its next pull.
    val V27_V28 = object : Migration(27, 28) {
        override fun migrate(db: SupportSQLiteDatabase) {
            val changed = ArrayList<Pair<String, String>>()
            db.query("SELECT `id`, `permissions` FROM `roles`").use { c ->
                while (c.moveToNext()) com.restopos.core.data.Perms.grantPayments(c.getString(1))?.let { changed += c.getString(0) to it }
            }
            changed.forEach { (id, perms) -> db.execSQL("UPDATE `roles` SET `permissions` = ? WHERE `id` = ?", arrayOf<Any>(perms, id)) }
        }
    }
```

In `TillDatabase.kt`, change `version = 27,` to `version = 28,`. In `AppModule.kt`, add `, Migrations.V27_V28` after `Migrations.V26_V27` in the `addMigrations(...)` list.

- [ ] **Step 6: Run the tests, the web test and a build**

```bash
android/gradlew -p android :app:testDebugUnitTest --tests "com.restopos.core.data.PermsTest" --tests "com.restopos.core.data.LocalAnswersTest"
node web/lib/perms.test.mjs
android/gradlew -p android :app:assembleDebug
```

Expected:
- PASS, `the permissions a role's sheet offers are the back office's, by kind of business` included;
- `all passed`;
- BUILD SUCCESSFUL, with `android/app/schemas/com.restopos.core.database.TillDatabase/28.json` written.

- [ ] **Step 7: Commit**

```bash
git add android/app/src/main/java/com/restopos/core/data/Perms.kt web/lib/perms.ts db/tests/fixtures/till-office/perms.json android/app/src/main/java/com/restopos/feature/settings/SettingsScreen.kt android/app/src/main/java/com/restopos/core/database/Migrations.kt android/app/src/main/java/com/restopos/core/database/TillDatabase.kt android/app/src/main/java/com/restopos/app/di/AppModule.kt android/app/schemas/com.restopos.core.database.TillDatabase/28.json android/app/src/test/java/com/restopos/core/data/PermsTest.kt
git commit -m "till and back office: See all receipts and See the day's payments are two ticks on both Roles pages, for a restaurant and a shop; the till's Payments page asks for the second; the tablet's database 28 gives it to the roles a tablet working on its own holds that see the day's figures, as 0111 does on the server" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: The minutes in the back office's POS settings

**Files:**
- Modify: `web/lib/settings.ts` (type, `DEFAULT_SETTINGS`, `withDefaults`)
- Modify: `web/app/backoffice/settings/page.tsx` (`saveGeneral`; the Service card after "Takeaway time", line 417)
- Test: `db/tests/backoffice-saves.test.cjs` (the kitchen notes block, line 34 on)

- [ ] **Step 1: Write the failing check**

In `backoffice-saves.test.cjs`, inside the `// ---- the kitchen notes a restaurant saved (no database) ----` block, after the last `N2` check:

```js
    const due = (raw) => s.withDefaults(raw).dueReminderMinutes;
    check('N3 the reminder before an order is due is off until set, and 1 to 120',
      due(null) === 0 && due({ dueReminderMinutes: 10 }) === 10 && due({ dueReminderMinutes: 0 }) === 0 && due({ dueReminderMinutes: 500 }) === 0 && due({ dueReminderMinutes: '10' }) === 0,
      [due(null), due({ dueReminderMinutes: 10 }), due({ dueReminderMinutes: 500 })].join(' '));
```

- [ ] **Step 2: Run it to see it fail**

Run: `node db/tests/backoffice-saves.test.cjs`
Expected: `FAIL N3 ...` (`undefined`).

- [ ] **Step 3: The setting in `settings.ts`**

In the `PosSettings` type, after `promoStillDays: number;`:

```ts
  // minutes before an order for later is due that the tills ring (migration 0111); 0 is off
  dueReminderMinutes: number;
```

In `DEFAULT_SETTINGS`, after `promoStillDays: 14,`:

```ts
  dueReminderMinutes: 0,
```

In `withDefaults`, after the `promoStillDays:` line:

```ts
    dueReminderMinutes: typeof d.dueReminderMinutes === "number" && d.dueReminderMinutes >= 1 && d.dueReminderMinutes <= 120 ? Math.round(d.dueReminderMinutes) : 0,
```

- [ ] **Step 4: The form**

In `page.tsx`, `saveGeneral`, after `prepMinutes: int(f, "prepMinutes", 1, 180, 15),`:

```ts
            // empty is off (0111)
            dueReminderMinutes: int(f, "dueReminderMinutes", 0, 120, 0),
```

In the Service card, after the `Takeaway time` setting's closing `</div>`:

```tsx
            <div className="setting">
              <div>
                <strong>Reminder before an order is due</strong>
                <small>The till makes a sound and says which order, this many minutes before a takeaway or delivery taken for later is due. One taken for as soon as possible never rings. Empty is off.</small>
              </div>
              <label className="check" style={{ margin: 0 }}>
                <input name="dueReminderMinutes" type="number" min={0} max={120} defaultValue={s.dueReminderMinutes || ""} placeholder="Off" className="narrow" aria-label="Reminder minutes" />
                minutes
              </label>
            </div>
```

- [ ] **Step 5: Run the check and the type check**

```bash
node db/tests/backoffice-saves.test.cjs
npm --prefix web run typecheck
```

Expected: every check PASS, N3 included; `tsc` prints nothing and exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/lib/settings.ts web/app/backoffice/settings/page.tsx db/tests/backoffice-saves.test.cjs
git commit -m "back office: POS settings, Service: Reminder before an order is due, in minutes, empty is off (dueReminderMinutes)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: The whole check, then on an emulator with the owner watching

**Files:** none changed, unless a check finds a fault. A fault goes back to the task it belongs to, with its own test first.

- [ ] **Step 1: Every unit test and the web checks**

```bash
android/gradlew -p android :app:testDebugUnitTest
node web/lib/perms.test.mjs
npm --prefix web run typecheck
```

Expected:
- every unit test passes (587 before this plan, plus the ones added here);
- `all passed`;
- `tsc` exits 0.

- [ ] **Step 2: Build the APK**

Run: `android/gradlew -p android :app:assembleDebug`
Expected: BUILD SUCCESSFUL. Close any emulator first, or add `--priority low --max-workers 2`.

- [ ] **Step 3: Tell the owner before touching an emulator**

Say in chat which emulator will be used, that its window will be open, and what will be done on it. Follow the memory note `restopos-emulator-is-shared.md`:
- look at the screen before every tap;
- never tap in the owner's session;
- read the note whole first, and check the last commits and free memory;
- read papers through the stand-in printer, as that note says.

- [ ] **Step 4: Run it**

On the emulator, with the stand-in printer:
1. Open the day. Ring a counter order and a takeaway. Check:
   - the board shows `C-01` and `A-02`;
   - the receipt reads `CUSTOMER No. 01`, and a line with add-ons has them on one line;
   - the kitchen ticket reads `No. 02` and then the name.
2. Change a counter order to a takeaway before sending it. It becomes `A-03` from `C-03`.
3. Close the day. Ring an order: it is `C-01` again.
4. Test the reminder:
   - set the preparation time to 1 minute in the back office, or straight in dev's `pos_settings` for the test client, then sync;
   - set the reminder to 10 on the tablet (Settings, Notifications);
   - take a takeaway for 15 minutes from now on the pick-up clock: it rings and shows its banner about 5 minutes later;
   - an "as soon as possible" takeaway does not ring;
   - OK closes the banner;
   - restarting the app does not ring it again.
5. As a Cashier (default role), Settings, Payments is locked. As a Manager, it opens.

Put the preparation time and the reminder back as they were afterwards.

- [ ] **Step 5: Say what was run, and update memory**

Tell the owner what was seen, what was not, and that nothing is pushed or tagged. Update `C:\Users\sheik\.claude\projects\C--Projects-RestoPOS\memory\restopos-customer-number-reminder-payments.md`:
- what is built, with its commits;
- migration 0111 on dev only;
- the tablet's database 28;
- what was not seen.

Offer the release as the owner's step: a version bump commit, then push, then their tag. See memory `restopos-one-tag-release.md`, and name the commit.
