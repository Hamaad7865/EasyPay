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
  - Visits: the orders they paid for. A split bill is one visit.
  - Spent: sales less refunds.
  - Average per visit: Spent divided by Visits.
  - First visit and last visit.
  - Points: the balance, where loyalty is kept.
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

## 8. Checked

- `tsc` and `next build`;
- the page opened through `db/tests/page.cjs` for the dev clients, both as the owner and as a role without
  `reports.view`;
- for every customer with an order on those clients, the page's Spent against the Spent column on Customers;
- the settings and other pages with the label, drawn with the real stylesheet and looked at, light and dark.
