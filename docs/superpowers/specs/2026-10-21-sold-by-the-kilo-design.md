# Sold by the kilo, set by the shop itself

2026-10-21. Approved by the owner ("Yes go ahead, write the spec and build it").

## Why

A laundry client (an offline shop) prices its washing by the kilo. The till already
sells by the kilo: a product whose `items.sold_by` is `weight` asks "How heavy?" and
multiplies (`RetailViewModel.put`), its card says "/kg", its lines "0.350 kg", and
stock is kept in grams (thousandths, as every quantity). But nothing sets
`sold_by`: not the tablet's product sheet, not the back office, not the import.
Onboarding that client took a script run on production. The owner: "the client
should be able to do it themselves in the apk".

## The owner's answers

- Where: the tablet's product sheet, the back office's product page, and the import.
- The import says all three things a script had to: sold by (each, kilo, or a price
  typed at the sale) and whether the product counts stock.
- Switching each and kilo on a product that holds stock is refused.

## The rules (the same at every door)

A shop's product is sold one of three ways:

| Way | `sold_by` | `open_price` | price |
|---|---|---|---|
| Fixed price | `each` | false | the product's (or its variants') |
| By the kilo | `weight` | false | the price of a kilo (or each variant's) |
| At the sale | `each` | true | 0, typed at the till |

1. By the kilo and at the sale exclude each other. A product with variants can be by
   the kilo (each variant's price is its price a kilo); it cannot be at the sale (as
   today: `open-price-not-here`).
2. At the sale counts no stock (as today).
3. **Changing `each` to `weight` or back is refused while the product counts stock and
   holds any**: code `unit-has-stock`, "It holds stock: count it to zero first, or turn
   off Count its stock." "Counts stock" is judged as it will be after the save, so
   turning off counting and switching in one save is allowed. "Holds stock" is any
   `stock_levels` row of the product (any variant, any store) with `qty <> 0`, or
   `items.stock_qty <> 0`. Choosing at the sale keeps `sold_by` = `each`; from a
   `weight` product it is a switch, and allowed (at the sale counts no stock).
4. Restaurants: nothing changes. Their order screen has no weighing, so their sheet
   and editor do not offer it, and a restaurant's save never sends `sold_by`.

## The server (migration 0131)

`0128` is the loyalty work's and `0130` the customer display's (first numbered 0129). `0131_sold_by.sql`, built from the live definitions on dev:

- `item_holds_stock(p_tenant uuid, p_item uuid) returns boolean`: rule 3's "holds stock",
  one place for the till save, the import and the back office page.
- `push_item_save` (live = 0112): reads `sold_by` (`each` or `weight`; anything else
  `bad-payload`). Not sent: unchanged, so a tablet built before this is unaffected.
  - `weight` with `open_price` true: `open-price-not-here`.
  - A change of unit on an existing product: `unit-has-stock` under rule 3, where
    "counts stock after" is `coalesce(v_track, track_stock) and not v_open`.
  - A new product: `sold_by` as sent, `each` when not sent.
  - An existing `weight` product saved with `open_price` true AND `sold_by` = `each`
    in the same payload is allowed (the sheet's "At the sale" from "By the kilo");
    the existing refusal reads the unit after the save, not before.
- `catalog_import` (live = 0081): two optional keys on a row, `sold_by` (`each`,
  `weight`, `open`) and `count_stock` (boolean). Rows without them import exactly as
  today. New problem codes:
  - `bad-sold-by`: a value the browser did not turn into one of the three (defensive);
  - `price-missing` is no longer raised for an `open` row with no price;
  - `open-price-not-here`: `open` on a row with options, or on an existing product
    with variants;
  - `unit-has-stock`: rule 3 against an existing product;
  - `stock-not-counted`: an opening stock on a row that is `open` or `count_stock` no.
  A product takes `sold_by` and `count_stock` from its first row, as it does its
  category. New product: `sold_by` `weight` or `each`, `open_price` for `open`, price 0
  for `open`, `track_stock` = `open ? false : coalesce(count_stock, true)`. Existing
  product: unit and `open_price` changed only when the file says, `track_stock` only
  when it says or the row is `open`.

## The tablet

- `ItemForm.Item` gains `soldBy: String?` (`each`, `weight`, or null: not sent).
  `OfficePayloads.itemSave` sends it when not null. The sheet sends it for a new shop
  product always, and for a product being changed only when the way changed (as the
  second page sends only what changed: the tablet's copy may be older than the server's).
- `ItemForm.refused` words `unit-has-stock`; `open-price-not-here` keeps its words.
- `LocalAnswers` (`item.save`, offline tablets): the same rules over the tablet's rows,
  `levelsOfItem` for "holds stock"; writes `sold_by`. The queued change carries
  `sold_by`, so the server takes it the same at Premium.
- `ItemSheet` (shops): on Basics, the "Price typed at the sale" switch becomes a choice
  of three, **Fixed price · By the kilo · At the sale**; a product with variants is
  offered the first two. "Price" reads "Price a kilo" when by the kilo. At the sale
  hides the price and the stock switch as the switch does now. `ItemEdit.fixedPrice`
  (variants or weight) no longer hides anything for a shop: by the kilo is a choice
  on the sheet, and variants only remove "At the sale".
- Restaurants keep the switch.
- No Room change: `items.sold_by` is already on the tablet and in every pull.

## The back office (shops)

- The product page's Price card: the "Price typed at the till" checkbox becomes the same
  three-way choice (radio, `sold`), with "At the till" hidden for a product with variants.
  The selling price label reads "Price a kilo (Rs)" when by the kilo. The save writes
  `sold_by` and `open_price`, refusing as rule 3 (`item_holds_stock`) and as today.
- The import screen: two new kinds of column in `lib/catalog-rows.ts`:
  - "Sold by" (headers: soldby, sellby, unit, uom, unite, vendupar): each, piece,
    pieces, pc, pcs, unit, units, item → `each`; kilo, kilos, kg, kgs, kilogram,
    kilograms, weight, byweight, bythekilo, perkg, perkilo, aukilo, aupoids, poids →
    `weight`; atthesale, atthetill, typed, open, openprice, variable, adeterminer →
    `open` (cells compared as headers are: letters and digits, lower case, no accents).
    Anything else: `bad-sold-by`.
  - "Count stock" (headers: countstock, trackstock, countedinstock, stocked, counted,
    suivistock, gererstock): yes, y, true, 1, oui, o, x → true; no, n, false, 0, non →
    false; anything else `bad-count-stock`.
  - An `open` row whose price cell is empty or not a number is not `price-missing`.
  - The words of the new problem codes in `importer.tsx`.
- The export and its template gain "Sold by" (each, kilo, at the sale) and
  "Count stock" (yes, no), so a file exported and imported again keeps them.

## Not built

- Selling by the kilo on a restaurant's order screen.
- Scale barcodes (a weight printed in the barcode) and a scale on the tablet.
- The tablet's own import (products from a file on the tablet).
- Changing the unit of a product that holds stock with a conversion of its stock.

## Tests

- `db/tests/sold-by.test.cjs` (dev, its own clients, cleaned up): `push_item_save` with
  and without `sold_by`; `weight` + open refused; the unit switch refused with stock and
  allowed with counting off or after counting to zero; at the sale from by the kilo;
  `catalog_import` with each new key and problem code, rows without them as before.
- `web/lib/catalog-rows.test.mjs`: the two columns, their words, an `open` row with no
  price, the bad values.
- Tablet unit tests: `ItemForm` (the sheet's choice to `soldBy`, only sent when
  changed) and `LocalAnswersTest` (the same refusals as the server's suite).
- An offline tablet's queue with a product switched to by the kilo, replayed against
  dev (`replay-demo-outbox.cjs`).
- The sheet seen on an emulator; a kilo sale rung up.
- Sunwave's file with the two columns imported on dev: the script's result without it.

## Release

The tablet part is a till release (version raised, the owner's `v*` tag, which also
takes 0131 to production). Built in the worktree `claude/sold-by` beside the loyalty
work (which has uncommitted changes in `LocalAnswers.kt` and `OfficePayloads.kt` in the
main folder) and rebased on its commits before being merged.
