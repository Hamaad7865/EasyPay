# How many of an add-on

2026-10-13. Asked by the owner: "We need to be able to add more than one add on. For example if the customer is buying grillade + sausage as add on. We need to be able to select how much sausages he wants". The approach below was put to them with one question, how a group's "Most" counts, and answered "Each one counts".

## What was wrong

1. **Only one add-on could be picked in an "any number" group.** The add-on editor, on the tablet and in the back office, says "Most 0 is as many as they like". The selling pop-up took 0 for one, so a second add-on took the place of the first.
2. **An add-on had no quantity.** A line held each add-on once, on the tablet and on the server: the rows are keyed by the line and the add-on.

## The rules

- A group whose Most is 1 is one where a single thing is chosen (how it is cooked). A tap moves the pick. Nothing is counted there.
- In every other group a tap picks an add-on or takes it off. A picked add-on has minus, how many and plus on it. Minus at one takes it off.
- **Each one counts.** Three sausages fill "up to 3", and two sausages and an egg fill it too. The Fewest counts the same way.
- Most 0 is as many as they like, up to 99 of one add-on.
- An add-on is charged once for the line, whatever the line's own quantity, as it was before. Two grillades with three sausages are two grillades and three sausages.
- Two lines of the same item merge only when they carry the same add-ons and as many of each.

## How it is kept

`ticket_line_modifiers` and `receipt_line_modifiers` get `qty`, one where nothing is said (migration 0105; the tablet's database, version 21).

`price` keeps its meaning: what the add-on adds to the line. For three sausages at Rs 50 it is Rs 150. Every sum written before adds `price` as it is and stays right: the receipt's subtotal and tax, a refund's shares, the split check, the reports of the back office, the tablet's totals. None of them changed.

Four server functions changed, each rebuilt from its live definition:

| Function | Change |
|---|---|
| `push_ticket_add_line` | takes `qty` on each add-on, 1 to 99; none sent is one |
| `push_ticket_split_line` | the part taken off keeps the counts |
| `push_receipt_create` | the receipt keeps the counts; an add-on's price is held against the catalog's price for that many |
| `push_refund_create` | a refund keeps the counts |

Without the change to `push_receipt_create`, three sausages at the right price would be marked for review as a price that had drifted from one.

## Where the count is said

- The pop-up, on the picked add-on.
- The order: "+ 3 × Sausage" with what the three cost.
- Receipts and kitchen tickets: "+ 3 x Sausage". The kitchen screen and the lists of orders read the same text as the order.
- The back office's order report: "3 × Sausage".

## Release order

A till must not send counts to a server that has not had 0105: the server would keep the price of three and mark the receipt for review. One tag runs the migrations before a tablet is offered the new build. A till built before this sends no count and is unaffected.

## Not in this piece

- Guests ordering from their phones take one of each add-on. A group with Most 0 is published to phones as "up to" the number of its choices (it was published as one).
- A limit for each choice by itself. The group's Most does that job.
- Changing the add-ons of a line already on the order.
- The guest order shown to the cashier multiplies add-ons by the line's quantity, while the till charges them once. Noticed, left as it is.

## Checked

- `db/tests/addon-counts.test.cjs`, 16 checks on dev: a count kept on the line, the receipt and a refund; no review for the right price; a review with both figures for a wrong one; no count sent is one; 0 and 100 refused; a split keeps the count; a pull hands it out.
- The suites that already covered orders, receipts, refunds and splits pass unchanged.
- Unit tests of the rules (`GuestTest`): a tap, one more, one fewer, the most, Most 0, what a phone is told.
