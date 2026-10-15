# Add-ons on one line, the customer number, a reminder before an order is due, and the day's payments kept from cashiers

2026-10-15. Asked by the owner, for the restaurant:

> for client receipt the add ons are in vertical. For each add on it should be horizantal

> We need to add in kitchen receipt and customer receipt as well a customer counter number so when an order is completed, the cashier can call out the customer order number

> For the customer counter number say for example if the customer comes in first it should be customer number 01 then if we have last customer we can make it customer number 10 and then closing the register resets this number

> We need the till to notify us, for example if an order is due 21:00, we need the till to make a sound 10 mins before, now this 10 mins should be configurable based on the requirement of the customer not all customer wants 10 mins

> Payments cannot be seen by cashier

and, asked what that last one should do:

> Can we have a place in the back office to create rules and permissions instead of coming here and create rules via code

They also asked for a receipt designer (drag and drop, variables, how a price is shown). That is part 2, with its own spec once this one is built. Their answer for its scope: the receipt, the bill and the kitchen ticket, in the back office, as a column of blocks. What this spec builds becomes blocks in it (the customer number, add-ons on one line) and is not built twice.

The design below was put to the owner and agreed ("Yes, the design is right. Write the spec."). What they chose is marked theirs; the rest is mine, and was in what they agreed to.

## 1. A line's add-ons on one line, on the receipt and the bill

Until now the customer's paper gave each add-on a line of its own (`Docs.page`, "+ m" per add-on). That was a choice made when the kitchen's paper was given one line per add-on group (`Kitchen.kt`: "The customer's receipt keeps one add-on a line"). The owner reverses it.

```
Before                                After
1 Burger                  250.00      1 Burger                  250.00
  + Cheese                              + Cheese, Bacon, Extra sauce
  + Bacon
  + Extra sauce
```

- All of a line's add-ons go on one line after "+ ", joined by ", ", in the order they were picked; "2 x Egg" stays as it is written today (`modNames`).
- Too long for the paper, the line wraps under the "+" with the same indent, as `wrapped` does now.
- It is done where the paper is laid out (`Docs.page`), not where the receipt is made: a receipt kept from before prints the new way when it is printed again, and on the till's screen (`receiptLook`). What is kept with the receipt does not change.
- The receipt, the bill, a guest's share and a refund are the one layout and all change. The kitchen ticket does not: it keeps one line per add-on group (`kitchenMods`).

## 2. The customer number: 01, 02 … and 01 again once the register is closed

Until now an order with no table had a number from one of three counts kept on the tablet (`SessionStore.nextNumber`): C for the counter, A for takeaways, D for deliveries, each from 1, each started again at midnight. The kitchen's paper had it large inside the order's name ("A-12 · Ravi"); the receipt had it small, beside the date.

**One count per till** (mine, agreed):

- Every order with no table takes the next number of one count, whatever its kind: the first customer after the register is opened is 01, the tenth is 10, the hundredth 100.
- The count starts again at 01 when this till's day is closed (the owner's rule: "closing the register resets this number"). Both ways of closing reset it: on the till (`CashOps.closeDay`) and asked from the back office (`closeDayAsked`). Nothing else resets it: not midnight, not a restart, not a sign-out. A till left open for two days counts on.
- The number is kept in the order's number as it is today, with the letter for its kind in front and two digits at least: `C-01`, `A-05`, `D-12`, `A-100`. The Takeaway board, the Orders list and the kitchen screens show it as they show it now. **Nothing changes on the server**: `order_no` is already a string it keeps.
- An order whose kind changes (counter to takeaway) keeps its number; only the letter follows the kind, under the rule it has today (while the kitchen has had nothing and nothing is paid). It no longer takes a number of the new kind.
- An order at a table takes no number: it is served at its table, as before.
- The kitchen tickets' own count ("K", the kitchen display's ticket numbers) is not this count and keeps its midnight reset.
- The first order after this build is installed is 01, whether or not the day was closed since.

**On paper:**

- The receipt and the bill print **CUSTOMER No. 05**, large and centred, under RECEIPT or BILL. It is taken from the order's number (the digits after the dash). A share of a split bill carries it; a refund and a credit note do not.
- `ReceiptDoc` gains `customerNo: String? = null`. It is kept with the receipt (`receipts.doc`), so a reprint carries it; a receipt kept from before has none and prints as it did.
- The kitchen ticket prints **No. 05** large, under the station's name, where the order's name was; the name it was given (Ravi), when there is one, follows in bold, normal size. A table's ticket is as it was. `KitchenDoc` gains `customerNo: String? = null`.
- An order numbered before this build ("A-7") prints "No. 7".

**A limit, said to the owner:** each till counts on its own. A restaurant with two tills taking orders can have two customers holding 05 at once.

**Another, found while planning:** a day can be closed while paid takeaways still wait on the board (closing refuses only unpaid orders, and closing to make way for a new day carries unpaid ones on). Those keep their numbers, so the board can hold an A-05 from before the closing and a new A-05 after it.

## 3. A sound before an order is due

**The setting** (the owner's: "not all customer wants 10 mins"):

- `dueReminderMinutes` in the business's settings: 1 to 120 minutes, or off. **Off when the key is missing**, as every key is "as before" (`PosSettings`): no restaurant already live starts ringing when this build reaches it (the owner's choice).
- In the back office: POS settings, next to the takeaway preparation time, "Remind before an order is due: __ minutes"; empty is off.
- On the tablet, for a restaurant on the offline plan, which has no back office: Settings, Notifications, the same line (mine: the place). Saved with `settings.save` like the kitchen notes, under `settings.device`, and answered by the tablet itself when it works on its own. The same setting for the whole business in either place.
- The server's `push_settings_save` takes it (0 to 120; 0 stored as off) in a new migration.

**Which orders ring** (the owner's: only orders for later):

An order rings when it was taken for a time further off than its usual time plus the reminder. Its usual time is the preparation time (`prepMinutes`), twice it for a delivery: the due time an order is given when nobody chooses one. So an "as soon as possible" takeaway never rings, and one moved five minutes later on the board does not either.

- Taken at 20:00 for 21:00, preparation 15, reminder 10: 60 minutes is more than 25, so it rings at 20:50.
- Taken at 20:00 for 20:20: 20 is less than 25, so it does not ring; the kitchen starts it now anyway.
- When it was taken is read from the order's id (a UUID version 7 carries the moment it was made), so no column is added anywhere. A limit: an order that sat as a counter sale for a while and was then made a takeaway is given its due time when it becomes one, but counts as taken when it was started. If it sat longer than the reminder, an "as soon as possible" takeaway made that way rings. That should be rare.
- It rings only while the order is new or in the kitchen: not once it is ready, done, handed over, marked a no-show, or removed.
- Only orders with a due time ring: takeaways and deliveries. Table bookings do not (not asked).

**What happens:**

- At the due time less the reminder, the till plays a sound of its own (three falling notes, unlike the new-order and food-ready sounds; `Chime.due`) and shows a banner across the top of whichever screen is open: "A-05, Ravi, is due at 21:00: in 10 minutes", with a key OK. The banner stays until OK is pressed or the order is no longer new or in the kitchen. Tapping it opens the Takeaway board.
- It rings once for an order and its due time. The orders it has rung for are kept on the tablet (with the due time), so a restart does not ring again; moved to a later time, the order rings again before the new one. Kept for two days, then forgotten.
- A till started after the moment, with the order not yet due, rings at once; one started after the due time does not ring (the board already shows it late).
- It is watched from one place for the whole app, not from a screen (as `Kitchen.ready` is), every 30 seconds: a till that has locked itself still rings, and the banner is there once it is unlocked.
- Each till rings for the orders on its own Takeaway board, a paid one waiting to be collected included. The app must be open on the tablet; "Keep the screen on" keeps it so.

## 4. The day's payments, kept from cashiers unless their role is given them

**The place to set it is already there**, which the owner did not know: the back office's Settings menu, **Roles and permissions** (and Settings, Roles on the tablet). A role is added there, its permissions ticked, and it is given to staff on the Staff page. What it could not do was keep the day's payments from someone who sees the receipts: one tick, "See all receipts and the day's payments" (`receipts.view_all`), held both, and the Cashier role every client is made with has it.

- That tick becomes two:
  - `receipts.view_all`, **See all receipts**;
  - `payments.view`, **See the day's payments**: Settings, Payments on the till (every payment since the day was closed, with its totals by way of paying).
- The Payments page asks for `payments.view`; someone without it is shown the lock and may ask a person who has it to approve, as now.
- **On release**, a migration gives `payments.view` to every role that already holds `shift.view_report` (See the day's figures on the till): Managers keep the page, **Cashiers lose it**, in every live restaurant. The Owner holds everything already. From then on the owner gives or takes it on Roles and permissions, for any role.
- A client made after this gets the same: its Manager role has `payments.view`, its Cashier role does not (`platform.create_tenant`).
- A tablet that works on its own holds its own copy of the roles and never hears of the migration. Its database moves to version 28 with the same rule, applied to the roles it holds.
- The list of permissions is one file the till and the back office are both held against (`db/tests/fixtures/till-office/perms.json`, `Perms.kt`, `web/lib/perms.ts`); all three gain the new one in the Receipts group, for a restaurant and for a shop.
- A role saved from a till built before this does not offer the new tick, and the server keeps what the role held of what was not offered (`push_role_save`): saving it there does not take `payments.view` away.
- Until a till is updated it still opens Payments on `receipts.view_all`.
- Only the Payments page changes. How each receipt was paid stays on the receipt, under Receipts: a cashier reprints and refunds with it.

## Not built here

- The receipt designer (part 2).
- One count shared by all the tills of a restaurant.
- A reminder for table bookings.
- The preparation time on the tablet.

## How it is checked

- Unit tests:
  - the receipt's add-ons on one line, wrapped on 58 mm paper;
  - CUSTOMER No. on the receipt and the bill, and none on a refund;
  - No. on the kitchen ticket, and a table's ticket unchanged;
  - the count: 01 first, padded, three digits past 99, back to 01 after a closing, not at midnight;
  - the letter changing with the kind and the number kept;
  - the reminder rule (an "as soon as possible" order, one moved by five minutes, one for later, a delivery, off, a ready order, rung once, rung again when moved later);
  - the settings key read and refused out of range.
- The permission file test on both sides; the tablet's database migration 27 to 28.
- On dev:
  - the migration;
  - the settings and roles suites that touch `push_settings_save` and roles;
  - the back office's POS settings saved with the reminder and read back.
- On an emulator, with its window open so the owner can watch (said before it starts):
  - a counter order and a takeaway numbered 01 and 02;
  - the receipt and the kitchen ticket read through the stand-in printer;
  - with the preparation time at 1 minute and the reminder at 10, a takeaway for in 15 minutes (more than 11, so it is for later), ringing five minutes later with its banner, and an "as soon as possible" one not ringing;
  - a Cashier locked out of Payments and a Manager not.
