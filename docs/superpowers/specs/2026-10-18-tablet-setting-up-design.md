# Setting up on an offline tablet, then Go live

2026-10-18. Asked by the owner, the day a restaurant opened with test sales still on its tablet: "We need a button in the settings or an option or something. The tablet or apk creates a test environment in itself, where he can test etc and then completing test he can choose to go live where logins menu/stocks if its retail etc are transferred to live but not sales receipt etc". Then: "I think we only need this in the offline build". The approach below was put to them (one copy of the data, what was rung up thrown away at Go live) and answered "Write the plan build the feature".

## Why one copy, not a test copy and a transfer

A second copy of everything set up (menu, staff, stock, tables, printers, about thirty kinds of thing on the tablet) would have to be carried across at Go live, kind by kind, and every new kind would need its own rule; one missed is something the owner set up, gone on the opening day. With one copy, what is set up while trying is already the real one. Only what was rung up goes at Go live: the same idea as `/admin`'s Clear test activity (migration 0104), on the tablet.

## Whose tablets

A tablet that works on its own (the offline plan). A business in the cloud keeps `/admin`'s Clear test activity and Go live, unchanged.

## When a tablet is setting up

- **Set up with a code**, the card asks: "Is this business already selling with EasyPay?" **Not yet** (it is being set up) or **Yes** (this tablet sells for real from its first sale). Nothing is assumed: the key stays shut until one is picked. Asked because a business that is already trading adds a second tablet with an ordinary "Code for a new tablet", and that tablet's sales are real from the start.
- The answer is kept on the tablet, with what it knows of itself (`setting_up` in its preferences), so a backup carries it and a tablet filled from that backup is setting up too.
- It counts only while the tablet works on its own. A pull whose settings name the plan `premium` or `trial` ends it for good: the business was made Premium, and `/admin`'s tools are its from then on. Settings that are empty or name no plan change nothing.
- A tablet set up before this build is live. Nothing puts a tablet back to setting up: a tablet cannot tell a sale rung up to try from a real one.

## While it is setting up

- A strip under the top bar, amber: "Setting up. What is rung up here is for trying, and goes when the business goes live." Its key, Go live, opens Settings at This till.
- Every paper the tablet prints says **TEST, NOT A RECEIPT** at its top and at its foot: receipts, bills, kitchen tickets, slips and reports. A guest is never handed one that looks real.
- What a sale, a refund that puts things back, and a deposit take off the shelf or put back is also written down as a stock movement marked `trial` (`stock_movements.ref_type`), product by product after an item made of others is split into its parts, as the shelf itself moves. The Stock History shows them.

## Go live

Settings, This till, the Setting up card: **Go live**. For the owner (a role with `*`); anyone else is asked for the owner's PIN. A sheet says what goes, with how many, and what stays, and has the one key.

**Goes:** orders and their lines, receipts and refunds with their lines and payments, days (shifts, day closings, drawer counts), cash in and out, clock-ins, kitchen tickets, bookings, requests from the back office, orders from tables, the tablet's own log (price changes, corrected payments), credit notes, deposits with their lines and payments, account bills and account payments.

**Stays:** the menu (categories, items, variants, add-ons, taxes, discounts, pictures, promotions), payment types and order types, staff, roles, PINs, tables and the floor plan, printers and kitchen screens, settings, customers, suppliers, and the stock with its orders, deliveries, counts and corrections.

**The queue** (what goes up the day the business is connected to the cloud): what was rung up is taken out of it, by kind (orders, receipts, refunds, payment corrections, days, drawer counts, cash, clock-ins, kitchen marks, bookings, answers to requests, deposits, account payments). Everything set up stays in it, in its order. A kind in neither list stays: a sale left in by mistake can still be cleared then, a set-up change taken out could not be had back. A test holds every kind the code queues to one list or the other.

**Stock:** every movement marked `trial` is undone and removed, except one made before a count of that product was completed on this tablet: the count found what was really there and set the level, so that sale is no longer in it. Judged by when the count was completed, which is also what the count's `moved` sent with it at Premium is worked out from, so the server lands where the tablet is.

**Numbers:** receipts start again at 1 on this till, and so do the day's bill numbers, the customer numbers and the kitchen's.

**Then:** the list of print jobs is emptied (Try again would print a test receipt), the flag is written last, the till locks, and the day is opened as on any first day. A Go live cut short (the tablet switched off in the middle) is finished by pressing it again: its tables are already empty.

Each tablet of a business goes live on its own: each holds its own sales.

## /admin

An offline client's "Being set up" card says that a tablet set up with "Not yet" has its own Go live, under Settings, This till.

## Decided while designing, for the owner to confirm

1. Only before opening. Asked whether it is also for training staff after the business is live; not answered when this was written. A training switch is not built.
2. The question on the code card, rather than every new tablet setting up.
3. Tablets set up before this build are live, and there is no Back to setting up on the tablet.
4. Owner only.
5. The count rule judges by when the count was completed. `/admin`'s Clear test activity judges by when the line was counted; the tablet follows its own queue instead, so that Premium lands where the tablet is.
6. A tablet that was once in the cloud (a Standard client moved to offline by 0115) is never setting up. If such a tablet were set up again with "Not yet", its receipt numbers would carry on from the server's last one after a Get changes from EasyPay (the server's count is the higher).

## How it is checked

- Unit tests: the queue's kinds (every kind the code queues is in one list; nothing in both); the stock put back (the count rule, an item made of others, a refund that put things back); a paper with and without the mark.
- On an emulator with its window: an offline restaurant set up "Not yet", a few things set up, sales, a refund that puts stock back, a delivery, a count, a day closed, cash out; TEST seen on the stand-in printer's papers; Go live; the tables, the queue and the stock read off the tablet; then `db/scripts/read-till-state.cjs` and `replay-demo-outbox.cjs` against dev, rolled back: REPLAY PASS.
