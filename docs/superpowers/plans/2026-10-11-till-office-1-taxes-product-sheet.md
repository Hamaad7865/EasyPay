# Setting up on the tablet, build 1: taxes and the fuller product sheet

> Lean plan, one session, no subagents (the owner's rule). Design:
> `docs/superpowers/specs/2026-10-11-till-setup-design.md`, section 4, build 1.

**Goal:** a till can add and change taxes, and its product sheet carries what the back office's
does: the product's tax, and for a shop its cost, SKU, brand, supplier and supplier's code, reorder
level and order quantity.

**How:** one new waited change (`tax.save`) and a grown one (`item.save`), both through
`ServiceRepository.ask`. The rules are the back office's (`taxes/page.tsx`, `saveProductRow`,
`setItemTax`, `stock_set_reorder`). Example payloads in `db/tests/fixtures/till-office/` are read by
the server's suite and by the Kotlin tests.

## The two changes

`tax.save` (needs `items.edit`, or `approved_by` who has it):

```json
{ "id": "tax-1", "name": "VAT", "rate_bp": 1500, "type": "included", "is_default": true }
```

- `name` trimmed, 30 at most, `name-required` when empty, `name-taken` when another tax of the
  client is called the same (any case, removed ones too: the table's own rule is on the name).
- `rate_bp` 0 to 10000, else `bad-rate`. `type` is `included` or `added`, else `bad-payload`.
- `is_default` true: it becomes the usual one and the others stop being it. False or missing: left
  as it is (a new one is not the usual one).
- Safe to repeat: a lock on the id, then insert or update by id. Answer `{tax_id, created}`.

`item.save` grows. Every key below is optional; a till that sends none changes nothing of these:

```json
{ "tax_id": "tax-1", "sku": "POLO-01", "cost": 17000, "brand": "Maison",
  "supplier_id": "supplier-1", "supplier_code": "M-POLO",
  "store_id": "store-1", "reorder_point": 3000, "reorder_qty": 12000 }
```

- `tax_id`: a live tax of the client, else `bad-tax`; the item's other taxes are taken off (one tax
  per item). Empty or missing: an item being changed keeps its tax, a new one gets the usual one.
- `sku`, `brand`, `supplier_code`: present means set, empty means none. `sku-taken` is the table's.
- `supplier_id`: empty means none; else a live supplier of the client, else `unknown-supplier`.
- `cost`: cents, 0 or more, JSON null means none. **Written only if `may(emp, p, 'costs.view')`**;
  otherwise ignored, never an error.
- `reorder_point`, `reorder_qty`: thousandths, 0 or more, JSON null means none, else
  `bad-quantity`. When either key is there `store_id` must be a store of the client (`bad-store`),
  and both are saved through `stock_set_reorder` (a key that is missing counts as none).

## Task 1: the server

- [x] `db/tests/fixtures/till-office/tax-save.json`, `item-save-full.json` (`{type, payload}` with
  the stand-ins `tax-1`, `item-1`, `category-1`, `supplier-1`, `store-1`).
- [x] `db/tests/till-office.test.cjs`, on the pattern of `till-stock.test.cjs` (a shop, a
  restaurant, another client; owner, an editor with `items.edit` only, a cashier). Checks:
  - T: a tax added from the fixture; the same again changes nothing and makes no second row; rate
    and name changed; `bad-rate`; `name-required`; `name-taken`; a cashier `forbidden`; a cashier
    with the owner's word done, the approval written; made the usual one, the other stops being it;
    `is_default` false leaves the usual one; another client's tax id is `conflict` and theirs is
    untouched; a pull carries the tax.
  - I: the fixture on a new product (every field landed, the level's reorder set in that store);
    an old-shape `item.save` afterwards changes none of them; `tax_id` moves the tax and leaves one
    live link; `bad-tax` (unknown, another client's); `unknown-supplier`; `bad-store`;
    `bad-quantity`; `sku-taken`; cost ignored for an editor without `costs.view` (the rest of the
    change is done), written with the word of someone who may; cost null clears; a new product
    with no `tax_id` gets the usual tax; a restaurant's item takes `tax_id`.
- [x] Run it: every check fails for want of the change (`unknown-op`).
- [x] `db/migrations/0094_till_office_taxes.sql`, made by a script in the scratchpad from the
  **live** `push_item_save` and `sync_push` (`node db/scripts/dump-function.cjs`), after looking at
  what the other session committed. New: `push_tax_save`. `sync_push`: the line
  `when 'tax.save'`, the codes `bad-rate`, `bad-tax`.
- [x] `node db/migrate.cjs` on dev (after `require-dev`), the suite passes, and so do
  `item-ops`, `open-price`, `till-categories-stock`, `till-stock`, `till-setup`, `catalog`.
- [x] Commit.

## Task 2: the tablet's rules

- [x] Database 17: `items.supplier_code` (`Entities.kt`, `Migrations.V16_V17`, `TillDatabase`,
  `AppModule`, `PullApplier`). Look at the other session's version first.
- [x] `core/data/TaxForm.kt`: `Tax(name, rateBp, added, usual)`, `read(name, rate, added, usual)`
  ("15", "12.5", "7,25"; 0 to 100), `rate(bp)`, `says(tax)`, `refused(code)`.
- [x] `core/data/ItemForm.kt`: `Typed` (what the More page holds, as text) and `More` (read):
  tax, cost with whether it was shown, SKU (60), brand (60), supplier, supplier's code (60), reorder
  level and order quantity as `StockForm.units` reads a quantity, empty meaning none; `refused`
  gains `bad-tax`, `unknown-supplier`, `bad-store`, `bad-quantity`.
- [x] `core/data/OfficePayloads.kt`: `taxSave`, `itemSave` (the keys `saveItem` writes today, and
  the More keys when given; cost only when shown). `ServiceRepository.saveItem` builds through it
  and takes `more`; `saveTax`; `itemMore(itemId)`: the taxes, the item's own, the suppliers, the
  level's reorder figures, whether cost may be seen.
- [x] Tests: `TaxFormTest`, `ItemFormMoreTest`, `OfficePayloadsTest` (the two fixtures, stand-ins
  swapped, compared key by key).
- [x] Commit.

## Task 3: the screens

- [x] `feature/settings/TaxesPage.kt` with `TaxesViewModel`: the list (name, rate and way, "Usual",
  how many products carry it), "Add a tax", the sheet. `SettingsScreen.kt`: `Page.Taxes`, its icon,
  its route, and the parts the new file needs made `internal`.
- [x] `feature/menu/ItemSheet.kt`: two pages, "Basics" and "More". More: the tax as chips; for a
  shop the cost (when it may be seen), SKU, brand, the supplier as chips with "None", the
  supplier's code, reorder level and order quantity. `ItemEditor` loads `itemMore` when a sheet
  opens and sends `Typed` with the save, also through an approval. The last line of the sheet says
  what is still the back office's (variants; add-ons).
- [x] The made-up shop and restaurant get a second tax (`demo-shop.json`, `DemoReceiver`).
- [x] Help: "Taxes" in both lists; "A product's tax, cost and supplier" in a shop's.
- [x] `gradlew --priority low --max-workers 2 testDebugUnitTest assembleDebug`. Commit.

## Task 4: run it, with the owner watching

- [x] Say what is about to run. An emulator **with its window**; `install -r`, never `pm clear`
  on one of theirs.
- [x] The made-up shop: Settings > Taxes (the list, the sheet, its refusals in words); a product's
  More page (every field, the cost hidden from the cashier); Save answers that it needs a
  connection. The same on the made-up restaurant (tax only).
- [x] A real save needs a till signed in to a dev client: the owner signs in; a tax added, a
  product's tax and supplier changed, both read back from the dev database.
- [x] Database 16 to 17 with data on it.
- [x] Write the record below: what was seen, what was not.

## Record

Built 2026-10-11, commits `25c1029` (server), `3fa0f28` (rules), `cc65511` (screens), `9b2828b` and
`7750005` (what reading it again, and running it, put right). Not pushed. Production untouched.

**Tasks 1 to 3: done.** Migration 0094 is on the dev branch only. Suite `till-office`, 36 checks;
`item-ops`, `open-price`, `item-price`, `till-categories-stock`, `till-setup`, `catalog` and
`till-stock` pass after it. The till's database is 17. 436 unit tests pass.

**Two faults found on reading the screens again, before any tablet ran them** (`9b2828b`):

- An item being changed that carried no tax opened with the usual tax lit, so a save of its name
  would have put that tax on it. Only a new item starts on the usual tax now.
- Every save of a shop's product sent its brand, supplier, code, SKU and reorder figures from the
  tablet's own copy, which may be older than the server's. Of an item being changed, only what the
  person changed on the second page is sent.

**Task 4, the run.** On my emulator `easypay_claude_own`, **with its window open**, said in the
conversation before it started. Nothing shows whether the owner was watching: it was the middle of the
night, and the emulator's window closed by itself once (a display error of the emulator, not of the
app) and was opened again.

Seen:

- The new build installed over the made-up restaurant left from the reports' run, with its unsent
  changes and its open day: the database went from 16 to 17 and everything was there.
- Settings > Taxes: the list (VAT, usual, "on 13 items"; on the shop three taxes), the sheet for a
  new tax, "Give the tax a name", and with a name typed and the keyboard up a rate of 150 answered
  "The rate is a percentage between 0 and 100", above the keyboard. (That last one was seen only
  after the fix below: before it the answer was drawn where nobody could read it.)
- A restaurant's item: two pages, the second its tax.
- The made-up shop (my emulator cleared and filled again, said first): three taxes; a product's
  second page with its cost, SKU, brand, supplier, and the three fields under them; a product with
  variants with no SKU and no cost and the line that says why; the cashier with no cost, asked for a
  manager's PIN at Save.
- Both pages on a screen 686 dp high (set on the same emulator, and put back).
- Save on the made-up business: "This tablet has to be signed in again before anything can be
  changed from it." It has no server behind it.

What the run showed, and what was changed for it (`7750005`):

- The row of pages had pushed Remove, Cancel and Save off the foot of the item sheet. The first page
  is tightened and fits again.
- The tax sheet's keys sat under the keyboard. It is shorter, and they stay above both keyboards.
- A refusal said while a sheet was open was drawn behind the sheet, and with the keyboard up behind
  the keyboard too, so it was never seen. A sheet now draws what the till says over itself, and a
  sheet that is typed into ends where the keyboard begins. **This is in the shared `Sheet` and
  touches all ten sheets that are typed into**, most of them in screens already released; six were
  looked at with the keyboard up (the item's, the tax's, a supplier's, whose lowest field could not
  be typed into before and now can, a category's, the stock sheet and the note on a sale). What the
  till says covers the sheet's Cancel key for the three seconds it shows.

**Seen on a signed-in till, by the owner (2026-10-11, 02:40 to 02:45).** They signed the same emulator in
to their dev client Hamaad Retail and tried it themselves; I kept my hands off it and read the dev
database. Every change was applied:

- 02:41 a new product from the sheet, with its cost on the second page (`item.save`): Rs 200, cost
  Rs 100, on the usual tax.
- 02:43 a tax added, "Test", 10 %, added on top (`tax.save`).
- 02:44 that product moved onto the new tax: one tax on it afterwards, VAT taken off.
- 02:44 the new tax made the usual one: VAT stopped being it, one usual tax in all.
- 02:45 the product sold: receipt S1-T2-000001, Rs 200 and Rs 20 of tax, Rs 220, and **one** tax on
  its line (Test, 10 %, added). The till had the moved tax by then, so the pull after the save
  dropped the old link.
- The owner: "I tested and everything seems good so far".

Their dev client is left with "Test" as its usual tax; that is theirs to put back.

**Not seen by anyone:**

- An existing product's SKU, brand, supplier, supplier's code or reorder figures changed from a
  signed-in till (the client has no supplier). The server's suite and the payload tests cover them.
- The first-run set-up's menu step, which opens the same sheet.
- The other four typed-into sheets with the keyboard up (the label designer's, the label printer's,
  the two of the set-up's staff step).
- A real tablet.

**Left for build 2 or later:** the last line of the sheet still says variants and add-ons are the
back office's. Reorder figures show the first variant's for a product with variants, and a save of
them sets every variant's, as the back office does.
