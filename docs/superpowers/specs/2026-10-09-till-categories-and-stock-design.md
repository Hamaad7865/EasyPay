# Categories and stock from the tablet: design

Asked 2026-10-09: "in the apk, we should be able to add category with its color picker and also add or
remove stock. Lets plan it and the release this feature". The owner's answers are quoted where they decide
something.

## What exists

- Items are made, changed and removed on the tablet since 0.5.0 (`item.save`, `item.remove`, migration
  0084; `feature/menu/ItemSheet.kt`), for restaurants (`MenuStock.kt`) and shops (`retail/Products.kt`).
- Categories are the back office's only (`web/app/backoffice/categories/page.tsx`): name, colour, order,
  printers, "stock is counted". The till already holds `categories.color` and paints with it.
- Stock is read on the tablet (`stock_levels` is pulled for every client, shop or restaurant) and changed
  only in the back office: `stock_adjust()` (0073) for a shop, `stock_move(..., 'adjust')` for a
  restaurant.
- Quantities are thousandths everywhere (`stock_levels.qty`, `items.stock_qty`, the till's `LinePrice`).

## 1. Categories

Owner: "Add, change and remove". Printers, "stock is counted" and the order stay in the back office.

**Screens.** A **Categories** key in the head of the restaurant's Menu and of the shop's Products & stock.
It opens a sheet listing the categories (colour dot, name, how many items) with **New category**. Tapping
one opens the category's sheet: name, the swatches, and **Remove** on an existing one. The shop's category
chips gain the colour dot the restaurant's have.

**Colour.** Owner: "A set of swatches". Twelve, plus "No colour": the eight of `CAT_COLORS` in
`MenuStock.kt` and four more that read on the tiles in light and dark. `CAT_COLORS` moves to one shared
place so the swatches and the fallback colours cannot differ. A colour from the back office that is not
among the twelve is shown as a thirteenth, selected, and is kept unless another is tapped.

**Server, migration 0087.**

- `category.save {id, name, color, approved_by?}`: makes a category or changes one. On a change it writes
  `name` and `color` and nothing else: `printer_ids`, `is_stock` and `sort_order` are never touched. A new
  one takes `sort_order` = the client's highest + 1, as the back office gives it. `color` is `#rrggbb` or
  empty (the back office's `HEX` rule); anything else is `bad-payload`. Name trimmed, 1 to 60 characters
  (`name-required`).
- `category.remove {category_id, approved_by?}`: refused with `has-items` while live items are in it, as
  the back office refuses. Removed already is removed.
- Right: `items.edit`, own or the approver's (`may()`), as `item.save`.
- Refusals: `name-required`, `bad-category` (gone, or not this client's), `has-items`, `conflict` (the id
  is another client's), `forbidden`, `bad-payload`.

## 2. Stock

Owner: "with reason but make reason optional".

**Screens.**

- Shop: the product's sheet (`ProductSheet`) gains **Add stock** and **Remove stock** for a product with
  no variants, and a **Stock** key on each variant's row. Its line "Stock is changed in the back office"
  goes.
- Restaurant: the Menu list says "N left" under the name of a counted item; the item's sheet gains
  **Add stock** and **Remove stock** for a counted item.
- The stock sheet: Add or Remove, a quantity (up to three decimals, as the back office takes), what the
  store holds now and what it will hold, and reason chips, none of which need be picked:
  - Add: Delivery (`receive`), Found (`found`).
  - Remove: Damaged, Expired, Lost, Used here (`internal`), Returned to supplier (`supplier_return`).
  - None: `adjust`, which the Movements page already names.

**Counting switched on from the tablet.** Owner chose the switch over a line pointing at the back office.
The item's sheet gains **Count its stock** (`items.track_stock`). Under it, when it is being switched on:
"It will say Out on every till until stock is added." Not offered for an item whose price is typed at the
sale (a service has no stock: 0084's rule), and shown as on and fixed when the item's category counts
stock (`categories.is_stock`), since the item's own flag would change nothing. `item.save` takes an
optional `track_stock`; a till that does not send it (0.5.x) leaves the flag as it is, and a new item
without it is counted as 0084 decided.

**Server, migration 0087.** `stock.adjust {store_id, item_id, variant_id?, units, direction, reason?,
note?, approved_by?}`:

- `direction` is `in` or `out`; `units` is thousandths, above zero.
- `reason`, when given, must belong to the direction (the lists above); otherwise `bad-reason`. Not given,
  it is `adjust`.
- The store must be this client's (`unknown-store`); the till sends its own.
- The item must be counted (`not-counted`); a product with variants needs one (`pick-variant`), and the
  variant must be its own (`unknown-line`): 0073's rules.
- Taking out more than the line holds is refused (`not-enough-stock`), under the line's lock, for shops
  and restaurants alike.
- It moves through `stock_move()` with no cost, so the average cost stays as it is.
- Right: `stock.adjust`, own or the approver's. Every role with `items.edit` was given it (0073).

`sync_push` is regenerated from dev's live definition (it was last rewritten by 0085, not 0084) with the
three ops and their codes added. 0087 is taken only after checking no other session has taken it.

## 3. The till

- All three are asked online and waited for, as `item.save` is (`ServiceRepository.ask`, then `pullNow`):
  a queued category that the server later refused would take the items made in it down with it.
- `ServiceRepository`: `saveCategory`, `removeCategory`, `adjustStock`; `saveItem` sends `track_stock`.
- `core/data/CategoryForm.kt` and `core/data/StockForm.kt` read what the sheets hold and put the server's
  refusals in words, as `ItemForm` does, `unknown-op` among them ("The server has to be updated before...").
- `feature/menu/CategorySheet.kt` and `feature/menu/StockSheet.kt`, with their editors, used by both
  screens as `ItemSheet` is.
- Room does not change: `categories.color`, `items.track_stock` and `stock_levels` are there already.
- Help: an entry for categories and one for stock in `HELP` and in `SHOP_HELP`.

## 4. Tests

- `db/tests/till-categories-stock.test.cjs`, written first, one transaction rolled back: a category made,
  changed (its printers, `is_stock` and order as they were), removed, refused with items in it; a bad
  colour; a cashier refused and allowed with an approver; stock in and out with and without a reason; a
  reason of the wrong direction; the floor; a variant required; an item not counted; another client's
  store; `item.save` with and without `track_stock`.
- Unit tests written first for `CategoryForm` and `StockForm` (quantities as typed, into thousandths).
- The whole unit suite and `assembleDebug`.
- Seen on `easypay_claude_till` as the made-up shop and the made-up restaurant; never on the owner's
  emulator.

## 5. Release

Owner: "One release with the kitchen screen". Built and committed on `restopos`, applied to dev only.
It goes out as till 0.6.0 (versionCode 7) with the kitchen screen's remaining tasks, by one `v0.6.0` tag,
when the owner says to, after the Premium restaurants are set in `/admin` (0085). No tag is pushed before
that. That tag carries migrations 0085, 0086 and 0087.

## Left out

- A category's printers, order and "stock is counted" on the tablet.
- Making a category from inside the item's sheet.
- A cost for stock added on the tablet (a delivery with costs is the back office's purchase order).
- Counts, transfers and stock for another store.
