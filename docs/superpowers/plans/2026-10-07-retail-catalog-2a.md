# Retail Catalog, step 2a: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (inline; this repo's owner is cost-sensitive, no subagent fan-out). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop's catalog: suppliers, products with brand, supplier, cost and reorder level, variants made from options, and barcodes and SKUs that the database keeps unique.

**Architecture:** Every rule that protects data lives in the database (triggers and functions in one migration) and is covered by one suite in `db/tests`. The back office adds a Suppliers page and a full-page product editor for shops; restaurants keep their item panel.

**Tech Stack:** Postgres on Neon (plpgsql, RLS), Node suites in `db/tests`, Next.js 16 back office in `web/`.

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, sections 4 (Products) and 5 (Catalog › Products), piece 2. Step 2b (labels, CSV import and export) is its own plan. Read `docs/superpowers/plans/2026-10-07-retail-foundation.md`, "Before starting", first: how migrations, suites and commits work here is the same.

**The user's two answers (2026-10-07):** a shop's product opens on a **full page**; barcode labels (2b) are printed on **both** a label roll and A4 sheets.

---

## Before starting

- Another session was still adding migrations that evening (`0069_booking_table_store.sql` at about 22:00). **This plan's migration takes the first free number; 0070 when written.** Check `ls db/migrations | tail -3` again before creating the file, and `git status --short` before touching `nav.ts` (commit only this plan's lines of it: copy the file first, edit, `diff -u` the copy against it, `git apply --cached` that patch).
- Run suites one at a time, and only while no other session is running suites on dev.
- From `web/`: `npx tsc --noEmit`. The build's output goes to a file.

## What the till does with this (state it in every report)

Nothing yet. The current APK reads named fields of `items` and has no branch for `item_variants`, so new columns are ignored and a product with variants shows as one item at the product's price; a variant's barcode does not scan. That is acceptable until piece 4 (the sell screen). `suppliers` and `barcode_counters` are **not** added to the pull.

## Rules, each one a check in `db/tests/catalog.test.cjs`

| Check | Rule |
|---|---|
| C1 | `suppliers` holds a tenant's suppliers; another tenant sees none (forced RLS). |
| C2 | A barcode is unique within a tenant across products and variants. A second use is refused with `barcode-taken`, whichever table it is in, on insert and on update. A removed product's barcode is free again. Blank becomes null. |
| C3 | A SKU is unique within a tenant across products and variants, ignoring case (`sku-taken`). |
| C4 | Two tenants may use the same barcode and the same SKU. |
| C5 | `variants_generate` makes every missing combination of the option values, named "M / White", at the product's price and cost, and reports `{created, existing}`. Run again with one more value it creates only the new lines. |
| C6 | `variants_generate` refuses more than 3 options, an empty or repeated option name, an empty or repeated value, and more than 200 lines in all (`bad-options`, `too-many-variants`). |
| C7 | A simple product becomes one with variants only when its stock is zero (`has-stock`). |
| C8 | `variant_archive` refuses a variant that still has stock (`has-stock`); otherwise it is removed, and when the last one goes the product is simple again (`option_names` empty). |
| C9 | A change of the product's price reaches the variants that had that price and leaves a variant priced differently alone; the same for cost. |
| C10 | `assign_barcodes` gives every line of a product that has none a valid EAN-13 (prefix, serial, check digit), never one already in use, and never the same one twice; it returns how many it gave. The check digit of `ean13('200', 1)` is the published one for `200000000001`. |
| C11 | A variant's first stock level starts at the variant's cost when it has one, the product's otherwise. |
| C12 | `stock_set_reorder` puts the reorder level and usual order quantity on every line of a product in a shop, making the levels (at zero) that do not exist yet. |
| C13 | The tenant role can call all of it inside its own tenant. |

## File map

| File | Created or changed | What it holds |
|---|---|---|
| `db/migrations/0070_catalog.sql` | create | everything below under "The migration" |
| `db/tests/catalog.test.cjs` | create | checks C1 to C13, one rolled-back transaction |
| `db/tests/require-dev.cjs` | change | `suppliers`, `barcode_counters` in the cleanup list |
| `web/app/backoffice/data/export/route.ts` | change | `suppliers`, `item_variants` in the backup |
| `web/app/backoffice/suppliers/page.tsx`, `table.tsx` | create | the Suppliers page (shops only) |
| `web/app/backoffice/items/[id]/page.tsx`, `product-form.tsx` | create | a shop's product, full page |
| `web/app/backoffice/items/page.tsx`, `table.tsx` | change | for a shop: opens the page, shows cost, margin and variants, finds a variant's SKU or barcode |
| `web/app/backoffice/nav.ts`, `counts/route.ts` | change | the Suppliers link and its count |
| `web/app/backoffice/search/route.ts`, `search-box.tsx` | change | no tables for a shop; variants are found; a shop's hit opens the product page |

## The migration

One file, additive. In this order:

1. **`suppliers`**: `name` (required), `contact`, `phone`, `email`, `address`, `note`, the standard columns, forced RLS with `tenant_isolation`, `trg_touch`, index on `(tenant_id, server_seq)`. Copy the pattern from `stock_levels` in 0067. No unique on the name: `act()` already says "That name is already in use" for 23505, so add `unique (tenant_id, name)` only among live rows as a partial unique index.
2. **`items`** gains `brand`, `supplier_id`, `supplier_code`, `option_names text[] not null default '{}'`. **`item_variants`** gains `option_values text[] not null default '{}'`, `cost bigint`.
3. **`catalog_code_guard()`**, a trigger function on `items` and `item_variants`, `before insert or update of sku, barcode, deleted_at`: trims both codes (blank becomes null), takes the tenant's lock (`pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 0))`, the one `touch_row` takes), then refuses a barcode or a SKU (compared with `lower()`) held by another live row of the tenant in either table. A row being removed (`deleted_at` set) is not checked.
4. **`variants_follow_price()`**, `after update of price, cost on items`: `update item_variants set price = new.price where item_id = new.id and price = old.price and deleted_at is null` when the price changed, and the same for cost with `is not distinct from`.
5. **`barcode_counters`** (`tenant_id` primary key, `prefix text not null default '200'`, `next_serial bigint not null default 1`, forced RLS). The prefix is in GS1's range for codes that never leave the shop. It is per tenant so a shop whose scale prints labels starting the same way can be given another. **`ean13(prefix text, serial bigint) returns text`** pads the serial to fill twelve digits and adds the check digit (weights 1,3,1,3… from the left; the digit that takes the sum to the next ten). **`assign_barcodes(p_tenant, p_item) returns integer`** locks the tenant's counter row, and for each live line of the product with no barcode (its variants, or the product itself when it has none) takes the next serial whose code no live row of the tenant has.
6. **`variants_generate(p_tenant uuid, p_item uuid, p_names text[], p_values jsonb) returns jsonb`**: `p_values` is an array of arrays, one per name. Validates (C6), refuses C7, writes `items.option_names`, inserts the missing combinations (name = values joined with `' / '`, price and cost from the product, SKU = the product's SKU, a dash and the values, when the product has a SKU and that SKU is free), returns `{created, existing}`.
7. **`variant_archive(p_tenant uuid, p_variant uuid) returns void`** (C8).
8. **`stock_level_for`** redefined from 0067 with one change: the first level's cost is `coalesce(variant's cost, product's cost, 0)`.
9. **`stock_set_reorder(p_tenant uuid, p_store uuid, p_item uuid, p_point integer, p_qty integer) returns integer`** (C12): the number of lines set.

## Tasks

### Task 1: the suite, failing

- [ ] Write `db/tests/catalog.test.cjs` with checks C1 to C13 (harness as in `stock-engine.test.cjs`: one transaction, `failsWith`, a tenant made with `platform.create_tenant`, a second tenant for C1 and C4, role switched to `app_user` for C13).
- [ ] Run it: `node db/tests/catalog.test.cjs`. Expected: `TEST_FAILED` on the first thing missing (`relation "suppliers" does not exist`).

### Task 2: the migration

- [ ] Check the first free migration number. Write the migration as described above.
- [ ] `node db/migrate.cjs`, then the suite. Expected: every line `PASS`, last line `CATALOG PASS`.
- [ ] Add `'suppliers','barcode_counters'` to `CHILD_FIRST` in `db/tests/require-dev.cjs` (beside `'stock_levels'`), and `"suppliers", "item_variants"` to `TABLES` in the backup export route.
- [ ] Run, one at a time: `stock-engine`, `stock-sales`, `stock-locks`, `pos-operations`, `offline-price`, `item-price`, `isolation`, `pull-pages`. Expected: all pass (they insert items and variants, and one of them reads the pull).
- [ ] Commit the migration, the suite and the two list changes.

### Task 3: Suppliers page

- [ ] `web/app/backoffice/suppliers/page.tsx` (starts with `onlyFor("retail")`) and `table.tsx`, built on `table-kit` like Customers: an add form above the list; a row opens to edit name, contact person, phone, email, address, note, or to remove (a soft delete). Each row shows how many products name it. Actions go through `act("items.edit", …)`.
- [ ] `nav.ts`: in the group `menu`, after Discounts, `{ href: "/backoffice/suppliers", label: "Suppliers", only: "retail", icon: Truck, words: "vendors wholesalers contacts" }` (import `Truck` from lucide-react). `counts/route.ts`: count live suppliers and `put` it.
- [ ] Type-check. Commit (for `nav.ts`, only this plan's lines).

### Task 4: a shop's product, full page

- [ ] `web/app/backoffice/items/[id]/page.tsx` (`onlyFor("retail")`; `id` is a uuid or `new`) and `product-form.tsx` (client: the margin as you type; option chips). Layout as the approved board: **General** (name, category, brand), **Price** (cost, selling price, tax, margin shown), **Stock** (supplier, supplier's code, reorder level, usual order quantity, "Counted in stock" ticked for a new product), then **Variants** (each option with its values and a field to add one; the lines with barcode, SKU, price, cost and on hand; Remove on a line; "Make barcodes for the lines that have none"). No add-ons section.
- [ ] Actions, each `act("items.edit", …)`: save the product (insert or update `items`, its one tax, `stock_set_reorder` for the first shop); add option values (`variants_generate`); save the lines (barcode, SKU, price, cost per variant); remove a line (`variant_archive`); make barcodes (`assign_barcodes`); remove the product (soft delete, refused while any of its levels is not zero). `barcode-taken`, `sku-taken`, `has-stock`, `bad-options`, `too-many-variants` become sentences an owner can act on (`Refused`).
- [ ] Type-check. Commit.

### Task 5: the list and the search, for a shop

- [ ] `items/page.tsx` and `table.tsx`: pass `mode`. For a shop: a product's name and "Add" go to `/backoffice/items/<id>` and `/backoffice/items/new` (no panel); columns Cost and Margin; "8 variants" under the name; the search text of a row includes its variants' SKUs and barcodes; no Add-ons column.
- [ ] `search/route.ts`: for a shop, no tables; products are also found by a variant's SKU or barcode; a product hit opens its page. `search-box.tsx`: the group's label is Products for a shop.
- [ ] Type-check, build (output to a file). Commit.

### Task 6: see it

- [ ] Every suite, one at a time (the loop in the foundation plan, plus `stock-locks` and `catalog`).
- [ ] The menu for a shop from a temporary page (as in the foundation plan): Suppliers is in Catalog; a restaurant's menu is unchanged. Delete the page.
- [ ] Tell the user what was run and what is theirs to open signed in: Suppliers; a new product with sizes and colours; a second colour added later; a barcode typed twice; "Make barcodes"; the list's cost and margin.
