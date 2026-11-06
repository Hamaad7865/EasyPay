# Receipts: a dated list, and each receipt in a pop-up

Asked 2026-11-07, with two pictures of Carfectionist's Tickets view (a list for a period, a ticket opened in a pop-up with Open sale, Email and Print): "In receipts module in EasyPayPos back office can we have it somehow like this please? clicking on the shows the receipt sharable etc... and then we can also change payment method".

The owner's choices:
- Sharing works like the tablet's: WhatsApp and Email hand the receipt as text to the owner's own apps (the customer's number and address filled in when the sale has a customer), Print uses the browser at receipt width (Save as PDF there), plus Copy. Nothing is hosted or sent by EasyPay.
- "Yes, build it" to the design below.

## The list (`/backoffice/receipts`)

- From and To dates, today by default; Clear goes back to today. The branch picker when the account has several branches.
- `q` (the links from Accounts, Deposits and the Sales journal already send one) finds a receipt by number on any day; when one receipt matches, its pop-up opens.
- `view=check`: every receipt still to check, whatever the dates. The warning counts them all, with the same `where` as the menu badge (`counts/route.ts`).
- One line per receipt: number, order (table, order number or customer; a shop: order name or customer), date, time, till, cashier, paid by, total without tax, total. Marks: Refund, To check, corrected.
- The count and the totals, at the top and the foot: from `receipt_revenue` with `counts_as_sale`, refunds taken off, the store's day, so they are what Orders / Sales give for those days. A double payment is listed (it needs signing off) but not counted.
- At most 500 lines; past that, a line says to narrow the dates.
- Seeing receipts needs `reports.view`, as Orders does.

## The pop-up (`?r=<receipt id>`, kept with the dates)

- The receipt as the till prints it, drawn by `web/lib/papers.ts` with the business's own receipt design, logo, header and footer notes, at 80 mm. With several branches the paper names the branch and gives its address and phone, as the till does (`PosSettings.shop`).
- The tablet keeps what it printed on the tablet (`ReceiptEntity.doc`), so the pop-up rebuilds the paper from the server's rows (`web/lib/receipt-doc.ts`):
  - subtotal, discount, tax, service, rounding and total are the stored figures, never worked out again;
  - each line: `(unit price x qty + 500) / 1000` plus its add-ons, the add-ons with their prices;
  - the tax lines: each line's share of the discount taken off, each tax worked out as the server and the till do (`DocBuilder.taxes`); what rounding leaves over goes on the largest, so they add up to the stored tax;
  - marked as a copy (`OrderOps.marked`): COPY, what has been refunded since, and no account balance or points balance of that day. So a copy cannot be brought back for a second refund.
- Paid by, with Change beside each payment; the reasons to check, with Sign off.
- Copy, WhatsApp, Email, Print, and the customer's history when the sale has a customer.

## Changing the payment method

- Through `push_payment_correct`, as before: the reports use the new type, the receipt says "corrected from".
- After it, the page comes back with the same dates and the pop-up open.
- Only plain types are offered: not On account, Exchange, Credit note or Deposit (the server accepts them; they would put money where none went). Not offered on those payments either, as before.
- Not offered for a client live on MRA, with the reason; `mra-no-correction` is said in words if it comes back anyway.
- Needs `payment.correct`.

## Not in it

- No till build, no migration: live with a `live-` tag, which is the owner's to ask for.
- An MRA client's copy carries no IRN or QR code.
- No Open sale: EasyPay has no page per sale.

## Checks

- `web/lib/receipt-doc.test.mjs`: the tax split, the copy marks, the text.
- `db/tests/receipt-popup.test.cjs`: a till sale with a discount, an included tax and a priced add-on, through `sync_push`; the pop-up's paper says the stored total and its tax lines add up to the stored tax; the period totals equal Orders'; the To check view; `q`; a role without reports; a correction comes back to the pop-up; special payment types not offered.
- Type-check, `next build`, the Receipts page drawn in both looks with no sign-in.
