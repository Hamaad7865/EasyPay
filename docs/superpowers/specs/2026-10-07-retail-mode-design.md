# Retail mode: design

Date: 2026-10-07. Status: design approved by the user in conversation, section by section. No code written yet.

## 1. Purpose

EasyPay serves restaurants only. This design adds a second kind of business, a retail shop, to the same product: one database, one back office, one APK. A tenant is a restaurant or a shop; the choice decides which pages and screens appear.

A shop needs three things a restaurant does not have today: products with variants, a full stock module in the back office, and a sell screen on the till built around scanning.

The behaviour reference is Lightspeed Retail (X-Series), read on 2026-10-07 at `x-series-support.lightspeedhq.com`: adding products, purchase orders, receiving, inventory adjustments, inventory counts, inventory movements, the Sell screen, returns. EasyPay keeps its own name, wording and look.

## 2. Decisions the user made

| Question | Answer |
|---|---|
| Which shops first | Any shop: clothing, mini-market, general goods. Variants are in from the start. |
| Several shops per customer | Stock is stored per shop from day one. The screens show one shop. Transfers come later. |
| The till | A new retail sell screen is part of this work. |
| How retail relates to restaurants | One product with a mode per tenant (not a separate app, not per-feature ticks). |
| Add-ons in retail | Hidden. |
| Who sets the mode | The platform admin only. |
| Selling at zero stock | Never blocked. The figure goes negative and is listed for review. |
| Restaurants' stock | Moved onto the same stock engine; their page and tills behave as before. |
| Bundles | Not in this build. |
| Counting | Blind: the expected figure is hidden while counting. |
| Barcode labels | In this build. |
| Discount on one line | In this build. |
| Price change on one line | In this build. |
| Exchange as one flow | Later. Until then: a refund, then a new sale. |

## 3. The switch

**Where it lives.** `tenants.business_type`, `'restaurant'` or `'retail'`, default `'restaurant'`. Every existing tenant is therefore a restaurant and nothing changes for them.

**Who sets it.** The platform admin, when creating a tenant and later on the tenant's page in `/admin`. It goes through a `platform.*` function that writes an audit row, like a plan change. The owner cannot see or change it. A change is refused while the tenant has open orders. The switch hides things; it deletes nothing.

**How it reaches the back office.** `tenantContext()` already joins `tenants`; it carries the type to every page and to the shell.

**How it reaches the till.** `tenants` is not in the pull. `pos_settings` is, and the till reads its JSON loosely, ignoring keys it does not know. A trigger on `tenants` keeps `pos_settings.data.businessType` in step, so a till learns the type through the pull it already makes. `tenants.business_type` stays the one source of truth.

**Old APKs.** A till below the first retail version, belonging to a retail tenant, gets "update required" (the existing 426 answer, made aware of the tenant's type). It never shows restaurant screens to a shop.

### What the mode changes in the back office

| Area | Restaurant (unchanged) | Retail |
|---|---|---|
| Menu group | Categories, Items, Add-ons, Taxes, Discounts, Stock | Named **Catalog**: Categories, Products, Taxes, Discounts. Add-ons hidden. |
| Stock | One page under Menu | Its own **Stock** group: Stock on hand, Purchase orders, Suppliers, Counts, Movements |
| Restaurant group | Tables, Bookings, Customers, Printers, Receipt design | Named **Shop**: Customers, Printers, Receipt design. Tables and Bookings hidden. |
| POS settings | Service charge, kitchen notes, prep time, kitchen sound, order types | Hidden. The rest stays. |
| Categories | Kitchen printer ticks, Counted tick | Both hidden. |
| Wording | restaurant, menu, item, guest, order | shop, catalog, product, customer, sale |

Reports, receipts, day closing, cash flow, tills, staff, roles, taxes and backup are the same in both modes. A hidden page also refuses a direct visit to its address.

`nav.ts` stays the single list of pages. Each link and group says which modes it belongs to; the side menu and the search both filter by the tenant's mode, so they cannot drift apart.

### What the mode changes on the till

The home screen is the Sell screen in place of the floor plan. Hidden: Tables, Bookings, kitchen display, takeaway board, order types, courses, seats, send to kitchen, service charge. Kept as they are: PIN login, clock in and out, open and close day, cash in and out, receipts, refunds, reprint, customers, discounts, receipt printing, sync.

A tenant is one type. A restaurant that also runs a shop is two tenants.

## 4. Products, stock and cost

### Products

A product is simple (one barcode, one stock figure) or has variants. Variants come from up to three options the owner names (Size, Colour, Material). Each combination is its own line with its own barcode, SKU, price, cost and stock; price and cost start from the product's.

Schema, all additive:

- `items`: add `brand`, `supplier_id`, `supplier_code`, `option_names text[]` (at most three). `cost`, `sku`, `barcode`, `sold_by`, `track_stock` exist.
- `item_variants`: add `option_values text[]`, `cost`. The table and `variant_id` on ticket and receipt lines exist; no screen uses them yet.
- `suppliers`: name, contact person, phone, email, address, note.
- A barcode is unique within a tenant across items and variants together.

A product is counted when `track_stock` is set or its category is marked counted, the rule that exists. In retail the product form ticks it by default; unticking it makes a "not stocked" product (a service, a bag fee) with no quantity.

Removing a product, variant or supplier that has history is the soft delete that exists: it leaves the till and the lists, and its sales and movements stay.

### The stock figure

`stock_levels`: one row per shop and per product or variant, holding quantity on hand (thousandths, as elsewhere), average cost (cents), reorder level and reorder quantity.

`items.stock_qty` stays, maintained as the item's total, so the present till and the present Stock page keep working without change.

Selling is never blocked by stock. A negative figure means a delivery was not entered or a count is wrong, and the Stock page lists negatives in red.

### Movements

Every change to a quantity writes one row in `stock_movements`. The table gains `store_id`, `variant_id`, `unit_cost`, and a reference to the document the movement came from (`ref_type`, `ref_id`, `ref_line_id`). The reference is unique where present, which is what makes a receipt that syncs twice, or a double-clicked Receive, move stock once.

Reasons: `sale`, `refund`, `receive`, `supplier_return`, `count`, `opening`, `damaged`, `expired`, `lost`, `internal`, `found`, and the existing `adjust`. The CHECK constraint is widened; nothing is renamed.

A movement is never edited or deleted. A mistake is corrected by another movement.

### Cost

Cost is a running average per shop and per product or variant.

- Receiving: with quantity `q` on hand at average `a`, receiving `n` at cost `c` gives `(q*a + n*c) / (q + n)`. When `q` is zero or negative, the average becomes `c`.
- A sale, an adjustment out and a supplier return leave at the average of that moment, stored on the movement. Cost of goods sold is the sum over sale movements, so a past sale's profit never changes.
- A customer return comes back at the cost its sale left at.
- `found` and `opening` come in at the current average, or at the product's cost when there is none.

Not in this build: spreading freight and duty over a delivery, orders in a foreign currency. A unit cost can be corrected line by line when receiving.

### One engine

One database function, `stock_move`, is the only code that writes a movement and changes a level. It locks the level row, writes the movement, updates quantity and average cost, and keeps `items.stock_qty` in step.

Its callers:

- `push_receipt_create` and `push_refund_create`, redefined fix-forward from their live definitions to call it per line, with the variant and the receipt's shop.
- The back office: adjust, receive a delivery, complete a count.

**Restaurants.** The migration gives each counted item a level row at the tenant's first shop, with its present quantity and its cost. From then on restaurants run on the same engine. Their Stock page looks and behaves as now. The existing restaurant test suites must pass unchanged; that is the proof.

### The till and stock

The till pulls the levels of its own shop and shows "3 left". The number is information as of the last sync. The server holds the truth and applies each sale when its receipt syncs, so selling offline works as today.

## 5. Back office pages (retail)

Every page works with a barcode scanner plugged into the device showing the back office. There is no separate phone app. Pages follow the existing design system and table kit.

### Catalog › Products

A list searched by name, SKU or barcode; filtered by category, supplier and stock status; with price, cost, margin and on hand.

The product page has four parts:

- **General**: name, category, brand.
- **Price**: cost, selling price, tax; the margin shows as you type.
- **Variants**: name the options, type their values, and the lines are made. Each line's barcode, SKU, price and cost can be edited. Turning a simple product into one with variants is allowed only when its stock is zero.
- **Stock**: supplier, supplier's code, reorder level, reorder quantity, and a link to the product's movements.

**CSV import.** Download the template, upload, and see each row's problems before anything is saved. Then import the good rows or fix the file. Import creates products and updates existing ones by SKU. Nothing is half-saved. Export is the same file.

**Barcode labels.** A printable sheet from the browser for chosen products, or for a received delivery (one label per unit received). A label shows name, variant, price and barcode. A product with no barcode gets one made by EasyPay, in the range reserved for in-store codes. Barcodes are drawn as Code 128 by our own code, with no library to download. Layouts: common A4 label sheets and a single-label roll.

### Stock › Stock on hand

Every product and variant with on hand, average cost, stock value, reorder level and sold in 30 days. Status: Out, Low (at or below its own reorder level), Negative, In stock. A product with no reorder level is never Low. The restaurant Stock page keeps its own rule (five or fewer). Totals on top: stock value at cost and at selling price, how many are low, how many are out.

A row opens to adjust: a reason, a quantity, a note.

### Stock › Suppliers

Name, contact person, phone, email, address, note. Each supplier shows its products and its orders.

### Stock › Purchase orders

- **New order**: supplier, expected date, note. Add products by search or scan, or press **Add what is low** to fill in that supplier's products at or below their reorder level, each with its reorder quantity.
- **Draft**, then **Sent**: printed or saved as PDF for the supplier.
- **Receive**: type what arrived, or Receive all; correct a unit cost if the invoice differs. Stock goes up and the average cost is recalculated. Each delivery is its own document (`deliveries`, `delivery_lines`; "receipt" already means a sale's receipt).
- An order can arrive in several deliveries (**Part received**) until it is **Received** or the rest is **Closed**. More than was ordered is accepted and shown as over-received.
- **Receive without an order**: the same in one step, for a delivery that was never ordered.
- An order can be cancelled only before anything is received. A received delivery cannot be undone; goods sent back go out as "Returned to supplier".

### Stock › Counts

- **New count**: the whole shop, or one category, supplier or brand.
- **Counting**: scan (each scan adds one) or search and type a quantity. The expected figure is hidden. Two people can count the same count on two devices; their scans add up.
- **Trading during a count**: each count line keeps the time it was last counted. On completion, the new quantity is the counted figure plus the movements made after that time. A sale after the product was counted is therefore applied on top, and a sale before it was counted is already reflected in what was on the shelf.
- **Review**: Different, Matching, Not counted, with the difference in units and in rupees. A line can be recounted or left out.
- **Complete**: for products not counted, choose "leave as they are" or "set to zero". Stock is corrected by `count` movements; the count becomes read-only and prints as a report. A completed or cancelled count cannot be completed again.

### Stock › Movements

Every movement, filtered by product, reason, person and date, with CSV download.

### Reports

Added for retail: stock value by category and supplier; a reorder list; cost and profit columns on item sales; losses by reason (damaged, expired, lost); products not sold in 60 days.

### Permissions

Added to roles: see stock, receive deliveries, adjust stock, run counts, manage suppliers, see cost and profit, change a line's price. Cost and profit are hidden everywhere, CSV downloads included, from anyone without that permission.

## 6. The retail sell screen

This section fixes behaviour. The screen's look is drawn in the till's current design language and shown to the user for approval before any till code is written.

**Layout** (tablet, landscape). Left: the sale, with the customer on top, the lines (product, variant, quantity, price, line total), then subtotal, discount, VAT, total and **Pay**. Right: a search box for name, SKU or barcode, and under it categories and their products as tiles, each showing how many are left.

**Adding.**

- A scan adds the product at once; scanning it again raises the quantity. A code that matches nothing says so and adds nothing.
- Scanning a variant's barcode adds that exact variant.
- Tapping a product with variants opens a picker with the options as chips and the stock left for each.
- A product sold by weight asks for the weight.
- Tapping a line changes its quantity, adds a note, or removes it.

**During the sale.**

- Attach a customer (the picker that exists).
- Discount on the whole sale, in percent or rupees, as today.
- **Discount on one line**, in percent or rupees. It follows today's discount permission. The receipt shows the original price and the discount. `receipt_discounts.line_id` exists; the receipt function learns to accept it.
- **Price change on one line**, for this sale only. It needs its own permission or a manager's PIN (the approval that exists) and is recorded with who did it.
- **Park** puts the sale aside and starts another; parked sales are listed for retrieval. This is today's On hold.

Line discount and line price change are added to the server for both modes. Only the retail screen offers them in this build.

**Paying.** The payment screen that exists: cash with change, card, split payments, receipt printed.

**Returns.** From Receipts: find the sale, pick the lines and quantities coming back, refund to the chosen method. The goods go back into stock at the cost they left at. This is today's part-refund.

**Tabs in retail.** Sell, Receipts, Customers, Products & stock (look up a product, see what is left, change a price), Today, More (cash drawer, open and close day).

A retail sale is a ticket of the existing kind `counter`.

## 7. When things go wrong

| Case | What happens |
|---|---|
| Till offline | It keeps selling. Stock is applied when the receipts sync. |
| Two tills sell the last one | Both sales stand. Stock shows −1 and appears under Negative. |
| A receipt syncs twice | It moves stock once. |
| Double-click on Receive | It counts once. |
| More arrives than was ordered | Accepted, shown as over-received. |
| Count completed twice | Refused. |
| Product with history removed | Archived, not deleted. |
| Simple product turned into variants while it has stock | Refused until its stock is zero. |
| CSV with bad rows | Listed with reasons before anything is saved. |
| Mode changed with open orders | Refused. |
| Retail tenant's till on an old APK | "Update required". |
| Hidden page visited by its address | Refused. |

## 8. Testing

- **Server.** Every rule in sections 4 and 7 gets a database test on dev, in the style of the suites in `db/tests`: average cost, receiving in parts, over-receiving, a count with sales during it, negatives, a return at its original cost, movements written once, the mode-change guard. The existing restaurant suites pass unchanged.
- **Back office.** Each page is clicked through signed in, on dev data. Every report to the user says which paths were run and which were not.
- **Till.** Unit tests for the sale's arithmetic (line discount, price change, totals), then a run on the emulator. The emulator is shared with the user: ask before installing.
- **Production.** Nothing reaches production without the user's explicit yes. Order: migrations, then the API, then the APK.

## 9. Build order

Each piece gets its own implementation plan and ends in something the user can open on dev.

1. **Foundation.** The switch in admin; `business_type`; the stock engine (`stock_levels`, wider `stock_movements`, `stock_move`); restaurants moved onto it; the two receipt functions redefined; the back office menu and wording following the mode.
2. **Catalog.** Products with variants, suppliers, CSV import and export, barcode labels.
3. **Stock module.** Stock on hand, purchase orders and deliveries, adjustments, counts, movements, reports, permissions.
4. **Retail till.** The screen design for approval; then the sell screen, variant picker, stock on tiles, line discount, line price change, returns, the retail tabs, the version gate.
5. **Later.** The one-flow exchange; transfers between shops.

## 10. Not in this build

Offered to the user and left out: bundles and cases that break into singles; a full supplier-return document; emailing orders to suppliers; gift receipts; customer accounts and store credit; camera scanning; custom adjustment reasons; freight and duty spread over a delivery; foreign-currency orders; serial numbers; an online store; price books; gift cards; layaway.

## 11. To verify while planning

These are facts the plans must check in the code, not assume:

1. How a till on the present APK treats a table in the pull that it does not know. If it fails, the server sends `stock_levels` only to tills that can take it.
2. How the till reports its version, for the per-tenant "update required".
3. Where permission ids are defined and how a new one reaches existing roles.
4. The working tree held uncommitted back office changes on 2026-10-07 (among them `nav.ts`, `stock/table.tsx`, `items/editor.tsx`, `categories/*`, and an untracked migration `0064_device_activity.sql`). Pieces that touch those files wait until that work is committed. The next migration number is the first one free after it.
5. Whether `ensure_pos_basics` should give a retail tenant different starting data (no Dine-in and Takeaway options).
