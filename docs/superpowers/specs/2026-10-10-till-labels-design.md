# Labels printed from a shop's till: design (piece 1, printing)

Asked 2026-10-10, with four photos of the Print label module of another till app (Cash Cow): "I want to
have print label module in the retail apk ... Can we have these in the apk please?" The photos show a
Print label screen, a list of label templates, and a template editor with rulers.

The owner's answers, the same day:

- Which printer: "Theres a seperate printer we will need to configure in settings maybe we'll need to
  create it". So: a sticker printer of its own, set up on the tablet.
- Order of work: "Printing first".
- "For the custom template is there any library we can import?" None exists for the editor (looked:
  one whole app for one printer family, one Flutter plugin, small drag helpers). One library is worth
  having, for the bars: ZXing. Asked, they chose "Yes, import ZXing".
- On the design below: "Build it as described".

## Three pieces

1. **This document:** a label printer on the tablet, a Print labels screen, ready-made labels.
2. **Afterwards, its own design:** the template editor (photos 2 and 3). It edits the templates this
   piece defines and adds nothing to how a label prints.
3. **Later, its own design:** weigh-print labels. They need a scale, which the till has no code for,
   and a decision that is the owner's: EasyPay's own barcodes start with 200, a range scales also use
   for weight-in-barcode labels.

## What there is today

The back office prints labels from the browser (`/backoffice/items/labels`: a 40 x 30 mm roll or A4
sheets). The till prints nothing but ESC/POS, the language of receipt printers (`core/print`). A sticker
printer speaks another language (TSPL) and must be told the label's size and the gap between labels.
Kids Corner's till prints a label as receipt text with a feed and a cut, which honours neither.

## 1. A label is a picture

The tablet draws each label as a black and white picture, dot for dot at the printer's own resolution,
and sends the picture. Chosen over sending the printer's own text and barcode commands because:

- the preview on screen is the picture that prints, not an imitation of it;
- accents and any script print as the tablet draws them, whatever fonts the printer holds;
- the same picture serves a sticker printer and a receipt-type printer;
- the editor of piece 2 needs only to change a template, never the printing.

The steps, each a unit of its own:

1. **Layout** (plain Kotlin, tested): a template and one product's words give a list of placed things in
   dots: text with its box, size and weight; bars with their box and thinnest bar; lines; boxes.
2. **Painting** (Android): the list is painted on a bitmap and turned into one bit per dot, in the
   `Raster` the logo already uses (a set bit is a black dot).
3. **Wrapping** (plain Kotlin, tested): the raster becomes the bytes of a job for the printer's language.

Templates are in millimetres. Dots are millimetres times the printer's dots per inch over 25.4.

## 2. Templates and the ready-made labels

A template has a name, a width and a height in mm, the gap between labels (2 mm unless it says
otherwise), and a list of elements: a text (one of the label's words, or words of its own), the bars, a
line, a box. It can be written as JSON, so that piece 2 can store the ones a shop makes. This piece
stores none: its templates are in the code.

A label's words: the shop's name, the product's name, the variant's name, the price, the code.

| Size (mm) | Label | On it |
|---|---|---|
| 40 x 30 | Name, price, barcode | name (two lines at most), variant, price, bars with the code under them |
| 50 x 25 | Shop, name, price, barcode | shop's name, name, price, bars with the code under them |
| 25 x 15 | Name and price | name, price |
| 25 x 15 | Price only | price |
| 25 x 15 | Price and barcode | price, bars with the code under them (see section 3: short codes only) |

The price is written as the till writes it (`Money.format`, with " /kg" for a product sold by weight). A
product whose price is typed at the sale has no price on its label. A name too long for its lines is cut.

Another size of sticker waits for the editor.

## 3. The bars

**The code** is the line's barcode; without one, its SKU (the till already finds a product by either);
with neither, the label has no bars and the screen says so before printing.

**The symbol:** EAN-13 for thirteen digits with a right check digit, Code 128 for anything else. Both
are worked out by ZXing (`com.google.zxing:core`, added to the version catalog); the till adds the quiet
zones (EAN-13: 11 modules before, 7 after; Code 128: 10 each side) and draws the bars itself.

**Whole dots, wide enough:** every bar is a whole number of dots wide, with no smoothing. The thinnest
bar is the widest that lets the symbol and its quiet zones fit the template's box, and never under
0.25 mm (2 dots at 203 dpi, 3 at 300). A code that does not fit at that width prints as its characters
only, and the screen says so. A 13-digit barcode therefore has no bars on a 25 mm label; a short code
has.

## 4. The label printer

**Where:** a page of the tablet's own, More > Label printer, shown on a shop's till only. It is kept
on the tablet like the scanners (DataStore, kept through a sign-out). Nothing of it is in the back
office or on the server, and the store's printers are untouched: a label printer is never among the
printers that print receipts, tickets and reports.

**What it asks:**

- a name;
- the connection: USB (picked among what is plugged in), Bluetooth (picked among what is paired, with
  the page's own "Allow Bluetooth" key as on Printers) or network (an IP address);
- the type: **sticker printer** (TSPL; the default) or **receipt-type printer** (ESC/POS, with its paper,
  58 or 80 mm);
- for a sticker printer, its resolution: 203 dpi (the default) or 300.

**Print a test label** sends one label in the size of the label in use (40 x 30 until another is
chosen on the Print labels screen): a frame at the edge, the words
"EasyPay label test", a barcode. It shows at once a label that is cut off, shifted, blank or black for
white. Remove takes the printer off the tablet.

**Two USB printers.** Today the till prints on the first USB printer it finds, so with a receipt printer
and a label printer both on cables either could get the other's job. The label printer is remembered by
its maker and product numbers, its name and, when the tablet gives one, its serial number. Receipts go
to the first USB printer that is not it. If the label printer cannot be told from another one plugged
in, the page says so and does not save it as USB: connect one of the two another way.

**A sticker printer's job,** each line ended by CR LF:

```
SIZE <w> mm,<h> mm
GAP <gap> mm,0 mm
DIRECTION 1
CLS
BITMAP 0,0,<bytes across>,<dots down>,0,<the picture>
PRINT 1,<copies>
```

`CLS`, `BITMAP` and `PRINT` repeat for each different label of a run; the copies of one label are the
printer's to repeat, so they cost one picture. In TSPL a set bit is white, the opposite of the raster,
so the wrapping turns every bit over. (That is the documented way round; the test label proves it on
the shop's own printer.)

**A receipt-type printer's job:** for each copy, the picture by the raster command the logo uses, a
feed and a cut. A label wider than the paper is refused with a sentence.

**Sending** goes through `Printing`: the same three connections, one job at a time to each printer. A
run that could not be sent is reported in words a cashier can act on, as a receipt is.

## 5. The Print labels screen

Arranged as the owner's first photo, in EasyPay's own look.

- **Right:** the products, as on Sell: the categories, the tiles, a search by name, SKU or barcode. A
  tap adds one label of the product, or one more. A product with variants asks which, or all of them.
  A scan adds the line it reads (the screen takes the scanner as Sell does).
- **Left:** the lines to print, each with its name, variant, code, price and how many (minus, plus, or
  tap the number to type it), and a key to take it off. Clear empties the list. A line with no bars
  says why.
- **Under the list:** the label in use (its size and name) and the picture of the selected line, as it
  will print. Tapping it opens the ready-made labels, each drawn with that line, to pick another. The
  choice is kept on the tablet.
- **At the foot:** how many labels in all, and Print.

**Limits,** the back office's: 99 labels of one line, 240 in one run.

**Print** sends the run to the label printer and waits for it. Sent: the list is emptied and the screen
says how many went to which printer. Not sent: the list stays and the reason is shown, so Print can be
pressed again. With no label printer set up, the key says so and opens its page.

The list is kept while the app is open, not through a restart.

**Reached from** the side menu ("Print labels", with Stock check and Cash drawer) and from a product's
sheet in Products & stock ("Print label", which opens the screen with that product added).

## 6. Where it touches what exists

- `MainShell.kt`: a screen `Labels` among a shop's (`SHOP_ONLY`, `SHOP_BACK`, the scanner's `taking`).
- `Printing.kt`: the USB device picked by who it is; a way to send to a printer that is not a store's.
- `SettingsScreen.kt`: the Label printer page, and an entry in a shop's Help (`SHOP_HELP`).
- `Products.kt`: the Print label key on the product's sheet.
- `RetailSell.kt`: the category keys and product tiles become usable by the new screen.
- New: `core/print` for the template, the layout, the bars, the painting and the two wrappings;
  `feature/retail/Labels.kt` for the screen.

No migration, no change to the API or the back office, and the till's own database stays as it is. The
till becomes 0.9.0 (build 13).

## 7. Not in this piece

The editor and labels of other sizes (piece 2). Weigh-print (piece 3). Cash Cow's "Custom Item" (a
label for something that is not a product). What EasyPay holds nothing of: member price, shelf life,
production date, place of origin, spec, material. QR codes, a logo on the label, labels for a delivery,
the label printer shown in the back office. Restaurants are not offered any of it.

## 8. How it is checked, and what is not

**Unit tests:** the layout (each ready-made label, the long name, the open price, the code chosen); the
bars (EAN-13 against the back office's own test codes, the quiet zones, the thinnest bar and when there
are none); both wrappings byte for byte (the header, the bytes across, every bit turned over for TSPL);
telling USB devices apart; the list's limits.

**On my emulator** (`easypay_claude_till`, the made-up shop): the two screens, and a run sent to a
stand-in printer on this PC that keeps the bytes, which are turned back into a picture and looked at.

**Not checked by me:** anything on a real sticker printer. No hardware is here. The owner prints the
test label first and says what came out.

## Decisions of mine, for the owner to overrule

- The label printer is the tablet's own, not the store's (their words were "configure in settings").
- A product without a barcode has its SKU as the bars.
- No bars rather than bars too thin to scan.
- The list is emptied after a run that was sent.
- Restaurants do not get the screen.
