# Retail till (piece 4): Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; this repo's owner is cost-sensitive, no subagent fan-out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop sells on the till: scan or tap, pick a variant, weigh, discount or re-price one line, park a sale, take payment, take a return, look a product up, with stock on every tile.

**Architecture:** The sale stays what it is today: a ticket of kind `counter`, its lines, one receipt, the payment screen that exists. A line learns three things (its variant, the price it was listed at, why it is charged something else), and one new operation edits a line that nothing has been done with yet. The till mirrors two more tables (variants, stock levels) and shows a shop its own screens when the settings it already pulls say the business is a shop. A restaurant's till and a restaurant's receipts do not change.

**Tech Stack:** Postgres on Neon (plpgsql), Node suites in `db/tests`, the till API (`hello.ts`), Android (Kotlin, Compose, Room, Hilt) in `android/`.

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, sections 6, 7, 8 and 9 (piece 4). **Approved screen:** artboard `Sell` of https://claude.ai/artifact/GfTY9m9TFyXfNt5inwRh14 (the user: "Yes thats very good my friend"). It draws the sell screen, the open line with its chips, and the variant picker. Not drawn there, and built in the till's own language (`core/ui/V2.kt`): the weight sheet, the price sheet, the parked list, Products & stock, the return's switch.

---

## Facts checked before planning (2026-10-08)

- `push_ticket_add_line` has taken `variant_id` since migration 0055. `item_variants` is already in the pull; the till has been discarding it. `stock_levels` is not in the pull; it has the trigger that moves `server_seq`, so a level that changes reaches a till.
- The till's `applyPage` reads only the tables it names, so a table added to the pull is ignored by a build that does not know it (spec 12.1).
- The mode reaches a till as `businessType` in `pos_settings.data` (0066); absent means restaurant.
- `stock_move` refuses a second movement for the same document, product and shop (`uq_stock_movements_ref` is on `ref_type, ref_id, store, item, variant`). A return that is not put back on the shelf needs its second movement under another `ref_type`.
- The receipt and refund functions, the till's `Calc` and `RefundCalc`, the Tax report and Item sales all spread a bill's discount over its lines in proportion to each line's amount. None of them knows a discount that belongs to one line.
- The till says its build in `X-Till-Version` (today 2). `MIN_TILL_VERSION` in the API is one number for every client.
- Every pushed operation is the tablet's record of something that already happened: the server stores a sale that drifted and flags it for review, and refuses only what cannot be stored.

## Decisions made while planning (tell the user)

- **A discount on one line, and a price changed on one line, are kept on the line itself**: the price charged (`unit_price`), the price it was listed at (`list_price`), which of the two it is, and who allowed it. The receipt's subtotal is then already after them, and every sum that exists (receipt, refund to the cent, tax, profit) is unchanged. The other way, a discount row per line inside the bill's discount total, would have changed six places that must agree to the cent.
- **A discount on a line in rupees is per unit** ("Rs 100 off each"), so a line of three is three times a whole number of cents.
- **A line whose price was changed by someone not allowed to is stored and flagged for review, not refused.** The sale happened; refusing its receipt would lose a payment.
- **The retail screen changes a line in place** (quantity, note, price) with one new operation, `ticket.edit_line`, for a line nothing has been done with (not paid, not voided, not sent to a kitchen). The restaurant's way (void and add again) stays for restaurants: there a kitchen may hold the line.
- **Stock on a tile is the server's figure, less what this till sold since.** The till takes what it sells off its own copy at once; every sync brings the server's figure back. Two tills offline can both show the last one, and both can sell it: that is the design's rule.
- **A return not put back on the shelf** comes back at the cost it left at and leaves again as damaged, so the Losses report holds it.
- **A shop's till is too old below build 3**: the API answers "must be updated" to an older build of a shop, and to one that does not say its build. A restaurant's till is asked nothing new.

## Step 4a: the server (migration 0077)

| Check | Rule (each one in `db/tests/retail-till.test.cjs`, pushed as the till pushes it) |
|---|---|
| A1 | A line added with a variant keeps it; its receipt moves that variant's stock, not the product's other variants. |
| A2 | A line added with `list_price`, `price_kind` and `price_label` keeps them, and who allowed it. `unit_price` above `list_price` is refused for a discount (`bad-payload`), allowed for a price change. |
| A3 | `ticket.edit_line` changes quantity, note and price of a line in place. It is refused on a line that is paid, voided or sent to a kitchen (`paid-line`, `bad-line`), and on a closed ticket (`ticket-closed`). Sent twice it applies once. |
| A4 | A receipt copies each line's listed price, kind and label to its own lines; so does a refund of it. |
| A5 | A line discounted or re-priced by someone allowed (their own right, or `approved_by`) is not flagged as price drift. The listed price is what is compared with the catalog: a listed price that drifted is still flagged. |
| A6 | A line discounted by someone without `sale.apply_discount`, or re-priced without `sale.change_price`, is stored and flagged `price-unapproved`. |
| A7 | The totals of a receipt with a discounted line are the sums of today, over the price charged: the bill's discount, VAT and rounding spread as before. A part refund of it is exact to the cent. |
| A8 | A refund with `restock: false` puts the goods back at the cost they left at and takes them out again as damaged: the level is unchanged, and Losses holds it. With `restock` absent or true it is as today. Sent twice, it moves stock once. |
| A9 | A weighed line (quantity in thousandths) is charged and leaves stock by its weight. |
| A10 | The pull carries the shop's own `stock_levels`, not another shop's; a level that changes arrives again. |
| A11 | `item.set_price` with a `variant_id` changes that variant's price and nothing else. |
| A12 | `sale.change_price` is held by every role that held `sale.apply_restricted_discount`, and by a new tenant's Manager. |
| T1 | The tenant role can do all of it; another tenant sees none of it. |

Files: `db/migrations/0077_retail_till.sql`, `db/tests/retail-till.test.cjs`, `web/lib/perms.ts` (+ test).

## Step 4b: the till's data

Room 8 to 9 (the cursor back to 0: variants were sent and discarded): `item_variants`, `stock_levels`; on `items` `sku`, `sold_by`, `track_stock`, `option_names`; on `ticket_lines` and `receipt_lines` `list_price`, `price_kind`, `price_label` (and `price_by` on the first). `PosSettings.retail`. `LinePrice` (pure: a percent or rupees off a listed price, a price change, what the line says). `TicketRepository`: a line with a variant, a weight, a price; lines merge only when product, variant, price and note agree; `editLine`; the stock copy moves with a sale and a return; `findCode` (barcode or SKU, product or variant). Unit tests for `LinePrice` and for which lines merge.

## Step 4c: the screens

The shell shows a shop: Sell, Receipts, Customers, Products & stock, Today, More. Sell is the approved artboard. The line sheet (quantity, discount chips, Change price, note, Remove), the variant picker with stock left for each, the weight sheet, Park and the parked list, Add customer, Discount on sale, Pay (the payment screen that exists). Receipts: a return's "Put back into stock" switch. Products & stock: find a product, what is left of each variant, change a price. The receipt prints a discounted line with what it was.

## Step 4d: the gate, and seeing it

`hello.ts`: a shop's till below build 3 is answered 426. `versionCode` 3. Type-check, unit tests, `assembleDebug`. Every database suite. What was run on a device and what was not, in the record at the end of this file.

## Not tonight, and why

Installing on the user's emulator (it signs them out and migrates their till's data with nobody watching), and a run signed in to a shop (a sign-in is the user's). The record ends with the exact click-through for them.
