# The public site: shops beside restaurants, and a till that plays

Asked by the owner on 2026-10-08: "We now offer retail, so can you update the
website? Can we make motion design as well like placing an order and showing
stuff etc like inkeep does", with a screenshot of inkeep.com's Product menu
open over its hero, where a conversation plays by itself.

## Decided by the owner

- **One page, a switch.** A Restaurant / Shop choice in the hero changes the
  tablet's film and the sections below it. `/#shop` opens the page for a shop.
- **Straight to the live site** once it is checked here.

## What changes

**The choice.** `<html data-for="restaurant|shop">`. Anything marked
`data-only="restaurant"` or `data-only="shop"` is shown for that one only. The
choice is made in the hero, by a link to a section that belongs to one of them,
by `#shop` in the address, and is remembered on the visitor's device.

**The bar.** "Product" opens a panel like inkeep's: a column "For restaurants"
(Front of house, Kitchen and bar, Payment) and a column "For shops" (Selling,
Stock, Returns). A link there sets the choice and goes to its section. Back
office and Questions stay as links. The phone menu lists the same two groups.

**The hero.** Headline and lead for each. One tablet, two tills: the
restaurant's four screens as today, and a shop's Sell and Receipts screens
drawn from `feature/retail/RetailSell.kt` (the sale down the left, a box to
scan or search into, categories, a tile for each product with what is left).

**The film.** The tablet plays a sale by itself, with a line under it saying
what is happening and a key for each chapter. A dot shows where a finger taps.

| | Restaurant | Shop |
|---|---|---|
| 1 | Seat: a free table is tapped and seats three | Scan: two barcodes are read, a tile is tapped twice; each tile's "left" goes down |
| 2 | Order: three dishes are tapped, the total builds | Discount: 10% on the sale, the total follows |
| 3 | Kitchen: Send; the ticket prints and is on the kitchen screen with its clock | Pay: cash given, the change shown; the receipt prints with a barcode at its foot |
| 4 | Pay: cash given, change shown, the receipt prints, the table is free | Return: the receipt's barcode is scanned, it opens, one line is refunded |

A chapter's key jumps to it; a Pause key stops the film (moving content that
lasts must be stoppable). It plays only while it is on screen and the tab is in
front. With "reduce motion" set, nothing moves: the tablet shows a finished
sale. On a phone, where half the tablet shows, the tablet slides to keep the
part that is moving in view.

**Smaller movement in the sections**, only while each is on screen: the
kitchen ticket's clock runs and a line is ticked; the last share of a split
bill is paid; a tile's "left" counts down; a line sweeps a receipt's barcode;
a size is picked on a product with variants.

**Sections.** Restaurants keep theirs. Shops get three of their own: Selling,
Stock, Returns. "Also on the till", the back office window and its four
columns, Getting started, Questions and Book a demo say the right thing for
each.

## What the page may say about shops

Only what a shop's till and back office do today, taken from the till's own
Help (`SHOP_HELP`) and the back office's menu (`web/app/backoffice/nav.ts`):
scan or tap; variants; sold by weight; a discount or another price on a line;
a discount on the sale; park a sale; a customer on the sale; cash with change,
card or transfer recorded; refund with the goods put back into stock or
written off; exchange with only the difference paid; stock check; what is left
on each tile; price change from the till; products imported from a
spreadsheet; barcode labels; suppliers, purchase orders, counts, movements;
stock reports.

Not said, because not built or not whole: scanning with the camera, card
terminals driven by the till, Bluetooth printers, transfers between shops, and
three languages on a shop's till (its screens are only partly translated).

## How it is built

Plain HTML, CSS and one script, as now: no library, no video. The film is a
short list of steps per chapter in `js/main.js`, run by one small player (wait,
tap, say, show); each chapter starts by putting its screens back as they were
written in the HTML, so it can be played from any chapter and loops cleanly.

## Checked before it goes live

Both choices at desktop and phone widths; every chapter by its key; Pause;
`/#shop` and a link to a shop's section from the restaurant's page; reduced
motion; no errors in the console; the demo form's message for each.
