# Add-ons by group for the kitchen, a pick-up time, a bill paid in parts, and no-shows

2026-10-13. Asked by the owner in one message:

> kitchen receipts when come out right now all add ons comes out horizantally. We need the add ons to come vertically. Like this: * Mayo, Chili / * Onion
>
> in the takeaway option, add a time probably a small clock icon this is for: at what time will the customer pick up his order at the restaurant, you can make it a clock and we turn its needles to select the time
>
> Split pay option should be added - for example one customer total is 175 he wants to pay 100 by cash and 75 by juice
>
> Sometimes customers place orders and they dont show up - so we should add a no show if paid thats fine. If not paid include it in Z report

What was already there was put to them with three questions. Their answers: the kitchen's paper prints "Chili" and "Mayo" on two lines and they want "Chili, Mayo"; **one line for each add-on group**; the other three "build as described". Then, while it was being built: "in the kitchen receipt it should say, the time the customer will pick up the order".

Four separate things, built and committed one after the other. Only the fourth touches the server.

## 1. Add-ons for the kitchen: a line for each group

The kitchen's paper printed every add-on on a line of its own (`+ Mayo`, `+ Chili`, `+ Onion`). The kitchen screen put them all on one line, joined with dots, the kitchen note after them.

Now, under an item, there is one line for each add-on group, its choices side by side in the order they were picked:

```
2 x Grillade
   * Mayo, Chili
   * 3 x Sausage
   ! No salt
```

- The paper marks a group's line with `*`, as in their example. The note keeps its `!`.
- The kitchen screen (this till's and a kitchen tablet's) shows the same lines, one under the other, then the note.
- An add-on whose group cannot be found (taken off the menu since) gets a line of its own.
- Mine, not asked: the customer's receipt and bill are unchanged, one add-on a line. So are the order's panel, the payment screen and the board, which keep one short line.

## 2. When a takeaway is picked up

A takeaway or delivery already had a time (`tickets.due_at`): set by itself to the preparation time after it was rung up, shown with a clock on its card on the board, moved by 5 or 15 minutes there. Nobody could choose it while taking the order and the kitchen was not told.

- On a takeaway or delivery, a key with a clock sits beside the customer's name and phone. It shows the time once the order has one.
- It opens a clock face: the hand is turned to the hour, then to the minutes. 24 hours.
- A time already past is refused. Late in the evening a time of the small hours is tomorrow's (one that passed more than half a day ago): at ten to midnight 00:15 can be chosen, as the time an order gets by itself can be past midnight too.
- Choosing a time on an order that has nothing on it yet makes the order, as typing a name does.
- The card on the board opens the same clock; its 5 and 15 minute keys stay.
- The kitchen's paper says `PICK UP 18:30` under the order's name (`DELIVERY 18:30` for a delivery), and the kitchen screen's card says the same. It is the time the order had when it was sent; one changed afterwards is not printed again.

Nothing changes on the server: the time is already kept and synced there. The tablet's database gets the time on a kitchen ticket (version 23).

## 3. A bill paid in parts of any amount

"Split equally" already took a bill in shares, each by its own payment type, and recorded them as one receipt. Its shares were always equal.

- A fourth choice on the payment screen, **By amount**, beside Full bill, Equally and Split check.
- In it, a row says what this payment is for, and a key opens a number pad to type it. Choosing By amount opens the pad for the first part. Left alone, a part is everything that remains.
- Take 100 by cash: the screen says 75 remaining; pick Juice and charge: done.
- A part paid in cash can still be counted in from a bigger note, with its change.
- As many parts as needed. One receipt, with each payment on it; the day closing counts each under its own payment type, as it already does for shares.
- As with equal shares: nothing is recorded until the whole bill is covered, leaving the screen asks to give the parts back, and a tablet that stops keeps what was taken.

Nothing changes on the server.

## 4. No-show

Bookings had No-show; a takeaway did not. One never collected stayed on the board, and unpaid it held up closing the day until every item was voided.

- The sheet a card's time opens on the board has a key **No-show**.
- **Paid:** the order leaves the board marked as a no-show. The sale and its money stay as they are. Nothing is added to the day closing. It is not counted in "collected today".
- **Not paid:** the order is closed (cancelled), its items left on it, with what was still to pay written down. It no longer holds up closing the day.
- The day closing (Z), and the day so far, get a line `No-shows (2)  350.00`, and the detailed one lists each: its number, who it was for, what it came to.
- It is not a sale: it is in no total, no tax, no payment type and not in the drawer.
- The back office's Day closing page shows the same line for each closing.
- Mine, not asked: an unpaid no-show needs the permission to void an item the kitchen already has (`sale.void_sent_line`), with a manager's PIN where the cashier lacks it, and who marked it is kept. An unpaid no-show is where cash could go missing, which is what the line on the Z is for.

Server: migration 0107 adds to `tickets` when it was marked, what was unpaid, by whom and on which till; `ticket.cancel` carries the no-show. The tablet's database, version 23.

Not built: taking a no-show back when the customer turns up after all (an unpaid one is rung up again); the stock its food used; a list of no-shows in the till's reports.

## What was run, the night it was built

On a test emulator (1280 x 800, the made-up restaurant that works on its own), the debug build installed over database 22: it went to 24 in place with no fault. A stand-in printer on the PC took the papers.

- **The clock.** The key sits beside the name and the phone on a new takeaway. The face opened at the time it was; the hand set to 23 then 55 gave "Set 23:55", and that made order A-1 with that time on an order that had nothing on it. The key then showed 23:55. With the time on it, the name box shows about fifteen letters.
- **The kitchen's paper**, as it came out for a takeaway with Mayo, Sausage and the note Rush:

```
KITCHEN ORDER
A-3
PICK UP 00:03
13/10/2026 23:48                           Aisha
Takeaway
================================================
1 x Ceramic mug, Blue
   * Mayo, Sausage
   ! Rush
================================================
```

- **By amount.** The four choices fit their row. Rs 370: 200 typed on the pad and charged in cash, the screen said 170 remaining, charged by card: "Rs 370.00 · 2 payments", one receipt holding Cash 200.00 and Card 170.00.
- **No-show.** A paid takeaway: it left the board, stayed paid, nothing owed, not in "collected today". An unpaid one of Rs 450: asked again, then closed with its item on it and 450.00 kept. As the cashier of the made-up restaurant, the same key asked for an approval ("Ben may not mark an unpaid order as a no-show"); cancelled, the order stayed as it was.
- **The X report** printed after it: "No-shows, unpaid (1)  450.00" under Discounts given, Cash (4) 11,765.00 and Card (1) 170.00 by payment type, the sales unchanged by the no-show.

Not seen: this till's Kitchen screen and a kitchen tablet (the made-up restaurant's plan has no kitchen display), a delivery, a time refused for being past, the Z itself on paper (the X has the same line; the list of each order is in the unit test only), the back office's page in a browser, a real tablet or printer.

Found by that run and changed after it, so not seen on the emulator: the clock took a time today only, and the order rung up at 23:48 had been given 00:03 by itself, a time the clock would have refused. A time that passed more than half a day ago is now tomorrow's. And an unpaid order with parts already taken on the payment screen is not made a no-show until they are finished or given back: they are only written down on that screen until the bill is covered.
