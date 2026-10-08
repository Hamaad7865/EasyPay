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
- **Stock on a tile is the server's figure as of the last sync, moved by what this till has done since.** The till takes what it sells off its own copy at once and puts back what it takes back onto the shelf; every sync replaces the copy with the server's figure. (A refund of a receipt another till made does not move this till's copy: the server's figure arrives with the next sync.) Two tills offline can both show the last one, and both can sell it: that is the design's rule.
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

---

## What happened when this plan was run (2026-10-08, night)

Built as written, with the differences below. Commits `9e2a859` to `09db609` on `restopos`. Migration 0077 is on dev; the till API with the shop gate is deployed to the dev branch; nothing is on production and nothing is pushed.

**As built:**

- **Server (4a).** Migration `0077_retail_till.sql`, made by `gen` from the live definitions with each change an exact replacement (a function that had moved on would have stopped it). `db/tests/retail-till.test.cjs`, 31 checks, pushes what the till pushes.
- **The till's data (4b).** Room 8 to 9; `LinePrice` (pure) with 10 unit tests; `RetailSales`; the receipt and the refund carry the listed price; the stock copy moves with sales and returns.
- **The screens (4c).** `feature/retail`: Sell (the approved board), the variant picker, the number sheet (weight, quantity, price, percent, rupees), the note sheet, the parked list, the discount on a sale, Products & stock. A shop's keys in the shell. The return's stock switch on Receipts.
- **The gate (4d).** `hello.ts` answers 426 to a shop's till below build 3; the till is build 3 (0.3.0). `db/tests/api-shop-gate.test.cjs`, 10 checks against the deployed dev API.

**Different from the plan, or added to it:**

- **A debug-only made-up business** (`android/app/src/debug`): `DemoReceiver` fills a tablet that was never set up from `assets/demo-shop.json`, as a shop or (`--es type restaurant`) as a restaurant, and refuses one that is set up. It is not in the release build. It exists so the screens can be run with no login.
- **`db/scripts/replay-demo-outbox.cjs`** makes the same business on dev in a rolled-back transaction and sends it a till's own outbox. `db/tests/retail-till-replay.test.cjs` does that with two recorded outboxes of build 3 (a shop's 28 operations, a restaurant's 14): 24 checks.
- **A shop's sale is never sent to a kitchen.** A counter order goes to the kitchen when it is paid; for a shop that would have made a kitchen ticket per sale. Found reading `OrderOps.afterPay`; switched off for a shop.
- **A sheet that is typed into sits at the top of the screen** (`Sheet(top = true)`), found on the emulator: the keyboard covered the note's Save. The discount on a sale is typed on the till's own keys for the same reason.
- **Today is worded for a shop**: refunded, average sale, parked; no covers, no channels.
- The plan's "parity fixture" between `Calc` and the server was not needed: the line's price is worked out on the till only and the server stores it; the replay test is the stronger proof (the till's real figures against the server's).

**Run on a device.** A separate emulator made for this (`easypay_claude_test`, never the user's): 

1. **The upgrade.** A version-8 database built from `schemas/8.json` with a restaurant's rows (an open order with a paid and an unpaid line, a receipt, an unsent operation, a cursor) was opened by the new build: version 9, every row intact, the new columns empty, the cursor back to 0, no error. `check_room` also compares the hand-written migration with `schemas/9.json` column by column.
2. **A shop.** Clock in with a PIN, open the day with a float; two mugs by tapping; a shirt through the picker (L / Navy, "3 left"); 350 g of rice on the number sheet; 10% off the shirt line; park; a mug by typing its barcode; a code no product has (nothing added, and it says so); the parked sale brought back; Rs 2,000 cash, Rs 171 change; the tiles' stock down by what was sold. A part return of one mug, not put back into stock. As the cashier: a discount and then a price change, each stopped for the owner's PIN; paid by card. Then: a quantity typed (12), rupees off each, a note, a line removed, a new customer, 5% off the sale, cash. Products & stock, Today, More, the cash drawer (it expected the float plus cash sales less the cash refund, to the cent).
3. **A restaurant, same build.** The floor plan, a table seated for two, a quantity changed, sent to the kitchen, paid in cash and the table freed; a quick sale by card; a refund, with no stock switch offered.
4. **Both outboxes were sent to the dev server** (rolled back): every operation applied, every receipt equal to the cent, nothing flagged for review, each changed price naming who allowed it, every stock figure the same on the till and the server, and the return that was not put back written off as damaged.

No crash in the device log through any of it.

**Not run, and why:**

- **Nothing was installed on the user's emulator**, and no till was signed in to a real business: a sign-in is the user's. The sync itself (push and pull over the network from the till) was therefore not run from a device; its two halves were: the till's operations against the server's functions (the replay), and the API's routes with a till's key (`api-shop-gate`, `api-till-key`).
- **A real barcode scanner.** The till tells a scanner from a keyboard by the device the keys come from; `adb` types as a virtual keyboard, so codes were typed into the search box and entered. The lookup is the same function.
- **A printer.** The receipt's "was Rs 1,290.00, 10% off" line is in the layout and was seen on the receipt's screen, not on paper.
- **The pull of stock levels into a till** was checked on the server (`retail-till` A10) and in the till's reader by reading it, not by a till pulling. (Done later the same night: see "After this record".)

**Found and left for the user to decide or see:**

- The restaurant's own sheets that are typed into (an order's note, a typed discount) are hidden by the keyboard in the same way; they were not changed.
- A shop's customer form still says "Note (allergies, what they like)". (Changed later the same night: see "After this record".)
- A new shop still gets the order types Dine-in, Takeaway and Delivery from `ensure_pos_basics`; its sales are all "Counter", and the back office's order-type filter lists the others.
- `item.set_price` on a variant keeps no record of who changed it (a product's price does).
- Production needs migrations 0064 to 0079 (as of the end of the night), then the API, then build 3 on the tablets. A shop must not be switched on before its tablets have build 3: the gate will stop them syncing until they do.

**For the user: seeing it without a login.** With an emulator that has no EasyPay data on it (never the till in use):

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```
```bash
adb shell am start -n com.restopos.app/.MainActivity
```
```bash
adb shell am broadcast -n com.restopos.app/com.restopos.debug.DemoReceiver -a com.restopos.app.DEMO_SHOP
```

Close the app and open it again. The two members of staff and their PINs are in `android/app/src/debug/assets/demo-shop.json`.

## After this record (2026-10-08, later the same night)

Found in review of the work above, and fixed; each has its own commit.

- **A split check dropped a line's price** (`71c7e68`, migration 0078). `ticket.split_line` made the part taken off with the columns it knew by name, so that part lost what it was listed at and who allowed the change; its receipt was flagged as price drift and printed no "was". Two checks in `retail-till`, failing first.
- **A sale could only be refunded on the till that made it, and the pull had never run on a device** (`975c0b5`). A shop's till now keeps the shop's receipts of the last 30 days as the server sends them (`PullApplier`, a class of its own): one made on another till is listed, shown line by line, reprinted and refunded, the refund worked out from the pulled lines and their taxes. The receipts list is found by number. The debug build can be given a page of the server's pull (`DEMO_PULL`): the made-up shop was emptied and filled only from dev's pull page, signed in with the pulled PIN, sold a variant from the pulled catalog with the pulled stock on its tiles, and refunded a receipt it had not made; the server took that refund. The till's shift and day reports count a discount on a line as a discount, and say price changes apart.
- **A discount on one line showed nowhere in the back office** (`7206c4c`, `9b7b059`). The receipt's own discount does not hold it (it is on the line). The Sales summary, the dashboard, Staff performance and Day closing now count it for a shop, say prices typed for one sale apart, and Order details says on the line what it was listed at and who allowed it. A restaurant's pages ask what they asked before.
- **Nobody could open a shop's back office on dev** (no account, and one is not made by me). `db/tests/shop-pages.test.cjs` opens the real pages, compiled from their TypeScript, with the test's own connection as the tenant's role, on a shop and on a restaurant that traded through `sync_push`: 40 checks, among them every page of a shop's menu. It is the nearest thing to signing in that can be run without an account.

Piece 5 (the exchange) is in `2026-10-08-retail-exchange-5.md`.
