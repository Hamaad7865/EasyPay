# A shop's promotions: slow movers marked down, never below cost: design

2026-10-14. The owner: "also write the spec for promotion like kids corner does it". Kids Corner is their own
shop system, to be phased out; its Promotions module (`supabase/Migrations/20260820140000_promotions.sql`,
`20260825013000_promotion_manual_and_second_threshold.sql`, `app/(admin)/promotions/page.tsx`,
`components/promotions/*`) is the rule and the screen; this is that module in EasyPay's own stack, for a shop.

## 1. Purpose

A shop wants to clear stock that has stopped moving. A product that has not sold for a while is flagged; an
owner or manager marks it down, but never below what it cost, so a promotion can never turn a sale into a
loss. A promotion that still does not sell is flagged again to be reduced further. Lifting a promotion puts
the price back.

## 2. What a promotion is

**A real change to the selling price**, not a discount rule. The till sells at the price it is sent; a
promotion lowers that price and remembers the one before. That is Kids Corner's choice and it stays: the
discount engine EasyPay has (Discounts: percent or amount off a sale or a line, approved) is for the counter;
a promotion is a price the shop decided on in the back office, and it reaches every till the way any price
does, on the next pull, with nothing new for a till to learn. A till built before this sells the promotion
price without knowing it is one.

One promotion is per **variant** (a product with no variants is one variant for this purpose, as it is for
stock), because the never-loss floor is each variant's own cost, and two sizes of one product can cost
different amounts. The page groups them back by product.

## 3. The rules (Kids Corner's, kept)

1. **Never below cost.** `promo_price ≥ cost` of the variant, enforced in the one function that applies or
   reduces a promotion, on the server, and nowhere else. A variant with no cost known cannot be put on
   promotion: "Set a cost first" (Kids Corner has no such case: every variant has a cost; here `cost` is
   nullable).
2. **A real reduction.** `promo_price < selling price`; a reduction must be lower than the current promotion
   price. Raising a price is lifting, a different key with its own audit line.
3. **One live promotion per variant** (a partial unique index behind the function's own check).
4. **Lifting puts the original back, only if the price is still the promotion price.** If someone changed
   the price by hand during the promotion, that newer figure is the shop's latest word and is left alone;
   the promotion is marked lifted either way, and the page says whether the price was restored.
5. **Reducing again is not a second promotion.** The row keeps `original_price` (the true pre-promotion
   figure) and only `promo_price` moves, so lifting later puts the whole markdown back in one step and the
   till's "was" stays honest.
6. **Owner or manager only**, both to apply and to lift (`items.edit`, which those roles hold; a cashier with
   `items.edit` given by hand may too: the permission is the rule, as everywhere in EasyPay).
7. **Two thresholds, shop settings:** `slow_mover_days` (default 30): a product with stock, not on promotion,
   with no sale for that long is a slow mover; `promo_still_days` (default 14): a promotion with no sale for
   that long since it was applied (or since its last sale, whichever is later) is "still not selling".
   `settings.device` to change them (an owner, as Kids Corner has it).
8. **Detection is a query, not a job.** A product that has never sold counts from the day it was made, so a
   new arrival is not flagged the day it lands. Variants out of stock are left out (nothing to reprice on
   the shelf).
9. **The audit trail** says it in words: "put on promotion", "promotion reduced", "promotion lifted", each
   with before and after, as a price change is recorded today.

## 4. The server

Migration `promotions` (number taken when written):

- `promotions` (`id`, `tenant_id`, `variant_id`, `original_price`, `promo_price`, `status` `active` | `lifted`,
  `note`, `applied_by`, `applied_at`, `lifted_by`, `lifted_at`); checks `promo_price ≥ 0`,
  `promo_price ≤ original_price`; one `active` per variant.
- `promotion_apply(tenant, emp, variant, price, note)`, `promotion_reduce(…)`, `promotion_lift(tenant, emp,
  promotion)`, each under `for update` of the variant (apply) or the promotion (reduce, lift), with the
  refusals of section 3 in sentences; each writes the price through the same path a price change takes
  today (so `variants_follow_price`, the audit line and the till's pull are as for any price).
- `slow_movers(tenant, days)` and `stale_promotions(tenant, days)`: the two detections, as Kids Corner's,
  over EasyPay's tables (a product's variants and their stock levels across the shop's stores; the last
  completed sale of the variant from `receipt_lines`). `count_slow_movers(tenant, days)` for the menu's
  number.
- The two settings in `pos_settings.data` (`slowMoverDays`, `promoStillDays`), read by the page; a till is
  not sent them (it needs neither).
- `catalog_import` does not spare a promoted variant: an import that sets a price is a price change by
  hand, and rule 4 then leaves the promotion marked but not restored on lifting. The import's check says
  so before it runs: "N products on promotion will have their promotion price overwritten."

The Excel export says `original_price` in a column "Before promotion" for a variant on promotion.

## 5. The back office page

`/backoffice/promotions`, a shop's page in the Catalog group, with a count of slow movers beside its name
in the menu (as other counts are, `counts/route.ts`). Kids Corner's page, in EasyPay's own CSS:

1. **The two thresholds** at the top, each a sentence with the number editable in it: "Flag a product with no
   sale in the last [30] days." and "Flag a promotion still unsold after [14] days on promotion." Read-only,
   with the sentence saying who can change it, without `settings.device`.
2. **Slow movers** (count): Product (a link to its page) with its code, Category, Idle (N days), Stock, Price
   (a range when variants differ), and **Set promotion**, which opens the dialog. Empty: "Nothing has gone
   quiet: every product with stock has sold within the last 30 days."
3. **On promotion** (count): Item (product and its variant's label), Was (struck through), Now, Off, Applied
   (date and by whom), a tag "selling again" when it has sold since, and **Lift**. Empty: "No promotions are
   running. Put a product on promotion from the slow-mover list above, or from its page under Products."
4. **Still not selling** (count), only with `items.edit` and only when there are any: Item, Was, Now, Idle,
   Applied, **Reduce again** and **Lift**.
5. The foot: "A promotion changes the real selling price, so the till shows it on its next sync. Lifting it
   puts the price back."

**The dialog, Set promotion**: one row per live variant of the product: its label, "Cost Rs 120 · now Rs 350
· 4 in stock", and a price box seeded with the current price (so only what is to drop is edited). Under the
box, as the figure is typed: "Below cost (Rs 120): that would sell at a loss." (blocks), "Must be lower than
the current price to be a promotion." (blocks), or "Above cost, but below the Rs 138 that breaks even after
VAT: you keep less than it cost once VAT is paid." (a warning; `cost × (1 + rate)` at the variant's tax rate
as the shop charges it now, or no warning when the shop charges no VAT). Apply is on when at least one row is
a valid markdown and none is blocked; rows left at their current price are not touched.

**Reduce again**: the same dialog for one variant, floored at cost, must be lower than the promotion price,
showing Was, Now and the new figure.

**On a product's page** (`/backoffice/items/<id>`): each variant on promotion shows Was struck through beside
Now with a tag; a key **Promotion** on the page opens Set promotion for the product (a manual promotion, not
only from the slow-mover list: Kids Corner's second migration). **Lift** beside a promoted variant.

**The products list**: a promoted product shows its price in the promotion colour with the old price struck
through, as Kids Corner's till tiles do.

## 6. The till

Nothing to build to sell at the price. Two small things, so the counter sees what the shop decided:

- A product card on Sell for a variant on promotion shows the old price struck through above the price, in
  the promotion colour, as Kids Corner's tile does. For this the pull sends `promo_was` on a variant (null
  when none): one column on the tablet's variant table (the tablet's database goes up one).
- The receipt does not print "was Rs 350" under a promoted line: it shows what was charged, as Kids
  Corner's receipt does.

**On the tablet too, online and offline** (the owner: "both should be available offline and online").
Under Products & stock a tab **Promotions** with the same three lists (Slow movers, On promotion, Still not
selling), the two thresholds, Set promotion (one row per variant with the cost, the current price, the stock
and the price box, the same three sentences under it), Reduce again and Lift. The right is `items.edit`,
asked as the tablet asks it for a price change. The rules of section 3 are one module,
`core/data/Promotions` (apply, reduce, lift, the two detections over the tablet's own tables), with the
never-loss floor in it; the screen asks it and shows its sentences. A connected tablet sends
`promotion.apply`, `promotion.reduce` and `promotion.lift` as push operations, which the server answers with
the same functions (section 4), and takes the result with the pull (`promotions` rows and `promo_was`); a
tablet that works on its own answers them itself and keeps the rows, as it does a price change. The two
thresholds are in the tablet's settings (`pos_settings.data`, sent with the settings pull; the offline
edition keeps them on the tablet). The slow-mover detection on the tablet uses the sales the tablet holds
(its own receipts and the shop's receipts of the last 30 days it is sent), so on a connected tablet with
several tills the back office's list is the whole shop's and the tablet's is "as this tablet knows it"; the
tab says so in one line. The offline edition has one tablet, so there they agree.

## 7. Testing

- Suite `promotions` on dev: apply (below cost refused, not lower refused, no cost refused, a second active
  refused, the price moved and the audit line written, the till's pull carries the price and `promo_was`);
  reduce (floor, must be lower, `original_price` untouched); lift (restored when the price is still the
  promotion price, left when changed by hand, the row lifted either way); `slow_movers` (never-sold counts
  from creation, out-of-stock left out, on-promotion left out, the day it turns); `stale_promotions`
  (from applied or last sale); a cashier refused; `catalog_import`'s warning line.
- `shop-pages` opens the page in its three states, the product page with a promoted variant, and the list.
- Unit tests on the till for the card's "was" line.
- Seen in a browser on dev with the test shop; the card seen on the test emulator.

## 8. Decisions this design took, for the owner to confirm or overrule

1. The tablet's slow-mover list is "as this tablet knows it" (its own sales and the 30 days it is sent),
   not a question to the server. Alternative: a connected tablet asks the server for the list each time the
   tab opens, exact but blank with no signal. Both say the same thing on a one-till shop.
2. `items.edit` is the right, not "owner or manager" by name: EasyPay's roles are what the shop makes them.
3. A variant with no cost cannot be promoted (Kids Corner never meets the case).
4. An import that overwrites a promotion's price is allowed and warned about, not refused.
5. The slow-mover count sits beside Promotions in the menu, so the owner sees it without opening the page.
6. The till shows "was" on the card; the receipt does not.

## 9. Not in this build

- A promotion by category or by percentage across many products at once (Kids Corner has neither; the
  dialog is per product, every variant typed).
- A promotion with an end date that lifts itself (Kids Corner has none; the "still not selling" list is the
  reminder).
- A restaurant's promotions (a dish has no cost yet).
- Labels reprinted for the new price: the label designer prints what the product's price is; nothing new.
