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

- [ ] `db/tests/fixtures/till-office/tax-save.json`, `item-save-full.json` (`{type, payload}` with
  the stand-ins `tax-1`, `item-1`, `category-1`, `supplier-1`, `store-1`).
- [ ] `db/tests/till-office.test.cjs`, on the pattern of `till-stock.test.cjs` (a shop, a
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
- [ ] Run it: every check fails for want of the change (`unknown-op`).
- [ ] `db/migrations/0094_till_office_taxes.sql`, made by a script in the scratchpad from the
  **live** `push_item_save` and `sync_push` (`node db/scripts/dump-function.cjs`), after looking at
  what the other session committed. New: `push_tax_save`. `sync_push`: the line
  `when 'tax.save'`, the codes `bad-rate`, `bad-tax`.
- [ ] `node db/migrate.cjs` on dev (after `require-dev`), the suite passes, and so do
  `item-ops`, `open-price`, `till-categories-stock`, `till-stock`, `till-setup`, `catalog`.
- [ ] Commit.

## Task 2: the tablet's rules

- [ ] Database 17: `items.supplier_code` (`Entities.kt`, `Migrations.V16_V17`, `TillDatabase`,
  `AppModule`, `PullApplier`). Look at the other session's version first.
- [ ] `core/data/TaxForm.kt`: `Tax(name, rateBp, added, usual)`, `read(name, rate, added, usual)`
  ("15", "12.5", "7,25"; 0 to 100), `rate(bp)`, `says(tax)`, `refused(code)`.
- [ ] `core/data/ItemForm.kt`: `Typed` (what the More page holds, as text) and `More` (read):
  tax, cost with whether it was shown, SKU (60), brand (60), supplier, supplier's code (60), reorder
  level and order quantity as `StockForm.units` reads a quantity, empty meaning none; `refused`
  gains `bad-tax`, `unknown-supplier`, `bad-store`, `bad-quantity`.
- [ ] `core/data/OfficePayloads.kt`: `taxSave`, `itemSave` (the keys `saveItem` writes today, and
  the More keys when given; cost only when shown). `ServiceRepository.saveItem` builds through it
  and takes `more`; `saveTax`; `itemMore(itemId)`: the taxes, the item's own, the suppliers, the
  level's reorder figures, whether cost may be seen.
- [ ] Tests: `TaxFormTest`, `ItemFormMoreTest`, `OfficePayloadsTest` (the two fixtures, stand-ins
  swapped, compared key by key).
- [ ] Commit.

## Task 3: the screens

- [ ] `feature/settings/TaxesPage.kt` with `TaxesViewModel`: the list (name, rate and way, "Usual",
  how many products carry it), "Add a tax", the sheet. `SettingsScreen.kt`: `Page.Taxes`, its icon,
  its route, and the parts the new file needs made `internal`.
- [ ] `feature/menu/ItemSheet.kt`: two pages, "Basics" and "More". More: the tax as chips; for a
  shop the cost (when it may be seen), SKU, brand, the supplier as chips with "None", the
  supplier's code, reorder level and order quantity. `ItemEditor` loads `itemMore` when a sheet
  opens and sends `Typed` with the save, also through an approval. The last line of the sheet says
  what is still the back office's (variants; add-ons).
- [ ] The made-up shop and restaurant get a second tax (`demo-shop.json`, `DemoReceiver`).
- [ ] Help: "Taxes" in both lists; "A product's tax, cost and supplier" in a shop's.
- [ ] `gradlew --priority low --max-workers 2 testDebugUnitTest assembleDebug`. Commit.

## Task 4: run it, with the owner watching

- [ ] Say what is about to run. An emulator **with its window**; `install -r`, never `pm clear`
  on one of theirs.
- [ ] The made-up shop: Settings > Taxes (the list, the sheet, its refusals in words); a product's
  More page (every field, the cost hidden from the cashier); Save answers that it needs a
  connection. The same on the made-up restaurant (tax only).
- [ ] A real save needs a till signed in to a dev client: the owner signs in; a tax added, a
  product's tax and supplier changed, both read back from the dev database.
- [ ] Database 16 to 17 with data on it.
- [ ] Write the record below: what was seen, what was not.

## Record

(filled in when the build has run)
