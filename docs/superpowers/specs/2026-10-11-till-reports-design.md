# Reports on the tablet: design (piece 7 of the hybrid plan)

The overall plan is `2026-10-10-hybrid-offline-premium-design.md`. Its order of work, as the owner set it
on 2026-10-11, puts reports on the tablet next: "just do reports I'll you a picture what reports we need
and then do 5". Told the reports would start from the back office's own until the picture came, they
wrote "yes these 4 very nice start it right away", and then sent the picture.

**The picture** is the Report menu of another till app, on a small tablet. On the left: Report, Stock,
Promotion, Member, Cashier Settings, Hardware, Data Processing, About. On the right, under Report, nine
lines: **Sales Summary, Sales Analysis, Item Sales Rank, Hourly Sales Report, Transaction Detail, Price
Change, Resettlement, Shift Record, Tax Report**. The last is cut by the edge of the screen; whether more
follow is not known.

Those nine are the reports. What each one holds in EasyPay is my reading of its name (section 2), and
is the owner's to correct.

## 1. What there is today

- **The till already works out a period's figures.** `CashOps.period(device, from, to)` gives, for this
  till between two moments: how many sales and refunds and what they came to, discounts, VAT, what
  changed prices came to, the payments by type, sales by category, VAT by rate, cash in and out. The
  day-closing report (Z), the X report and the cash drawer report are all made from it.
- **Every receipt keeps what it printed** (`receipts.doc`, a `ReceiptDoc`): its lines (name, quantity,
  amount, category, and for a line charged another price what it was listed at and why), its VAT by
  rate, its discounts, its payments, the cashier, the waiter and the order type.
- **The tablet keeps** every day opened and closed on it (`shifts`, `day_closes`), each count of the
  drawer and each cash movement.
- **The tablet keeps no record of two things:** a product's price being changed (the change is queued
  for the server and the old price is gone), and a payment type corrected after the sale (the payment
  is rewritten and what it was is gone).
- On the tablet, Today shows the day's headline figures, and More has a Reports page for the X report
  and closing the day. Every other report is in the web back office.

## 2. The nine reports

All are of **this till**, for a **period** picked at the top: Today, Yesterday, This week, This month,
Last month, or any two dates. Money is as the day closing says it; a refund counts against the day it
was made.

| Report | What it shows |
|---|---|
| **Sales Summary** | Net sales, and how it is made up: gross sales, refunds, discounts, VAT. How many sales and the average sale. What was paid by each payment type, with its share. Cash put in and taken out. A line a day. |
| **Sales Analysis** | The same sales cut three ways, one at a time: by category, by member of staff, and (a restaurant) by order type. Each with quantity or sales count, amount and share. |
| **Item Sales Rank** | Every product sold, ranked: quantity, amount, share. Ranked by amount or by quantity. Search by name. |
| **Hourly Sales Report** | For each hour of the day: how many sales and what they came to, as bars. Over several days, the hours are added together. |
| **Transaction Detail** | Every receipt and refund of the period: number, time, who, how it was paid, total. A tap opens the receipt as it printed, with Print again. |
| **Price Change** | Two lists. Lines sold at another price than listed: the product, what it was listed at, what was charged, why ("10% off", "Price changed"), who, which receipt. And products whose own price was changed on this till: from what to what, when, by whom. |
| **Resettlement** | What was undone after it was paid. Refunds: the refund's number, the sale it refunds, the amount, who. And payments corrected: the receipt, what it was paid by, what it was changed to, when, by whom. |
| **Shift Record** | Each day opened and closed on this till: when and by whom, the float, what the drawer should have held, what was counted, the difference, cash in and out. A tap opens that day's closing report, with Print again. |
| **Tax Report** | For each VAT rate: sales excluding VAT, the VAT, sales including VAT. |

"Resettlement" in the other app most likely means a paid bill opened again and settled another way.
EasyPay's nearest things are a refund and a corrected payment type, so the report lists both.

## 3. Where it is

- A **Reports** screen, in the side menu of a restaurant's till and of a shop's, and behind a key on
  Today. It is laid out as the picture is: the nine reports listed on the left, the open one on the
  right, the period above it.
- It opens for whoever may see the day's figures (`shift.view_report`, as Today), or with a manager's
  PIN, which lasts while the screen is open.
- More's Reports page stays as it is: the X report and closing the day are about the day that is open,
  not about a period.
- **Print** on every report: it prints on the receipt printer, as narrow columns. Saving a report as a
  file comes with backup and restore (piece 4), which brings the tablet its file handling.

## 4. Where the figures come from

- Sales Summary and Tax Report are `CashOps.period` over the period picked, so they always agree with
  the day closings. The line a day is the same sum, a day at a time.
- Sales Analysis, Item Sales Rank and the first list of Price Change are added up from what each
  receipt printed (its lines, cashier, waiter, order type). Hourly is each receipt's own time.
- Transaction Detail and the refunds of Resettlement are the receipts themselves. Shift Record is
  `shifts` and `day_closes`.
- **One new table, `till_log`**, for the two things the tablet does not keep: a product's price changed
  (which product, from, to) and a payment corrected (which receipt, from which type, to which), each
  with when, who and who approved. Written in the same transaction as the change. It is the tablet's
  own: nothing is sent to the server, and the server sends none of it. The tablet's database goes up
  one version for it.
- The rules are plain Kotlin (`core/data/Reports.kt`): each report is a function of receipts, printed
  records and rows, tested on the JVM with made-up receipts, and one test holds Sales Summary against
  `CashOps.period` for the same period.

## 5. What a report covers, said on the screen

- The receipts this tablet holds of its own sales. On a tablet that stands alone that is everything
  since its first day. A till linked to the cloud keeps its own sales too, until it is signed out and
  set up again: then it starts from the day it was set up.
- Price changes and corrected payments are listed from the build that brings the log. Earlier ones
  were not written down on the tablet, and the report says from which day it knows.
- Another till's sales are not in a till's reports. Every till together is the back office's.

## 6. How it is checked

- Unit tests for every report's arithmetic, including a refund, a discount on a bill and on a line, a
  price changed at the sale, a product sold by weight, two VAT rates, and a day with no sales.
- On an emulator with the made-up shop and the made-up restaurant: sales rung up, a refund, a price
  changed, a payment corrected, a day closed; then each report read against what was done, the period
  keys, a print to the stand-in printer, the manager's PIN for a cashier, and a lower screen.

## 7. Build

Two plans, one release:

1. The Reports screen and the seven reports that need nothing new: Sales Summary, Sales Analysis, Item
   Sales Rank, Hourly Sales Report, Transaction Detail, Shift Record, Tax Report; Print.
2. The log, then Price Change and Resettlement.

No server change. The till's database was taken to version 15 by the table-ordering work on
2026-10-11; the log makes it 16, or the next free number at the time.

## 8. What I decided and the owner has not confirmed

- What each of the nine names means in EasyPay (section 2), above all Sales Analysis (three cuts),
  Price Change (two lists) and Resettlement (refunds and corrected payments).
- Reports are of this till only (section 5).
- A period is whole days by the tablet's clock, midnight to midnight; the X report stays the report of
  "since the day was opened".
- Print now, a file later (section 3).
- Who may open it: the permission Today uses (section 3).

## 9. Not in this piece

- Profit and margin (the back office's Item sales has them for a shop): they need what each sale cost
  at the time, which the tablet does not keep with a receipt.
- Stock reports (value, losses, what is not selling), time cards, the back office's insights.
- The other entries of the picture's left menu: Stock, Promotion, Member, Cashier Settings, Hardware,
  Data Processing. Promotions and members (loyalty) are not in EasyPay at all.
