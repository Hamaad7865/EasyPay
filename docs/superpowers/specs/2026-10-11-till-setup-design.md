# Setting up on the tablet, as in the back office (piece 5)

2026-10-11. Piece 5 of `2026-10-10-hybrid-offline-premium-design.md`. **Approved by the owner that
day** ("Yes, start build 1"), with two choices of theirs: importing from a file is for **shops only**,
and the tablet reads **Excel and CSV**.

## 1. What the owner asked

Watching the till: "We should be able to add items like the back office, set up tax etc...". Asked
what that covers, they ticked all eight:

- the fuller product sheet, variants, add-ons (restaurants), products from a file;
- taxes, discounts, roles and permissions, receipt design.

And on the same day: "when you test I need to shadow" (section 8).

## 2. What is there today

- **The tablet's sheet for an item** takes its name, its price or that the price is typed at the
  sale, its category, its barcode, whether it is on sale and whether its stock is counted. Its last
  line says the rest is set in the back office.
- **Only in the back office:** a product's tax, cost, SKU, brand, supplier and supplier's code,
  reorder level and order quantity; variants; add-on groups and which items carry them; taxes;
  discounts; roles; the receipt's notes and logo; importing a catalog from a file.
- **The tablet already holds all of it to read.** Its database has taxes, an item's tax, discounts,
  add-on groups and choices, which item carries which group, roles with their permissions, variants,
  and the settings with the receipt design; a pull fills them. What is missing is the screens, and a
  way for a till to ask the server for each change.
- **How the back office saves each** (the rules this piece repeats):
  - a tax: name, rate from 0 to 100 %, included in the price or added on top; ticking "usual" takes
    it off the others; a tax is never removed. A name is one tax's only (`unique (tenant_id, name)`).
  - an item's tax: one per item (`setItemTax`).
  - a product's row: `saveProductRow`, where a cost is written only by someone who may see cost.
  - variants: `variants_generate`, `saveVariantLines`, `variant_archive`, `assign_barcodes`.
  - add-ons: a group has a name, the fewest and the most that may be picked (most 0 = any number),
    and choices with a price; removing a group takes it off its items and renames it.
  - a discount: name, percent (1 to 100) or amount, whether it needs a manager; removed by renaming.
  - a role: a name and its permissions (`web/lib/perms.ts`); the owner's (`*`) cannot be changed; a
    role with staff on it cannot be removed; what the page does not show of a role is kept.
  - the receipt: two notes of 300 characters, a PNG logo under 400,000 characters, show it or not.
  - a file: `catalog_import(tenant, store, employee, rows, dry)`, for a shop, by someone who may see
    cost; the browser reads the file and says which column is what.

## 3. How every new thing is saved

As the item sheet saves today (`ServiceRepository.ask`): the tablet asks the server now, waits for
its answer, and a sync brings the row. It needs a connection; the other tills have it at their next
sync. The server applies the back office's rules and has the last word.

- **Ids are made on the tablet** when a form opens, so a second try after a lost answer sends the
  same one. `ask()` makes a new change id on every call, so each new server function is safe to
  repeat by what it carries: a lock on the row's id, then insert or update by that id.
- **Permissions are the back office's**, asked with `may()`: the person signed in holds it, or the
  manager who gave their PIN does.
- **Cost.** The tablet shows a cost only to someone who may see cost, and sends it only then. The
  server writes it only if the person, or the approver, may see cost; a sheet without the field
  never wipes one.
- **Each form's rules are plain Kotlin** (as `ItemForm`, `SupplierForm`): what is typed read as the
  change, or why it is not one yet, and the server's refusals in words. Example payloads live in
  `db/tests/fixtures/till-office/` and are read by the server's suite and by the Kotlin tests, so the
  two cannot drift.
- **One migration per build**, each re-making `sync_push` from the live definition with its new
  lines and refusal codes. A pull needs nothing new except where a build says so.

**What this does to piece 3** (the tablet alone). Piece 3 was written as ten changes the tablet has
to answer itself. The shop's stock tools added eight. This piece adds twelve and grows one:

| Build | New changes |
|---|---|
| 1 | `tax.save`; `item.save` grows (tax, SKU, cost, brand, supplier, supplier's code, reorder level and order quantity) |
| 2 | `variants.make`, `variants.save`, `variant.remove`, `barcodes.make`, `addon.save`, `addon.remove`; `item.save` grows (its add-on groups) |
| 3 | `discount.save`, `discount.remove`, `role.save`, `role.remove`, `receipt.save` |
| 4 | `catalog.import` |

So piece 3 answers about thirty kinds of change. The Kotlin forms above are written so that it can
use them as they are.

## 4. The four builds

Each ends with a run on an emulator that the owner watches.

### Build 1: taxes and the fuller product sheet

- **Settings > Taxes.** The taxes as a list: name, rate, "included in the price" or "added on top",
  and which one is the usual one. A key adds one; a tap opens one. The sheet: name (30 letters),
  rate, the two ways, a switch "The usual tax" (switching it on takes it off the others; it cannot
  be switched off, only moved). No removing.
- **The product sheet gets a second page**, "More", beside what it has today:
  - for every business: its tax, one of the list;
  - for a shop also: cost (only for someone who may see cost), SKU, brand, supplier (one of the
    shop's suppliers, or none) and the supplier's code for it, reorder level and order quantity for
    this till's store.
  - A new product is saved with both pages at once. What a page does not show is left as it is.
- **Server (0094):** `push_tax_save`; `push_item_save` reads the new keys when they are there, and
  an older till that sends none changes nothing. Refusals: `bad-rate`, `bad-tax`, and the existing
  `name-taken`, `sku-taken`, `unknown-supplier`, `bad-store`.
- **Tablet:** the product's supplier's code is a new column (database 17); `TaxForm`; `ItemForm`
  grows; `feature/settings/` gets a file per new page.

### Build 2: variants (shops) and add-ons (restaurants)

- **Variants,** a third page of a shop's product sheet: up to three options (Size, Colour) with
  their values; the lines made from them; each line's price, barcode, SKU and cost; a line removed;
  barcodes made for the lines that have none. A product with stock of its own cannot be given
  variants (the server says so), and one with variants cannot have a price typed at the sale.
- **Add-ons,** behind a key on a restaurant's Menu screen: the groups, each with its name, the
  fewest and the most that may be picked, and its choices with their prices. A group is saved whole,
  with its choices, in one change. On an item's "More" page, the groups it carries, as ticks.
- **Server (0095):** the six changes of the table above, each wrapping the function the back office
  calls; `item.save` takes the item's groups.

### Build 3: discounts, roles, receipt design

- **Settings > Discounts:** name, percent or amount, how much, "needs a manager"; removing one.
- **Settings > Roles:** the roles with how many permissions each has; a role's name and its ticks,
  grouped and worded as the back office's page, by kind of business. The owner's role is shown and
  cannot be changed. A role in use cannot be removed. The tablet sends the ticks and the list it
  offered; the server keeps what the role held outside that list, and never takes `*`.
  The list on the tablet and `web/lib/perms.ts` are both checked against one fixture.
- **Settings > Receipt:** the note at the top, the note at the bottom, a logo picked from the
  tablet's pictures and files (made no wider than the paper prints, saved as PNG, refused over the
  back office's limit), show it or not, and the receipt drawn beside the form as the till draws a
  receipt today.
- **Staff:** if the tablet cannot already move a member of staff to another role, that is added
  here (not checked yet, section 10).
- **Server (0096):** the five changes of the table.

### Build 4: products from a file (shops)

- On Products & stock: **Import**. Android's own file picker (a USB stick, Downloads, a Drive); a
  CSV file or an Excel workbook (`.xlsx`). The tablet reads it with no new library (a workbook is a
  zip of XML), guesses the columns from their headings and lets them be changed, shows what a run
  would do and the problem on each row that has one, then imports. For someone who may see cost.
- **Export**: the shop's products saved as a file the import reads back.
- The reading, the guessing and the rows are ports of `web/lib/csv.ts`, `xlsx.ts` and
  `catalog-rows.ts`, checked against the same example files.
- **Server (0097):** `catalog.import` wrapping `catalog_import` for the till's own store, with the
  barcodes the back office makes afterwards; its answer carries the result.
- The largest of the four, and the one whose twin on the tablet (piece 3) is largest too.

## 5. Where things sit

- **Settings** gets four pages in its list: Taxes, Discounts, Roles, Receipt.
- **Products** stay where they are: a restaurant's Menu, a shop's Products & stock, and the
  first-run set-up's menu step, which all open the same sheet.

## 6. Who may

| Thing | Permission |
|---|---|
| Taxes, discounts, add-ons, a product and its variants | `items.edit` |
| Roles | `employees.edit` |
| Receipt design | `settings.device` |
| A product's cost, importing a file | `costs.view` as well |

Anyone else is asked for a manager's PIN, as on the item sheet today.

## 7. As the back office does it

- A tax cannot be removed.
- The owner's role cannot be changed; a role in use cannot be removed.
- Importing is for shops, and for someone who may see cost (the owner's choice, section 1).
- Receipts already printed, and orders already open, keep the tax and the names they were rung up
  with.

## 8. Testing

The owner's rule of 2026-10-11: tablet tests run on an emulator **with its window open**, said
before they start, at a pace that can be followed.

- The server's rules are run first, out of sight, by a suite on the dev branch
  (`db/tests/till-office.test.cjs`) with the shared example payloads.
- The screens are then run on the open emulator. The made-up shop and restaurant of the debug build
  have no server behind them, so they show the screens and their rules, and Save answers "needs a
  connection".
- A save reaching the server is seen only on a till signed in to a dev client. The owner signs in
  themselves; logins are not typed for them.
- Anything that wipes a tablet or resizes its screen is done on a hidden emulator and said.

## 9. What I decided and the owner has not confirmed

- The four builds and their order; the three answers they gave are in section 1.
- The product sheet gets pages rather than growing longer: the keyboard takes half the screen.
- A tax can be made the usual one when it is added (the back office does it in a second step).
- Reorder level and order quantity are saved for the till's own store (the back office: the first
  store; a client has one store today).

## 10. Not checked yet

- Whether the tablet can already change a member of staff's role (build 3).
- How large one save the till's service accepts. Nothing in `hello.ts` limits it but 200 changes a
  request; the host's own limit is measured on dev before build 3's logo and build 4's file of
  5,000 rows.
- A restaurant's item with reorder levels: the sheet does not offer them, as its back office panel
  does not.

## 11. Outside this piece

- Payment types, order types, time cards, grid pages of the till.
- Removing a tax.
- Importing a restaurant's menu from a file.
- Answering any of this with no server: piece 3.
