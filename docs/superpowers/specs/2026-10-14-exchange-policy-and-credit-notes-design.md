# A shop's return policy, the exchange, and credit notes: design

2026-10-14. The owner, after comparing EasyPay's exchange with Kids Corner's (their own shop system, which they
will stop maintaining; its client moves to EasyPay): "We dont refund we only exchange, if another thing added
customer pays difference", and, of what happens when the replacement costs less, "We should be able to choose
between" refusing it and leaving the rest on a credit note. The credit note is a slip anyone may spend, and is
also on the customer's account when one is attached ("C"). A customer may not bring goods back and take only a
credit note ("No"). The exchange stays the path it is on the till (receipt, then Sell, then Pay), with Kids
Corner's size-swap keys added ("A").

The exchange itself is built (piece 5 of retail mode, migration 0079, `core/data/Exchange.kt`,
`docs/superpowers/plans/2026-10-08-retail-exchange-5.md`). This design is what is missing against Kids Corner's
rules, and the policy switch the owner asked for.

## 1. Purpose

A shop in Mauritius says on its receipt: no refunds, exchange within seven days. EasyPay must let a shop say
that and hold to it at the till, with one of three answers when what the customer takes is worth less than
what comes back: it is not allowed, the rest stays on a credit note, or the shop gives money back.

## 2. Decisions the owner made

| Question | Their answer |
|---|---|
| Does the shop refund? | No: exchange only; the customer pays any difference. |
| Replacement worth less than what came back? | The shop chooses: not allowed, or the rest as a credit note. (The third value, a refund, is kept for shops that do refund.) |
| Who spends a credit note? | Whoever brings the slip; and it is on the customer's account too when one was attached, so a lost slip can be found. |
| Goods back, nothing taken, a credit note for the lot? | No. A credit note only comes out of an exchange where something is taken. |
| The exchange screen | Keep EasyPay's path; add the one-tap swap to another size or colour of the same product. |

Decisions that are mine, for them to confirm or overrule, are in section 10.

## 3. Settings (shop only)

Three settings on POS settings, General, for a shop (`pos_settings.data`, sent to tills with the settings
pull; the offline edition keeps them on the tablet, under Settings as the other POS settings are):

| Setting | Values | Default |
|---|---|---|
| **Returns** | `exchange` (exchange only) · `credit` (exchange; what is left over goes on a credit note) · `refund` (exchange or refund) | `exchange` |
| **Return window** | days, 0 to 365. Inside it a cashier with the right to refund acts alone; after it a manager's PIN. 0: always a manager. | 7 |
| **A credit note is valid for** | months, 0 to 36. 0: never expires. | 6 |

A restaurant has none of these; its refund is as it is today.

A till built before this reads none of them and goes on as today (refund and exchange offered, a manager
asked for every refund by a cashier). The server's refusals below hold for an old till too: a plain refund
from a shop on `exchange` or `credit` is refused with `refund-policy`, and the till shows it on its Rejected
screen as "Refund: this shop does not refund. Exchange instead."

## 4. The till: a receipt, and the window

On a shop's receipt (Receipts, Detail):

- `refund`: Refund and Exchange, as today.
- `exchange` or `credit`: Exchange only. The Refund key is not drawn, and the sheet's title says "Exchange" and
  nothing of refunds.

**The window.** The receipt's age is counted from its own time to now, in whole days on the tablet's clock.
Inside the window a member of staff with `sale.refund` starts an exchange (or a refund, on `refund`) alone;
past it `staff.allow` asks for a manager's PIN whatever their right, with the sentence "This receipt is N
days old, past the N-day window. A manager must approve." The approver is kept on the refund as today.
The server enforces the same: `refund.create` (and the exchange's refund) past the window with no approver
is refused, `refund-window`. Window 0 means every refund and exchange needs a manager, which is what every
shop has today.

**The swap keys.** On the exchange sheet, under each line ticked as coming back whose product has other
variants, a row of keys: every other live variant of the same product ("Navy · M", "Red · L"), the one
returned left out, in the order the product's options are listed. A tap adds that variant to the sale the
exchange is rung up on, at today's price, one unit (a second tap adds another). The keys are what Kids
Corner's `ExchangeScreen` does with its size chips; here they are on the sheet, and the sale is still the
ordinary Sell screen, so a scanned product, a line discount, a parked sale and the customer work as on any
sale. A product with no variants has no keys.

## 5. The till: paying for the exchange

On Sell with an exchange on it, `due = sale total − credit` (credit: what the returned goods are worth, as
today).

| Returns | due > 0 | due = 0 | due < 0 |
|---|---|---|---|
| `exchange` | "Pay Rs 270" | "Exchange" (nothing to pay) | Pay is off; the total row says **"Pick something worth at least Rs 590"** (the credit). |
| `credit` | "Pay Rs 270" | "Exchange" | **"Credit note for Rs 270"** |
| `refund` | "Pay Rs 270" | "Exchange" | "Give back Rs 270", as today |

**Cash short of the gap** (due > 0, cash chosen): the Pay screen refuses a tendered amount under the gap, as
it refuses an underpaid sale: "Rs 200 is short of the Rs 270 to pay." Not booked, not partly paid.

**Under `credit`, confirming with due < 0** writes, in one transaction on the tablet, in this order:

1. the refund of what comes back (as today; `toExchange` = the part the sale uses, and a second payment of
   the rest to the shop's credit-note type, section 6);
2. the sale, paid from the exchange type for the part it uses (as today);
3. the credit note: number, amount = the rest, the refund's number, the customer on the sale if any, valid to
   (today + the months set; null when 0), issued by, on this till.

Then the refund slip, the receipt and the **credit-note slip** print, in that order. If the slip does not print
the note still exists: it is on the Receipts screen beside its refund with a key "Print the slip again"
(reprint needs what a reprint needs today).

**The slip.** Header as a receipt's; "CREDIT NOTE"; the number large; "Rs 270.00"; "Valid to 14 April 2027"
(or "Does not expire"); the customer's name when attached; "From exchange of receipt S-T1-000123"; a barcode
of the number (Code 128, as a receipt's number prints today); the sentence "Spend it on any purchase at this
shop. Keep this slip: it is the note."

## 6. On the books

**Two built-in payment types a shop has.** The `exchange` type of 0079 is as it is. A second, kind
`credit_note`, named "Credit note" (another name if taken), one live per shop, made by `ensure_credit_note_type`
where `ensure_exchange_type` is called (when a tenant becomes a shop; on migration for every shop; kept
soft-deleted if it becomes a restaurant). Neither is a payment option the back office edits nor a tender the
till offers on its own; the credit-note type is paid *from* on a sale only through the Credit note tender
(section 7), which names the note.

**Issuing.** The exchange's refund pays `settled` to the exchange type (reference: nothing, as today) and
`rest` to the credit-note type with `reference` = the note's number. `refund.create` takes with it, in the same
push operation, the note itself (`credit_note: {number, amount, valid_to, customer_id}`); the server writes the
row in `credit_notes` in the same transaction as the refund, and refuses the refund if the note's amount is
not the payment's amount to that type (`bad-payment`). A refund with a payment to the credit-note type and no
note, or a note and no such payment, is refused the same way. So a note can never exist without the refund
that backs it, nor the other way round.

**The table** `credit_notes`: `id` (the tablet's, as receipts), `tenant_id`, `number`, `amount`, `balance`,
`refund_id`, `customer_id` (nullable), `valid_to` (nullable), `status` (`open`, `used`, `expired`, `void`),
`issued_by`, `device_id`, `created_at`, `used_at`. Number series `CN-<till code>-<n>`, counted on the tablet as
receipt numbers are, so two tablets never make the same number and a note made with no signal has its number
at once. `balance` is kept on the row and is also always equal to `amount − sum(redemptions)`: the server
recomputes it on every redemption inside the row's lock, so the column is a cache the server owns, not a
second truth a till can move.

**Redeeming.** A payment on a sale from the credit-note type, `reference` = the note's number, amount ≤ what
the till believes the balance is. `receipt.create` on the server, under `select … for update` of the note:

- note not found, `void`, or `expired` by its date, or `used`: the sale is stored and flagged, review reason
  `credit-note-refused`, with which; the till is told on its next pull as sales flagged today are
  (the owner settles it in the back office: it is money the shop did not get).
- amount over the balance (two tablets spent one note while apart, the second arriving now): stored and
  flagged `credit-overspent` with the excess; the balance goes to 0 and the note `used`. It is the exchange's
  own `exchange-unmatched` rule applied to a note.
- otherwise the balance comes down; 0 makes it `used` with `used_at`.

`payment.correct` from or to the credit-note type is refused (`bad-payment`), as for the exchange type.

**Expiry** is a fact of the date, judged on the server when the note is spent, and shown by the back office;
nothing runs nightly. A note past its date spent on a tablet that had no signal is flagged like one spent
twice, with the reason "expired on …".

**Void** is the owner's, in the back office, with a reason: for a note the shop decides not to honour (a slip
proven forged, a refund later found wrong). The refund stands; the voided note's balance goes to 0. The till
is sent the change with the pull.

**Reports.** The two types are not tenders that hold money: on Sales summary and Day closing, "By payment
type" leaves them out, and two lines are added under the day's cash and card: **Credit notes issued** (sum of
refund payments to the type) and **Credit notes redeemed** (sum of sale payments from it). The X and Z reports
on the till say the same two lines. Net sales are as they always were (sales less refunds). The exchange type's
zero line goes from the drawer count and the payment split at the same time (left as found in piece 5).

## 7. The till: spending a credit note

On a shop's Pay screen a tender **Credit note**, beside the others, offered only when the shop's type has been
sent to the till. It asks for the number: typed, or scanned from the slip (the scanner reads the barcode; a
scan on Sell of a number that is a note's opens Pay with it). The till looks the note up in its own table:

- found and open: "Credit note CN-T1-000012, Rs 270.00 left" and an amount, at most the balance and at most
  what is due, the balance offered. The rest of the sale is paid by any other tender, as a split is today; the
  note's rest stays on the note. One note at most on a sale.
- found and used, voided or expired: refused with the reason.
- not found: "This till does not know that note. Let it sync and try again, or take another payment." A till
  that works on its own knows every note it made; a connected till is sent the shop's open notes with the pull
  (`credit_notes` where `balance > 0` and not expired, as receipts of the last 30 days are sent), so a note
  made on another tablet is spendable here once both have synced. Never spent blind.

The till takes the balance down on its own row when the sale is written, and takes the server's figure on the
next pull. Two tablets apart can both spend one note: the server flags the second (section 6). That is the
price of a till that sells offline, and it is bounded by the note's amount.

**On the receipt**: "Credit note CN-T1-000012 · Rs 270.00", among the payments; "Rs 0.00 left on it" or
"Rs 120.00 left on it" under it.

**The customer.** When a note is spent and the sale has no customer but the note has one, the receipt names no
one; nothing attaches the customer to the sale by itself.

## 8. The back office

- **Credit notes**, a page of a shop's Finance group (`/backoffice/credit-notes`, `reports.view`): the open
  notes first (number, amount, left, valid to, customer, from which receipt, issued when and by whom), then a
  switch to used, expired, voided; a search by number or customer; a note opens to its redemptions (each sale
  and amount) and its refund. Void with a reason (`settings.device`, as a payment type's change is; the reason
  is kept). Nothing is issued from the back office: a note comes only out of an exchange at a till.
- **Receipts**: a refund that issued a note says so with the number; a sale that spent one says so; a flagged
  sale says why in words ("Credit note CN-… was already used up: Rs 100.00 of this sale is not covered").
- **Customers**: a customer's page lists their open notes with the balance.
- **Sales summary, Day closing**: the two lines of section 6.
- **POS settings, General**, for a shop: the three settings of section 3, with one sentence each on what the
  till does.
- **Dashboard**: nothing new.

## 9. Testing

- Server suites on dev, one at a time: `exchange-policy` (refund refused on `exchange`/`credit` with
  `refund-policy`; past the window with no approver `refund-window`, with an approver taken; window 0),
  `credit-notes` (issue with the refund: the pair refused when they disagree; redeem in full, in part, twice
  across two sales; overspent flagged and the note closed; expired flagged; void; the pull sends open notes
  only; `payment.correct` refused), and `shop-pages` extended (the page, a sale that spent a note on
  Receipts, the two report lines, the settings saved).
- Unit tests on the till: the Returns table of section 5 (what Pay says and whether it is on, for the three
  values and the three signs of `due`); the window in whole days, including the day it turns; the slip's
  text; the swap keys (other variants of the product, the returned one left out, none for a product without
  variants); the Credit note tender's amount cap.
- On the test emulator with the made-up shop: an exchange worth less under each of the three values; the note
  spent in part on one sale and the rest on another; a note from another tablet (fed by `DEMO_PULL`); the
  replay fixture extended with the note's operations and `retail-till-replay` proving the drawer and the
  note's balance agree with the server.
- On paper, through the stand-in printer: the slip, and a receipt that spent a note.

## 10. Decisions this design took, for the owner to confirm or overrule

1. The default is `exchange` (no refunds), window 7 days, notes valid 6 months. A shop that refunds today
   would, after this, refuse refunds until its setting is changed. **Alternative:** default `refund` so
   nothing changes for an existing shop; the Kids Corner client is set to `exchange` by hand. Since dev has
   one test shop and production none, I took the owner's own shop's rule as the default.
2. A credit note is spent in parts, the rest staying on it. Kids Corner has no notes; Lightspeed spends a
   gift card in parts. Alternative: one go, the rest forfeited: simpler, and the customer will refuse it.
3. One note at most on one sale.
4. The swap keys are on the exchange sheet, not on Sell. Alternative: a "Take instead" key on the Sell
   banner that opens the same row. Both can exist; the sheet first, where the returned line is in front of
   the cashier.
5. Expiry is judged when spent, not by a nightly job; the back office shows "expired" from the date.
6. A voided note's refund stands. If the whole exchange was wrong, the owner refunds the new sale and voids
   the note: two documents, each with its reason.
7. The two report lines are separate from "By payment type", not inside it. Alternative: list the two types
   with their sums as the other types; they would read as money taken, which they are not.

## 11. Not in this build

- A credit note from a plain return with nothing taken (the owner's "No").
- A credit note on a restaurant.
- Moving a note to another customer; combining notes; a note spent across two tills' sales at once.
- Paying out a note in cash (it is spent on goods only; the Returns setting `refund` gives money back at the
  exchange itself, before any note exists).
- Kids Corner's on-account credit (a tab for a named customer): the next piece, with deposits.
- A guest's phone or the public site: nothing.

## 12. What was built, and what was run (2026-10-14, the same day)

Built as the plan `docs/superpowers/plans/2026-10-14-exchange-policy-and-credit-notes.md` says: migration 0109 (applied on
dev), the till (database 26), the back office. Suites on dev, one at a time: `credit-notes` (new, 37 checks),
`retail-till`, `shop-pages` (section Y added); 580 unit tests; the back office type-checks.

**Two things the plan settled otherwise than section 4 says, and why.**
- *The window.* Section 4 had a cashier with the right to refund acting alone inside the window and a manager past
  it, which is what every refund already asked. As built, the window means something: inside it whoever is at the
  till returns alone, with no right needed; past it (and always, with a window of 0) the right to refund is needed,
  held or approved, exactly as before this. The server enforces the same (a vouched till's unapproved refund past
  the window is stored and flagged as 0082 has it; an unvouched login's is refused). There is no `refund-window`
  code: the refusal is `forbidden`, as it always was.
- *The note's number* is the refund's with `CN` for `R`: `DM-T1-R000002` issues `DM-T1-CN000002`. One series, one
  event.

**Run on the test emulator** (`easypay_claude_size`, 5598, with its window; the made-up shop on the offline plan,
seeded with `--es returns credit`; the stand-in printer at `10.0.2.2` catching every paper): the day opened; a scarf
(Rs 590) sold for cash; on Receipts the receipt offered **Exchange** and no Refund; the sheet said "Exchange
Rs 590.00" with no way to give money back; a mug (Rs 320) put on the sale, Sell saying "On a credit note · Rs 270.00"
and its key "Credit note"; Pay saying "ON A CREDIT NOTE Rs 270.00" with the sentence of section 5 and the key
"Credit note for Rs 270.00"; pressed: "Exchange complete · On a credit note, printed with the receipt Rs 270.00".
Three papers came out in order: the refund slip ("Exchange, to the new sale 320.00 · Credit note, kept for the
customer 270.00 · Ref: DM-T1-CN000002"), the receipt ("Returned goods 320.00 · Ref: DM-T1-R000002"), and the credit
note (CREDIT NOTE · DM-T1-CN000002 · VALUE Rs 270.00 · Valid to 14 April 2027 · From exchange of DM-T1-000001 · the
sentence · the number in bars). Then a candle (Rs 450): Pay's "Credit note" key, the number typed, "Use it": "Paid ·
Credit note DM-T1-CN000002 − Rs 270.00 · Remaining Rs 180.00", the rest by cash; the receipt says "Credit note
DM-T1-CN000002 270.00 · Cash 180.00". A postcard set then: the same note typed again was refused (the sheet closed,
nothing on the sale); the tablet's row reads balance 0, used.

**Not seen:** the swap keys on a product with variants (the Linen shirt); the policy `exchange` on the device ("Pick
something worth at least": unit-tested, the words seen only in code); a note from another tablet (the pull); the
window's PIN on the device; the back office in a browser (the pages are proven by `shop-pages`); a slip scanned
(the emulator has no scanner); a till that syncs (the made-up shop works on its own).

**Not built, found while running it:** the offline edition has no place on the tablet to change the three settings
(the server takes them from a till through `settings.save`, and a connected shop sets them in the back office; a
tablet that works on its own is `exchange` with 7 days and 6 months until a Settings row is built for it). The
emulator was shut down afterwards; the postcard sale C-4 was left open on it.
