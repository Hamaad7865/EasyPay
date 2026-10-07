# Retail Stock module, step 3d: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; this repo's owner is cost-sensitive, no subagent fan-out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop's owner sees what the stock is worth and where, what to order, what was lost and why, what is not selling, and what each product earned after its cost.

**Architecture:** No migration: everything needed is already written down by the stock engine (every movement keeps the average cost of its moment). The questions live in one module, `web/lib/stock-reports.ts`, as SQL and a few pure sums, so a suite can ask them as the tenant's own connection and the pages cannot drift from what was tested. One new page, Stock reports, has four views; Item sales gains four columns for a shop.

**Tech Stack:** Postgres on Neon, Node suites in `db/tests`, Next.js 16 back office in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, section 5 (Reports, Permissions) and 7, piece 3. Read `2026-10-08-retail-stock-3a.md`, "Before starting", first: it applies here unchanged.

---

## Facts checked before planning

- `stock_move` writes `unit_cost` on every movement: the cost given when stock comes in at a cost, otherwise the line's average cost at that moment. A sale's movement is one per receipt, product and variant, with the receipt as its document; a refund's carries the cost its sale went out at.
- Movements written before the engine (0067) have no cost. A line of stock that was never given a cost moves at 0. Both mean "the cost is not known", and are treated the same: no cost, no profit, not 100% profit.
- Prices on dev include VAT (`receipt_line_taxes.type = 'included'`); a tax can also be `added`. The Tax report already takes each line's share of the bill's discount off before working out the VAT. Profit uses the same sums.
- The CSV button of a report copies the tables on the page. A column that is not drawn is not in the file.

## Decisions made while planning (tell the user)

- **Profit is sales excluding VAT, after the bill's discount, less what the goods cost when they were sold** (the average cost of that moment, kept on the sale's movement). Changing a product's cost later does not rewrite past profit.
- **A product with no known cost is left out of cost and profit**, and the report says how much of the sales that is. It is not counted as all profit.
- **One page, Stock reports, with four views** (Stock value, Reorder list, Losses, Not selling), not four entries in the menu.
- **The reorder list is the rule "Add what is low" already uses** on a purchase order: a reorder point is set and the line holds that or less. A line that is out with no reorder point is not on it; the page says how many there are.
- **Losses are damaged, expired and lost**, as the design says. What counts corrected in the same days is said in one line under the table, not added in.
- **"Not selling" looks back 60 days from now** (30, 90 and 180 can be picked), shows when each line last sold and last came in, and lists only lines that hold stock.
- **Stock reports need "See reports" and "See stock"; every rupee figure also needs "See cost and profit".** Stock value is nothing but rupees, so it needs all three.

## Rules, each one a check in `db/tests/stock-reports.test.cjs`

| Check | Rule |
|---|---|
| V1 | Stock value by category, and by supplier, each add up to the totals Stock on hand shows (at cost and at shelf price), to the cent. A line below zero counts for what it shows in both. A product with no category or no supplier is in a row of its own. |
| O1 | For every supplier, the reorder list holds exactly the lines `po_fill_low` puts on a draft order for that supplier, with the same quantities. A line with no reorder point is never on it. |
| L1 | Losses are the damaged, expired and lost movements of the days asked, by reason and by product, in units and at the cost of the moment. Found, internal use, returns to a supplier, counts and sales are not losses. |
| L2 | The days are the shop's: a loss at 23:30 on the last day, shop time, is in; one at 00:30 the next day is out. |
| L3 | A cost changed after the loss does not change what the loss was worth. |
| U1 | Not selling: a line that holds stock and has no sale in the last N days. A line sold yesterday is not on it; a line with nothing on hand is not on it; a refund is not a sale. Each line says when it last sold (or never) and when stock last came in. |
| P1 | Item sales, for a shop: cost is what the goods cost when sold. Changing the product's cost afterwards changes nothing. |
| P2 | Two lines of one product on one receipt cost what the two together cost, not twice that. |
| P3 | A refund takes off its sales, its cost and its profit. |
| P4 | A product not counted in stock has no cost, and its sales are in "sales with no cost" and in no profit. |
| P5 | Sales excluding VAT are after the bill's discount, by the same sum as the Tax report. |
| T1 | The tenant role can ask all of it inside its own tenant, and sees nothing of another. |

## File map

| File | Created or changed | What it holds |
|---|---|---|
| `web/lib/stock-reports.ts`, `stock-reports.test.mjs` | create | `LOSSES_SQL`, `UNSOLD_SQL`, `itemProfitSql`, and the pure sums: `valueBy`, `reorderList`, `suggestedQty`, `margin` |
| `db/tests/stock-reports.test.cjs` | create | the checks above |
| `web/app/backoffice/reports/stock/page.tsx` | create | Stock reports: the four views |
| `web/app/backoffice/reports/items/page.tsx` | change | for a shop, to whoever may see costs: sales excluding VAT, cost, profit, margin. A restaurant's page is not changed |
| `web/app/backoffice/nav.ts` | change | Stock reports, under Reports, for a shop |

## Tasks

### Task 1: the sums (pure)
- [ ] `web/lib/stock-reports.test.mjs`, failing: `valueBy` groups lines by a key, sums units, cost and shelf value with `lineValue`'s rounding, and its rows add up to the whole; `suggestedQty` is `reorder_qty` when set, otherwise what is missing to the reorder point, and at least one; `reorderList` groups low lines by supplier; `margin` is null when there are no sales with a cost.
- [ ] `web/lib/stock-reports.ts` until `node web/lib/stock-reports.test.mjs` passes. No value imports: the suite compiles this one file.

### Task 2: the questions (SQL), test first
- [ ] `db/tests/stock-reports.test.cjs`, in one rolled-back transaction, as `app_user` for the questions: a shop with a category, a supplier, three products (one with two variants, one not counted in stock), deliveries at a cost, sales through the sync operations as `stock-sales.test.cjs` does, a refund, adjustments. Run it: every check fails for want of the module's SQL.
- [ ] The SQL in `web/lib/stock-reports.ts` until the suite passes.
- [ ] `node db/scripts/prepare-web-sql.cjs` on the new page and Item sales.

### Task 3: the pages
- [ ] `reports/stock/page.tsx`: `onlyFor("retail")`; needs `reports.view` and `stock.view`; `?view=value|reorder|losses|unsold`; rupee columns only for `costs.view`; Print and CSV as the other reports.
- [ ] Item sales: draw a restaurant's page from sample rows before the change and keep the HTML; add the shop's columns; draw the restaurant's page again: the HTML is the same.
- [ ] `nav.ts` (the copy-of-HEAD way: the file carries another session's lines).

### Task 4: see it
- [ ] Type-check; every view drawn from sample rows, with and without `costs.view`; every suite, one at a time; a production build.
- [ ] "What happened when this plan was run", at the end of this file.

---

## What happened when this plan was run (2026-10-08)

Built as written, with the differences below. Commits `160501d` and `4907d61` on `restopos`, dev only, not pushed. No migration.

**As built:**

- `web/lib/stock-reports.ts`: `LOSSES_SQL`, `COUNTED_SQL`, `UNSOLD_SQL`, `itemSalesSql`. `db/tests/stock-reports.test.cjs` asks them as the tenant's own connection, in one rolled-back transaction, with sales and a refund pushed through the sync operations (27 checks).
- `/backoffice/reports/stock`, four views: Stock value, Reorder list, Losses, Not selling. Under Reports in a shop's menu, as Stock reports.
- Item sales, for a shop and for whoever may see costs: Without VAT, Cost, Profit, Margin, a Profit figure on top, and a line saying how much of the sales has no cost on file.

**Different from the plan:**

- **The sums (`valueBy`, `isLow`, `suggestedQty`, `reorderList`, `margin`) are in `web/lib/stock.ts`**, beside the sums they build on, with their checks in `stock.test.mjs`. `stock-reports.ts` holds SQL only and imports nothing, so the suite can compile that one file.
- **`itemSalesSql` serves every business.** Without cost it is the question the page always asked, so a restaurant's page did not move: its HTML, drawn from the same sample rows before and after, is the same byte for byte.
- **A row whose sales are only partly costed says so** ("Some of these sales have no cost"): its profit is over the part that has one, so it is not the Without VAT column less the Cost column.
- The reports' shared filter bar can now carry a hidden field (the view to come back to). Losses open on this month so far, not on today alone.

**Found while testing:** the till's `ticket.add_line` does not carry a variant yet (that is piece 4). The suite's sales are of products without variants; variants are in its stock value, reorder and not-selling checks. Cost on Item sales for a variant is matched on the variant in the SQL, and nothing has run it.

**Seen and not seen.** `stock-reports` 27 checks, `stock-counts` 37, `purchase-orders` 45, `stock-adjust` 31, `backoffice-saves` 66, `isolation` 10: all pass (the whole set of 41 suites passed earlier the same day, after migration 0076; nothing in the database changed since). The pure checks, the type-check and a production build are clean. The page's fixed queries were planned against dev; `itemSalesSql` is put together at run time, and the suite runs both of its forms. Drawn to HTML from sample rows: every view of Stock reports with and without the right to see costs, empty, for someone who sees reports and not stock, and for a restaurant (not found); Item sales for a restaurant, a shop with costs and a shop without. **The four views were looked at in a real browser** on a temporary page with sample rows (deleted afterwards), for their layout only. **Nobody has opened these pages signed in**, and the CSV and Print buttons were not pressed on them (the buttons are the reports' own, unchanged: the file is the tables on the page).

**Left for later:**

- The reorder list points to Purchase orders; it does not start the order itself.
- "Not selling" counts from when a sale reached the server, as "sold in 30 days" on Stock on hand does, not from the receipt's own time.
- Production needs migrations 0064 to 0076 (none from this step).
