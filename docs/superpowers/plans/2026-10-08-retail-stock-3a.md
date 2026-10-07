# Retail Stock module, step 3a: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; this repo's owner is cost-sensitive, no subagent fan-out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop sees what it holds, line by line, with its value; takes stock out or puts found stock back with a reason, never below zero by hand; reads every movement; and the owner decides who may see stock, adjust it, and see cost.

**Architecture:** One migration adds `stock_adjust` (the floor lives there, not in `stock_move`, so restaurants behave as before), `stock_on_hand` (the one definition of "a line of stock": a counted product, or each variant of one), and the new permission ids. The back office gains a Stock group for shops, a Stock on hand page drawn from the approved board, and a Movements page. Cost is hidden from anyone without the new permission.

**Tech Stack:** Postgres on Neon (plpgsql, RLS), Node suites in `db/tests`, Next.js 16 back office in `web/`, pure modules tested under node (`node web/lib/<name>.test.mjs`).

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, sections 4, 5 (Stock on hand, Movements, Permissions) and 7, piece 3. Approved boards: https://claude.ai/artifact/GfTY9m9TFyXfNt5inwRh14 (`Main` is Stock on hand, `Side` is the menu). Piece 3 is built in four steps, each with its own plan and its own migration: **3a** this one; **3b** purchase orders and deliveries; **3c** counts; **3d** reports. Read `2026-10-07-retail-foundation.md`, "Before starting", first.

---

## Before starting

- `ls db/migrations | tail -3` right before writing the migration: it takes the first free number (**0073** when this was written).
- `git status --short` before every edit. `web/app/backoffice/nav.ts` still carries another session's uncommitted lines (the Point of sale group): commit only this plan's lines of it (copy the file, edit, `diff -u` the copy against it, `git apply --cached` that patch). Stage by path, never `git add -A`.
- Suites one at a time. A `retry:transient` is a collision with another session until the suite fails alone.
- Nobody can sign in from here: a page is checked with `node db/scripts/prepare-web-sql.cjs <files>` (its queries are planned against dev) and by rendering it to HTML with sample rows (the stand-in renderer used for Printers on 2026-10-07). Say in the report what was rendered and what nobody has opened.
- Nothing is applied to production.

## What the till does with this

Nothing. None of the new tables or functions is in the pull (`sync_pull` works from its own lists). An adjustment made here reaches a till only as the item's total (`items.stock_qty`), as before.

## Decisions made while planning (tell the user)

- **The floor is in `stock_adjust`, not in the engine.** A restaurant's Stock page still adds and counts as it did, below zero included; only a shop's adjustments by reason are refused when they would take a line below zero.
- **A reason decides the direction.** Damaged, Expired, Lost or stolen, Used in the shop and Returned to supplier take out; Found puts in. The quantity is typed as a plain number. Stock is added with its cost by receiving a delivery (3b), which is what the board says.
- **New permissions:** `stock.view`, `stock.receive`, `stock.adjust`, `stock.count`, `suppliers.edit`, `costs.view`. Every role that holds `items.edit` today is given all six, so nobody loses what they can do. The owner's role already has everything. "Change a line's price" is left to piece 4, where the till enforces it: a tick that does nothing yet would mislead.
- **Addresses:** Stock on hand stays at `/backoffice/stock` (a restaurant keeps its own page there); Movements is `/backoffice/stock-movements`. `/backoffice/counts` is taken by the menu's numbers, and an address under `/backoffice/stock/` would light up two menu lines at once.

## Rules, each one a check in `db/tests/stock-adjust.test.cjs`

| Check | Rule |
|---|---|
| A1 | `stock_adjust` with a reason that takes out (`damaged`, `expired`, `lost`, `internal`, `supplier_return`) lowers the line by the quantity typed, at the line's average cost, and writes one movement with that reason, the shop, the person and the note. The average does not move. |
| A2 | Taking out more than the line holds is refused (`not-enough-stock`) and nothing changes. Taking out exactly what it holds leaves zero, and the level's row stays. |
| A3 | `found` raises the line at its present average cost (the product's cost when the line has never had stock). |
| A4 | The quantity is a number of units above zero (`bad-quantity` otherwise). Any other reason, `adjust`, `sale`, `refund`, `receive`, `count` and `opening` included, is refused (`bad-reason`). |
| A5 | A product with variants is adjusted variant by variant: without one it is refused (`pick-variant`). A variant of another product, or a removed one, is refused (`unknown-line`), and so is a variant given for a product that has none. |
| A6 | A product that is not counted (neither ticked nor in a counted category) is refused (`not-counted`). |
| A7 | Another shop's level of the same product is untouched. |
| A8 | The engine is as it was: `stock_move` with `adjust` still goes below zero (a restaurant's page). |
| L1 | `stock_on_hand(tenant, shop)` gives one line per counted product without variants and one per live variant of a counted product with variants, never the product itself beside its variants. Removed products and variants, and products that are not counted, are left out. |
| L2 | A line that never had stock in this shop shows zero on hand, at the variant's cost, else the product's. |
| L3 | A line carries its own on hand, average cost, reorder level and order quantity for this shop, the price it sells at (the variant's, else the product's), and what it sold in 30 days in this shop: sales less refunds, older ones and other shops left out. |
| P1 | After the migration every role that held `items.edit` holds the six new permissions once each; a role without it holds none of them. Granting again adds nothing. |
| P2 | A tenant created now has them on its Manager and not on its Cashier or Waiter. |
| T1 | The tenant role can call both functions inside its own tenant, and sees no line of another tenant. |

`web/lib/stock.ts` is pure and tested in `web/lib/stock.test.mjs`: the status of a line (Below zero under zero; Out at zero; Low at or below its own reorder level, never without one; In stock otherwise), the totals on top (value at cost, at selling price, how many low, out and below zero), and the reasons with their words and direction.

## File map

| File | Created or changed | What it holds |
|---|---|---|
| `db/migrations/0073_stock_adjust.sql` | create | `stock_adjust`, `stock_on_hand`, `grant_stock_perms`, the Manager's defaults in `platform.create_tenant` |
| `db/tests/stock-adjust.test.cjs` | create | the checks above, one rolled-back transaction |
| `web/lib/stock.ts`, `stock.test.mjs` | create | status, totals, reasons (pure) |
| `web/app/backoffice/nav.ts`, `side.tsx` | change | the Stock group for a shop; the open group follows the business type |
| `web/app/backoffice/stock/page.tsx` | change | a shop gets Stock on hand; a restaurant's page is untouched |
| `web/app/backoffice/stock/on-hand.tsx`, `on-hand-table.tsx` | create | Stock on hand (the `Main` board) |
| `web/app/backoffice/stock-movements/page.tsx`, `export/route.ts` | create | Movements, and its CSV |
| `web/app/backoffice/roles/page.tsx` | change | the Stock permissions, for a shop |
| `web/app/backoffice/suppliers/page.tsx` | change | its saves ask for `suppliers.edit` |
| `web/app/backoffice/items/page.tsx`, `table.tsx`, `[id]/page.tsx`, `export/route.ts`, `import/page.tsx` | change | cost and margin only for `costs.view` |

## The migration

One file, additive. In this order:

1. **`stock_adjust(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_units integer, p_reason text, p_emp uuid, p_note text) returns uuid`**, security invoker. `p_units` is thousandths, above zero. Checks A4 to A6, then `stock_level_for` (which locks the line), then the floor (A2), then `stock_move` with the signed quantity, no cost, no document. Returns the movement's id.
2. **`stock_on_hand(p_tenant uuid, p_store uuid) returns table (item_id, variant_id, name, variant, sku, barcode, category_id, category, supplier_id, supplier, price bigint, qty integer, avg_cost numeric, reorder_point integer, reorder_qty integer, sold30 integer)`**, `language sql stable`, security invoker (RLS applies). Lines as in L1; `left join stock_levels` for the shop; `sold30` from `stock_movements` with reason `sale` or `refund` in the shop over 30 days, sign turned.
3. **`grant_stock_perms(p_tenant uuid) returns integer`** (null: every tenant): appends each missing id to every live role holding `items.edit`; returns how many roles it changed. Called once at the end of the migration.
4. **`platform.create_tenant`** redefined from its live definition (it is in the `platform` schema, so read it with `pg_get_functiondef` yourself: `dump-function.cjs` reads `public` only) with the six ids added to the Manager's list. `create_tenant_of_type` calls it and needs no change.

## Tasks

### Task 1: the suite, failing

- [ ] Write `db/tests/stock-adjust.test.cjs` (harness as in `stock-engine.test.cjs`: one transaction, `failsWith`, a tenant from `platform.create_tenant`, a second shop, a second tenant for T1, role switched to `app_user` for T1).
- [ ] Run it. Expected: `TEST_FAILED` on `function stock_adjust(...) does not exist`.

### Task 2: the migration

- [ ] Check the first free number; write the migration as above.
- [ ] `node db/migrate.cjs`, then the suite. Expected: every line `PASS`.
- [ ] One at a time: `stock-engine`, `stock-sales`, `stock-locks`, `catalog`, `catalog-import`, `pos-operations`, `platform`, `business-type`, `isolation`. Expected: all pass unchanged.
- [ ] Commit the migration and the suite.

### Task 3: status, totals and reasons

- [ ] `web/lib/stock.test.mjs` first (status at each boundary, totals with a negative line, each reason's direction), run it and see it fail; then `web/lib/stock.ts`. Commit.

### Task 4: the menu

- [ ] `nav.ts`: Stock is `only: "restaurant"` in the Menu group; Suppliers leaves it; a new group `stock` ("Stock", icon `Boxes`) with Stock on hand (`/backoffice/stock`), Suppliers and Movements, each `only: "retail"`. `groupOf(path, mode)` looks in `groupsFor(mode)`; `side.tsx` passes its mode. Type-check. Commit (only this plan's lines of `nav.ts`).

### Task 5: Stock on hand

- [ ] `stock/page.tsx`: a shop is handed to `on-hand.tsx`; nothing else in the file changes.
- [ ] `on-hand.tsx` (server) and `on-hand-table.tsx` (client, on `table-kit`), as the `Main` board: the five figures; the search by name, SKU or scanned barcode; All, Low, Out, Below zero and a supplier filter; a line opens to adjust (reason, quantity, note, "Save adjustment", "See movements") with "N on hand now. To add stock, receive a delivery, so its cost is recorded." The action is `act("stock.adjust", …)` calling `stock_adjust`; `not-enough-stock` and the other refusals become sentences. Without `stock.view` the page says so and shows nothing; without `costs.view` the cost, value and the two value figures are not sent to the browser.
- [ ] `prepare-web-sql.cjs` on the new files, type-check, render with sample rows. Commit.

### Task 6: Movements

- [ ] `stock-movements/page.tsx`: the latest 500 in the filter (product, reason, person, from and to), each with when, product and variant, what happened, quantity, cost (for `costs.view`), who, note and the document it came from; `export/route.ts` gives the whole filter as CSV. "See movements" on a line and on a product's page lead here with the product chosen.
- [ ] `prepare-web-sql.cjs`, type-check, render. Commit.

### Task 7: who may do what

- [ ] `roles/page.tsx`: a Stock group shown to a shop (See stock; Receive deliveries and place orders; Adjust stock; Run stock counts; Manage suppliers; See cost and profit). What a role holds and the page does not show is kept, as today.
- [ ] `suppliers/page.tsx`: its three saves ask for `suppliers.edit`.
- [ ] Cost only for `costs.view`: the products list (Cost, Margin, and its CSV), the product's page (the cost fields are not drawn, and a save without them leaves the cost as it was), the catalog export (the Cost column is empty), the import page (refused: a file writes costs).
- [ ] Type-check, build (output to a file). Commit.

### Task 8: see it

- [ ] Every suite, one at a time. The menu for a shop and for a restaurant, rendered. Add what was built and what nobody has opened to the end of this file, and tell the user what is theirs to open signed in.

---

## What happened when this plan was run (2026-10-08)

Built as written. Commits `32f20a8` to `0348151` on `restopos`, dev only, not pushed.

**As built:**

- Migration `0073_stock_adjust.sql` and `db/tests/stock-adjust.test.cjs` (31 checks). `stock_adjust` also refuses a shop that is not the tenant's (`unknown-store`).
- `web/lib/stock.ts` (status, totals, reasons, the words for every movement) and `web/lib/perms.ts` (what the Roles page offers and saves), each with a node test.
- The menu: a shop has a Stock group (Stock on hand, Suppliers, Movements); `groupOf` takes the kind of business. A restaurant's menu is unchanged.
- Stock on hand (`stock/on-hand.tsx`, `on-hand-table.tsx`) and Movements (`stock-movements/`), with the CSV.
- Roles: the Stock permissions for a shop. Suppliers ask for `suppliers.edit`.
- Cost only for `costs.view`: the products list, a product's page, the catalog export, the import. The product and line writes moved to `web/lib/saves.ts` (`saveProductRow`, `saveVariantLines`), where the suite `backoffice-saves` checks that a save from a form with no cost field leaves the cost alone (it would have wiped it).

**Found on the way, and fixed:** Remove on a product's line (piece 2) could never have worked: the line was sent as the button's name and value, which React takes over when the button's action is a server function. The line is now bound to the button. It has not been pressed in a browser.

**Seen and not seen.** Every suite passed, one at a time (`stock-adjust`, `stock-engine`, `stock-sales`, `stock-locks`, `catalog`, `catalog-import`, `backoffice-saves`, `pos-operations`, `platform`, `business-type`, `isolation`, `service-v2`), and the node tests. Type-check and a production build are clean. The queries of every new and changed page were planned against dev (`prepare-web-sql.cjs`), and the Movements query was run for real, read only. Stock on hand, Movements, a product's page, the products list and a restaurant's Stock page were drawn to HTML from sample rows with a stand-in session: an owner, someone who may see stock but not cost, someone who may not see stock. **Nobody has opened any of it signed in**, and dev has no shop yet (no tenant is retail).

**Left for the next steps:**

- Stock on hand has no "Receive a delivery" or "New count" button yet: they arrive with 3b and 3c.
- The pages show the tenant's first shop. A second shop needs a way to choose one.
- A shop's Roles page still words some permissions for a restaurant (kitchen, tables).
- "Change a line's price" is added with the till's sell screen (piece 4).
- Production needs migrations 0064 to 0073.
