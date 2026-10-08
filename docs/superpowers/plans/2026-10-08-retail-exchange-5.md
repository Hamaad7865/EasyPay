# Retail piece 5: the exchange, as built

**Goal:** At a shop's till, goods come back and the customer takes something else on the same visit, in one go; only the difference changes hands.

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, section 9 (piece 5: "The one-flow exchange; transfers between shops"). Built on 2026-10-08, at night, with the user away. Transfers were not built: see the end.

**Commit:** `026f1bb`. Migration `0079_exchange.sql`, on dev only.

## What an exchange is

It stays what it was on the books: a refund and a sale, the two documents the server already takes. Nothing about a receipt, a refund, stock or VAT changes. What is new is how the two are settled against each other.

**The decision made here, for the user to confirm.** The part of the new sale that the returned goods pay for has to be written as a payment on both documents (the server wants a refund's payments to equal its amount, and a sale's to equal its total). Three ways were weighed:

| Way | What it does to the books |
|---|---|
| Write it as cash on both | Cash nets out, but a card-only exchange shows cash that never moved, and a refund refused by the server leaves the drawer overstated with nothing to show for it. |
| Write it under the type the difference is paid in | Net totals are right, but the card total holds a refund and a charge the terminal never saw. |
| **A payment type of its own (built)** | A shop gets one type of kind `exchange`. The refund pays that amount out to it and the sale is paid that amount from it: the same amount both ways, so it comes to nothing. Cash and card hold only what changed hands. If a refund does not arrive, the type is left holding its amount, and the sale is flagged. |

It is not store credit: nothing is kept on it from one visit to the next, and a till does not offer it as a way to pay.

## As built

**Server (migration 0079).**
- `payment_types.kind` may be `exchange`; at most one live per tenant. `ensure_exchange_type(tenant)` makes it (named "Exchange"; another name if the shop already uses that one). A tenant gets it when it becomes a shop and loses it (kept, soft-deleted, for the receipts that name it) when it becomes a restaurant; every shop on dev was given one.
- `receipt.create`: a payment of that kind names the refund it comes from (`reference` = the refund's number). If that refund is not there, gave another amount to an exchange, or was already used by another sale, the sale is stored and flagged: review reason `exchange-unmatched`.
- `payment.correct` is refused from or to that kind (`bad-payment`).
- Nothing else changed. `refund.create` already took several payments.

**Back office.** The Exchange type is not among the payment options a shop edits (Settings), and cannot be renamed, switched off or removed there. Receipts says in words why a sale is flagged `exchange-unmatched`. Reports show it like any payment type: "Exchange, 2 payments, Rs 0.00".

**Till (build 3).**
- Receipts, a shop's refund sheet: a second button, **Exchange**. It needs the right to refund (a cashier is asked for a manager's PIN), keeps what comes back (lines, put back or not, reason), and goes to Sell. Nothing is refunded yet.
- Sell: a banner says which receipt, how many lines and what they are worth, with a cross to cancel. The Pay key shows what is left: "Pay Rs 270.00", "Give back Rs 270.00" or "Exchange, nothing to pay".
- The exchange belongs to the sale it is rung up on: a parked sale keeps it, a sale rung up for another customer in between has none, a cleared sale drops it. It is kept in memory: a till that stops in between has refunded nothing.
- Pay: sale total, less what comes back, and what is left to pay or to give back; one payment type for the difference. No split.
- On confirm, one local transaction writes the refund (first) and the sale. If the sale cannot be written, the refund is not either. The refund slip prints, then the receipt; the drawer opens when cash moved.
- A receipt paid in part with returned goods says "Paid with returned goods"; its payment cannot be "corrected".

## What was run

**Server suite** `db/tests/retail-till.test.cjs`, section E (16 checks, 49 in all): a shop has one Exchange type and cannot be given a second; an exchange worth more (card takes the difference, cash and the exchange type unchanged), worth less (cash goes back), and even with the goods faulty (written off, not put back); the sale names its refund; a sale against a refund that is not there, for another amount, or already used, is stored and flagged, and the first sale that used it stays clean; a correction from or to the exchange is refused and another still works; the type follows the kind of business; a till is sent it.

**On the test emulator** (`easypay_claude_test`, never the user's), the debug build's made-up shop, no login:
1. Mug and scarf sold for cash (Rs 910.00).
2. The mug back for a scarf: Rs 590.00, returned Rs 320.00, Rs 270.00 by card.
3. The scarf back as faulty for a mug: Rs 320.00, returned Rs 590.00, Rs 270.00 given back in cash; the scarf is written off.
4. A scarf for a scarf: nothing to pay.
5. As the cashier: a mug sold; its exchange asked for the owner's PIN; a bag rung up on it; the sale parked; a mug sold to another customer by card with no exchange on it; the parked sale brought back with its exchange; Rs 70.00 paid with Rs 100.00, Rs 30.00 change.
6. An exchange started and cancelled: nothing refunded.
7. Today: net sales Rs 1,620.00, cash Rs 1,030.00, card Rs 590.00. The drawer counted at Rs 2,030.00 against Rs 1,000.00 float and Rs 1,030.00 of cash sales: balanced. Day closed. No crash in the device log.

**The till's own operations on the server.** `db/scripts/read-till-state.cjs` (new) reads the emulator's till database; the 32 operations of that run are the fixture `db/tests/fixtures/demo-till-exchange.json`, and `db/tests/retail-till-replay.test.cjs` sends them to dev in a rolled-back transaction: every one is taken, every receipt equal to the cent and not flagged, the 14 payments the same on both, nothing left in the exchange type, each sale naming its refund, the stock the same, and the drawer the server works out equal to the till's.

**The back office with an exchange in it** (`db/tests/shop-pages.test.cjs`, section X): what was collected goes up by the difference alone; by payment method, cash holds what changed hands and the exchange holds nothing; Order details names the refund; Settings does not list the type; a sale against a missing refund is on the Receipts page with the reason.

## Not run, and why

- **On paper.** No printer: the slips' wording was read from what the till keeps to print ("Returned goods, Ref: DM-T1-R000002"; "Exchange, to the new sale").
- **A till signed in.** As for piece 4: the till's operations against the server's functions, not the network sync from a device.
- **A refund the server refuses under a real till.** The server's side is in the suite (the sale is flagged). What a till shows for an operation the server refused is as it was before this work.

## Left as found

- A zero line "Exchange, Rs 0.00" shows among the other tenders on the till's drawer count and in the back office's payment split. It says exchanges came to nothing; it could be hidden when it is zero.
- The exchange is for one receipt at a time, and one payment type for the difference.
- If the till is closed between starting an exchange and paying it, the exchange is gone and is started again from the receipt. Nothing was written, so nothing is lost.

## Transfers between shops: proposed, not built

The other half of piece 5. Not built, because the back office cannot show a second shop yet, and a transfer to a shop nobody can look at is half a feature:

- Stock on hand, Counts, Movements, Purchase orders and receiving, Stock reports, the product page and the import all show the customer's first shop (`first_store()`, 20 uses in 11 files).
- No customer on dev has two shops, and the store-hierarchy note says the second-store gaps are to be proposed before they are built.

**What it would take, in order:** (1) a shop picker on those pages, kept in the address, with the first shop as the default; (2) a transfer document (from, to, lines, sent, received) with its number series; (3) two stock movements per line, each with its own `ref_type`, the leaving one refused when the source does not hold the goods (the design's rule from Kids Corner 029); (4) the Movements page and the stock reports reading both ends. A customer with one shop would see none of it.
