# Invoices: design (2026-11-12)

The owner asked for A4 invoices for business customers, from a screenshot of another product's invoice
editor: "create this but much much much better". EasyPay has receipts, bills on account and store credit
notes, but nothing a business customer can be sent: no A4 tax invoice, no numbered series, no payment
terms. This is the design of **Invoices**: a list page and a full-page editor in the back office.

Slice 1 (this spec): invoices, from draft to paid. Slice 2 (proposed after slice 1, not built):
quotations and proformas that turn into an invoice, delivery notes, a credit note against an invoice,
sending by email with the PDF attached, recurring invoices.

## 1. What a person does

- **Invoices** (Finance, under Receipts): tabs Drafts, Issued, Partly paid, Overdue, Paid, All. A strip
  on top for today and the open balance (issued today, received today, still owed, overdue). Search
  (number, customer, reference), a branch picker as on the stock pages, CSV of the list. A row opens
  the invoice. New invoice opens the editor on a fresh draft.
- **The editor** (`/backoffice/invoices/<id>`), a full page:
  - *Bill to*: find a customer as you type (name, phone, email) or add one there and then. Their saved
    invoice details fill in (address, BRN, VAT number, buyer type, language, email copy). Buyer type
    Person / Business / Government (B2C, B2B, B2G); for a business the BRN and VAT number are asked.
    Extra fields open on demand: copy to (email), contact person, phone, deliver to.
  - *Dates and terms*: issued on, terms (on receipt, 7, 15, 30, 60 days, end of month, or a date),
    due on (worked out, or typed), their reference (PO), our reference, salesperson.
  - *Lines*: one box finds a product by name, SKU or barcode (a scanner works: it types and presses
    Enter); Enter adds the line, a product with variants asks which. Quantity, price and discount edit in
    place; Tab moves along; Enter on the last field starts a new line. A heading line and a note line
    can be put between. Lines move up and down. Each line shows its VAT, its stock at this branch (red
    when the invoice asks for more than there is), and, for someone who may see cost, its margin.
  - *Totals*: subtotal, a discount on the whole invoice (Rs or %), VAT tax by tax, total. Prices can be
    shown with or without VAT (the figures do not change, only how they are shown).
  - *Note to the customer*, and the shop's own payment details (bank, account, terms) shown as they will
    print.
  - *Customer at a glance* (side): what they owe (bills on account and open invoices), what is overdue,
    their last invoices, and the products they buy most with the price they last paid; one click adds
    a product at that price.
  - Buttons: **Issue** (numbers and locks it), **Print or PDF**, **Delete draft**. A draft saves
    itself a moment after each change; the page says "Saved" or "Not saved: <why>".
- **An issued invoice** shows the same page read-only, with **Record a payment** (date, amount, how
  paid, reference), the payments so far, **Print or PDF**, **Send on WhatsApp** and **Email** (as the
  receipts pop-up does: the text and the link to open, from the customer's phone or address).
- **Invoice set-up** (a panel on the Invoices page): bank details, default terms, default language,
  the footer note, and per branch the number's prefix and where its numbers start.

## 2. Choices I made (the owner can change any of them)

1. **Money is the till's.** One set of rules for every figure, the same as `push_receipt_create`
   (0049, still the receipt's rules): a line is `line_amount(unit, qty)` with qty in thousandths; the
   whole-invoice discount is a percent `(sub*pct+50)/100` or an amount up to the subtotal, spread over
   the lines as `disc*base/sub` (truncated); added tax `(x*rate+5000)/10000`, included tax
   `(x*rate+div/2)/div` with `div = 10000+rate`; total = sub − discount + added tax. No service charge
   and no rounding on an invoice (it is paid to the cent). The editor shows totals from one pure module
   (`web/lib/invoice-money.ts`, built on `receipt-doc.ts`'s `lineAmount` and its tax rule); the server
   works them out again in SQL when it saves and when it issues, and a test pushes the same lines
   through the real receipt push and asks for the same figures.
2. **A line's discount is a lower price**, the way the till changes a price: the line keeps the
   catalog price as "was" and charges the lower one. So there is no second discount rule per line.
3. **VAT comes from the product's own taxes** at the time it is put on the invoice, kept on the line
   (name, rate, included or added). Issuing keeps them as they were on the draft.
4. **Numbers:** a draft has none. Issuing takes the next number of the invoice's branch inside the same
   transaction, so a failed issue leaves no gap and two people never get the same number. One series per
   branch: `INV-00001` with one branch, `INV-<branch code>-00001` with several (the prefix can be set).
   A shop coming from another system sets where its numbers start, before its first invoice and only
   upwards.
5. **Lifecycle:** stored as draft or issued. Partly paid, paid and overdue are worked out from the
   payments and the due date, never stored, so they cannot disagree. An issued invoice is never changed:
   the database refuses any change to its lines or its figures. **In slice 1 there is no way to correct
   an issued invoice**; the credit note against an invoice is slice 2. A draft can be deleted; an issued
   invoice cannot.
6. **Payments** are recorded in the back office against one invoice (Bank transfer, Cheque, Cash, Card,
   Mobile money, Other), never more than what is owed. A payment typed in error is cancelled, not
   deleted: it stays on the invoice, struck through, with who and when. Back-office payments do not
   reach a till's drawer or its Z report (money at the counter stays the tablet's).
7. **Customer accounts are not changed.** Bills on account stay the tablet's (owner, 2026-10-17: money
   on accounts is taken on the tablet only). Invoices keep their own balance; the side card, the
   customer's page and the invoice list add the two together where a total owed is shown. No credit
   limit (the owner chose none for accounts); the warning is for what is overdue: an invoice past its
   due date, or a bill on account older than the shop's account days.
8. **Stock:** issuing takes the products off the shelf of the invoice's branch, through the stock
   engine and the made-of parts (`stock_parts`, 0112) as a sale does, one movement per product, reason
   `sale`, document `invoice`. Going below zero is allowed, as at the till; the editor warns first.
9. **Customers' invoice details** (address, BRN, VAT number, buyer type, language, email copy) are kept
   in their own table, not on `customers`: the tills pull `customers` whole and need none of it.
10. **Reports:** the Sales journal counts an invoice's payments as money received, and the Tax page
    counts the VAT of invoices issued in the period, so the owner's VAT figure is complete.
11. **Deleting transactions** (Backup and data, Clear test activity, Go live, removing a client)
    removes invoices, their payments and their numbers too, like orders and deliveries.
12. **Who:** a new permission, "Make and issue invoices, record their payments", held by the owner
    until given to a role. Margin and cost are shown only to "See cost and profit".
13. **Words:** a shop's pages say products and catalog; a restaurant's say items and menu. Nothing on
    these pages speaks of tables, kitchen or guests.
14. **The PDF** is the browser's: the print page is laid out for A4 and "Print or PDF" opens it with
    the print dialog, where Save as PDF is a choice. English or French per invoice, from the customer's
    saved language, else the shop's default.
15. **No online payment link**: EasyPay has no payment gateway. The invoice prints the bank details and
    the terms instead.
16. **Currency:** rupees only in slice 1.

## 3. The owner's answers (2026-11-12)

1. **MRA: hand it to a till.** Issuing a Premium MRA client's invoice in the back office will queue it
   for one of the client's tills, which sends it with its own MRA login on its next sync; the IRN and QR
   come back and print on the A4. That needs a till release and its own design, so it is a piece after
   slice 1. **Until it is built**, a client on Premium MRA in training or live can make drafts but cannot
   issue, and the page says why. Nothing in slice 1 talks to the MRA.
2. **Plans:** every plan with a back office (trial and Premium; the offline plan has none).
3. **Business types:** shops and restaurants.
4. **Payments:** recorded in the back office; the customer's total owed shows bills on account and open
   invoices side by side. Tablet accounts are unchanged.

## 4. The questions as they were put

1. How should a Premium MRA client's invoice be fiscalised, given that the MRA login lives on the
   tills? (a) the back office hands the issued invoice to one of the client's tills, which sends it with
   its own login and the QR comes back; (b) invoices for such a client are made on the till; (c) no
   back-office invoices for MRA clients.
2. Which plans get invoices: every plan with a back office, Premium only, or a paid extra like deposits
   and accounts?
3. Restaurants too (catering, corporate lunches), or shops only?
4. May payments on invoices be recorded in the back office (bank transfers and cheques arrive there),
   and should an invoice's balance count in the customer's account balance that the tablet shows?

## 5. Data (migration 0159)

- `invoice_setup` (one per tenant): bank name, account name, account number, IBAN/SWIFT, default
  terms, default language, footer note.
- `invoice_series` (one per branch): prefix, next number, `started` once the first invoice is issued.
- `invoice_customers` (one per customer): address, BRN, VAT number, buyer type, language, email copy,
  contact, phone, deliver to, terms.
- `invoices`: branch, customer, number (null while a draft), status (`draft`, `issued`), the buyer as
  printed, dates and terms, references, salesperson, language, note, discount, the figures (subtotal,
  discount, tax, total), paid so far, who made and who issued it and when.
- `invoice_lines`: position, kind (`line`, `heading`, `note`), product and variant, name, detail, qty
  (thousandths), unit price, catalog price ("was"), taxes as kept, cost as kept (for margin).
- `invoice_payments`: invoice, day, amount, how, reference, who; cancelled at, by.
- Functions: `invoice_save` (a draft and its lines, figures worked out), `invoice_issue` (lock, number,
  stock, figures again), `invoice_pay`, `invoice_pay_cancel`, `invoice_totals` (the rules of §2.1),
  `invoice_series_start`. Triggers refuse changes to an issued invoice's lines and figures.
- Each table: RLS on and forced, the tenant policy, `trg_touch`, the `server_seq` index, as 0074.

## 6. Checks

- `web/lib/invoice-money.test.mjs`: the module against hand-worked cases and against `taxLines`.
- `db/tests/invoices.test.cjs` (dev, one probe client, rolled back): totals equal a real receipt push of
  the same lines; numbers have no gap and continue from the start set; an issued invoice refuses every
  change; payments cannot exceed the balance; stock goes down once, with made-of parts; purge removes it
  all; an MRA client cannot issue; the permission is needed.
- `db/tests/shop-pages.test.cjs` W1: the new pages say nothing of a restaurant to a shop.
- The pages drawn read-only from the dev data (the sign-in is the owner's).
