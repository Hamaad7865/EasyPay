# The shop's stock tools on the tablet, plan 2 of 3: orders and deliveries

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking. One session, no subagent a task.

**Goal:** on the Stock screen a shop writes an order to a supplier, sends it, and receives a delivery,
with or without an order; the delivery's lines go on to Print labels.

**Architecture:** tablet only. Plan 1 left the server answering `po.save`, `po.send`, `po.cancel`,
`po.close` and `delivery.receive`, the tablet holding orders, deliveries and their lines, and the shared
product pane. This plan adds the rules as plain Kotlin (lines, an order, a delivery, "Add what is low"),
a draft kept on the tablet, five saves, and four screens.

**Tech stack:** Kotlin, Room, Jetpack Compose, Hilt, kotlinx.serialization, JUnit 4.

**Spec:** `docs/superpowers/specs/2026-10-10-till-stock-tools-design.md`, sections 3 and 4.

**Before starting:** plan 1 is committed and its record written; its suite passes on dev
(`node db/tests/till-stock.test.cjs`). The rules of plan 1's "Rules of this folder" hold here.

---

### Task 1: the lines of an order or a delivery (`core/data/DocLines.kt`; test first)

```kotlin
// Quantities in thousandths, costs in cents, "no variant" as "".
object DocLines {
    data class Line(val item: String, val variant: String = "", val qty: Int, val cost: Long)
    fun merged(lines: List<Line>): List<Line>       // one line a product: quantities added, cost averaged by quantity and rounded (the server's doc_lines), in the order first met
    fun add(lines: List<Line>, item: String, variant: String, by: Int, cost: Long): List<Line>   // a tap or a scan: `by` more; a new line starts at `cost` and goes last
    fun setQty(lines: List<Line>, item: String, variant: String, qty: Int): List<Line>           // nothing or less takes the line away
    fun setCost(lines: List<Line>, item: String, variant: String, cost: Long): List<Line>        // never below nothing
    fun units(lines: List<Line>): Int
    fun value(lines: List<Line>): Long              // each line Math.round(qty * cost / 1000.0), added (web/lib/stock.ts lineValue)
    // The lines the server would refuse, so that the screen can name them: the product is gone, its
    // stock is not counted, it has variants and the line names none, or names one that is gone.
    fun gone(lines: List<Line>, items: Map<String, ItemEntity>, counted: (ItemEntity) -> Boolean, variantsOf: (String) -> List<ItemVariantEntity>): List<Line>
    fun shown(qty: Int): String                     // 3, 1.5, 0.35: thousandths as units, up to three decimals
}
```

- [ ] `DocLinesTest`: `merged` of 3000 at 4500 and 1000 at 4900 is 4000 at 4600; `add` to a line there
  and to none; `setQty` 0 removes; `value` of 1500 at 333 is 500 (rounded half up as JavaScript's
  `Math.round` does); `gone` for each of its four reasons and for a sound line; `shown`. Fail, write,
  pass. Commit.

### Task 2: an order, "Add what is low", a delivery (`core/data/OrderForm.kt`, `PoFill.kt`, `DeliveryForm.kt`, `StockPayloads.kt`; tests first)

```kotlin
object OrderForm {
    data class Order(val id: String, val supplier: String? = null, val expectedOn: String = "", val note: String = "", val lines: List<DocLines.Line> = emptyList())
    fun startCost(item: ItemEntity, variant: ItemVariantEntity?, level: StockLevelEntity?): Long   // what it last cost: the variant's cost, else the product's, else the level's average rounded, else 0
    fun problem(o: Order, toSend: Boolean): String?   // "Pick the supplier."; to send: "Add at least one product."
    fun refused(code: String?): String                // unknown-supplier, unknown-store, unknown-order, not-draft, no-lines, already-received, not-open, not-part,
                                                      // unknown-item, not-counted, pick-variant, unknown-line, bad-line, forbidden, conflict, unknown-op, null, else
}
object PoFill {
    // The supplier's lines of stock at or below their reorder point that are not on the draft, as po_fill_low:
    // quantity = reorder_qty when it is set and not 0, else max(reorder_point - qty, 1000); cost = max(round(avg_cost), 0).
    // A product's supplier is items.supplier_id; a line of stock is a product without variants, or one variant; one with no level or no reorder point is skipped.
    fun low(supplier: String, on: List<DocLines.Line>, items: List<ItemEntity>, variants: List<ItemVariantEntity>, levels: List<StockLevelEntity>, counted: (ItemEntity) -> Boolean): List<DocLines.Line>
}
object DeliveryForm {
    data class Delivery(val id: String, val order: String? = null, val supplier: String? = null, val arrivedOn: String, val invoice: String = "", val note: String = "", val lines: List<DocLines.Line> = emptyList())
    fun fromOrder(id: String, order: PurchaseOrderEntity, lines: List<PurchaseOrderLineEntity>, today: String): Delivery   // each line what is still due (qty - received) at the order's cost; nothing due, no line
    fun problem(d: Delivery): String?                 // "Nothing has been received yet."
    fun refused(code: String?): String                // nothing-received, not-open, unknown-order, unknown-supplier, unknown-store, bad-delivery, the four of a line, forbidden, conflict, unknown-op, null, else
    fun labels(lines: List<DocLines.Line>, soldBy: (String) -> String): List<Pair<DocLines.Line, Int>>   // labels a line: whole units (at least 1), 1 for a product sold by weight, never over LabelList.MOST_EACH
}
// added to StockPayloads
fun poSave(o: OrderForm.Order, store: String, approvedBy: String?): JsonObject
fun poState(id: String, approvedBy: String?): JsonObject                 // po.send, po.cancel, po.close carry the same
fun deliveryReceive(d: DeliveryForm.Delivery, store: String, approvedBy: String?): JsonObject   // no order and no supplier as ""
```

- [ ] `OrderFormTest`, `PoFillTest`, `DeliveryFormTest`:
  - `poSave` for the fixture's order equals `po-save.json`; `poState("order-1", null)` equals
    `po-send.json`; `deliveryReceive` equals `delivery-receive.json` (paths as in plan 1, Task 7).
  - `PoFill.low` with these cases, and any that `db/tests/purchase-orders.test.cjs` has for
    `po_fill_low` and these lack: at the point, below it, above it
    (not added), already on the draft (not added), another supplier's (not added), a reorder quantity
    set, none set and 400 short (1000), none set and 2500 short (2500), an average cost of 4533.6
    (4534).
  - `fromOrder`: 12000 ordered and 10000 received leaves 2000; a line fully received is not there.
  - `labels`: 3000 gives 3; 2500 gives 2; 400 gives 1; a product sold by weight gives 1; 500000 gives
    `LabelList.MOST_EACH`.
  - every refusal code has its own sentence; `problem` in each case.
- [ ] Fail, write, pass. Commit.

### Task 3: a draft is not lost (`core/data/StockDrafts.kt`, `core/data/StockRepository.kt`; test first)

```kotlin
object StockDrafts {
    fun write(o: OrderForm.Order): String; fun order(text: String?): OrderForm.Order?            // unreadable is none
    fun write(d: DeliveryForm.Delivery): String; fun delivery(text: String?): DeliveryForm.Delivery?
}
// added to StockRepository
suspend fun orderDraft(): OrderForm.Order?; suspend fun keepOrderDraft(o: OrderForm.Order); suspend fun dropOrderDraft()
suspend fun deliveryDraft(): DeliveryForm.Delivery?; suspend fun keepDeliveryDraft(d: DeliveryForm.Delivery); suspend fun dropDeliveryDraft()
suspend fun saveOrder(o: OrderForm.Order, approver: StaffMember? = null): Result<Unit>     // po.save; staff.allow("stock.receive", "order from suppliers", approver)
suspend fun sendOrder(id: String, approver: StaffMember? = null): Result<Unit>             // po.send
suspend fun cancelOrder(id: String, approver: StaffMember? = null): Result<Unit>           // po.cancel
suspend fun closeOrder(id: String, approver: StaffMember? = null): Result<Unit>            // po.close
suspend fun receive(d: DeliveryForm.Delivery, approver: StaffMember? = null): Result<Unit> // delivery.receive; "receive a delivery"
```

- A draft is written to `stock_drafts` on every change of it and dropped when its save is answered
  done. The ids in it were made when it was begun, so a second try sends the same ones.
- Signing the tablet out empties its database (`MainActivity.kt`, `session.clear()` then
  `db.clearAllTables()`), drafts included. Where Settings says what signing out does
  (`feature/settings/SettingsScreen.kt`, beside the outbox's `pending`), a kept draft is named: "An
  order you were writing will be lost." It does not hold the sign-out back; plan 3 holds it back for
  an open count.
- [ ] `StockDraftsTest`: both round trips with a variant, no variant, a note with a quote and a line
  break; garbage reads as none. Fail, write, pass. All unit tests pass. Commit.

### Task 4: Orders (`feature/stock/Orders.kt`, `feature/stock/OrderEdit.kt`, `feature/stock/StockScreen.kt`)

- `OrdersViewModel`: the shop's orders in three groups (drafts; waiting: `sent`, `part`; finished);
  suppliers' names; the order open as a record; the draft being written
  (`MutableStateFlow<OrderForm.Order?>`, kept through `keepOrderDraft` on each change); one
  `ProductPick` whose `onAdd` adds a unit at `OrderForm.startCost`; `NumAsk` for a quantity (three
  decimals for a product sold by weight, none otherwise) and for a cost (two); `gone` for the lines the
  screen marks.
- The list: a row an order (number, supplier, state, expected date, units, and the value for someone who
  may see costs). **New order**: when a draft is already kept, a sheet asks to carry on with it or
  throw it away.
- `OrderEdit`: on the left the supplier (a sheet of the suppliers), the expected date, a note, the lines
  (name and variant, quantity, cost, line value, Remove), the totals, and the keys **Add what is low**
  (`PoFill.low`; a toast says how many were added, or that nothing is low), **Save as a draft**,
  **Send**; on the right `ProductPane`. Send saves, then sends: if the second step fails the order is a
  draft on the server and the screen says so. A second tap of Send after its answer was lost finds the
  order sent already, and the save step is refused `not-draft`: within Send that refusal means "it is
  no longer a draft", so the till goes on to `po.send`, which answers done. Only Save as a draft shows
  `not-draft` to the person.
- A draft of the server's opened here becomes the tablet's draft with the same id.
- An order's record: the lines with ordered, received and still due; **Receive** for a waiting one
  (hands `DeliveryForm.fromOrder` to Task 5's screen); **Cancel order** behind a confirmation while
  nothing has arrived; **Close order** for a part-received one, saying the rest will not come.
- After a refusal of `unknown-item`, `not-counted`, `pick-variant` or `unknown-line`: the tablet syncs
  (`SyncScheduler.pullNow`), and the lines `DocLines.gone` finds are marked and named in the message.
- The tab's "Coming with the next build" text is removed for Orders.
- [ ] Compiles; all unit tests pass. Commit with Task 5.

### Task 5: Deliveries (`feature/stock/Deliveries.kt`, `feature/stock/Receive.kt`, `feature/retail/Labels.kt`, `feature/main/MainShell.kt`)

- `ReceiveViewModel`: the shop's deliveries; one open as a record; the draft being typed (kept through
  `keepDeliveryDraft`); a `ProductPick` whose `onAdd` adds a unit at `OrderForm.startCost`.
- The list: number, the day it arrived, supplier, the order's number when it has one, units, value.
  **Receive stock** opens a sheet: the waiting orders, and "No order". A kept draft is offered first.
- `Receive`: on the left the order's number or "No order", the supplier (fixed with an order; a sheet
  or none without), the invoice number, the day (today, changed from a date sheet), a note, the lines
  (with an order: ordered and still due beside the quantity received), totals; on the right
  `ProductPane`, so a product that was not ordered can be added. **Receive** opens the last sheet: how
  many lines, units and rupees, "A delivery cannot be changed once it is received." and Receive.
- Done: the draft is dropped, a sheet says the stock is in and offers **Print labels for this
  delivery** and Done. With no connection: the till's own sentence, and the draft stays. A refusal
  about a line is handled as Task 4 handles it: a sync, then the lines `DocLines.gone` finds are marked
  and named.
- `LabelsViewModel.fill(rows: List<Triple<ItemEntity, ItemVariantEntity?, Int>>)`: the run becomes
  these rows, each with its copies, within `LabelList`'s limits (what does not fit is said, as
  `add` says it today). `MainShell` hands `DeliveryForm.labels` to it and goes to Print labels, the way
  Products hands one product (`labels.tap(item); shell.go(Screen.Labels)`).
- A delivery's record: its lines, and who received it.
- The tab's "Coming with the next build" text is removed for Deliveries.
- `SHOP_HELP` (`feature/settings/SettingsScreen.kt`): "Ordering from a supplier", "Receiving a
  delivery", "Labels for what arrived".
- [ ] On my emulator with the made-up shop: an order written from nothing with a tap, a search, a scan
  and a product with variants; a quantity and a cost typed; Add what is low adds the product whose
  reorder point the made-up shop put above its stock, and not the other; the app closed and opened
  again in the middle: the draft is there; Send with no connection says so and keeps it; the sent
  order of the made-up shop opens, Receive starts with what is due; a product not on it is added; the
  last sheet's figures; the delivery of the made-up shop as a record; every screen at `1024x600` too.
- [ ] Commit. Append the record: seen, not seen (every save reaching a server: the owner's, signed in
  on a dev shop), decided along the way.
