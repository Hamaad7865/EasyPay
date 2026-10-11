# The tablet alone: the offline edition (pieces 3 and 6, redrawn)

2026-10-11, written during the night the owner asked for it. Replaces sections 4 and 6 of
`2026-10-10-hybrid-offline-premium-design.md` where they differ.

## 1. What the owner said

> I want you to complete the whole package for the offline mode even for restaurant as well roles
> permission, create tables etc... Because only in premium that they will have back office access.
> [...] If a client wants to upgrade, he just says so, I make him premium and automatically
> everything syncs. This way our free neon plan will be good and also we can use the money to pay
> neon then.

So: an offline business has **no back office**; everything it sets up, it sets up on the tablet; it
costs nothing on Neon while it is offline; and the day the owner makes it Premium in /admin, what the
tablet holds goes to the cloud by itself.

## 2. How it works

**One plan more: `offline`.** A client's plan is a word in /admin (`tenants.plan`), and the tills
read it in the settings they pull. `offline` is new beside `standard`, `premium` and `trial`.

- A tablet whose plan is `offline` is **alone**: it does not sync. Nothing is pushed, nothing is
  pulled, no timer wakes the database.
- **Everything is still queued.** Sales already are (the outbox). A change that a linked till asks
  the server for and waits (`ask()`: a product, a tax, a table, a member of staff) is, on a tablet
  alone, **applied to the tablet's own database by the same rules, and put in the same queue**.
- **Going Premium is the queue being sent.** The owner sets the plan to `premium` in /admin. The
  tablet learns it (below), switches its sync on, and the queue drains in the order things happened:
  the set-up first, then the sales that used it. No bulk upload, no second way for data to move. The
  server takes each change by the handler a linked till's change already goes through.
- **Nobody signs in for it.** A till has had a key of its own since it was first set up (the till
  service's `issue_device_key`); syncing uses that, not the login.
- **How the tablet learns it is Premium:** Settings > This till has **Connect to the cloud**. It asks
  the server once. Still offline: it says so and nothing changes. Premium: the sync starts. It is a
  tap and not a timer because a timer on a hundred tablets is what would wake the database all day.
- **First start is as today:** online for a minute, with the login made in /admin; the tablet
  registers, gets its key, and pulls what a new client is given (payment types, roles, VAT, order
  types). Then, on the `offline` plan, it stops talking to the server.

**What it costs to be true:** every kind of waited change needs two things, a rule on the tablet (to
answer alone) and a handler on the server (to take it the day it is sent). The handlers are what
piece 5 builds anyway; the rules on the tablet are new, in plain Kotlin beside the forms.

## 3. Decided here, not confirmed by the owner

- **`offline` is a new plan; `standard` stays what it is.** A client on Standard today (one is live)
  keeps its back office and its sync until the owner moves it. Nothing is switched off by a release.
- **The back office refuses an `offline` client** with a sentence saying it is part of Premium.
- **The queue, not a bulk upload** (the earlier design's "lift"). It matches the owner's words and
  uses a sync that is released and works. What it costs:
  - the whole history goes up, not a trimmed one. A Neon project holds 1 GB; a busy shop's years of
    receipts are a real part of that. Trimming what is sent is a later piece.
  - a rule the tablet applies more loosely than the server would be refused on the day, with what
    depends on it. So each rule on the tablet is written from the server's function, and a tablet's
    queue is replayed against the dev server as the check (`db/scripts/replay-demo-outbox.cjs`).
- **The login stays the unlock** for now: the licence code of piece 2 is not built. One login can
  set up a second tablet, as today; each would be alone, with its own menu and sales.
- **A tap, not a timer,** to learn of Premium.
- **Coming back from Premium to offline** (a lapse): setting the plan back to `offline` makes the
  tablet alone again at its next sync; it keeps everything. Not built further than that.

## 4. What an offline business cannot do today, from the till's own words

Every place the till says "in the back office", crossed with the back office's pages. Kitchen screens
and Bookings are Premium's and are left out.

| Thing | On the tablet today | Tonight |
|---|---|---|
| Products, categories, stock in and out | yes, asked of the server | answered alone |
| Taxes, a product's tax, cost, SKU, supplier | yes (build 1) | answered alone |
| Suppliers | yes | answered alone |
| First-run set-up: tables of a room, a printer, business details, staff and PINs | yes | answered alone |
| Staff: change a name or a role, switch off | no | to build |
| Roles and permissions | no | to build |
| Discounts | no | to build |
| Tables after the set-up: add, rename, remove | add a room only | to build |
| Which printer a category prints on | no | to build |
| Add-ons (restaurants) | no | to build |
| Variants (shops) | no | to build |
| Order types, the service charge | no | to build if time |
| Receipt notes and logo | no | to build if time |
| Products from a file | no | last |
| A receipt older than 30 days | the tablet keeps every receipt it made | nothing to do |
| Backup to a file, and back | no | to build: no offline tablet without it |

## 5. Not in this piece

- The licence code (piece 2), payments and the paid-until date (piece 1).
- Two offline tablets sharing.
- Trimming the history that goes up with Premium.
- A product's EasyPay barcode made by itself on an offline tablet (the server makes it when the
  product arrives there).

## 6. Record: what is built and what was seen (the night of 2026-10-11)

Nobody watched any of this: the owner was asleep. Every tablet run was on a hidden emulator of mine
(`easypay_claude_kitchen`, port 5588), with the debug build's made-up shop and restaurant on the
offline plan (`DEMO_SHOP --es plan offline`). Nothing is pushed; production is untouched; migrations
0094 and 0095 are on the dev branch only.

**Built**

- The core: `PosSettings.alone`, `LocalAnswers` behind `AloneDao`, the gate in `ServiceRepository.ask`,
  no sync while alone, `SyncScheduler.connect` and the key Connect to the cloud, the sync's words
  hidden, `Journey` for what the sheets say.
- Answered alone: an item with all of its sheet and its removal, a category and its removal, stock in
  and out, the tables of a room, a printer, the business's details, a member of staff and a PIN, a
  tax, a supplier and its removal, a role and its removal, a change to a member of staff, a discount
  and its removal. 26 tests against a stand-in for the tablet's database.
- New on the server (0095) and in Settings: Staff, Roles, Discounts.
- /admin: the plan Offline; the back office turns an offline client away with its own sentence.
- Backup: Save a backup (Settings > Support), a warning on This till when there is none or it is a
  week old, Restore from a backup on the first screen.

**Seen**

- A shop alone: a tax, a product with its second page, stock in, a category, a supplier, a sale; then
  a role, a member of staff added and switched off, a discount. Its queue of 14 changes replayed
  against the dev server (`db/scripts/replay-demo-outbox.cjs`, rolled back): every one taken, the
  sale's figures the till's to the cent, the stock figures equal.
- A restaurant alone: a second room of three tables and a printer added from Set-up, the kitchen
  order and the receipt printed on that printer (a stand-in on this PC), a table of the new room
  served and paid. Its 8 changes replayed: every one taken.
- A backup saved to Downloads, the app cleared, and the tablet filled again from the file: products,
  receipt, staff and the 14 kept changes all back. A file whose note does not say what it is was
  turned away.

**Not seen by anyone**

- Connect to the cloud against a real server. It needs a client that is really on the offline plan
  and a tablet set up with its login, which is the owner's to do: make a client in /admin with the
  plan Offline, set a tablet up with its login, sell, set the plan to Premium, tap Connect to the
  cloud. The replay above is the proof that the server takes what such a tablet kept.
- A first start on the offline plan from a real sign-in.
- A restored tablet connecting later (it has to sign in once more for its key).
- Anything on a real tablet or a real printer.

**Known and left**

- An offline shop's stock history shows what was put in and taken out by hand, not each sale.
- A removed role's or discount's freed name carries the tablet's clock on the tablet and the
  server's on the server; the rows are removed ones.
- A product made offline gets its EasyPay barcode only when it reaches the server.
- The whole queue goes up with Premium: years of sales are years of rows.
- One login can set up a second offline tablet; each is alone.
- `db/tests/backoffice-plan.test.cjs` had one check failing before any of this ("N2 and loses
  nothing else"); it is not this work's and is not fixed here.

## 7. Record, continued: add-ons, settings, variants (the same night)

Migrations 0096 and 0097, on the dev branch only. The server's suite `till-office` stands at 101
checks. The till's database is 18. 474 unit tests, 39 of them of the tablet's own answers.

**Built, each on the server, as a rule on the tablet, and as a screen**

- **Add-ons** (restaurants): Menu > Add-ons lists the groups; a group's sheet has its name, the fewest
  and the most that may be picked, and its choices with their prices, saved whole. An item's second
  page ticks the groups it carries.
- **The receipt's two notes and the service charge**: Settings > Receipt.
- **Variants** (shops): on a product's panel, Variants (its options and their values; every
  combination it does not have becomes a variant) and, on each variant's row, Codes (barcode, SKU,
  cost, and removing it). The tablet makes each variant's id, which is why the server has its own
  change for this and does not use the back office's function: a tablet alone sells a variant before
  the server has heard of it.

**Seen** (hidden emulator, the owner asleep; then each tablet's queue replayed against dev, rolled back)

- A restaurant alone: a group of add-ons with two choices, ticked on two items; an order at a table
  asked for the choice and priced it; a note for the top of the receipt and a service charge of 10 %
  saved; the printed receipt (a stand-in printer) carried the note, "+ Cheese", and the service
  charge, Rs 379.50 in all. **16 changes replayed, every one taken**, both sales' figures the till's
  to the cent.
- A shop alone: four variants made on a product, one given its barcode, SKU and cost, one removed,
  one sold. **8 changes replayed, every one taken**, the sale of the tablet-made variant among them.

**What an offline business still cannot do on the tablet** (section 4's table, after this night)

| Thing | State |
|---|---|
| Products, categories, stock, taxes, suppliers, the set-up's tables, printer, details, staff and PINs | done, answered alone |
| Staff changed or switched off, roles and permissions, discounts | done |
| Add-ons, variants, the receipt's notes, the service charge | done |
| Backup to a file, and a tablet filled from one | done |
| A second printer, and which printer a category prints on | done (section 8) |
| A table renamed, moved or removed after it was added | **not built**: rooms and tables can be added |
| Order types (their names, which go to the kitchen) | **not built**: the ones a new client is given |
| The receipt's logo | **not built** |
| Products from a file | **not built** |
| A shop's purchase orders, deliveries and counts | **not built** (their rules are; their screens say "Coming with the next build") |
| An EasyPay barcode made for a new product | **not built** offline: made when the product reaches the server |

## 8. Record, the last of the night: a kitchen printer, and four checks

**A second printer, and which categories print on it** (migration 0098, on dev only; suite
`till-office` 108 checks; 475 unit tests). Settings > Printers has Add a printer; a category's sheet,
in a restaurant, ticks the printers its orders print on. Seen on the hidden emulator, the restaurant
alone: the counter's printer set not to take kitchen orders, a second printer added, one category
ticked for it, an order sent: **the kitchen order printed on the second printer and nothing on the
first** (two stand-in printers on this PC). The tablet's 8 changes replayed against dev: every one
taken.

**Checked before the morning**

- **The dev database takes the plan `offline`**: no rule on the column names the plans, /admin hands
  the word to `platform.set_tenant_plan` as typed, and a client made on it in a transaction that was
  rolled back had no Premium and was told `offline` in the settings a till pulls.
- **An old sale is not refused for being old.** `push_receipt_create`, `push_shift_open`,
  `push_shift_close` and `push_ticket_create` read a sale's own time and compare it with nothing: a
  queue kept for months is taken as one kept for minutes.
- **A tablet with no key can sign in to be connected.** The key is not in a backup, so a tablet
  filled from one has none; Connect to the cloud was asked to sign in and kept it to itself. It says
  so now, and This till and Support show Sign in. Not run: it needs a real login.
- **All of the night's commits are this session's**, and migrations 0094 to 0098 and the till's
  database versions 17 and 18 were not taken by anyone else meanwhile.

**A risk at the moment of connecting, known and not yet closed.** Connect to the cloud pulls before
it pushes. The owner's change of plan rewrote the client's settings on the server, so for the few
seconds until the queue has gone up and come back, the tablet shows the server's old copy of what it
had changed while alone in those settings: the business's details, the receipt's notes, the service
charge, the one-printer switch. They come back with the queue. If the server refused one of those
changes, that one would be lost. Pushing before applying what was pulled closes it; it is the first
thing to do before this is used by a paying client.

