# A shop's deposits (layaway): goods held for a customer who pays part now: design

2026-10-16. The owner: a client buying the retail edition sells kids' things, "and sometime people deposits an
amount to reserve what they want to buy. How can we make this a feature?" Kids Corner (their own shop system,
being phased out; its client moves to EasyPay) already does it:
`KidsCorner/supabase/Migrations/20260823100000_deposit_orders.sql` is the rule, and this is that rule in
EasyPay's own stack. Asked what happens on cancel, past the date and whether a customer is needed, the owner
answered: "1 2 4 should be configurable settings"; and: "3 should work both offline and online".

## 1. Purpose

A customer chooses goods, puts money down, and comes back (once or several times) to pay the rest and take
them home. Today that is paper in a drawer. EasyPay must hold the goods off the shelf, keep the price agreed,
know what has been paid and what is left, make the drawer add up on the day the money came in, and make the
sale (and its VAT) only on the day the goods leave.

## 2. Ways it could be built

1. **A deposit is its own document; the sale is written on collection (chosen).** Kids Corner's shape. The
   deposit holds its lines, at the price of the day, and a list of payments. Collecting writes an ordinary
   receipt for what is taken, paid first from a built-in **Deposit** type (as a credit note pays today),
   the rest by any tender. Reports, VAT and stock stay true without special cases elsewhere.
2. **A parked sale with a part payment.** Less to build, but a part-paid sale is a sale: VAT and net sales
   would fall on the deposit's day, the stock would leave on the wrong day, and a parked sale is one
   tablet's, not the shop's.
3. **Money on the customer's account, goods noted by hand.** That is on-account credit (the next piece): no
   goods held, no price kept. It does not answer "reserve what they want to buy".

## 3. Who has it: a paid feature

The owner: "deposit is a feature, if an offline wishes to have it they need to pay more than 5000". So deposits
are not part of the one-time offline edition; a client pays for them, and the platform admin switches them on.

- **The switch** is the admin's, in `/admin` on the client: **Deposits** on or off, beside the plan. It is kept
  as `tenants.features` (a list of names; `deposits` the first) and written into `pos_settings.data.features`
  in the same transaction, as 0085 writes the plan, so a till has it at its next pull. A tablet working on its
  own has it when it is set up with its code and on "Get changes from EasyPay".
- **`has_feature(tenant, 'deposits')`**: true for a shop on `premium` or `trial` (the cloud plan carries it),
  or when `deposits` is in the list (the offline edition, or a Standard shop, after paying). The price is the
  owner's and is not written in the product.
- **Without it**: no Deposit key, no Deposits screen or page, no settings rows; the back office's Deposits page
  says "Deposits are an extra. Ask EasyPay to add them." A `deposit.*` operation from a till of a client
  without it is refused `not-entitled`, and the till says why (hiding the key is not the guard, as 0085 says).
- **Switched off later**: deposits already taken stay readable and can still be collected, topped up and
  cancelled (the customer's money is there); no new one can be taken.

## 4. Settings (shop only)

On POS settings, General, for a shop, beside Returns (`pos_settings.data`, sent to tills with the settings
pull). **The offline edition gets the same rows under Settings on the tablet** (the gap credit notes left is
not repeated here).

| Setting | Key | Values | Default |
|---|---|---|---|
| **Deposits** | `deposits` | on · off | on for a shop |
| **When a deposit is cancelled** | `depositCancel` | `refund` (the money back) · `credit` (a credit note for it) · `keep` (the shop keeps it) | `credit` |
| **Hold goods for** | `depositDays` | days, 1 to 365: the collect-by date offered | 30 |
| **Past the collect-by date** | `depositOverdue` | `show` (marked overdue, nothing else) · `cancel` (cancelled by itself after the grace days below) | `show` |
| **Grace days before cancelling** | `depositGrace` | days, 0 to 365 (only with `cancel`) | 7 |
| **Customer needed** | `depositCustomer` | `required` (name and phone) · `optional` | `required` |

A restaurant has none of these. A till built before this reads none of them and offers no Deposit key; a
collection it cannot make, the server refuses nothing it never receives.

## 5. What a deposit is

- **A number** `<prefix>-<till>-D<n>` (as `DM-T1-D000001`), counted on the tablet as receipt numbers are, so a
  deposit taken with no signal has its number at once and two tablets never make the same one.
- **The customer** (required or not, by the setting), **the collect-by date**, who took it, on which till.
- **Lines**: item, variant, quantity, **the unit price and any line discount of that day, frozen**. Collection
  prices come from these rows, never from the catalogue again: a price rise next month does not reach a
  part-paid agreement, and a promotion that starts later does not lower it (the customer may cancel and buy
  again, under the cancel setting).
- **Payments**: append-only, each with its payment type, amount, till, shift, employee, time. Money in is
  positive; money given back on cancel is negative.
- **Status**: `open`, `collected` (every line taken), `cancelled`. Overdue is not a status: it is the date,
  read where it is shown.
- **What is free to use**, always computed, never stored as a second truth:
  `paid − given back − sum of Deposit-type payments on live receipts of this deposit`.

## 6. The till: taking a deposit

On Sell, for a shop with deposits on, a key **Deposit** beside Pay (while the sale has lines and is not an
exchange). It opens a sheet:

1. **Customer**: the sale's customer, or pick or add one (`customer.upsert`, offline too). With `required`,
   name and phone must be there before the next step.
2. **Collect by**: today + `depositDays`, changeable.
3. **Paid now**: an amount from 0 to the total, and the tender, as on Pay (cash with change, card, Juice,
   any of the shop's types; not a credit note, not the exchange or deposit types). 0 holds the goods with
   nothing paid.
4. **Take deposit**.

In one transaction on the tablet: the deposit with its lines and its first payment (if any); **a stock
movement per line, kind `deposit`, taking the goods off the shelf** (so no other till sells the last one,
and the shelf counts are true); the sale on Sell is cleared. The `deposit.create` operation goes to the queue.

**The slip** prints (twice when the shop prints two receipts): header as a receipt's; "DEPOSIT"; the number
large; the customer; each line with quantity and price; "Total Rs 2,000.00 · Paid Rs 500.00 · To pay
Rs 1,500.00"; "Collect by 15 November 2026"; the number as a barcode; a sentence built from the settings
("If not collected, the deposit is given back as a credit note." / "...is kept by the shop." / "...is given
back.").

Stock that is not there: a deposit takes the goods as a sale does, by the same rule as selling a product that
is out (if Sell lets it, the deposit does too).

## 7. The till: Deposits

A screen **Deposits**, beside Receipts in a shop's menu: open deposits first, overdue ones marked in red, then
a switch to collected and cancelled. A search by number, customer name or phone; scanning a slip opens it
(a scan on Sell of a deposit number does too). A deposit opens to its lines (taken / left), its payments, and
"Total · Paid · Used · To pay", with four keys:

- **Add payment**: an amount up to what is left to pay, any tender as in §6. Writes a payment
  (`deposit.pay`); prints a short slip "Paid Rs 500.00 · To pay Rs 1,000.00".
- **Collect**: tick the lines (and how many of each) taken today; **all of them** ticked at first. Sell opens
  with those lines at their frozen prices, a banner "Collecting deposit DM-T1-D000012", and nothing else may
  be added or changed on those lines (other goods may be added to the same sale and are sold as usual). Pay
  puts **the deposit first, by itself**: the Deposit type, `reference` = the number, amount = the lesser of
  what is free to use and the sale's total; the rest by any tender. The receipt says "Deposit DM-T1-D000012 ·
  Rs 500.00". The lines from the deposit move no stock (it left the shelf on the deposit's day). When every
  line is taken the deposit is `collected`; money still free on a collected deposit (paid more than the goods)
  is handled as a cancel of nothing: by `depositCancel`.
- **Cancel**: asks the reason; needs the right to refund (`sale.refund`, held or approved by a manager's
  PIN, as a refund does). The lines not taken go back on the shelf (`deposit_release` movements). What is free
  to use goes by `depositCancel`:
  - `refund`: a payment out, by default in the tenders the money came in, newest first; the cashier may make
    it all cash. Cash leaves the drawer.
  - `credit`: a credit note for it, as an exchange's note is (section 6 of the credit notes design), with the deposit
    named instead of a refund; its slip prints.
  - `keep`: nothing moves; the deposit says "Rs 500.00 kept by the shop".
  Already-collected goods are not touched: returning them is an exchange, as for any receipt.
- **Print the slip again.**

## 8. Past the collect-by date

`show`: the deposit is marked overdue on the till and in the back office, nothing else.

`cancel`: a deposit `depositGrace` days past its date is cancelled as §7's Cancel does, by the system, with the
reason "Not collected by …". Money under `refund` cannot be put in a customer's hand by itself: the deposit
stays listed as **"Rs 500.00 to give back"** until a till pays it out with the key **Give back**. Under
`credit` the note is issued (its slip prints when someone opens the deposit or reprints it); under `keep`
nothing moves.

Who does it, so two places never do it twice: **a connected shop's server** (when any till pulls or the back
office opens Deposits; nothing runs nightly), and the tablet takes the result with its pull; **a tablet working
on its own**, when it opens the day. A connected tablet never cancels by itself.

## 9. On the books

**Server tables** (migration number taken when written): `deposits` (`id` from the tablet, `tenant_id`,
`store_id`, `number`, `customer_id`, `collect_by`, `status`, `cancel_reason`, `cancel_outcome`, `device_id`,
`created_by`, `created_at`, `cancelled_by`, `cancelled_at`), `deposit_lines` (`id`, `deposit_id`, `item_id`,
`variant_id`, `qty`, `unit_price`, `discount`, `qty_collected`), `deposit_payments` (`id`, `deposit_id`,
`payment_type_id`, `amount` (negative for money back), `shift_id`, `device_id`, `employee_id`, `created_at`).
The tablet has the same three in its database (version taken when written). Reads by the tenant only; writes
only through the push functions.

**A third built-in payment type**, kind `deposit`, named "Deposit", one live per shop, made where
`ensure_credit_note_type` is made. Not a tender a cashier picks; Pay uses it only when collecting.
`payment.correct` from or to it is refused (`bad-payment`).

**Operations** pushed by the till (and answered by the tablet itself on the offline plan):
`deposit.create` (with lines, its first payment and the stock movements), `deposit.pay`, `deposit.cancel`
(outcome, reason, approver, the money back or the note), `deposit.give_back`. Collection is an ordinary
`receipt.create` whose lines carry `deposit_line_id` and whose Deposit-type payment carries the number.

**The server's checks**, under `for update` of the deposit (two tablets apart can disagree; the money at risk
is bounded by the deposit):

- prices of a collection's deposit lines must be the frozen ones (`bad-payment` otherwise);
- a collection that takes more of a line than is left, or uses more than is free, or comes after the deposit
  was cancelled: **stored and flagged** `deposit-overused` with what is wrong, as `credit-overspent` is: the
  goods have left the shop and the sale stands. If the deposit was cancelled first, the collection's lines
  move stock as a normal sale (the cancel put them back).
- a cancel after a collection cancels only what is left, and gives back only what is free then.
- a payment on a cancelled or collected deposit: stored and flagged `deposit-closed`.

**The drawer.** Cash paid on a deposit is in the drawer of that shift's day: expected cash includes the
day's cash deposit payments (in and out). Card or Juice ones touch no drawer. At collection the Deposit-type
payment carries no cash of its own, so nothing is counted twice.

**Reports** (Sales summary, Day closing; X and Z on the till): net sales and VAT only on collection, as
receipts. "By payment type" leaves the Deposit type out (as credit notes). Lines added:
**Deposits taken** (by type), **Deposits used on collection**, **Deposits given back**, **Deposits kept**.

**Stock.** Two new movement kinds, `deposit` (out) and `deposit_release` (back), shown in Stock history in
words ("Held for deposit DM-T1-D000012"). A held unit is off the shelf for everything: counts, low stock,
the shop's stock list.

## 10. The back office

- **Deposits**, a shop's page in Sales (`/backoffice/deposits`, `reports.view`): open first (number, customer,
  phone, total, paid, to pay, collect by, overdue, till), then collected and cancelled; search; a deposit
  opens to its lines, payments, the receipts that collected it, and how it was cancelled. Read only: money
  and goods move at a till. Opening the page runs §8 for a connected shop.
- **Receipts**: a receipt that collected a deposit says so with its number.
- **Customers**: a customer's page lists their open deposits.
- **POS settings, General**: the six rows of §4, with one sentence each.
- **Day closing, Sales summary**: the four lines of §9.

## 11. Testing

- A server suite on dev, alone: `deposits` (create with and without money; the stock held; a payment; a
  collection in two visits at the frozen price after a price change; the Deposit type capped at what is
  free; cancel under each of the three outcomes, with the stock back and the drawer moved for cash; overdue
  cancel under `cancel` and none under `show`; the conflicts of §9 flagged; the pull sends open deposits;
  `payment.correct` refused; a client without the feature refused `not-entitled`, and one switched off still
  collecting an old deposit) and `shop-pages` extended (the page, the report lines, the settings).
  `retail-till`, `credit-notes`, `stock-sales` still pass.
- Unit tests on the till: what is free to use; the collection's amount cap; the slip's sentence per setting;
  overdue and grace in whole days; the local answers (offline) giving the same results as the server for the
  same steps.
- On the test emulator with the made-up shop on the offline plan: a deposit taken with cash, topped up by card,
  collected in two visits; one cancelled under `credit` (the note spent afterwards); the drawer's Z
  matching. Then on a connected tablet with `DEMO_PULL`, a deposit taken on one tablet seen on another.
- On paper, through the stand-in printer: the deposit slip, the payment slip, a collection receipt.

## 12. Decisions this design took, for the owner to confirm or overrule

1. The defaults: on cancel a **credit note** (it matches the shop's "we don't refund"), hold for **30 days**,
   past the date **only marked overdue**, a **customer required** with phone.
2. Taking, topping up and collecting need no special right (they are selling); **cancelling needs the right
   to refund** or a manager's PIN, because goods and money go back. Each is a permission the owner can
   change in the back office.
3. A deposit may be taken with **nothing paid** (holding only). Alternative: a minimum (an amount or a
   percent) as another setting.
4. Money kept under `keep` is a line of its own, **not counted as sales** and with no VAT on it; the
   accountant decides what it is. Alternative: book it as a sale of a "Kept deposit" item.
5. A collection takes the deposit first and by itself; the customer cannot keep the deposit for a later
   visit while paying today in cash.
6. Collected goods come back through the exchange, as any receipt's, never through the deposit.
7. Prices are frozen both ways: a promotion after the deposit does not lower them.
8. **Premium and trial include deposits**; the offline edition and a Standard (cloud, one-time) shop need the
   extra switched on. Alternative: only the offline edition pays for it, every cloud shop has it.
9. The extra is a list of features on the client (`tenants.features`), not a new plan, so later extras (on-account
   credit, for one) are switched the same way without a plan for each mix.

## 13. Not in this build

- Moving Kids Corner's open layaways into EasyPay (the client's data move, a piece of its own).
- On-account credit (the next piece).
- Deposits on a restaurant (bookings with a deposit are another thing).
- Changing a deposit's lines after it is taken (cancel and take a new one, under the cancel setting).
- Reminders to the customer by SMS or WhatsApp before the collect-by date.
- A deposit taken from the back office or the public site.
