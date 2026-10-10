# The shop's stock tools on the tablet: design (piece 8 of the hybrid plan)

The overall plan is `2026-10-10-hybrid-offline-premium-design.md`. It leaves the shop's stock tools in
the offline edition, so they have to exist on the tablet. Shown the order of the eight pieces, the owner
wrote "Start with 8 first".

The owner's answers, 2026-10-10:

- Told that built first these screens land on shops whose tills are linked to the cloud, where they do
  what the back office already does and a save needs a connection, and asked which job should come
  first after a shared base (receiving deliveries, or counts): **"Both in one release"**.
- On the design below: **"Yes go ahead and write it up"**.

## What there is today

- **The server has every rule** (migrations 0067 to 0076): `po_save`, `po_send`, `po_cancel`,
  `po_close`, `po_fill_low`; `delivery_receive`, with or without an order, safe to send twice;
  `count_start`, `count_add`, `count_line`, `count_review`, `count_complete`, `count_cancel`;
  `stock_adjust`; `stock_movements` as the history. The back office's pages use them.
- **A till is sent** whole rows of `items`, `item_variants` and `stock_levels`, and keeps only part of
  them: a product's cost, supplier and brand, a variant's cost, and a line of stock's reorder point,
  reorder quantity and average cost arrive and are dropped. Suppliers, orders, deliveries, counts and
  movements are not sent at all.
- **The till** has Products & stock (what is left, a correction through `stock.adjust`), Stock check
  and Print labels. Its database is at version 13.
- **Permissions** reach the till inside each role: `stock.view`, `stock.receive`, `stock.adjust`,
  `stock.count`, `suppliers.edit`, `costs.view` are already there.
- **A till's change that waits for the server** goes through `ask()` in `core/data/Service.kt`; the
  server checks the person or their approver with `may()` in a `push_*` function that `sync_push` calls.
- The Kids Corner till has a stock check and nothing else of this, so there is no till screen to follow.
  What a screen holds and in what order follows EasyPay's own back office pages.

## 1. Where it is

A shop's side menu gains **Stock**, beside Stock check and Print labels. It opens one screen with five
tabs: **Deliveries, Orders, Counts, History, Suppliers**. A restaurant's till does not have it.

Who may open what, with a manager's PIN for someone who may not, as everywhere on the till:

| Tab | Permission |
|---|---|
| Deliveries, Orders | `stock.receive` |
| Counts | `stock.count` |
| History | `stock.view` |
| Suppliers | `suppliers.edit` to change one; the list itself is open to whoever has opened Stock, as the back office's page is |

Costs are shown to whoever holds `costs.view` or `stock.receive`, as the back office decided for its own
order pages: someone who receives a delivery types its costs.

## 2. The data on the tablet

The screens read the tablet's own database and never the network. The sync fills it.

- **Kept from what already arrives:** a product's cost, supplier and brand; a variant's cost; a line of
  stock's reorder point, reorder quantity and average cost.
- **Newly sent, to a shop's till only** (a restaurant's sync stays as it is):
  - `suppliers`: all of the client's;
  - `purchase_orders` and their lines: this shop's, those still open (draft, sent, part received) and
    those changed in the last 30 days;
  - `deliveries` and their lines: this shop's, the last 30 days;
  - `stock_counts` and their lines: this shop's, the last 30 days;
  - `stock_movements`: this shop's, the last 30 days.
- **The tablet's database goes to version 14** with those columns and eight tables, plus one of its own,
  `stock_drafts` (section 4). After the update the tablet asks for everything once more, so that
  products it already holds gain their cost and supplier.
- **Nothing is removed from the tablet as it ages.** For an offline tablet these tables will be the only
  copy.
- An older till ignores tables it does not know (`PullApplier` takes tables by name), so the server can
  be updated first.

## 3. Saves

Every save is a change that waits for the server's answer, like a product's today. Each id is made on
the tablet, so the same change sent twice is written once.

| Change | Carries | Server rule behind it | Permission |
|---|---|---|---|
| `supplier.save` | id, name, contact, phone, e-mail, address, note | what the back office's page does, which is plain statements today: a name is needed, and two live suppliers cannot share one | `suppliers.edit` |
| `supplier.remove` | id | as the back office: the supplier is marked removed and stays on its old orders | `suppliers.edit` |
| `po.save` | id, shop, supplier, expected date, note, lines (product, variant, quantity, cost) | `po_save`, taught to take the id of a new draft | `stock.receive` |
| `po.send`, `po.cancel`, `po.close` | id | `po_send`, `po_cancel`, `po_close` | `stock.receive` |
| `delivery.receive` | id, shop, order or none, supplier or none, date, invoice number, note, lines | `delivery_receive` | `stock.receive` |
| `count.complete` | id, shop, scope, when it began, what to do with the uncounted, lines (product, variant, counted, when, left out) | a new `count_from_till` (section 6) | `stock.count` |

`stock.adjust` stays as it is. Each refusal the server can give has its sentence on the tablet, as
`ItemForm.refused` does for a product. A till talking to a server that is not updated yet is told so
("The server has to be updated before...", the sentence tables already use).

After a save the tablet syncs, and the list on screen changes when the rows arrive: an order's number
(`PO-0007`), a delivery's (`D-0031`) and a count's (`C-0004`) are the server's to give.

## 4. Suppliers, orders, deliveries

The working screens are arranged like Print labels: on the left what is being built, on the right the
products, found by tapping, searching or scanning; a product with variants asks which. That right-hand
pane is taken out of `Labels.kt` into one shared picker instead of being written a second and third
time.

**Suppliers.** The list; a sheet to add or change one (name, contact, phone, e-mail, address, note);
Remove.

**Orders.** Three groups: drafts, waiting (sent, part received), finished (the last 30 days).

- A new order: the supplier, an expected date, a note, and lines with a quantity and a cost each. The
  cost starts at what the product last cost.
- **Add what is low** fills the draft with the supplier's products at or below their reorder point that
  are not on it yet, each with its reorder quantity, or with what brings it back to its point when none
  is set. It is worked out on the tablet from what it holds, by the server's own rule (`po_fill_low`),
  so it needs no connection.
- Save as a draft, Send, Cancel (while nothing has arrived), Close (the rest of a part-received order
  will not come). A sent order's lines cannot be changed, as on the server.
- An order that is waiting has **Receive**, which opens a delivery for it.

**Deliveries.** The list of the last 30 days, and **Receive stock**.

- Against a waiting order, or with no order. With an order, the lines start as what is still due and the
  supplier is the order's. With none, the supplier may be left out.
- An invoice number, the day it arrived, a note; each line a quantity and a cost.
- A product that was not on the order can be added to its delivery. The server takes it (the line
  belongs to no order line); the back office's own form does not offer this yet.
- Before it is sent, a sheet says how many lines and units and what they cost, and that a delivery
  cannot be changed once received. Goods sent back afterwards leave by a correction, "returned to
  supplier", as today.
- Then **Print labels for this delivery**: the label screen opens with the delivery's lines as its run,
  each with as many labels as arrived, within the label screen's own limits.

**A draft is not lost.** An order or a delivery being typed is kept on the tablet (`stock_drafts`: one
per kind, as text) until it is sent or thrown away, so closing the app or losing the connection in the
middle of a sixty-line delivery costs nothing. "Save as a draft" on an order is the server's draft
(`po.save`); the tablet's own copy is only what has not been sent yet.

## 5. History

Every movement the tablet holds for this shop: when, the product and its variant, how many in or out,
why (sale, refund, delivery, count, correction and its reason), the document it belongs to, who. A
search by product (typed or scanned) and a filter by kind. On a linked till a sale shows once it has
been to the server and back.

## 6. Counts

- **Start a count** of everything, one category, one supplier or one brand: the server's four scopes.
  The count's lines are the lines of stock in that scope, worked out on the tablet.
- **Counting:** a scan or a tap adds one; a tap on the figure sets it from the keypad. Each line
  remembers when it was last counted. A product outside the scope that is scanned is added: it is on
  the shelf. A line can be left out of the count. The screen says how many lines are counted of how
  many.
- **The count lives on the tablet** until it is completed. It survives closing the app, needs no
  connection, and the till sells meanwhile. One open count a tablet.
- **Review:** for each line what was expected, what was counted and the difference, and what to do with
  the lines nobody counted: leave them, or set them to nothing. Expected is what the tablet holds for
  the line, with its own sales since the line was counted put back.
- **Complete** needs a connection. The till first sends the sales it is still holding, then the count as
  one change. With no connection the count is kept and the till says to complete it when it is online.
- **The server's figures are the ones that stand.** `count_from_till` makes the count, writes each
  line with the moment the tablet counted it, and completes it by the rule the back office uses: a
  line becomes what was counted plus what moved after it was counted, a sale being judged by its own
  time on the till. The same count sent twice is answered with what was written. The tablet's review is
  its best knowledge; in a shop with several tills another till's unsent sales are not in it, and the
  review says so.
- A count open in the back office shows in the list as open there and is not opened on the tablet. A
  finished count, wherever it was made, opens as a record: expected, counted, difference, and its worth
  for someone who may see costs.

## 7. The parts

Rules as plain Kotlin in `core/data`, tested on the JVM, with no Android in them:

- `SupplierForm`, `OrderForm`, `DeliveryForm`: what a form holds, what is wrong with it, two lines of
  one product added together (the server's `doc_lines`), the totals, each refusal's sentence.
- `PoFill`: "Add what is low".
- `CountBook`: a count's lines, add and set, leaving out, the review's arithmetic.
- `StockHistory`: a movement's words and the filters.

Screens in a new `feature/stock`: the tabbed screen, one file a tab, and the shared product picker.
`Service.kt` gains the six saves beside the ones it has. `PullApplier` gains the tables. A shop's Help
(`SHOP_HELP`) gains an entry for each tab.

Server, one migration (the next number, 0092 when this was written): `sync_pull` with the tables of section 2 for a shop; the `push_*`
functions of section 3 and their lines in `sync_push`; `po_save` taking a new draft's id;
`count_from_till`. Built from the live definitions, as every fix-forward migration here.

## 8. For the offline edition later

Nothing here is offline-only or linked-only. When the tablet can stand alone (piece 3 of the plan), the
six saves get their answer from the tablet itself, at the same place in the code as the ten that exist,
and the tablet writes its own movements and document numbers. The screens, the tables and the rules of
section 7 stay as they are. That work belongs to piece 3 and is not part of this build.

## 9. How it is checked

- **A suite on dev** (`db/tests/till-stock.test.cjs`) for every new change through `sync_push`: done by
  someone who may, refused for someone who may not, done with an approver, sent twice, each refusal;
  and for the pull: a shop is sent the tables, a restaurant is not, another shop's rows never arrive.
- **One set of example changes read by both sides:** files of the exact payloads, which the Kotlin
  tests build and compare and the suite sends to dev. What the tablet sends is then what the server was
  tested with, without a tablet being signed in.
- **Unit tests** for the rules of section 7; `PoFill` and `CountBook` are given the cases of the
  server's own suites.
- **On my own emulator**, with the made-up shop given suppliers, an order, a delivery and movements:
  every tab, the drafts, a count up to its review, the database's step from 13 to 14 on a tablet with
  data, and what the till says with no connection.
- **Not seen by me:** a save going from a signed-in till to the server and coming back in a sync. I
  cannot sign a tablet in. It is the owner's to try on a dev shop before the release.

## 10. Build and release

Three build plans, one release:

1. **The base:** the migration's pull, the tablet's database, the Stock screen, Suppliers, History, the
   shared picker.
2. **Orders and deliveries.**
3. **Counts.**

Then the server's migration and a till release together, the version after 0.9.0. The migration can go
first: an older till ignores what it does not know. Both tags are the owner's.

## 11. What I decided and the owner has not confirmed

- The entry is called Stock, with five tabs, and it opens for anyone who holds one of the four
  permissions of section 1; a tab they may not use asks for a manager.
- A count can also be of one supplier: the server has four scopes and I named three (section 6).
- "Add what is low" is worked out on the tablet (section 4).
- Drafts are kept on the tablet (section 4).
- Only a shop's till is sent the new tables (section 2).
- The tablet keeps what it is sent and removes nothing (section 2).
- A product that was not ordered can be received on an order's delivery (section 4).
- The review before completing is the tablet's estimate, and the server's figures stand (section 6).

## 12. Not in this piece

- Sending an order to the supplier (printing it, e-mail, WhatsApp): the tablet marks it sent.
- Setting a product's supplier and reorder point on the tablet: the back office's until piece 5. A
  product's cost is set by receiving it.
- Stock reports (stock value, the reorder list, losses, what is not selling): piece 7.
- Transfers between shops.
- A count shared between two tablets, or continued from the back office.
- Anything for a restaurant's till.
