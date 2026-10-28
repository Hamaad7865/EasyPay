# Add one variant, and pictures for products and their variants

2026-10-28. Asked by the owner while onboarding a shop: "Need a new way to simplify on how to add a new
variant and please add option to add picture for products and its variant, it should be reflected in the
android as well". Choices put to them and taken: variant first, then pictures; one line at a time; a
picture per colour; pictures kept in EasyPay's database. "please build all asap and I give you permission
to release".

## Why

A shop's product with Colour (40 values), Age (21) and Style (10) cannot be given one new line: the product
page's only way, Add values then Make the missing lines, makes every combination the product lacks, which
for one new colour is 210 lines and is refused over 200. Values typed again drift (Plain and plain, stripe
and stripes).

## Part 1: Add a variant (back office only)

- The Variants card of a product that has lines opens with **Add a variant**: a field for each option,
  suggesting the values the product already uses; Barcode, SKU, Price (the product's price when empty),
  Cost (for someone who may see cost), and Quantity in stock at the working branch (the one picked, or the
  account's only one; hidden with All branches of several). **Add this variant** makes that one line.
- The old form stays, folded, as **Make every combination**.
- `variant_add` (migration 0142) makes the line. A value typed that is already one of the option's values
  but for its case takes the spelling already used. Refused: `unknown-item`; `bad-options` (a product with
  no options, a value missing, empty or over 30 characters, more values than options); `variant-exists`
  (a line with those values, case aside); `too-many-variants` (200 lines); `barcode-taken`, `sku-taken`
  (the existing guard); `stock-not-counted` (a quantity for a product that counts none). The quantity is
  an opening stock movement at the branch named.
- A shop with automatic barcodes gives the new line one, as Make the missing lines does.
- Tablets get the line with their next pull (item_variants is pulled); no new till.

## Part 2: Pictures

- Kept in the database: table `pictures` (tenant, JPEG bytes, width, height), never pulled as rows.
  `items.picture_id` and `item_variants.picture_id` name the picture; they are pulled with their rows.
- The browser makes every picture a JPEG of at most 640 px on its long side before sending it (about
  40 KB), so the server keeps what the tablets draw.
- Back office: the product page has a Picture card for the product; under Variants a row of the first
  option's values (the colour), each with a picture: one put on Beige goes on every Beige line. A line can
  be given its own in the lines table. Remove takes it away.
- Served to the back office at `/backoffice/pictures/<id>` (the tenant's own only) and to tablets by the
  till API, by id, cached for good: a picture is never changed, a new one gets a new id.
- Tablet: the pull brings the ids; pictures not yet held are fetched once and kept in the till's database.
  A product's card shows its picture; the variant chooser shows each line's. A picture chosen on the tablet
  itself (today's, the tablet's own) still shows where the back office has set none; one set in the back
  office comes first.
- Released as till 0.9.32.
