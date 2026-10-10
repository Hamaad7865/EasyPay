# Reports on the tablet: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. One session, no subagent a task.

**Goal:** a Reports screen on the till with the nine reports of the owner's picture, each for a period
picked at the top, each printable on the receipt printer.

**Architecture:** every report is a plain-Kotlin function (`core/data/Reports.kt`) of the receipts this
till holds and of what each printed (`ReceiptDoc`), so the arithmetic is tested on the JVM. Sales
Summary and Tax Report take their totals from `CashOps.period`, the sum the day closings are made from,
so the two always agree. One repository loads a period's receipts and prints; one screen lists the nine
on the left and draws the open one on the right. Part B adds the tablet's own log (`till_log`) for the
two things it keeps no record of today, a product's price changed and a payment type corrected.

**Tech stack:** Kotlin, Room, Jetpack Compose, Hilt, kotlinx.serialization, JUnit 4. No server change.

**Spec:** `docs/superpowers/specs/2026-10-11-till-reports-design.md`. Approved: "Yes go ahead and write
the build plan and build it then report to me when its done".

**Rules of this folder:** as `2026-10-10-till-stock-1-base.md`. Another session commits here: read a
file as committed before editing it, stage only the files a task names. The till's database is at 15
(table ordering); the log makes it the next number at the time. The owner's emulator (5590) may be
used at their word to show them, with `install -r` and never `pm clear`; anything that wipes or resizes
is done on a hidden one of mine. Paths are under `android/app/src/main/java/com/restopos/`.

---

## Part A: the screen and the seven reports that need nothing new

### Task 1: the reports' arithmetic (`core/data/Reports.kt`; test first)

```kotlin
object Reports {
    // A receipt as a report reads it: the row the tablet keeps, and what it printed.
    data class Sale(val id: String, val number: String, val refund: Boolean, val refundOf: String?, val at: Long, val total: Long, val doc: ReceiptDoc?)

    enum class Pick(val label: String) { Today("Today"), Yesterday("Yesterday"), Week("This week"), Month("This month"), LastMonth("Last month"), Custom("Dates") }
    // from is not in the period and to is, as CashOps.period reads them: the last instant of the day before, the last of the last day.
    data class Span(val from: Long, val to: Long, val first: LocalDate, val last: LocalDate)
    fun span(pick: Pick, today: LocalDate, zone: ZoneId, from: LocalDate? = null, to: LocalDate? = null): Span   // a week starts on Monday; Custom takes its two days in either order; nothing after today
    fun says(s: Span): String                                // "11 Oct 2026", "5 Oct to 11 Oct 2026"

    data class Day(val day: LocalDate, val sales: Int, val refunds: Int, val net: Long)
    fun byDay(sales: List<Sale>, zone: ZoneId): List<Day>    // only days something happened, oldest first

    // name; how many receipts (or, for products and categories, units in thousandths); the amount, refunds taken off; its share of the whole in tenths of a percent
    data class Cut(val name: String, val count: Int, val qty: Int, val amount: Long, val share: Int)
    fun byCategory(sales: List<Sale>): List<Cut>             // a line's category as it printed; "No category"
    fun byStaff(sales: List<Sale>): List<Cut>                // the cashier on the receipt; "Nobody signed in"
    fun byOrderType(sales: List<Sale>): List<Cut>            // the order type on the receipt; "Direct sale"
    fun items(sales: List<Sale>, byQty: Boolean): List<Cut>  // ranked by amount, or by quantity

    data class Hour(val hour: Int, val sales: Int, val amount: Long)
    fun hourly(sales: List<Sale>, zone: ZoneId): List<Hour>  // from the first hour with a sale to the last, the empty ones between included

    data class Tx(val id: String, val number: String, val at: Long, val refund: Boolean, val who: String?, val paid: String, val total: Long)
    fun transactions(sales: List<Sale>): List<Tx>            // newest first; paid: "Cash", "Cash + Card"

    data class Repriced(val at: Long, val receipt: String, val receiptId: String, val product: String, val was: Long, val charged: Long, val why: String, val who: String?)
    fun repriced(sales: List<Sale>): List<Repriced>          // lines that printed with another price than listed, sales only

    data class Refund(val id: String, val number: String, val of: String?, val at: Long, val amount: Long, val who: String?)
    fun refunds(sales: List<Sale>): List<Refund>             // of: the number of the sale it refunds, when the tablet holds it

    data class TaxLine(val name: String, val rateBp: Int, val excl: Long, val vat: Long, val incl: Long)
    // For each rate the VAT is what the receipts printed. What it was charged on is worked out from it
    // and the rate, because the tablet keeps no VAT line by line; what is left of net sales is "No VAT".
    fun tax(taxes: List<DocTax>, net: Long): List<TaxLine>
}
```

- [ ] `ReportsTest`: `span` for each pick on a Wednesday and on the 1st of a month; `byDay` across
  midnight; each cut with a refund taken off, a receipt with no printed record left out of the cuts and
  kept in `transactions`; shares adding to 1000 within rounding; `items` by amount and by quantity, a
  product sold by weight; `hourly` with a gap; `transactions` with two payments; `repriced` for "10%
  off" and "Price changed" and not for a refund; `refunds` naming their sale; `tax` for 15% included,
  for two rates, for a rate of 0 and for sales with no VAT at all. Fail, write, pass. Commit.

### Task 2: loading and printing (`core/data/CashOps.kt`, `core/data/ReportsRepository.kt`, `core/database/Ops.kt`, `core/print/Docs.kt`)

- `CashOps`: `class Figures(...)` (what `Period` holds, public) and `suspend fun figures(from: Long, to: Long): Figures`
  for this till; `period` itself is unchanged.
- `OpsDao`: `dayClosesBetween(device, from, to)`.
- `ReportsRepository` (`@Singleton`): `suspend fun sales(span): List<Reports.Sale>` (this till's
  receipts between, each with its decoded record), `figures(span)`, `days(span): List<ShiftRow>` (each
  day closed in the period with its shift: opened and closed when and by whom, float, expected,
  counted), `dayDoc(row)`, `printDay(row)` (the existing `printZOf`), `since(): Long?` (this till's
  first receipt), `print(title, span, lines)`.
- `Docs.report(d: ReportDoc, shop, paper): ByteArray` with `ReportDoc(title, period, till, lines:
  List<ReportLine>)`, a line being a heading, a rule, or a left and a right. `Docs.reportLook` for tests.
- [ ] A test of `Docs.reportLook` at 32 and 48 columns: the title, the period, a heading, a row whose
  left is too long for the paper wrapped and not cut. Compiles; all unit tests pass. Commit.

### Task 3: the screen (`feature/reports/` new, `feature/main/MainShell.kt`, `feature/today/Today.kt`, `feature/settings/SettingsScreen.kt`)

- `Screen.Reports`, in both side menus (`BACK`, `SHOP_BACK`), routed to `ReportsScreen`; a "Reports" key
  on Today.
- `ReportsViewModel`: which report, the pick and the two dates, the period's sales and figures loaded
  when either changes, `allowed` and `unlock()` as `TodayViewModel` (and forgotten on leaving), the
  item ranking's order, Sales Analysis's cut, `print()`.
- `ReportsScreen(vm, onReceipt)`: the nine on the left as the picture lists them, the period keys and
  Print above the report, the report on the right. A date sheet for the two dates (a stepper a date).
  Price Change and Resettlement show their first list now and say the second "is kept from the next
  build" until Part B.
- One composable a report, in `feature/reports/Views.kt`: rows of name, count, amount and a share bar;
  Hourly as bars; Transaction Detail rows that open the receipt (`onReceipt`); Shift Record rows that
  open the day's closing figures in a sheet with Print again.
- What a report covers, said under its title: "This till, since <first receipt's day>".
- Help: one entry in `HELP` and one in `SHOP_HELP`.
- [ ] Compiles; all unit tests pass; the debug app builds. Commit with Task 4's record.

### Task 4: seen running

- [ ] With the made-up shop, on an emulator: sales rung up (a plain product, a variant, one by weight),
  a discount on a line, a price changed, a refund, a day closed; each of the seven reports read against
  what was done; Sales Summary's figures against the day closing printed for the same day; every period
  key; two dates; Print to the stand-in printer (`printer_listen.cjs` pattern: a listener on this PC at
  10.0.2.2:9100) and the bytes read back as text; a cashier asked for a manager; `1024x600`. The same
  screen with the made-up restaurant (`--es type restaurant`) for the order types.
- [ ] Commit. Record at the end of this file.

## Part B: the log, Price Change and Resettlement

### Task 5: the tablet writes it down (`core/database/TillLog.kt` new, `TillDatabase.kt`, `Migrations.kt`, `app/di/AppModule.kt`, `core/data/Service.kt`, `core/data/OrderOps.kt`)

```kotlin
// kind "price": item_id, variant_id, was and now in cents. kind "payment": receipt_id, was and now are payment type names.
@Entity(tableName = "till_log", indices = [Index("at")])
data class TillLogEntity(@PrimaryKey val id: String, val at: Long, val kind: String, val employee_id: String? = null, val approved_by: String? = null,
    val item_id: String? = null, val variant_id: String? = null, val receipt_id: String? = null, val was: String, val now: String)
```

- `TillLogDao` (`db.log()`): `add(row)`, `between(kind, from, to)`, `first(): Long?`.
- The next database version and its step: the one `CREATE TABLE` and its index, as Room exports them.
- Written in the same transaction as the change: `ServiceRepository.setPrice`, `setVariantPrice`,
  `OrderOps.correctPayment`. Nothing is sent to the server and nothing of it is pulled; it is kept
  through the mirror being cleared (it is not the server's).
- [ ] Compiles; the schema file is committed. Commit.

### Task 6: the two lists (`core/data/Reports.kt`, `core/data/ReportsRepository.kt`, `feature/reports/Views.kt`; test first)

- `Reports.PriceChange(at, product, was, now, who, approvedBy)` and `Reports.Corrected(at, receipt,
  receiptId, was, now, who, approvedBy)`, made from log rows and names in the repository.
- Price Change's second list and Resettlement's second list drawn; each says from which day the tablet
  has kept it (`log().first()`), or that nothing was changed since this build.
- [ ] Tests for the two mappings (a product gone, a variant, a receipt the tablet no longer holds).
  Fail, write, pass.
- [ ] On the emulator: a price changed on Products & stock and on a variant, a payment corrected on
  Receipts, each seen in its report with who did it; the database's step with data. Commit. Record.
