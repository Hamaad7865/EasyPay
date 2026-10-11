# Setting up on the tablet, build 2: variants (shops) and add-ons (restaurants)

> Lean plan, one session, no subagents (the owner's rule). Design:
> `docs/superpowers/specs/2026-10-11-till-setup-design.md`, section 4, build 2.

**Goal:** a shop's till gives a product its variants and keeps their codes; a restaurant's till makes
its add-on groups and says which items carry them.

**How:** six new waited changes and one grown, through `ServiceRepository.ask`, each wrapping what
the back office does (`variants_generate`, `saveVariantLines`, `variant_archive`, `assign_barcodes`,
the Add-ons page's statements, the item panel's group links). Example payloads in
`db/tests/fixtures/till-office/`, read by the server's suite and by the Kotlin tests.

**Where on the tablet** (changed from the design, which said a third page of the product sheet: the
shop's product panel already lists a product's variants with their price and stock, so they are
changed there):

- **Shop, the product panel:** a key **Variants** opens the options sheet (up to three options and
  their values, comma apart; what is there already is shown and kept; "Make the variants"; "Make
  barcodes"). Each variant's row gets **Codes**: its barcode, SKU and cost (cost for whoever may see
  it), and Remove. A variant's price stays where it is, behind its Price key, so that a change of
  price is still written down as one.
- **Restaurant, the Menu screen:** a key **Add-ons** lists the groups; a group's sheet has its name,
  the fewest and the most that may be picked (most 0: any number), and its choices with prices. The
  group is saved whole. An item's second page, now "Tax and add-ons", ticks the groups it carries.

## The changes (all `items.edit`, or `approved_by` who has it)

| Change | Payload | Notes |
|---|---|---|
| `variants.make` | `item_id`, `names` (1 to 3), `values` (a list for each name) | `variants_generate`, then `barcodes_auto`. Answer `created`, `existing`, `barcodes`. Sent again it makes nothing more. Refusals: `unknown-item`, `bad-options`, `too-many-variants`, `has-stock` |
| `variants.save` | `item_id`, `lines`: `id`, `barcode`, `sku`, and `cost` when it was shown | no price here. `cost` written only with `costs.view`. Refusals: `unknown-variant`, `barcode-taken`, `sku-taken` |
| `variant.remove` | `variant_id` | `variant_archive`; one already removed answers done. `has-stock`, `unknown-variant` |
| `barcodes.make` | `item_id` | `assign_barcodes`. Answer `made` |
| `addon.save` | `id`, `name` (40), `min`, `max` (0 to 20), `choices`: `id`, `name` (40), `price` | upsert by id under a lock; a choice not listed is removed. `name-required`, `name-taken`, `bad-limits`, `too-many` (50 choices), `bad-group` (a removed one) |
| `addon.remove` | `group_id` | as the back office: off its items, its choices removed, renamed. One already removed answers done |
| `item.save` grows | `groups`: the ids of the groups the item carries | each a live group, else `bad-group`; the others are taken off. Not sent, nothing changes |

New refusal codes: `bad-options`, `too-many-variants`, `has-stock`, `bad-limits`, `bad-group`.

## Task 1: the server

- [ ] Fixtures: `variants-make`, `variants-save`, `variant-remove`, `barcodes-make`, `addon-save`,
  `addon-remove`, `item-save-groups`.
- [ ] `db/tests/till-office.test.cjs` grows two sections: V (variants: made, made again, a value
  added later, the product with stock of its own refused, codes saved, cost only for who may, a
  barcode another line has, removed, removed twice, with stock refused, barcodes made, a cashier
  refused, another client's product) and A (a group made with its choices, sent again, a choice
  dropped and one added, limits, names, removed, removed twice, an item's groups set, changed,
  emptied, a removed group refused, a pull carrying groups, choices and links).
- [ ] `db/migrations/0095_till_office_variants_addons.sql` from the live `push_item_save` and
  `sync_push`, after looking at what the other session committed. Apply to dev; the suite and its
  neighbours pass. Commit.

## Task 2: the tablet's rules

- [ ] `core/data/VariantForm.kt` (options as typed read into names and values, with what the product
  has kept; a line's codes; refusals in words), `core/data/AddonForm.kt` (a group and its choices
  read; limits; refusals). `OfficePayloads` grows; `ItemForm.Typed/More` take the groups (sent only
  when changed). `ServiceRepository`: `makeVariants`, `saveVariant`, `removeVariant`,
  `makeBarcodes`, `saveAddon`, `removeAddon`; `itemMore` reads the groups and the item's own.
- [ ] Tests against the fixtures. Commit.

## Task 3: the screens

- [ ] `feature/retail/Variants.kt`: the options sheet and the codes sheet; `Products.kt`: the two
  keys and their state.
- [ ] `feature/menu/Addons.kt`: the list and a group's sheet; `MenuStock.kt`: the key;
  `ItemSheet.kt`: the ticks on the second page.
- [ ] Help: the entries that said these are the back office's. The made-up restaurant gets two
  add-on groups if it has none.
- [ ] Unit tests and the debug build. Commit.

## Task 4: run it, with the owner watching

- [ ] Say what is about to run; the emulator with its window; never tap while the owner is using it.
- [ ] The made-up shop and restaurant for the screens; a till signed in to a dev client for the
  saves, read back from the dev database.
- [ ] The record below.

## Record

Built the night of 2026-10-11, **not as this plan lays it out**: the owner asked that night for the
tablet standing alone, so this was built on that (`docs/superpowers/specs/2026-10-11-tablet-alone-design.md`,
sections 6 and 7 carry the record). What differs from the plan above:

- The migrations are **0096** (add-ons, an item's groups, and `settings.save`) and **0097**
  (variants), not 0095, which went to roles, staff and discounts.
- `variants.make` carries the lines with the tablet's own ids (`lines: [{id, values}]`), not `values`
  per option: a tablet alone needs the ids before the server has them.
- `variants.save` has no price, as planned; `barcodes.make` was **not built**.
- Each change is also answered on a tablet that works on its own (`LocalAnswers`).
