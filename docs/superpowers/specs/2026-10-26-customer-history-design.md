# A customer's history in the back office

Asked 2026-10-26: "In the backoffice we need a place where we can see the history of customers". The owner chose
"Their visits" over one timeline of everything and a record of changes to a customer's details, and approved the
design below with "write spec and plan and build".

## 1. What it is

A page per customer, `/backoffice/customers/<id>`, for restaurants and shops alike. It is opened from Customers:
the customer's name in the table is a link, and the row's open panel has a History link. A customer's account page
(shops) links to it too.

## 2. What it shows

- **Head:** the name. The lede gives the phone, the email, the note and the loyalty card, and says when the
  customer was removed from Customers. A removed customer's page still opens: their receipts stay. A button goes
  back to All customers. For a shop, more buttons, each only when there is something behind it:
  - Account: their account page;
  - Deposits: Deposits, all of them, found by their name;
  - Credit notes: Credit notes, found by their name.
- **Figures**, over every receipt and not only the ones listed:
  - Visits: the orders they paid for. A split bill is one visit. Under it, the first visit.
  - Spent: sales less refunds. Under it, where loyalty is kept, the points to spend.
  - Average per visit: Spent divided by Visits.
  - Last visit.
- **Buys most:** the five items with the most taken home, returns taken off.
- **Receipts:** every sale and refund, newest first, the latest 200. Each opens to the same card as on the Orders
  report: the items, discounts, tax, total and payments. It also gives the cashier, the store (only when the
  business has more than one) and the points the receipt earned or used.

## 3. Which receipts are a customer's

A receipt is the customer's when the order it was paid on carries them (`tickets.customer_id`). This is how
Customers counts Spent, so the page's Spent equals that column for every customer. `receipts.customer_id` (0128) is
set only when points moved, so it is not used to find receipts.

## 4. Who sees it

The name and details are shown to anyone who may open the back office, as on Customers. The figures, Buys most and
the receipts are shown only to a role allowed to see reports (`reports.view`), as on a customer's account page. No
permission is added: the owner sets permissions themselves.

## 5. The Orders card, shared

The receipt card of the Orders report, with its lines, payments and discounts queries, moves into one shared file.
Orders and the history then draw a receipt the same way. What Orders shows does not change.

## 6. Not built

Changing a customer here (that stays on Customers), printing or emailing the history, or picking dates.

## 7. Also in this change: words beside a box

The owner, the same day, with a picture of POS settings: "please fix the alignments of the words there are many
places where they are not aligned properly". A word after a number box ("days", "months", "days on promotion") sat
at the top of the box, not beside it. The `check` label holds a checkbox and its words to the top, and a number box,
a time or a list given the same label inherited that. Such a label now centres its words on the box. Every page
that used the label that way is checked.

Three more faults of the same kind, found while checking:

- **Boxes out of line.** Each box sat wherever its word ended, so the boxes of one card zigzagged: 7, 6, 30 and 14
  at different places. Such a label now takes at least 150 pixels, so the boxes share one column. "days on
  promotion" became "days", to fit that column. The setting's title already says "still unsold after".
- **Choices squeezed on a phone.** Below 640 pixels, a list of choices stacked one over another ("A credit note for
  it / Given back / Kept by the shop") was squeezed until its words ran over each other. On a phone, a setting's
  control now goes under its words. A choice that wraps now grows taller instead of spilling out.
- **A broken line over a total.** The line over a total (`.kv`, used by the receipt card and other pages) broke at
  the gap between its two columns. It now runs on.

## 8. Checked (2026-10-26 and 27)

- `tsc` is clean, and `next build` passes; `/backoffice/customers/[customer]` is among its routes.
- `db/tests/customer-history.test.cjs`, new, passes 26 of 26. It uses a made-up restaurant and a made-up shop in a
  rolled-back transaction.
  - The restaurant has a split bill, a refund and two items. The page's Spent of Rs 575.00 equals the Customers
    column.
  - A role without `reports.view` sees the name only.
  - A customer who bought nothing, a removed customer and an unknown id are each handled.
  - Orders draws the same six receipts, with the same figures, as before the card moved.
  - In the shop, a customer bought on account. Their page has the Account button, and none for deposits or credit
    notes, which they do not have. The account page links back to the history.
- `seats-customers` passes. `shop-pages` passes except A4. That check is on the Accounts list, which this change
  does not touch. Its test bill was made about 40 minutes earlier and the clock had passed midnight, so the page
  said "1 day" where the check expects "0 days".
- No dev client has a customer with an order, so Spent could not be compared on real data. The suite stands in for
  that.
- 73 back office pages were drawn read-only for Hamaad Retail and Saheer Resto, with the real stylesheet. A script
  in headless Chrome measured the middle of each word against the box or button beside it, at 512 pixels (the
  narrowest headless Chrome draws, under the 640-pixel phone rules) and at 1280.
  - With the old style, it found every word after a number box 11 pixels high: 13 on POS settings.
  - With the new style, it found none.
  - What it still reports are checkboxes beside a title and a description on two lines, held to the top on
    purpose.
- The history page was looked at light and dark, at 1280 and 512, and as the role without reports.
- Not seen: the page signed in, in a real browser.
