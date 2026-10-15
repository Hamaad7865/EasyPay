# The receipt designer: the receipt, the bill and the kitchen ticket as blocks

2026-10-15. Part 2 of the owner's restaurant asks of that day (part 1: `2026-10-15-addons-line-customer-number-due-reminder-payments-design.md`, built). Their words:

> let's create a receipt designer so we can drag and drop and adjust create variables what can be printed how to display price etc...

and of the customer number, that it "can be added in the designer as well".

Decided by them before this design was written: it covers the receipt, the bill and the kitchen ticket; it lives in the back office; it is a column of blocks dragged into order, not a free canvas (a thermal printer prints line by line, and a receipt's length changes with its items); each block has its own settings (size, bold, alignment, shown or hidden, how prices show); a free-text block takes variables such as `{customer_no}`; the preview shows 58 and 80 mm.

Asked while designing, one question at a time, and answered:

- The receipt and the bill: **one design** for both, the bill adding what only a bill has.
- Add-on prices: **a choice in the designer**: names only, priced in the item (as today), or each add-on with its price.
- The price of one item on a line of more than one: **a choice in the designer**: the line total only (as today), or "2 x 50.00" under it as well.
- Variables: **EasyPay's list only**. Words that never change (a Wi-Fi password) are typed into the block.
- BRN, VAT number and the tax lines: **can be hidden, with a warning** about the MRA.
- The approach: **blocks** (not a written template, not switches on today's paper).
- Asked while the design was shown: with add-ons one per row, how do their prices show? Answered: the Items block also offers add-ons **on one line or one per row**, and in rows the price **follows the price setting**: with prices, each row has its price in the price column and the item shows its own price, so the column adds up; names only, the item shows its total and the rows carry no price.

The design below was shown in three parts and agreed ("Yes, go on" to each; then "Write the spec build it and then tell me when its done and tested also"). What is theirs is above; the decisions marked *mine* in section 9 were in what they agreed to and are theirs to overrule.

## 1. The page

Back office › **Receipt design** becomes the designer. It has two tabs: **Receipt and bill**, and **Kitchen ticket**. A shop has the first only: its kitchen prints nothing.

- **Left: the column of blocks.** Each block has a handle to drag it by, an eye to hide it, and settings that open under it when it is clicked. Up and down keys move the open block as well, for a touch screen or a keyboard.
- **Right: the preview**, redrawn at every change. Three switches: 80 or 58 mm; Receipt or Bill (the Receipt tab); a takeaway with customer No. 05 or Table 4.
- Each tab has **Save** and **Back to EasyPay's design** (which removes that paper's design, so it prints exactly as before).
- One line under the preview: "Tills print this design from version 0.9.13. A till not yet updated prints EasyPay's own until it is." (The version is the one that carries this build; if it goes out later than 0.9.13 the line says that one.)
- Hiding **BRN**, **VAT number** or **Taxes** shows, beside the block: "A receipt without these may not satisfy the MRA. Check with your accountant."
- Who may change it: whoever holds `settings.device`, as today; a suspended client sees it and cannot save.

### Block settings

Every block has **Shown** (the eye). The others depend on what the block is:

- **Words** (a name, a note, a title): size (Normal, Tall, Big), bold, alignment (left, centre, right), a line above.
- **A row** (words on the left, a figure on the right, such as "Served by … Priya" or "Cash … 1,000.00"): size, bold, a line above. A row has no alignment: it spans the paper.
- Big is twice as wide and twice as tall, so it wraps at half as many characters (16 on 58 mm, 24 on 80 mm). Tall is twice as tall at the same width.
- A **line above** prints only when the block prints something: the line over "This is not a receipt" is not on a receipt.

## 2. The receipt and the bill

One design for the receipt, the bill, a refund and a guest's share of a split bill. Its blocks, in EasyPay's order (today's paper):

| Block | Prints | EasyPay's settings |
|---|---|---|
| Logo | the logo set on this page, when "Print the logo" is on | centre |
| Business name | from Company details | centre, Big |
| Address, Phone, BRN, VAT number | "Tel: …", "BRN: …", "VAT: …"; nothing when empty | centre |
| Header note | the header note (also set on the tablet, Settings › Receipt) | centre |
| Line | | |
| Title 🔒 | RECEIPT, BILL or REFUND; then COPY on a reprint, and *** REFUNDED *** or *** PARTLY REFUNDED *** when it is | centre, bold |
| Customer number | CUSTOMER No. 05, for a restaurant's order with no table (part 1); never on a refund | centre, bold, Big |
| Receipt number | No. … S1-T1-000128 (not on a bill) | row |
| Date and order | 15/10/2026 19:42 … Table 4 | row |
| Order type | Order type … Takeaway | row |
| Served by | Served by … Priya, and Waiter … Ravi when the waiter is someone else | row |
| Guests | Guests … 4 | row |
| Customer | Customer … Mrs Li, when it is not the order's own name | row |
| Refund of | Refund of … S1-T1-000120, and Reason: … (a refund only) | row |
| Line | | |
| Items 🔒 | the lines (section 4) | |
| Line | | |
| Subtotal | only with a discount, a service charge or rounding | row |
| Discounts | each discount | row |
| Service charge | | row |
| Taxes | VAT 15% (incl.) … 84.78 | row |
| Rounding | | row |
| Total 🔒 | TOTAL (REFUNDED on a refund) … Rs 650.00 | row, bold, Tall |
| Guest's share | SHARE 1 OF 3 … and the tax in it (a guest's copy of a split bill) | row, a line above |
| Payments | each payment, its reference, what was given and the change | row |
| This is not a receipt | a bill only | centre, a line above |
| Remark | the order's remark | a line above |
| Footer note | the footer note (also set on the tablet) | centre, a line above |
| Barcode 🔒 | a shop only: the receipt's number in bars, for returns (not on a bill) | a blank line above |

🔒 **Locked**: it can be moved and its settings changed, but not hidden. The Barcode is locked because returns are scanned from it; it is offered to a shop only (a restaurant's till scans no receipts). Title, Items and Total are locked by me (section 9).

The rules inside today's paper stay inside their blocks: Subtotal only with a discount, service or rounding; the Waiter row only when it differs; COPY and REFUNDED; the share; "This is not a receipt" on a bill only; no barcode on a bill; the customer number never on a refund nor on a shop's receipt. **Hiding a block can only hide it; nothing makes a block print when it has nothing to say.**

The logo, the header note and the footer note are where they are today (`receipt.logo`, `receipt.showLogo`, `receipt.header`, `receipt.footer`): their blocks' settings hold the picker and the two boxes, and the tablet's Settings › Receipt page still edits the two notes.

## 3. The kitchen ticket

One design for every kitchen and bar printer (mine). Its blocks, in EasyPay's order:

| Block | Prints | EasyPay's settings |
|---|---|---|
| Station | KITCHEN, BAR …, or VOID - KITCHEN / REPRINT - BAR | centre, bold |
| Order heading | No. 05 large then who it is for; or the table, or the order's name, large | centre, bold, Big (the size is the large part's) |
| Pick-up time | PICK UP 18:30 (a takeaway) | centre, bold, Tall |
| Time and waiter | 15/10/2026 19:42 … Ravi | row |
| Order type and guests | Takeaway - 2 guests | words, left |
| Line (=) | | |
| Items 🔒 | the lines (section 4) | |
| Remark | REMARK: … | bold, a line above |
| Line (=) | | |

No prices on the kitchen ticket.

## 4. The Items block

**On the receipt and the bill:**

- **Add-ons**: on one line (as today, part 1) or one per row.
- **Add-on prices**: names only, the item priced with its add-ons (as today), or with prices.
- **Price of one**: off (as today), or on: under a line of more than one, "2 x 50.00", the price of one item without its add-ons (a weighed line: "0.5 x 400.00").
- **Notes**: shown (as today) or not.
- **Old price**: shown (as today: "was 120.00, 10% off") or not.
- Size and bold, for the item's own line.

The four looks of the add-ons:

```
One line, names only (today)       One line, with prices
1 Burger                  300.00   1 Burger                  250.00
  + Cheese, Bacon                    + Cheese 20.00, Bacon 30.00

One per row, names only            One per row, with prices
1 Burger                  300.00   1 Burger                  250.00
  + Cheese                           + Cheese                 20.00
  + Bacon                            + Bacon                  30.00
```

- With prices, the item shows its own price (what the line comes to less its add-ons) and each add-on what it adds to the line (as kept: for 3 eggs at Rs 10, "3 x Egg 30.00"); the two together are the line's total. The old price is shown the same way, less the add-ons.
- A free add-on never shows 0.00: its name only.
- A line's order on paper: the item; the price of one; the old price; the add-ons; the note.

**On the kitchen ticket:**

- **Add-ons**: a line for each add-on group (as today) or all on one line.
- **Seat**: shown (as today) or not.
- **Notes**: shown (as today) or not.
- Size and bold for the item's line (EasyPay's: Tall, bold). Course headings stay as they are.

## 5. Text, Line and Space

Added from **Add a block**, as many as wanted, on either paper; the only blocks that can be removed.

- **Text**: up to 300 characters, several lines; words settings. Variables are written in braces and picked from a list beside the box.
  - Receipt and bill: `{business}`, `{customer_no}`, `{order}`, `{receipt_no}`, `{date}`, `{time}`, `{cashier}`, `{waiter}`, `{guests}`, `{order_type}`, `{customer}`, `{total}`.
  - Kitchen ticket: `{customer_no}`, `{order}`, `{date}`, `{time}`, `{waiter}`, `{guests}`, `{order_type}`, `{station}`, `{pickup}`.
  - A variable with nothing to say is left empty; a line of the block that comes out empty is not printed; a block that comes out empty prints nothing (nor its line above). A word in braces that is not a variable prints as typed, so a mistake shows on the preview.
- **Line**: a rule across the paper, `-` or `=`.
- **Space**: 1 to 5 blank lines.

A paper holds at most 60 blocks.

## 6. Where the design is kept, and how it reaches the tills

**In the business's settings (`pos_settings.data`), under a key of its own, `papers`**: next to `receipt`, not inside it.

```json
"papers": {
  "receipt": { "v": 1, "blocks": [ { "k": "logo" }, { "k": "name", "size": "big", "align": "center" }, … ] },
  "kitchen": { "v": 1, "blocks": [ … ] }
}
```

- A block is `k` (its kind) and only the settings that differ from that kind's defaults: `hide`, `size` (`normal`, `tall`, `big`), `bold`, `align` (`left`, `center`, `right`), `above` (a line above), and the kind's own: `text` (Text), `ch` (Line: `-` or `=`), `n` (Space), and for Items `addons` (`line`, `rows`; on the kitchen ticket `groups`, `line`), `addonPrices`, `unitPrice`, `notes`, `was`, `seat`.
- **A paper with no design prints EasyPay's**, which is today's paper exactly.
- **Why a key of its own**:
  - The back office merges a save one level deep: the Receipt design page sends `receipt` whole, so a design inside it would have to be sent with every save of the notes.
  - A tablet that worked on its own keeps its own copy of `receipt` while a change of its notes waits to go up (`OwnSettings`), and an offline tablet's waiting changes never all go up: a design inside `receipt` would never reach it.
  - The server's `push_settings_save` and the tablet's own answer to it (`LocalAnswers.settingsSave`) merge only the keys they know and keep the rest, so a key of its own survives every save made on a tablet, with no change to either.
- **Nothing changes on the server**: no migration, no function. The tills already receive the settings row whole at each pull (`sync_pull` sends `pos_settings` with every column; `PullApplier` keeps `data` as sent).
- **The back office saves one paper at a time**: it reads the design through the same reader the preview uses (section 7), refuses one it cannot read, and merges it into `papers` so that saving the receipt keeps the kitchen ticket. The logo and the two notes are still saved into `receipt` as today. "Back to EasyPay's design" removes that paper from `papers`.
- **A till reads a paper forgivingly** (as `LabelBook` reads labels):
  - a paper that is not readable, of a version other than 1, or missing a locked block or with one hidden (a shop's Barcode included) is printed as EasyPay's;
  - a block whose kind it does not know is skipped, so a later back office cannot stop an earlier till printing;
  - a second block of a kind that can be on the paper only once is skipped;
  - a setting it does not know is ignored, one out of range takes the kind's default.
- **A till built before this** does not know `papers` and prints as before.
- **A receipt printed again** uses today's design: what is kept with a receipt (`receipts.doc`) is what was sold, not how it looked. The till's on-screen receipt (`receiptLook`) follows the design too (without the logo, as now).
- **An offline restaurant** has no back office of its own. It keeps EasyPay's design until EasyPay opens its back office from /admin with **Login to back office** and designs it there; the tablet takes it at its next **Get changes from EasyPay** (Settings › Support). Because the design has a key of its own, a header or footer changed on the tablet and still waiting never holds it back. There is no designer on the tablet.

## 7. The till's printing, and the preview held to it

**The till** (`core/print`):

- A new `Papers` (the blocks, their defaults, EasyPay's two designs, the forgiving reader) and the receipt and the kitchen ticket printed by walking the blocks (`Docs.page`, `Docs.kitchen`). The other papers (credit note, cash slips, drawer count, X report, day closing, reports, test) do not change.
- `PosSettings` reads `papers`; `DocBuilder` hands the paper's design to `Docs`.
- **With no design, the papers print exactly as now.** Proved two ways before the old code is removed: the 22 tests in `DocsTest` pass unchanged; a test prints a dozen papers (receipt, bill, refund, share, reprint, partly refunded, a shop's with bars, 58 and 80 mm, a takeaway's and a table's kitchen ticket, courses, a void) through the old code and through EasyPay's design and requires the same bytes.
- `EscPos` keeps, for each line, its text, its size, whether bold, and its alignment (`styled()`); `look()` is as before.

**The data a receipt keeps** (`DocLine`, `core/print/Docs.kt`), two new fields with defaults:

- `addons`: each add-on's name, how many, and what it adds to the line (from `ticket_line_modifiers`), filled by `DocBuilder.lines`.
- `unit`: the price of one item as charged.

A receipt kept from before has neither: its add-ons print by name only (from `mods`, as now) and no "price of one" line prints, whatever the design says. `mods` stays as it is, for the kitchen and for receipts kept from before.

**The preview** (`web/lib/papers.ts`): the same walk written in TypeScript, with the same wrapping, figures and dates (`EscPos.wrap`, `Docs.num`, `Docs.qty`, dd/MM/yyyy HH:mm in Mauritius time), producing the same styled lines, drawn in a fixed-width face: 32 or 48 characters across, Big twice as wide and tall, Tall twice as tall. The sample order is built in (a burger with two add-ons, two of an item, a note); the business's own name, details, notes and logo are used.

**Held together by shared examples** (as `db/tests/fixtures/till-office/perms.json` holds the two permission lists): `db/tests/fixtures/papers/`.

- `default-receipt.json` and `default-kitchen.json`: EasyPay's two designs, which both sides are tested to hold.
- One file per example: a design, the paper's data, the business, the paper width and the decimals, and the lines expected, each with its text, size, bold and alignment. The till's test (`PapersFixtureTest`, reading `../../db/tests/fixtures/papers/`) and the back office's (`node web/lib/papers.test.mjs`) print every example and must get exactly those lines.
- The examples: EasyPay's receipt at 80 and 58 mm; a bill; a refund; a guest's share; a reprint partly refunded; the four looks of add-ons; a receipt from before with no add-on prices, in a "with prices" design; the price of one, and a weighed line; a Big business name wrapping at half width; Text with variables, one of them empty; a block hidden that had a line above; a shop's barcode; a kind nobody knows, skipped; a design missing Total, printed as EasyPay's; EasyPay's kitchen ticket for a takeaway and for a table; kitchen add-ons on one line; seat hidden.

## 8. How it is checked

- Unit tests on the till: the reader (each forgiving rule of section 6), the walk, the byte equality with the old code, the examples.
- `node web/lib/papers.test.mjs` on the examples and on the reader; `tsc` clean; the back office builds.
- The designer page in a browser: drag, hide, settings, Text with variables, Save and reading back, Back to EasyPay's design. It needs a sign-in: the back office is run on this PC for the owner to sign in to, or a stand-in page with sample settings where no sign-in is possible, and that is said.
- On an emulator, its window open so the owner can watch, said before it starts: a design saved to dev's settings and pulled by the till; a receipt and a kitchen ticket printed through the stand-in printer at 58 and 80 mm and compared with the preview; EasyPay's design printed with no design saved.

## 9. Decisions that are mine

- Title, Items and Total are locked as well as a shop's Barcode: a receipt without its title loses COPY and REFUNDED, which keep it from being refunded twice.
- One kitchen design for every kitchen and bar printer; no prices offered on it.
- The kitchen ticket's Items block also offers add-ons all on one line, and the seat hidden.
- A line above, instead of rule blocks that print even when the block under them does not.
- Price of one is the item's own price, without its add-ons.
- A free add-on shows no price.
- A paper the till cannot read, or missing a locked block, prints EasyPay's whole, not a mended copy.
- The design is kept under `papers`, apart from `receipt` (section 6).
- The preview's sample order is built in, not one of the business's own receipts.
- Up and down keys besides dragging.
- At most 60 blocks to a paper; Text up to 300 characters.

## 10. Not built

- A design per printer, per store, or several named designs to choose from.
- A designer on the tablet.
- Variables of the business's own.
- Designs for the credit note, the cash slips, the drawer count, the X report and the day closing.
- Small print (the printer's second font), pictures other than the logo, QR codes.
- Prices on the kitchen ticket; the kitchen screens.
