# Sold by the kilo: build plan

> Spec: `docs/superpowers/specs/2026-10-21-sold-by-the-kilo-design.md`. Built inline in one
> session (the owner is cost-sensitive: no subagents), in the worktree `claude/sold-by`.

**Goal:** a shop sets "by the kilo" itself, on the tablet, on the back office's product page
and in the import file; the import also says "at the sale" and "count stock".

**Architecture:** one rule set, written where each door already saves a product:
`push_item_save` and `catalog_import` (migration 0131, with `item_holds_stock` shared),
`LocalAnswers.itemSave` for an offline tablet, and the back office's `saveProduct`. The
tablet's sheet and the back office page get a three-way choice; the import's browser
parser turns two new kinds of column into `sold_by` and `count_stock`.

**Tech:** Postgres (Neon dev), Next.js server actions, Kotlin/Compose, Room (no change).

---

### Task 1: the server (migration 0131) and its suite

**Files:**
- Create: `db/migrations/0131_sold_by.sql` (from the live `push_item_save`, = 0112, and
  `catalog_import`, = 0081; dumped with `node db/scripts/dump-function.cjs`)
- Create: `db/tests/sold-by.test.cjs` (pattern of `catalog-import.test.cjs`: one
  transaction, rolled back; `WITH_MIGRATION=db/migrations/0131_sold_by.sql` applies it
  inside the transaction first)

- [ ] Write the suite. Cases, each a `check`:
  - S1 a new product saved with `sold_by: weight` is `weight`; without the key, `each`.
  - S2 an existing product saved without `sold_by` keeps it (an old tablet).
  - S3 `weight` with `open_price: true` → `open-price-not-here`; `sold_by: each` +
    `open_price: true` on a `weight` product → done, `open_price`, `each`, no stock.
  - S4 a counted product holding 5 → switch refused `unit-has-stock`; with
    `track_stock: false` in the same save → done; counted at 0 → done.
  - S5 `sold_by: litre` → `bad-payload`.
  - S6 import: `{sold_by: weight}` new product is weight, counted; `{sold_by: open}` with
    no price → open, price 0, not counted; `{count_stock: false}` → not counted; a row
    without the keys as before (counted, each).
  - S7 import problems: `open` + options → `open-price-not-here`; `open` with stock →
    `stock-not-counted`; `count_stock: false` with stock → `stock-not-counted`; `weight` on
    an existing counted product holding stock → `unit-has-stock`; `sold_by: x` →
    `bad-sold-by`; `open` with price null is not `price-missing`.
  - S8 import changes an existing product's unit and stock counting only when the row says.
- [ ] Run `WITH_MIGRATION=db/migrations/0131_sold_by.sql node db/tests/sold-by.test.cjs`
  before writing the migration: it fails (file missing).
- [ ] Write 0131:
  - `create or replace function item_holds_stock(p_tenant uuid, p_item uuid) returns boolean`
    `language sql stable`: `exists (select 1 from stock_levels where tenant_id = p_tenant
    and item_id = p_item and qty <> 0) or exists (select 1 from items where tenant_id =
    p_tenant and id = p_item and coalesce(stock_qty, 0) <> 0)`.
  - `push_item_save`: `v_sold text := nullif(btrim(p->>'sold_by'), '')`; not in
    (`each`,`weight`) → `bad-payload`. Existing product: `v_unit := coalesce(v_sold,
    v_was.sold_by)`; the open-price refusal reads `v_unit = 'weight'`; if `v_unit <>
    v_was.sold_by and coalesce(v_track, v_was.track_stock) and not v_open and
    item_holds_stock(p_tenant, v_id)` → `unit-has-stock`; the update sets `sold_by =
    v_unit`. New product: `weight` + open → `open-price-not-here`; insert `sold_by =
    coalesce(v_sold, 'each')`. (`v_was` selects `track_stock` too.)
  - `catalog_import`: `_imp` gets `sold_by` and `count_stock` (`(x.r->>'count_stock')::boolean`);
    the checks listed in the spec; the product loop takes both from the first row; insert
    and update as the spec's table.
- [ ] Run the suite with `WITH_MIGRATION`: all PASS. Run `catalog-import`, `till-office`,
  `made-of` (as they are, after `node db/migrate.cjs` applies 0131 to dev): PASS.
- [ ] Commit.

### Task 2: the import on the web

**Files:** `web/lib/catalog-rows.ts`, `web/lib/catalog-rows.test.mjs`,
`web/app/backoffice/items/import/importer.tsx` (WHY), `web/app/backoffice/items/export/route.ts`.

- [ ] Tests first in `catalog-rows.test.mjs`: headers "Sold by" and "Count stock" map;
  "kg", "Kilo", "au kilo" → `weight`; "piece" → `each`; "A determiner", "at the sale" →
  `open`; "oui"/"no" → true/false; "litre" → `bad-sold-by`; "maybe" → `bad-count-stock`;
  an `open` row with "A DETERMINER" in its price cell has no `bad` and no `price`.
- [ ] `node web/lib/catalog-rows.test.mjs`: the new checks FAIL.
- [ ] `CatalogRow` gains `sold_by?: "each" | "weight" | "open"`, `count_stock?: boolean`;
  FIELDS gains the two kinds (after `stock`); the reader maps cells through `headerKey`
  and two word tables; after the row is read, `sold_by === "open"` clears a
  `price-missing` and drops `price`.
- [ ] Test passes. WHY gains `bad-sold-by`, `bad-count-stock`, `open-price-not-here`,
  `unit-has-stock`, `stock-not-counted`. The export writes "Sold by" (each, kilo, at the
  sale) and "Count stock" (yes, no) after "Opening stock"; the template's header too.
- [ ] `npx tsc --noEmit -p web` clean. Commit.

### Task 3: the back office's product page

**File:** `web/app/backoffice/items/[id]/page.tsx`.

- [ ] Price card: radio `sold` (Fixed price / By the kilo / Typed at the till; the last
  only without lines), replacing the checkbox. The price label says "a kilo" when by the
  kilo (`price-fields.tsx` takes a `label`).
- [ ] `saveProduct`: `sold` → `unit` (`weight` or `each`) and `open`; refusals: open with
  lines (as now); a unit change with counting on (as saved) and `item_holds_stock` →
  "It holds stock: count it to zero first, or untick Counted in stock."; the update writes
  `sold_by` and `open_price` together.
- [ ] Type-check; the page seen with the `web` preview on dev (signed in by the owner if
  available; otherwise rendered against a dev product through a scratch page) . Commit.

### Task 4: the tablet

**Files:** `core/data/ItemForm.kt`, `core/data/OfficePayloads.kt`,
`core/data/LocalAnswers.kt`, `feature/menu/ItemSheet.kt`, tests `ItemFormTest.kt`,
`LocalAnswersTest.kt`.

- [ ] Tests first: `LocalAnswersTest` cases S1–S5 of Task 1 over the fake DAO
  (`levels` for stock); `ItemFormTest`: the way read from the sheet's choice and sent
  only when changed for an existing product.
- [ ] `ItemForm`: `enum class Way { FIXED, KILO, AT_SALE }`; `Item.soldBy: String?`;
  `read(name, price, way, barcode, wasSoldBy)`; `refused("unit-has-stock")`.
- [ ] `OfficePayloads.itemSave`: `item.soldBy?.let { put("sold_by", it) }`.
- [ ] `LocalAnswers.itemSave`: the same rules (unit after, holds stock by `levelsOfItem`),
  writes `sold_by`.
- [ ] `ItemSheet`: shops get `Seg` Fixed price · By the kilo · At the sale (no At the sale
  with variants), "Price a kilo"; restaurants keep the switch. `ItemEditor.save` takes the
  way.
- [ ] `gradlew :app:testDebugUnitTest --priority low --max-workers 2`: PASS. Commit.

### Task 5: run it

- [ ] Build the debug APK; on my own emulator (see the emulator note: check the screen,
  say so first): a shop product switched to By the kilo, a sale of 3.5 kg, the refusal
  with stock, At the sale; the sheet at 1280 x 800.
- [ ] Offline queue replayed against dev (`read-till-state.cjs`, `replay-demo-outbox.cjs`).
- [ ] Sunwave's CSV with "Sold by" and "Count stock" through the import's own code and
  `catalog_import` on dev, rolled back: the same products as the script made.
- [ ] Record what was seen and not at the end of this file.

### Task 6: bring it home

- [ ] `git rebase restopos` (the loyalty work), build and unit tests again,
  `git -C C:/Projects/RestoPOS merge --ff-only claude/sold-by`.
- [ ] Version: raise `versionName`/`versionCode` past whatever `restopos` has then; the tag
  is the owner's.

---

## Record (2026-10-21)

**Built:** 0131 (`85c06c8`), the import's two columns and the export (`c71adc1`), the back
office product page (`1ab459e`), the tablet's sheet and offline answer (`7fcb409`).

**Run:**
- `sold-by.test.cjs` 32 checks PASS (first inside a rolled-back transaction with
  `WITH_MIGRATION`, then after `node db/migrate.cjs` applied 0131 to dev); `catalog-import`
  (25), `till-office` (119), `made-of` (25) PASS after it, one at a time.
- `catalog-rows.test.mjs`: PASS with four new checks. Web type-check clean.
- Unit tests: `ItemFormTest` 11, `LocalAnswersTest` 67, `OfficeFormsTest` 16, PASS.
- Sunwave's real price list with "Sold by" and "Count stock" filled in the owner's words
  ("Kg", "A déterminer" with A DETERMINER left in the price cells, "oui", "no"), through
  the import screen's own parser and `catalog_import` on dev, rolled back: 46 products,
  no problems, and exactly what the one-off script made (6 by the kilo at their price a
  kilo, 17 typed at the sale, 31 services not counted, 15 goods counted).

**Not run:**
- The sheet on an emulator, and a kilo sale on a tablet: the loyalty session was using
  emulator 5598 and shut it down for its own build; with about 0.5 GB of memory free no
  other emulator was started, and the owner wants to watch a test run. Selling by the
  kilo itself is older code (`RetailViewModel.put`).
- After the rebase on the loyalty work: the whole unit suite and the debug APK again.
- The back office page in a browser (needs a sign-in to a dev shop).
- An offline tablet's queue replayed against dev: covered by the same payloads in the
  server suite and `LocalAnswersTest`, not by a real tablet's outbox.
