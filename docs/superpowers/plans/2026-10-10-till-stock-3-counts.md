# The shop's stock tools on the tablet, plan 3 of 3: counts, and the release

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. One session, no subagent a task.

**Goal:** a shop counts its shelves on the tablet with no connection, reviews the differences and
completes the count as one change; then the stock tools are ready to release.

**Architecture:** tablet only. A count the tablet starts is rows in `stock_counts` and
`stock_count_lines` with no number and no `server_seq`; every change to it is a plain-Kotlin function
(`CountBook`) written straight to the tablet's database. Completing sends the sales the till still
holds, then `count.complete` with exactly the count's lines; the server's rows then take the place of
the tablet's by their key.

**Tech stack:** Kotlin, Room, WorkManager, Jetpack Compose, Hilt, kotlinx.serialization, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-10-till-stock-tools-design.md`, section 6 and the three notes
at the end of section 7.

**Before starting:** plans 1 and 2 are committed with their records. The rules of plan 1's "Rules of
this folder" hold here.

---

### Task 1: a count's rules (`core/data/CountBook.kt`, `core/data/StockPayloads.kt`; test first)

```kotlin
// Quantities in thousandths, "no variant" as "", moments as the tablet's clock in milliseconds.
object CountBook {
    data class Stock(val item: String, val variant: String)        // a line of stock
    // counted null: nobody counted it. expected: what the tablet held of it when it was last counted.
    data class Line(val item: String, val variant: String = "", val counted: Int? = null, val countedAt: Long? = null, val expected: Int? = null, val leftOut: Boolean = false)

    // The lines of stock a count begins with: every product whose stock is counted, one line for a product without
    // variants and one for each live variant of one with; of the whole shop ("all"), one category, one supplier
    // (items.supplier_id) or one brand (whatever its capitals and spaces round it).
    fun scope(kind: String, scopeId: String?, brand: String?, items: List<ItemEntity>, counted: (ItemEntity) -> Boolean, variants: List<ItemVariantEntity>): List<Stock>
    fun title(kind: String, category: String?, supplier: String?, brand: String?): String?    // "The whole shop", or the name; null: nothing to count by
    fun add(lines: List<Line>, s: Stock, by: Int, now: Long, level: Int): List<Line>   // a scan or a tap: `by` more; a product outside the count joins it
    fun set(lines: List<Line>, s: Stock, units: Int, now: Long, level: Int): List<Line>   // typed: this figure, 0 allowed
    fun clear(lines: List<Line>, s: Stock): List<Line>              // back to not counted
    fun leaveOut(lines: List<Line>, s: Stock, out: Boolean): List<Line>
    fun progress(lines: List<Line>): Pair<Int, Int>                 // counted, of those not left out
    data class Row(val line: Line, val expected: Int, val diff: Int?)   // diff null: not counted
    fun review(lines: List<Line>, levelNow: (Stock) -> Int): List<Row>  // counted: against what it held when counted; not counted: what it holds now
    fun totals(rows: List<Row>): Triple<Int, Int, Int>              // lines that differ, units over, units short
    fun refused(code: String?): String   // nothing-to-count, bad-scope, bad-uncounted, unknown-store, unknown-item, not-counted, pick-variant, unknown-line, forbidden, conflict, unknown-op, null, else
}
// added to StockPayloads. Moments go as java.time.Instant.ofEpochMilli(ms).toString() ("2026-10-10T08:05:00Z");
// a line nobody counted sends counted and counted_at as JSON null; clockAheadMs is the till's clock less the server's.
fun countComplete(id: String, store: String, kind: String, scopeId: String?, scopeText: String?, startedAt: Long, clockAheadMs: Long, uncounted: String, lines: List<CountBook.Line>, approvedBy: String?): JsonObject
```

- `level` in `add` and `set` is what the tablet holds of the line at that moment; it becomes the line's
  `expected`. That is the spec's "with its own sales since the line was counted put back", kept instead
  of worked out afterwards.
- [ ] `CountBookTest`: `scope` for each kind, a product with variants giving one line a variant and
  none for itself, an uncounted product left out of it, a brand matched as ` nike ` to `Nike`; `add`
  twice is 2000 with the second moment and the second level; `add` of a product outside the count
  joins it; `set` to 0 is counted at nothing; `clear`; `leaveOut` and back; `progress` ignores what is
  left out; `review` of a line counted 9000 when the tablet held 10000 is -1000 whatever it holds now,
  and of an uncounted line shows what it holds now and no difference; `totals`; every refusal;
  `countComplete` for the fixture's count equals
  `../../db/tests/fixtures/till-stock/count-complete.json`. Fail, write, pass. Commit.

### Task 2: the till's held sales can be sent on the spot (`core/sync/PushWorker.kt`)

```kotlin
enum class Drained { Done, Retry, Failed }
// Sends what waits in the outbox, batch after batch, exactly as the worker did: applied and duplicate rows
// leave it, a rejected one is set aside, anything else stays. Done: nothing is left to send.
suspend fun drainOutbox(db: TillDatabase, api: ApiClient, session: SessionStore): Pair<Drained, Boolean>   // and whether anything went up
```

- The body is `PushWorker.doWork`'s loop, moved. `doWork` calls it, then pulls when anything went up and
  maps `Done` to success, `Retry` to retry, `Failed` to failure, as now.
- [ ] All unit tests pass; the debug app builds. On my emulator a sale in the made-up shop still leaves
  the outbox the way it did (it stays queued with no server, and the till says so as before). Commit.

### Task 3: a count on the tablet (`core/database/Stock.kt`, `core/data/StockRepository.kt`)

```kotlin
// added to StockRepository (it now also takes ApiClient, for the clock)
suspend fun ownCount(): StockCountEntity?                                   // this tablet's open count, if any
suspend fun startCount(kind: String, scopeId: String?, brand: String?, approver: StaffMember? = null): Result<String>   // staff.allow("stock.count", "count stock", approver); refuses a second open count and an empty scope
suspend fun counted(countId: String, s: CountBook.Stock, by: Int)           // a scan or a tap
suspend fun typed(countId: String, s: CountBook.Stock, units: Int)
suspend fun uncount(countId: String, s: CountBook.Stock)
suspend fun leaveOut(countId: String, s: CountBook.Stock, out: Boolean)
suspend fun dropCount(countId: String)                                      // thrown away: it never reached the server
suspend fun completeCount(countId: String, uncounted: String, approver: StaffMember? = null): Result<Unit>
```

- `startCount` writes the count (`status = "open"`, `title` from `CountBook.title`, `started_by`,
  `created_at` now) and one line for each of `CountBook.scope`, in one transaction.
- Each change reads the count's lines, applies `CountBook`, and writes the line back with the level the
  tablet holds (`RetailDao.levelsOf`), in one transaction.
- `completeCount`: `drainOutbox` first; anything but `Done` fails with "The sales this till is holding
  have to go up first. Complete the count when the tablet is online."; then
  `ask("count.complete", CountBook::refused, StockPayloads.countComplete(...))` with
  `api.clockAhead.value ?: 0`; done: the tablet's row is marked `completed`, and the sync that `ask`
  starts brings the server's count and lines over them.
- [ ] Compiles; all unit tests pass. Commit with Task 4.

### Task 4: Counts (`feature/stock/Counts.kt`, `feature/stock/Counting.kt`, `feature/stock/StockScreen.kt`, `feature/settings/SettingsScreen.kt`)

- `CountsViewModel`: the shop's counts, newest first; the tablet's own open count and its lines as a
  flow; a `ProductPick` whose `onAdd` counts one more of what was chosen; `NumAsk` to type a figure;
  the review; the levels.
- The list: number (or "On this tablet" while it has none), what it is of, its state, when, who. An
  open count that is not this tablet's says "Open in the back office" and does not open. **Start a
  count** opens a sheet: The whole shop, A category, A supplier, A brand (the brands the products
  carry), each with how many lines it would count. With a count already open on this tablet the key is
  **Carry on counting**.
- `Counting`: on the left two lists under one head ("38 of 120 counted"): Counted, newest first, each
  with its figure (a tap opens the keypad; a long press offers "Not counted" and "Leave out of this
  count"), and Not counted. On the right `ProductPane`. A scan says the product and its new figure
  through `Scanner.say`. **Review** and **Throw this count away** (behind a confirmation) in the head.
- The review: each line that differs, with expected, counted and the difference (and its worth, for
  someone who may see costs: difference times the level's average cost); how many match; the lines
  nobody counted, with the choice **Leave them as they are** or **Set them to nothing**; one sentence,
  "Sales made on another till since its last sync are not in these figures; the server works the count
  out again with them."; **Complete the count**.
- A finished count's record, wherever it was made: its lines with expected, counted and difference as
  the server wrote them.
- The tab's "Coming with the next build" text is removed for Counts.
- `SHOP_HELP`: "Counting your stock", "Reviewing and completing a count".
- [ ] On my emulator with the made-up shop: a count of one category started; taps, a scan
  (`DEMO_SCAN`), a typed figure, a product with variants, one from another category joining it; a line
  left out and put back; the app closed and opened: the count is there with its figures; a sale made
  on Sell in the middle, and the review of a line counted before it is unchanged; Complete with no
  connection keeps the count and says why; a second Start a count is Carry on counting; throwing it
  away; all of it at `1024x600`. Commit.

### Task 5: the release is ready (`android/app/build.gradle.kts`, this file)

- [ ] Every suite of plan 1's Task 1 passes on dev, one at a time, output to files.
- [ ] All unit tests pass; `:app:assembleDebug` builds.
- [ ] One pass on my emulator over the whole Stock screen, each tab, as a manager and as a cashier.
- [ ] The version: `git ls-remote --tags github` and `gh release list`. If `v0.9.0` is released, this is
  `versionName "0.10.0"`, `versionCode 14`. If it is not, ask the owner whether the stock tools go out
  with the labels in 0.9.0 or after them, and change nothing until they say.
- [ ] Commit. Append the record of the three plans: what was built, what was seen and where, and
  **what nobody has seen**: every save from a signed-in till, a count completed against the server, a
  real scanner, a shop with two tills.
- [ ] Tell the owner, in this order: what to try on a dev shop signed in (a supplier, an order sent, a
  delivery against it, labels for it, a count of a category with a sale in the middle); that the
  server's migration can go to production before the till and changes nothing for tills in use; that
  both tags are theirs.
