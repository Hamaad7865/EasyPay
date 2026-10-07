# Retail Stock module, step 3b: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; this repo's owner is cost-sensitive, no subagent fan-out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop orders from a supplier, receives what arrives (in one delivery or several, with or without an order), and its stock and average cost follow.

**Architecture:** One migration adds purchase orders, deliveries and their numbering, and the functions that are the only way to write them. A delivery is written once and never changed: its tables are insert-only, like receipts. Each delivery line goes through the stock engine with the delivery as its document, so a delivery counts once. The back office gains a Purchase orders page, an order's page (draft, sent, receiving) and receiving without an order.

**Tech Stack:** Postgres on Neon (plpgsql, RLS), Node suites in `db/tests`, Next.js 16 back office in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, sections 4 (Cost), 5 (Purchase orders), 7 and 11, piece 3. Approved board: `Receive` at https://claude.ai/artifact/GfTY9m9TFyXfNt5inwRh14. Read `2026-10-08-retail-stock-3a.md` first: "Before starting" there applies here unchanged (migration number, `nav.ts`, suites one at a time, how a page is checked without a login).

---

## What the till does with this

Nothing. None of the new tables is in the pull. A delivery reaches a till only as the item's total (`items.stock_qty`), as before.

## Decisions made while planning (tell the user)

- **An order is sent before it is received.** Draft, Sent, Part received, Received; or Closed (the rest will not come), or Cancelled (before anything arrived). A delivery nobody ordered is entered with "Receive without an order".
- **A delivery cannot be changed or undone**, by the page or by any statement: the database refuses it (Kids Corner's migration 030). Goods sent back leave as Returned to supplier.
- **The cost typed on a delivery becomes the product's cost** (the variant's, for a variant), as Kids Corner does: the next order starts from what was last paid, and the margin on the products list follows. The average cost of what is on the shelf is the engine's, as before.
- **Two lines for one product are added together**, on an order and on a delivery: the engine moves a product once per document, so a second line would otherwise be lost.
- **A product that was not on the order is accepted on its delivery** as an extra line. More than was ordered is accepted too.
- **"Delete all transactions" also removes orders and deliveries**, and their numbers start again. Stock levels stay, as they do today.

## Rules, each one a check in `db/tests/purchase-orders.test.cjs`

| Check | Rule |
|---|---|
| O1 | A new order takes the tenant's next number (`PO-0001`, `PO-0002`), is a draft at its shop, with its supplier, expected day and note. Another tenant numbers on its own. A supplier that is not the tenant's is refused (`unknown-supplier`). |
| O2 | A line is a counted product, or a variant of one (`pick-variant`, `unknown-line`, `not-counted`, as for an adjustment), with a quantity above zero and a cost of zero or more (`bad-line`). Two lines for one product become one: quantities added, cost averaged by quantity. |
| O3 | Saving a draft again replaces its header and lines. An order that is no longer a draft refuses (`not-draft`), and no statement can add, change or remove its lines. |
| O4 | Sending needs at least one line (`no-lines`) and happens once (`not-draft` after). |
| O5 | "Add what is low" puts on a draft the supplier's lines at or below their reorder level, each with its order quantity (or what brings it back to its level when none is set), at its cost; lines already on the order and other suppliers' products are left out. It returns how many it added. |
| D1 | Receiving a sent order writes a delivery with the tenant's next number (`D-0001`), its day, invoice number, note and lines; each line raises its stock through the engine (reason `receive`, the delivery as its document) and moves the average cost. Something still to come: the order is Part received. |
| D2 | A second delivery adds to the first; when every line has arrived in full the order is Received. |
| D3 | More than was ordered is accepted, and the order is Received. |
| D4 | A cost corrected on the delivery is the cost the stock comes in at, and becomes the product's cost (the variant's, for a variant). |
| D5 | The same delivery sent twice (the same id: a double click) is written once. |
| D6 | A delivery with nothing in it is refused (`nothing-received`). A draft, a received, a closed or a cancelled order cannot be received (`not-open`). |
| D7 | Two lines for one product in one delivery are added together, not lost. |
| D8 | A delivery and its lines cannot be updated or deleted, and the tenant role has no right to. |
| D9 | A delivery without an order: the same stock, no order, the supplier optional. |
| D10 | A product that was not on the order is received as an extra line; it does not make the order Received by itself. |
| C1 | An order is cancelled while nothing has arrived (draft or sent); after a delivery it is refused (`already-received`). |
| C2 | A part-received order is closed: the rest is no longer expected. Any other order refuses (`not-part`). |
| X1 | "Delete all transactions" removes the tenant's orders and deliveries, and the numbers start again at 1. |
| T1 | The tenant role can do all of it inside its own tenant, and sees no order or delivery of another. |

`stock-adjust.test.cjs` passes unchanged (its line checks move into a shared function), and `pos-operations` T11 now holds the two delivery tables to the same rule as receipts.

## File map

| File | Created or changed | What it holds |
|---|---|---|
| `db/migrations/00NN_purchase_orders.sql` | create | the tables, `next_doc_number`, `stock_line_ok`, `po_save`, `po_send`, `po_cancel`, `po_close`, `po_fill_low`, `delivery_receive`, `purge_transactions` |
| `db/tests/purchase-orders.test.cjs` | create | the checks above |
| `db/tests/require-dev.cjs` | change | the new tables in the cleanup list; the two delivery tables among the insert-only ones |
| `web/app/backoffice/data/export/route.ts` | change | the new tables in the backup |
| `web/lib/orders.ts`, `orders.test.mjs` | create | an order's status in words, what is still to come, the totals of a delivery being typed (pure) |
| `web/app/backoffice/purchase-orders/page.tsx` | create | the orders, New order, Receive without an order |
| `web/app/backoffice/purchase-orders/[id]/page.tsx`, `lines-editor.tsx`, `receive-form.tsx` | create | an order: its lines while a draft, receiving once sent (the `Receive` board), its deliveries |
| `web/app/backoffice/purchase-orders/receive/page.tsx` | create | a delivery without an order |
| `web/app/backoffice/nav.ts`, `counts/route.ts` | change | the Purchase orders link and how many are open |
| `web/app/backoffice/stock/on-hand.tsx` | change | "Receive a delivery" |

## The migration

One file. In this order:

1. **`doc_counters`** (`tenant_id`, `kind` in `po`, `delivery`, `count`, `next`; unique per tenant and kind; the standard columns, RLS, `trg_touch`) and **`next_doc_number(p_tenant, p_kind) returns text`**: one statement that takes the next number and moves the counter, so two people are never handed the same one. `PO-0001`, `D-0001`.
2. **`purchase_orders`** (`store_id`, `number`, `supplier_id`, `status`, `expected_on`, `note`, `created_by`, `sent_at`) and **`purchase_order_lines`** (`order_id`, `item_id`, `variant_id`, `qty`, `unit_cost`; one line per product of an order). A trigger on the lines, `po_lines_draft_only`, refuses an insert, update or delete unless the order is a draft (the purge's way out as in `block_update`).
3. **`deliveries`** (`store_id`, `number`, `order_id`, `supplier_id`, `arrived_on`, `invoice_no`, `note`, `received_by`) and **`delivery_lines`** (`delivery_id`, `order_line_id`, `item_id`, `variant_id`, `qty`, `unit_cost`). Both insert-only: `trg_no_update` with `block_update`, and `revoke update, delete … from app_user` (0065's note).
4. **`stock_line_ok(p_tenant, p_item, p_variant)`**: the checks `stock_adjust` makes of a line (`unknown-item`, `not-counted`, `pick-variant`, `unknown-line`), as one function; `stock_adjust` redefined from 0073 to call it.
5. **`po_save`**, **`po_send`**, **`po_cancel`**, **`po_close`**, **`po_fill_low`**, **`delivery_receive`**: as the rules say. `delivery_receive` locks the order's row first, then moves each line through `stock_move` in a fixed order (by product), then writes the order's status.
6. **`purge_transactions`** redefined from its live definition with the four tables and the counters.

## Tasks

### Task 1: the suite, failing

- [ ] Write `db/tests/purchase-orders.test.cjs` (one rolled-back transaction, as `stock-adjust.test.cjs`). Run it. Expected: `TEST_FAILED` on `function po_save(...) does not exist`.

### Task 2: the migration

- [ ] First free number; write it; `node db/migrate.cjs`; the suite passes.
- [ ] `require-dev.cjs`: `'delivery_lines','deliveries','purchase_order_lines','purchase_orders','doc_counters'` at the head of `CHILD_FIRST`; `'delivery_lines','deliveries'` in `GUARDS`. The backup's `TABLES` gains the four document tables.
- [ ] One at a time: `stock-adjust`, `stock-engine`, `stock-sales`, `stock-locks`, `catalog`, `catalog-import`, `pos-operations`, `backoffice-saves`, `isolation`. All pass.
- [ ] Commit.

### Task 3: an order in words

- [ ] `web/lib/orders.test.mjs` first, then `web/lib/orders.ts`: the status words (Draft, Sent, Part received, Received, Closed, Cancelled); what is still to come on a line (never below zero) and "over-received"; the units and the total of a delivery being typed. Commit.

### Task 4: the orders

- [ ] `purchase-orders/page.tsx` (`onlyFor("retail")`, `stock.view` to see, `stock.receive` to act): New order (supplier, expected day, note) makes a draft and opens it; the list by number, supplier, status, expected day, units ordered and received, total; a filter by status. `nav.ts` and `counts/route.ts`: the link in the Stock group, with how many are sent or part received.
- [ ] Type-check, `prepare-web-sql.cjs`, render. Commit.

### Task 5: an order's page

- [ ] `[id]/page.tsx`: a draft is edited (`lines-editor.tsx`: find a product by name, SKU or scanned barcode, quantity and cost per line; "Add what is low"; Save; Send; Cancel); a sent or part-received order is received (`receive-form.tsx`, the `Receive` board: arrived on, invoice number, note, per line ordered, received before, arriving now and unit cost, "Receive all that was ordered", the units and total as typed, the three notes under it); every order shows its deliveries; Print uses the page's own print styles; Close the rest; Cancel.
- [ ] Type-check, `prepare-web-sql.cjs`, render a draft, a sent and a part-received order. Commit.

### Task 6: a delivery without an order

- [ ] `receive/page.tsx`: supplier (optional), arrived on, invoice number, note, and lines chosen as on a draft. "Receive a delivery" on Stock on hand leads to Purchase orders.
- [ ] Type-check, `prepare-web-sql.cjs`, render. Commit.

### Task 7: see it

- [ ] Every suite, one at a time; build; the record at the end of this file; tell the user what is theirs to open signed in.
