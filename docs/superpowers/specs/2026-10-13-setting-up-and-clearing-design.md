# Setting up, clearing and going live

2026-10-13. Asked by the owner with a picture of a client's page in `/admin` (two tills, three tablet codes): "I need a way to delete these and dont want to come back each time and ask you to delete", because "we're setting up/testing the POS for the restaurants and each time I need to delete", and "when going live all stocks menus login we created should be transferred to live". The approach below was put to them and answered "Yes go ahead and build it".

## The idea

A business is set up once, on the real system. Its menu, stock, staff and logins are made where they will be used, so nothing is carried across at the end. What has to go before it opens is only what it was tried with.

There is no second system to copy from. A login and its password belong to the sign-in service of the database they were made in, and do not carry over cleanly.

## What a client is

A client is **being set up** or **live**.

- A client made in `/admin` starts as being set up.
- **Go live** makes it live.
- **Back to setting up** is allowed only while it has no receipt. From its first sale its receipts are its books.
- When this was released: a client that syncs and had no receipt started as being set up. Every other client started as live.

The state is a row in `platform.setting_up`. It is not a column of `tenants`: no till pulls it and nothing a till reads changes.

## What `/admin` can now do

| | When | What goes |
|---|---|---|
| **Remove** a till | The till has nothing recorded: no receipt, day, cash movement, drawer count or clock-in. For a client that runs on its tablet, also only while it is being set up. | The till, its key, the codes it was set up with. Its number (T1, T2, ...) is free again. |
| **Remove** a code | The code waits or is over. | The code. One in use goes with its till. |
| **Clear test activity** | The client is being set up and syncs. The client's name is typed. | See below. |

Each is a `platform.*` function that checks the admin and writes what was done to `platform.audit`.

## What Clear test activity clears

Cleared: orders, receipts, refunds, payments, payment corrections, receipt reviews, approvals, days (shifts, closings, drawer counts), cash movements, clock-ins, bookings, requests to a till, the record of operations already applied, and every till with its key, the codes it was set up with and when it was last heard from. A code for a new tablet that nobody has used yet stays: it may be in someone's hand for the day the tablets are set up again.

Kept: the menu (categories, items, variants, options, taxes, discounts, prices and their history), payment types, tables and the floor plan, printers, settings, stores, staff, roles, logins, customers, suppliers, and the stock: its levels, purchase orders, deliveries, counts and their numbering. Crash reports are kept: they are EasyPay's.

`db/tests/setting-up.test.cjs` lists every table that holds a client's rows as kept or cleared. A table added later is in neither list and fails the suite until someone says which it is.

### Stock

What the sales and refunds moved is put back, on the level and on the item's total, and their movements are deleted. Deliveries, counts and adjustments stay.

One rule: a sale rung up **before** the shelf was last counted is not put back. The count found what was really there (nothing was really sold) and set the level to that, so the sale is no longer in the level. A sale is judged by when it was rung up on the till, a count by when its line was counted, as the stock count itself judges (migration 0075).

### The tablets

A tablet that was a till still holds what it sold. Set up again as it is, it would send it back. So the id of every removed till is kept (`platform.removed_tills`), and the till service refuses to set that id up again, by login or by code, and says to clear the EasyPay app's data. Cleared, a tablet makes a new id and starts clean, at receipt 1.

The page says to clear each tablet **before** pressing Clear. A tablet still signed in with a login can send an order (not a receipt, a day or cash: those name a till, and the till is gone). Clearing again removes it.

## Not covered

- **A client that runs on its tablet.** Its sales are on the tablet, never here, so Clear test activity is refused for it. Its tills and codes are removed one by one while it is being set up. Clearing the sales on the tablet itself while keeping its menu needs a key on the tablet: not designed.
- **A live client's own "Delete all transactions"** (its back office, Backup and data) is unchanged: its owner can still use it. Whether it should be refused once the client is live is the owner's to say.

## Decisions taken while building, for the owner to confirm

1. Clients with no receipt on release day start as being set up (first described as "existing clients count as live"). Otherwise the client in the picture could not have been cleared.
2. Back to setting up exists, for a client put live too early, and stops at the first receipt.
3. Stock papers (purchase orders, deliveries, counts) are kept, not cleared: they are the stock that was entered.
4. Bookings are cleared, as "Delete all transactions" clears them.
5. Remove is for a till with nothing recorded at all. A till that opened a day goes with Clear test activity.
