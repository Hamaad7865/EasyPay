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
