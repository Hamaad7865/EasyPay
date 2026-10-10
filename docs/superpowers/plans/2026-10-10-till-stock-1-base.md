# The shop's stock tools on the tablet, plan 1 of 3: the server and the base

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. One session, no subagent a task.

**Goal:** the server answers every stock change a tablet will make and sends a shop's till its stock
data; the tablet holds that data and shows the Stock screen with Suppliers and History.

**Architecture:** all of the server's work for the three plans is one migration with one suite, so the
contract is finished and tested before any screen. The tablet's database grows by eight tables and a
drafts table; `PullApplier` fills them; screens read only the tablet. Saves are new waited changes
through `ask()`, each wrapping a rule the server already has. Plans 2 and 3 add screens only.

**Tech stack:** Postgres (plpgsql), node `pg` suites, Kotlin, Room, Jetpack Compose, Hilt,
kotlinx.serialization, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-10-till-stock-tools-design.md`. Read it first.

**Rules of this folder:**
- Another session works in this folder. Before every edit of a file that exists, read it as committed
  (`git show HEAD:<path>`); stage only the files a task names; never `git add -A`.
- Take the next free numbers at the time: `ls db/migrations | tail -1` (0092 when this was written) and
  `version =` in `core/database/TillDatabase.kt` (13 when written). If they moved, use the next and say
  so in the commit.
- A function that exists is rebuilt from its **live** definition on dev
  (`node db/scripts/dump-function.cjs <name>`), the same hour the migration is applied, never from an
  older migration file. The migration's header names what was copied.
- Dev only. `node db/migrate.cjs` applies to dev; production and every tag are the owner's.
- A suite's output goes to a file in the scratchpad, never through `head`: a suite cut short leaves its
  test clients on dev.
- Kotlin is edited with the Edit tool, not from a heredoc. Paths below are under
  `android/app/src/main/java/com/restopos/` unless they start with `db/`, `android/` or `docs/`.
- Unit tests: `android/gradlew -p android :app:testDebugUnitTest --tests "<class>"`; add
  `--priority low --max-workers 2` while an emulator is open.
- Quantities are thousandths (one unit is 1000), money is cents, "no variant" is `""` on the tablet and
  null on the server.

---

## Part A: the server

### Task 1: the suite first (`db/tests/till-stock.test.cjs`, `db/tests/fixtures/till-stock/*.json`)

Set up as `db/tests/till-setup.test.cjs` does (its `check`, `op`, `asApp`, `pushAs`, `one`, `pull`): a
shop `TS-Probe` (`pos_settings.data.businessType = 'retail'`), a restaurant `TS-Resto`, another shop
`TS-Other`; in the shop a second store; roles Owner `['*']`, Stock `['stock.receive','stock.count',
'stock.view','suppliers.edit']`, Cashier `['sale.create','payment.take']`; two products counted in
stock (one plain, one with two variants) and one that is not counted. Everything it makes is removed in
`finally`.

The example payloads, one file a change, each `{ "type": ..., "payload": ... }` with these stand-in ids,
which the suite swaps for real ones before sending and the Kotlin tests of plans 1 to 3 pass in as they
are: `store-1`, `supplier-1`, `order-1`, `delivery-1`, `count-1`, `item-plain`, `item-sized`,
`variant-s`, `variant-m`, `emp-manager`.

| File | Payload |
|---|---|
| `supplier-save.json` | `{"id":"supplier-1","name":"Maurilait","contact":"Devi","phone":"52501234","email":"","address":"Phoenix","note":""}` |
| `supplier-remove.json` | `{"id":"supplier-1"}` |
| `po-save.json` | `{"id":"order-1","store_id":"store-1","supplier_id":"supplier-1","expected_on":"2026-10-20","note":"","lines":[{"item_id":"item-plain","variant_id":"","qty":12000,"unit_cost":4500},{"item_id":"item-sized","variant_id":"variant-s","qty":6000,"unit_cost":18000}]}` |
| `po-send.json`, `po-cancel.json`, `po-close.json` | `{"id":"order-1"}` |
| `delivery-receive.json` | `{"id":"delivery-1","store_id":"store-1","order_id":"order-1","supplier_id":"","arrived_on":"2026-10-10","invoice_no":"INV-88","note":"","lines":[{"item_id":"item-plain","variant_id":"","qty":10000,"unit_cost":4600}]}` |
| `count-complete.json` | `{"id":"count-1","store_id":"store-1","scope_kind":"all","scope_id":"","scope_text":"","started_at":"2026-10-10T08:00:00Z","clock_ahead_ms":0,"uncounted":"leave","lines":[{"item_id":"item-plain","variant_id":"","counted":9000,"counted_at":"2026-10-10T08:05:00Z","left_out":false},{"item_id":"item-sized","variant_id":"variant-s","counted":null,"counted_at":null,"left_out":false},{"item_id":"item-sized","variant_id":"variant-m","counted":null,"counted_at":null,"left_out":true}]}` |

Checks, by group. Each change is tried by the Owner, by Stock, by the Cashier (refused `forbidden`), and
by the Cashier with `approved_by` a Stock person (done).

- [ ] **Suppliers.** Saved, then in a pull. Saved again with the same id and another phone: one
  supplier, the phone changed. A second id with the same name in other capitals: `name-taken`. An empty
  name: `name-required`. Removed: `deleted_at` set, and removed again: done. Another client's supplier
  id: `conflict`, nothing of theirs changed.
- [ ] **Orders.** `po.save` with a new id makes a draft numbered `PO-0001` with two lines; sent again
  unchanged: still one order, two lines, the same number. Saved again with one line: one line. Two lines
  of one product in one save: one line, quantities added. An unknown supplier: `unknown-supplier`; a
  product not counted: `not-counted`; a product with variants named without one: `pick-variant`; a
  variant that is not the product's: `unknown-line`. `po.send`: sent; again: done, `sent_at`
  unchanged. `po.save` on it now: `not-draft`. `po.send` of a draft with no lines: `no-lines`.
  `po.cancel` of a sent order: cancelled; again: done. `po.close` of an order that is not part
  received: `not-part`; of a part-received one: closed; again: done.
- [ ] **Deliveries.** Against the sent order: stock up by what arrived, the product's cost is the cost
  typed, the order `part`, then `received` when the rest arrives. The same delivery sent again: the
  first answer, stock moved once. With no order and no supplier: written. A line of a product that is
  not on the order: written with no order line. Nothing in it: `nothing-received`. Against a draft:
  `not-open`.
- [ ] **Counts.** The example: the count exists with exactly its three lines, `C-0001`, completed; the
  plain product holds 9000 plus what sold after 08:05 on a receipt whose own time is later; the
  uncounted line is as it was; the left-out line is as it was. With `"uncounted":"zero"`: the uncounted
  line is 0, the left-out one untouched, **and a counted product that was not among the lines keeps its
  stock**. The same count sent again: the first answer, no second movement. A sale stamped 08:04 by the
  till's clock does not count as after; one stamped 08:06 does. The tablet's clock ten minutes fast
  (`clock_ahead_ms: 600000`): a correction is made now, then a count whose line was counted at "now
  plus 8 minutes" by the tablet's clock (2 minutes before the correction, in truth) is completed, and
  the correction counts as after it; with a line counted at "now plus 12 minutes" it does not. No
  lines: `nothing-to-count`. `uncounted` of anything else:
  `bad-uncounted`. A scope kind of anything else: `bad-scope`. `clock_ahead_ms` beyond a day:
  `bad-payload`.
- [ ] **The pull.** The shop's till is sent `suppliers`, `purchase_orders` (each with `lines`, each line
  with `received`), `deliveries` (each with `lines`), `stock_counts`, `stock_count_lines` of counts that
  are finished, `stock_movements`. A draft whose lines were replaced on the server arrives with the new
  lines only. The shop's second store is sent none of the first store's orders, deliveries, counts or
  movements, and all of the suppliers. An order closed 31 days ago (its `updated_at` set back in the
  test) is not sent; an open one of the same age is. The restaurant's pull has none of the six keys.
  `TS-Other` is sent nothing of `TS-Probe`'s. Run with `KEEP_PULL=<file>` the suite writes the shop's
  pull to that file, for Task 4's check on the emulator.
- [ ] **What must not move.** `node db/tests/purchase-orders.test.cjs`, `stock-counts.test.cjs`,
  `stock-adjust.test.cjs`, `till-categories-stock.test.cjs`, `till-setup.test.cjs`,
  `till-requests.test.cjs`, `pull-pages.test.cjs`, `retail-till.test.cjs`, `shop-pages.test.cjs` pass
  as before, one at a time.
- [ ] Run the new suite before the migration exists: it fails on `unknown-op`. Commit the suite and the
  fixtures.

### Task 2: the migration (`db/migrations/0092_till_stock.sql`)

- `alter table stock_counts add column if not exists clock_ahead_ms integer not null default 0`.
- `stock_moved_since_at(p_tenant, p_store, p_item, p_variant, p_since timestamptz, p_since_server
  timestamptz) returns integer`: as `stock_moved_since`, a sale or refund judged against `p_since` by
  the receipt's own time, everything else against `p_since_server`. `stock_moved_since` stays.
- `count_complete`, from its live definition, with one change: it reads the count's `clock_ahead_ms`
  and asks `stock_moved_since_at(..., r.counted_at, r.counted_at - make_interval(secs =>
  clock_ahead_ms / 1000.0))`. A back office count has 0 and behaves as before.
- `count_from_till(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb`: under
  `pg_advisory_xact_lock(hashtextextended(id::text, 0))`; a count of this client with that id is
  answered with what was written (`already: true`); else checks the store, the scope kind, the title
  (as `count_start` works it out; a brand's is `scope_text`), `clock_ahead_ms` within a day, at least
  one line; takes `next_doc_number(p_tenant, 'count')`; inserts the count with the id given and
  `clock_ahead_ms`; inserts **exactly the lines given** (`stock_line_ok` on each, `variant_id` through
  `nullif(..., '')`, `counted_at` as sent, `counted_by` the person); then `count_complete` with
  `uncounted`. It never reads `stock_on_hand`.
- `po_save_as(p_tenant, p_emp, p_id uuid, p_store, p_supplier, p_expected date, p_note, p_lines)`: no
  order of this client with that id: a new draft with that id, as `po_save` makes one; otherwise
  `po_save` on it.
- `po_fill_low`, from its live definition, plus `update purchase_orders set updated_at = now()` on the
  order, so that a till is sent the draft again when the back office fills it.
- The six `push_*` functions, each `(p_tenant uuid, p_emp uuid, p jsonb) returns jsonb`, each reading
  its payload inside `begin ... exception when others then raise exception 'bad-payload'`, each asking
  `may(p_emp, p, '<permission>')` or raising `forbidden`:
  - `push_supplier_save` (`suppliers.edit`): name trimmed to 120 and required (`name-required`), the
    other fields trimmed to the back office's lengths (120, 40, 120, 200, 200), empty as null; the row
    with that id updated, or inserted; a `unique_violation` on the name raised as `name-taken`.
  - `push_supplier_remove` (`suppliers.edit`): `deleted_at = now()` where it is null; done either way.
  - `push_po_save` (`stock.receive`): `po_save_as`.
  - `push_po_state(p_tenant, p_emp, p, p_what text)` (`stock.receive`), called for `po.send`,
    `po.cancel`, `po.close`: an order already `sent`, `part` or `received` answers a send done;
    `cancelled` a cancel; `closed` a close; otherwise `po_send`, `po_cancel`, `po_close`.
  - `push_delivery_receive` (`stock.receive`): `delivery_receive`.
  - `push_count_complete` (`stock.count`): `count_from_till`.
- `sync_push`, from its live definition, with the eight `when` lines (`supplier.save`,
  `supplier.remove`, `po.save`, `po.send`, `po.cancel`, `po.close`, `delivery.receive`,
  `count.complete`) and, in `codes`: `unknown-supplier`, `unknown-store`, `unknown-order`, `not-draft`,
  `no-lines`, `already-received`, `not-open`, `not-part`, `bad-delivery`, `nothing-received`,
  `unknown-line`, `bad-scope`, `nothing-to-count`, `bad-uncounted`, `bad-quantity`.
- `sync_pull`, from its live definition, with one block run only when
  `exists (select 1 from pos_settings where tenant_id = current_tenant_id() and data->>'businessType' = 'retail')`,
  each statement in the shape of the loops above it (rows over the cursor, ordered by `server_seq`,
  limited, feeding `high`, `low_cut` and `more` the same way):
  - `suppliers`: all of the client's;
  - `purchase_orders`: this store, `status in ('draft','sent','part') or updated_at > now() - interval
    '30 days'`, each row with `lines`: a JSON list of its lines (`item_id`, `variant_id`, `qty`,
    `unit_cost`, and `received`, the sum of its delivery lines), worked out when the pull runs;
  - `deliveries`: this store, the last 30 days, each with `lines` the same way;
  - `stock_counts`: this store, `status = 'open' or created_at > now() - interval '30 days'`;
  - `stock_count_lines`: joined to a count of this store that is not open and is within the 30 days;
  - `stock_movements`: this store, the last 30 days.
- No grant: 0087 and 0089 give none for their `push_*` functions, and `sync_push` calls these as they
  call those. The new column needs none either.
- [ ] `node db/migrate.cjs`; the new suite passes whole; the nine suites of Task 1 pass one at a time.
- [ ] Commit the migration alone, its header saying what was copied from where and "Never edit after
  merge".

Known and left as it is: "Delete all transactions" in the back office removes orders, deliveries,
counts and movements on the server and tells no till, as it tells none about receipts.

---

## Part B: the tablet's data

### Task 3: the tables (`core/database/Stock.kt` new, `Entities.kt`, `Retail.kt`, `TillDatabase.kt`, `Migrations.kt`)

```kotlin
@Entity(tableName = "suppliers") data class SupplierEntity(@PrimaryKey val id: String, val tenant_id: String, val name: String,
    val contact: String? = null, val phone: String? = null, val email: String? = null, val address: String? = null, val note: String? = null,
    val deleted_at: String? = null, val server_seq: Long? = null)
@Entity(tableName = "purchase_orders") data class PurchaseOrderEntity(@PrimaryKey val id: String, val store_id: String, val number: String,
    val supplier_id: String, val status: String, val expected_on: String? = null, val note: String? = null, val created_by: String? = null,
    val sent_at: Long? = null, val created_at: Long = 0, val updated_at: Long = 0, val deleted_at: String? = null, val server_seq: Long? = null)
@Entity(tableName = "purchase_order_lines", primaryKeys = ["order_id", "item_id", "variant_id"])
data class PurchaseOrderLineEntity(val order_id: String, val item_id: String, val variant_id: String = "", val qty: Int, val unit_cost: Long, val received: Int = 0)
@Entity(tableName = "deliveries") data class DeliveryEntity(@PrimaryKey val id: String, val store_id: String, val number: String,
    val order_id: String? = null, val supplier_id: String? = null, val arrived_on: String, val invoice_no: String? = null, val note: String? = null,
    val received_by: String? = null, val created_at: Long = 0, val server_seq: Long? = null)
@Entity(tableName = "delivery_lines", primaryKeys = ["delivery_id", "item_id", "variant_id"])
data class DeliveryLineEntity(val delivery_id: String, val item_id: String, val variant_id: String = "", val qty: Int, val unit_cost: Long)
// number and server_seq are null while a count is this tablet's own and has not gone up
@Entity(tableName = "stock_counts") data class StockCountEntity(@PrimaryKey val id: String, val store_id: String, val number: String? = null,
    val scope_kind: String, val scope_id: String? = null, val scope_text: String? = null, val title: String, val status: String,
    val uncounted: String? = null, val started_by: String? = null, val completed_by: String? = null, val completed_at: Long? = null,
    val created_at: Long = 0, val server_seq: Long? = null)
@Entity(tableName = "stock_count_lines", primaryKeys = ["count_id", "item_id", "variant_id"])
data class StockCountLineEntity(val count_id: String, val item_id: String, val variant_id: String = "", val counted: Int? = null,
    val counted_at: Long? = null, val left_out: Boolean = false, val expected: Int? = null, val diff: Int? = null, val unit_cost: Double? = null,
    val server_seq: Long? = null)
@Entity(tableName = "stock_movements") data class StockMovementEntity(@PrimaryKey val id: String, val store_id: String, val item_id: String,
    val variant_id: String = "", val qty: Int, val reason: String, val unit_cost: Double? = null, val ref_type: String? = null, val ref_id: String? = null,
    val receipt_id: String? = null, val employee_id: String? = null, val note: String? = null, val created_at: Long = 0, val server_seq: Long? = null)
// kind: "order" or "delivery". What is being typed and has not been sent.
@Entity(tableName = "stock_drafts") data class StockDraftEntity(@PrimaryKey val kind: String, val body: String, val updated_at: Long)
```

- `ItemEntity` gains `cost: Long? = null`, `supplier_id: String? = null`, `brand: String? = null`;
  `ItemVariantEntity` gains `cost: Long? = null`; `StockLevelEntity` gains `avg_cost: Double = 0.0`,
  `reorder_point: Int? = null`, `reorder_qty: Int? = null`.
- `StockDao` (`db.stock()`), in `Stock.kt`: upserts for each table; `replaceOrderLines(orderId, rows)`
  and `replaceDeliveryLines(deliveryId, rows)` (delete the document's lines, insert the ones given, in
  the caller's transaction); `suppliers(): Flow<List<SupplierEntity>>` (live ones, by name);
  `supplier(id)`; `orders(store): Flow`, `order(id)`, `orderLines(id)`; `deliveries(store): Flow`,
  `delivery(id)`, `deliveryLines(id)`; `counts(store): Flow`, `count(id)`, `countLines(id): Flow`,
  `openOwnCount(store)` (status open, `server_seq IS NULL`); `movements(store, limit): Flow` (newest
  first); `draft(kind)`, `saveDraft(row)`, `dropDraft(kind)`; `clearFromServer()`: deletes every row
  of the eight tables except counts whose `server_seq IS NULL` and their lines, and never touches
  `stock_drafts`.
- `MIGRATION_13_14`: the seven `ALTER TABLE ... ADD COLUMN`, the nine `CREATE TABLE` exactly as Room's
  exported schema writes them (`android/app/schemas/.../14.json` after a build), then
  ``UPDATE `sync_state` SET `cursor` = 0``, so that products gain their cost and supplier. Add it to
  the list of migrations; `version = 14`; a comment line for version 14 in `TillDatabase.kt`.
- This project has no test that opens a database at an old version: each step so far was seen on an
  emulator holding data (10 to 11 was). So is this one, in Task 9. What can be checked here: every
  `CREATE TABLE` and index in the migration is, character for character, the `createSql` Room exports.
- [ ] `:app:assembleDebug` builds; the migration's statements match
  `android/app/schemas/com.restopos.core.database.TillDatabase/14.json`; that file is committed with
  the code. Commit.

### Task 4: the sync fills them (`core/sync/PullApplier.kt`, `core/sync/Sync.kt`)

- `items`, `item_variants`, `stock_levels`: keep the new fields (`cost`, `supplier_id`, `brand`;
  `cost`; `avg_cost` as a double, `reorder_point`, `reorder_qty`).
- `suppliers`, `stock_counts`, `stock_count_lines`, `stock_movements`: upserted row for row. A count
  line's key is count, product, variant, so the server's lines of a count this tablet sent take the
  place of its own.
- `purchase_orders`, `deliveries`: the row upserted and its lines replaced by the row's `lines`.
- Times through the applier's own `time()`; a date (`expected_on`, `arrived_on`) kept as the text sent;
  `variant_id` null as `""`.
- `Sync.kt`, where a changed epoch clears the mirror: also `db.stock().clearFromServer()`.
- The applier has no unit test (it needs a database). It is checked as it was for the shop's receipts:
  the debug build takes a page of a pull with no network (`DEMO_PULL` in `DemoReceiver`, which reads
  the page as dev sends it), and `db/scripts/read-till-state.cjs` shows how to copy the till's database
  off an emulator and open it with `node:sqlite`.
- [ ] After Task 5, on my emulator: a page of dev's pull for the suite's shop (kept from Task 1 as a
  file, with one of each new row) is fed in and the eight tables read back hold it; the same order fed
  again with one line has one line; `variant_id` null arrived as `""`. Commit.

### Task 5: the made-up shop has stock papers (`android/app/src/debug/assets/demo-shop.json`, `android/app/src/debug/java/com/restopos/debug/DemoReceiver.kt`)

- The file gains `suppliers` (two), `orders` (a draft, a sent one with lines), `deliveries` (one against
  no order), `movements` (a sale, a delivery, a correction), and on its items a `supplier`, and on two
  of them a `reorder_point` below what they hold and above.
- The receiver writes them through `StockDao` with the shop's own ids, and the levels' reorder points.
- [ ] Debug build compiles. Commit with Task 6.

---

## Part C: the screen, Suppliers and History

### Task 6: one product pane for every screen (`feature/retail/ProductPane.kt` new, `feature/retail/Labels.kt`)

Read `Labels.kt` as committed first: another session finished the label designer in it today.

```kotlin
// The right-hand side of Print labels, Receive, an order and a count: the shop's products found by
// tapping, searching or scanning. It hands each product chosen to `onAdd`, which says whether it took it.
class ProductPick(
    private val scope: CoroutineScope, private val db: TillDatabase, session: SessionStore, private val sales: RetailSales,
    private val said: (ItemEntity, ItemVariantEntity?) -> String,          // the scanner's line: "Label · Polo shirt M"
    private val onAdd: suspend (ItemEntity, ItemVariantEntity?) -> Boolean,
) {
    val cats: StateFlow<List<CategoryEntity>>; val cat: MutableStateFlow<String?>; val query: MutableStateFlow<String>
    val products: StateFlow<List<ItemEntity>>; val left: StateFlow<Map<String, ItemLeft>>; val variantCounts: StateFlow<Map<String, Int>>
    val scanMode: StateFlow<Boolean>; val picking: MutableStateFlow<Picked?>
    class Picked(val item: ItemEntity, val variants: List<ItemVariantEntity>)
    fun setScanMode(on: Boolean); fun pickCat(id: String?); fun tap(item: ItemEntity); fun closePicker()
    fun pick(item: ItemEntity, chosen: List<ItemVariantEntity>); fun scanned(code: String); fun enter()
}
@Composable fun ProductPane(p: ProductPick, modifier: Modifier, empty: String)
@Composable fun WhichSheet(p: ProductPick, hint: String, all: String, some: (Int) -> String)
```

- The bodies are the ones in `Labels.kt` today (`Products`, `WhichSheet`, and in the view model `cats`
  to `scanMode`, `tap`, `pick`, `scanned`, `enter`), moved, with whatever private pieces they draw
  with. `LabelsViewModel` keeps one `ProductPick` and `LabelsScreen` draws it with the words it has now.
- [ ] All unit tests pass. On a hidden emulator of my own (a new AVD: 5586 and 5590 are the owner's;
  look at `adb devices` first) with the made-up shop: Print labels behaves as before for a tap, a
  search, a scan (`DEMO_SCAN`), a product with variants. Commit.

### Task 7: what a supplier's form holds (`core/data/SupplierForm.kt`, `core/data/StockPayloads.kt`; tests first)

```kotlin
object SupplierForm {
    data class Supplier(val name: String, val contact: String = "", val phone: String = "", val email: String = "", val address: String = "", val note: String = "")
    fun clean(s: Supplier): Supplier        // trimmed, cut to 120, 120, 40, 120, 200, 200
    fun problem(s: Supplier): String?       // "A supplier needs a name."
    fun refused(code: String?): String      // name-taken, name-required, forbidden, conflict, unknown-op, null, else
}
object StockPayloads {
    fun supplierSave(id: String, s: SupplierForm.Supplier, approvedBy: String?): JsonObject
    fun supplierRemove(id: String, approvedBy: String?): JsonObject
}
```

- [ ] `SupplierFormTest`: `clean`, `problem`, each refusal's sentence, and
  `StockPayloads.supplierSave("supplier-1", ...)` equal to the payload in
  `../../db/tests/fixtures/till-stock/supplier-save.json` (read from the test's working folder,
  `android/app`), the same for `supplier-remove.json`; with an approver the payload carries
  `approved_by` and nothing else changes. Fail, write, pass. Commit.

### Task 8: the saves (`core/data/Service.kt`, `core/data/StockRepository.kt` new)

- `ServiceRepository.ask` becomes `internal`: it stays the one place a waited change leaves the tablet.
- `StockRepository` (`@Singleton`, injected with `TillDatabase`, `SessionStore`, `StaffSession`,
  `ServiceRepository`):

```kotlin
suspend fun saveSupplier(id: String, s: SupplierForm.Supplier, approver: StaffMember? = null): Result<Unit>   // staff.allow("suppliers.edit", "change suppliers", approver)
suspend fun removeSupplier(id: String, approver: StaffMember? = null): Result<Unit>
```

- [ ] Compiles; all unit tests pass. Commit with Task 9.

### Task 9: the Stock screen, Suppliers, History (`feature/stock/` new, `feature/main/MainShell.kt`, `core/data/StockHistory.kt`, `feature/settings/SettingsScreen.kt`)

- `Screen.Stock` in the enum, in `SHOP_ONLY`, in `SHOP_BACK` after Print labels as "Stock", in the
  scanner's list (`Scanner.taking`), and routed to `StockScreen`.
- `feature/stock/StockScreen.kt`: the head and five tabs (Deliveries, Orders, Counts, History,
  Suppliers); `StockViewModel` holds the tab and, per tab, whether the person may
  (`stock.receive`, `stock.receive`, `stock.count`, `stock.view`, open) and `unlock(tab)` through
  `Approvals`, as `TodayViewModel.unlock` does. A tab the person may not use shows what it is for and a
  key to ask a manager. It also holds `costs`: whether rupees of cost are shown, true for someone with
  `costs.view` or `stock.receive`, and for a manager who unlocked Deliveries or Orders; every tab of
  the three plans asks it before showing a cost or a value. Deliveries, Orders and Counts say "Coming with the next build" until plans 2
  and 3; this text is removed by them.
- `feature/stock/Suppliers.kt`: the list (name, contact, phone, how many products name it); a sheet to
  add or change, its ids made when the sheet opens; Remove behind a confirmation. Changing asks for
  `suppliers.edit`. A refusal's sentence stays on the sheet; with no connection the sheet keeps what
  was typed.
- `core/data/StockHistory.kt`, test first:

```kotlin
object StockHistory {
    enum class Kind { Sale, Delivery, Count, Correction }
    fun kind(reason: String): Kind                       // sale, refund: Sale; receive: Delivery; count: Count; the rest: Correction
    fun says(reason: String): String                     // "Sold", "Refunded", "Delivery", "Count", "Damaged", "Expired", "Lost", "Used in the shop", "Returned to supplier", "Found", "Opening stock", "Correction"
    fun shown(qty: Int): String                          // +3, -1.5: thousandths as units, up to three decimals, always signed
}
```

- `feature/stock/History.kt`: newest first, 200 at a time with "Show more"; each row the time, the
  product and variant, `shown(qty)` green or red, `says(reason)`, the document's number (a delivery's or
  a count's by `ref_id`, a receipt's by `receipt_id` when the tablet holds it), who. A search box that
  takes a scan, and four filter keys from `Kind`.
- `SHOP_HELP`: "The Stock screen", "Suppliers", "The stock history".
- [ ] `StockHistoryTest`: every reason the server allows has words; `shown` for 3000, -1500, 350, 0.
- [ ] On my emulator with the made-up shop: Stock in the side menu; each tab; a cashier's PIN is asked
  for a manager; the supplier sheet with no connection says so and keeps the form; History lists the
  three movements, the filters and a scan narrow it; the same on a lower screen
  (`adb shell wm size 1280x720` is the layout's own; try `1024x600` as the label work did).
- [ ] The database's step from 13 to 14 on that emulator with the made-up shop already on it from a
  build before this plan: it opens, the products are there.
- [ ] Commit. Append to this file a record: what was seen, what was not (a save going through from a
  signed-in till is the owner's to try), and anything decided along the way.
