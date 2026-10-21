# Loyalty points: design

2026-10-21. The owner asked how EasyPay compares with Loyverse. Loyverse includes a loyalty program for free:
points on every purchase, spent as a discount, and the customer found by card, phone or name. EasyPay has
customers and on-account sales but no points. This adds them, for restaurants and shops alike, on the tablet
(online and offline edition) and in the back office.

## 1. The owner's choices

Each was a tap on an option put to them, the same day:

1. **Earning:** "Do it how Loyverse does it but in Rs". A percentage of what the customer pays comes back as
   points, and **1 point = Rs 1**. Loyverse's default is 1%, set in its back office.
2. **Spending:** **as a discount**. The bill comes down by the points' worth, so the VAT is worked out on the money
   actually paid.
3. **Expiry:** **never**.
4. **Plans:** **every plan, offline too**, at no extra cost.
5. **Which sales earn:** **what the customer pays, after discounts**, VAT included. The part paid with points
   earns nothing. Cash, card, credit notes, deposits and on account all count, and on account earns at the sale.
   A refund takes back its share.
6. **Finding the customer:** **phone, with an optional card**. Search by phone or name works as today. A customer
   may also have a card number with a barcode, printed on the receipt printer; scanning it puts them on the sale,
   in a shop and in a restaurant.

The design below was shown to the owner whole and approved ("Yes, build it"). It did not include the
owner-only manual adjustment that was offered beside it.

## 2. Rules

All amounts are in cents, as everywhere in EasyPay. A point is a rupee, so a balance is kept, shown and printed
as money: "Points Rs 12.50".

- **Earned** on a receipt = `floor(total × loyaltyBp / 10000)`, where `total` is the receipt's total after every
  discount (points included), with VAT, service charge and rounding. A receipt earns only when its order has a
  customer and loyalty is on. A total of zero earns nothing. Each receipt of a split restaurant bill earns on its
  own total.
- **Used** on a receipt is one discount named **Points**, of type amount, and it is applied after every other
  discount. The most that can be used is `min(balance, subtotal − other discounts)`, so it never exceeds the
  bill. With VAT added on top, VAT then comes off with it; with VAT included, the VAT inside the price comes
  down. A service charge is worked out after discounts, as it is today, so points lower it too. The till never
  lets the person paying use more than the customer's balance as the tablet knows it.
- **Who:** anyone allowed to take payment (`payment.take`). Points are not a discount the shop gives, so they
  need no `sale.apply_discount` permission and no manager.
- **A refund** of a sale that earned `E` and used `S` takes back `round(E × share)` and gives back
  `round(S × share)`, where `share` = the refund's subtotal ÷ the sale's subtotal (rounded half up). The refund
  that completes the sale (everything returned) settles the remainder exactly: the sale ends with every point
  it earned taken back and every point it used given back. A refund settles its sale's points whether loyalty
  is on or off at the time.
- **An exchange** is a refund and a new sale (`Exchange.kt`). The refund takes back its share, and the new sale
  earns on its own total. A like-for-like swap therefore leaves the balance where it was.
- **A balance may go below zero.** It happens when a refund takes back points already spent, or when two tills
  spend the same points while offline. A negative balance is never refused, and the next purchases fill it.
- **Off** (the setting) means nothing is earned, Use points is not offered, and nothing is printed about points.
  Balances are kept, and they come back if loyalty is switched on again.

## 3. Settings

Kept in `pos_settings.data`, for both business types, on every plan.

| Setting | Key | Values | Default |
|---|---|---|---|
| **Loyalty points** | `loyalty` | `on` · `off` | `off` |
| **Percentage back** | `loyaltyBp` | basis points, 1 to 10000 (0.01% to 100%) | 100 (1%) |

The default is off, so no live client starts printing points by surprise. The settings are changed on the tablet
(Settings > Loyalty) or in the back office (POS settings, a Loyalty card). The tablet's save is the
`settings.save` change: it is answered on an offline tablet itself (`LocalAnswers`), and both keys join
`OwnSettings.WRITES["settings.save"]`.

## 4. Data (migration 0128, dev only)

- `customers.points bigint not null default 0`: the balance in cents, kept by the server's functions.
- `customers.card text`: the card number, or null. An index on `(tenant_id, card)` where it is not null. It is
  not unique: a duplicate is refused on the tablet and in the back office, but the server never refuses a change
  from a till for it (two tills apart could both give one number).
- `receipts.customer_id uuid`: who earned or used points on this receipt. A foreign key to customers,
  `on delete set null (customer_id)`, as 0114 did for bills.
- `receipts.points_earned bigint not null default 0`, `receipts.points_used bigint not null default 0`: what a
  sale earned and used. On a refund both are zero or negative: what it took back (`points_earned`) and gave back
  (`points_used`).
- **Invariant:** for every customer, `customers.points` equals the sum of `points_earned − points_used` over
  their receipts. The suite checks it.
- `receipt_reviews.reason` gains `points`. Its `detail` says what was wrong: `no-customer`, `overspent`,
  `over-earned` or `over-returned`.

There is no new table, so no new row-level security and nothing to add to the clean-up lists. Every function is
redefined from its live definition on dev (`pg_get_functiondef`). The last files that defined them:
`push_receipt_create` 0123, `push_refund_create` 0114, `push_customer_upsert` 0055, `push_settings_save` 0114,
`clear_test_activity` 0114.

## 5. What the tablet sends, and what the server does with it

**`receipt.create`** gains:

- in `discounts`, the points entry:
  `{"type": "amount", "value": S, "name": "Points", "amount": S, "points": true}`;
- at the top: `"points": {"customer_id": "...", "earned": E}`, when the receipt earned or used points.

The server:

- takes the points entry without the discount permission or approval checks;
- writes `customer_id`, `points_earned` and `points_used` on the receipt, and moves `customers.points` by
  `E − S` in the same transaction.

**The till's figures stand**, because they are what was printed and what an offline tablet's replay must
reproduce. They are held to bounds, and anything out of bounds is stored and flagged, never refused:

| Case | What the server does | Flag |
|---|---|---|
| Unknown customer, or none given | The points are dropped. The points discount stays: it is the receipt's own discount. | `no-customer` |
| `S` is more than the balance | Stored; the balance goes below zero. | `overspent` |
| `E` is below zero or more than the total | Clamped to that range. | `over-earned` |

**`refund.create`** gains `"points": {"customer_id": "...", "taken": T, "back": B}`. The server holds `T` to what
the sale earned less what earlier refunds took back, and `B` to what it used less what earlier refunds gave back.
Past those, it clamps and flags `over-returned`. The refund row gets `points_earned = −T` and `points_used = −B`,
and the balance moves by `B − T`.

**`customer.upsert`** takes `card`: present means set (blank clears it), absent leaves it alone. It never
touches `points`.

**`clear_test_activity`** (set-up reset, Go live) puts `points` back to zero for the client's customers, since
their receipts are cleared.

`sync_pull` already sends whole rows (`to_jsonb`), so customers bring `points` and `card`, and receipts bring
their three new columns, with no change to it.

## 6. The tablet (Room 31 → 32)

- `CustomerEntity` gains `points` and `card`. `ReceiptEntity` gains `customer_id`, `points_earned` and
  `points_used`. A migration `V31_V32` handles the upgrade, checked against the exported schema.
- `core/data/LoyaltyRules.kt` is pure and unit-tested: earned, the most that can be used, a refund's take-back
  and give-back with the remainder rule, and the card number. A card number is `EP` and ten digits, made at
  random. It cannot be read as a product barcode, which is thirteen digits beginning 200.
- **Pay:** a **Use points (Rs X)** key appears when loyalty is on, the order has a customer, and their balance is
  above zero. It opens a sheet with the most that can be used and a box to type less. The points then show as a
  discount line, which can be tapped to take them off. `TicketRepository.pay` sends the points entry and the
  points block. In the sale's own transaction it writes the receipt's columns and moves the customer's local
  balance. The exchange path (`Exchange.kt`) and deposit collections go through the same rules.
- **Refund** (`OrderOps.refund`, and the refund half of an exchange): works out `T` and `B` from the original
  receipt's columns (also on a pulled receipt), sends them, and moves the local balance.
- **The pull:** a customer whose sale, refund or exchange still waits in the outbox keeps the tablet's balance,
  the way `account_bills` does today (`waiting`: the payload holds the customer's id). On an offline tablet,
  "Get changes from EasyPay" keeps the tablet's balance for every customer (`Fetched`, like stock counts). It
  still takes the name, phone and card the back office set.
- **Customers screen:** a Points column and the card number. The form gets a Card field with **Scan or type**,
  **New number** and **Print card**. A duplicate card is refused with the other customer's name. The search
  matches the card number too.
- **Customer picker** (Assign customer, Add customer): the balance beside each name when loyalty is on.
- **Scanner:** on a restaurant's order (`OrderViewModel`) and a shop's sale (`RetailViewModel`), a scan that
  matches no product but matches a customer's card puts that customer on the order. It says "Priya on the sale ·
  Points Rs 120.50" in the strip or toast those screens already use.
- **Settings > Loyalty:** the on/off switch and the percentage, for whoever may change the business's settings.
- **Go live** on the tablet (`GoLive`) puts every customer's balance back to zero along with the test sales.
- **Backup:** the new fields travel with the customers and receipts it already carries.

## 7. Papers

- **The receipt:** the points discount prints through the discounts block as "Discount: Points". Under the
  payments block, where "Balance owed on account" prints today, it adds "Points earned X" (when above zero) and
  "Points balance Y" (the tablet's balance after the sale). A reprint leaves out the balance.
- **The refund slip:** "Points taken back X", "Points given back Y" and the balance.
- **The card slip:** the business's name, the customer's name, the card's barcode (Code 128, as the receipt's
  own barcode) and its number, and "Show this card at the till to earn and use points".
- `ReceiptDoc` gains `pointsEarned`, `pointsUsed`, `pointsBalance` and `pointsBack`. The till's `PaperWalk` and
  the back office's `web/lib/papers.ts` print them the same way, and a new fixture in `db/tests/fixtures/papers`
  holds the two together.

## 8. Back office

- **POS settings:** a Loyalty card with the two settings, for both business types.
- **Customers:** a Points column, and the card number on the customer's form (refused when another customer
  has it).
- **A customer's points history:** their last 50 receipts with points (date, number, earned, used, given back,
  taken back), reached from the customer's row.
- **Review / Exceptions:** receipts flagged `points` appear where flagged receipts already appear, worded by
  what was wrong.

## 9. Not built

- Changing a balance by hand (offered with the design and not taken).
- A minimum balance before points can be used, tiers, birthday points, points on a bill (only receipts earn),
  and SMS or e-mail.
- A card printed on a label printer or on A4. The card prints on the receipt printer, and any bought barcode
  card can be scanned in.

## 10. Tests

- `db/tests/loyalty.test.cjs` (dev, in a transaction rolled back where it can be):
  - earning and using points, and using without the discount permission;
  - every flag: overspent, an unknown customer, earned out of bounds;
  - partial refunds followed by the last one settling the remainder, and an over-return;
  - an exchange;
  - a restaurant split bill;
  - card set, cleared and left alone by `customer.upsert`;
  - settings keys accepted and refused;
  - `clear_test_activity` zeroing balances;
  - the invariant (balance = sum of receipts) after every step.
- The till's unit tests: `LoyaltyRules`, the papers fixture, the settings round trip, and `OwnSettings` holding
  the two keys.
- The suites that touch receipts and refunds run again on dev, one at a time: `retail-till`, `credit-notes`,
  `accounts`, `shop-pages`, `till-office`, `pos-pages`.
- On the test emulator, per the emulator note:
  - a shop on the offline plan: sell to a customer, earn, use points on the next sale, refund part and then the
    rest, exchange, scan a printed card;
  - its queue replayed on dev, where the server's balances must equal the tablet's;
  - a restaurant: a table's order with a customer and a split bill.

## 11. Decisions that were mine

The owner approved the design above; these were decided while building it and were not put to them.

- **Where Use points is offered.** Only on a whole bill, before any payment is taken. It is not offered on one
  check of a split check, on an exchange's new sale, or on a deposit's collection (whose deposit is taken as a
  payment when Pay opens). Equal or by-amount splits work: the points come off first, and the shares split what
  is left.
- **Service charge.** A restaurant's service charge is worked out after discounts, as it always was, so points
  lower it too. Points are earned on the receipt's total, which includes the service charge and the rounding.
- **Whole rupees.** A business that shows no decimals earns whole rupees only (Rs 1.50 earned is Rs 1), and the
  most it can use is rounded down to whole rupees.
- **Exchanges.** An exchange's new sale takes the original sale's customer when loyalty is on, so a
  like-for-like swap leaves the balance where it was. The exchange's refund slip prints no balance: the new
  sale's receipt, printed after it, has the balance after both.
- **Who the receipt names.** `receipts.customer_id` is written only on a receipt that earned or used points. A
  sale with a customer and no points keeps its customer on the order only, as before.
- **Older tills.** A till on an earlier build sends no points: a sale it rings up earns nothing, and a refund it
  makes takes nothing back. **Every till of a business should be on this build before loyalty is switched on**,
  which the back office's Loyalty card says.
- **Cards.**
  - A card is any text up to 40 characters, scanned or typed; New number makes `EP` and ten digits.
  - The server never refuses a card another customer holds (two tills apart could give one number); the tablet
    and the back office refuse it.
  - A scan looks for a product first and a card after.
  - On a restaurant's order screen, a card puts the customer on the order that is open. That screen always has
    one.
- **The tablet's balance** is the server's from each pull, except while that customer's sale or refund waits to
  go up, and always on a tablet that works alone.

## 12. What was built and run (2026-10-21)

Commits on `restopos` (not pushed, no tag):
- `ba42152` the server (0128) and its suite;
- `570a284` the tablet;
- `1a258d2` the back office and the replay scripts;
- `2ee5211` the fix below;
- `8aae460` the exchange and slip changes.

Run:

- `db/tests/loyalty.test.cjs`: 55 checks on dev, in a transaction rolled back. One of them was written after the
  replay below found its fault.
- Run after it, one at a time: `accounts` (61), `credit-notes` (37), `deposits` (82), `retail-till` (49),
  `retail-till-replay` (90), `till-office` (119, now with the loyalty settings sample), `refund-shares` (17),
  `refund-snapshots` (18), `review-reasons` (25), `seats-customers` (16), `split-check` (12), `setting-up` (51),
  `receipt-accept` (8), `vat-included` (4) and `delete-client` (13) all pass. `fk-setnull` fails on three
  foreign keys of promotions and credit notes (0109, 0110), none of 0128's.
- The tablet's 720 unit tests. The receipt with points is held by `points-58.json`, which the back office's
  preview (`papers.test.mjs`) prints the same way.
- The back office type-checks clean.
  - `shop-pages` (116), `pos-pages` (126), `backoffice-saves` (75) and `retail-till-replay` (90) pass after the
    change. Their pages draw with loyalty off.
  - The customers page's points history query was run as `app_user` on dev, in a transaction rolled back: a
    sale and its refund for one customer came back.
  - POS settings changes the loyalty settings only when the form has the card, so a page opened before the
    deploy leaves them as they were.
  - The pages were not seen signed in.
  - The customers page reads each customer's last 50 point receipts when the page loads, wherever the
    business keeps points: one subquery per customer, through the index on `receipts (tenant_id, customer_id)`.
- On `easypay_claude_size` (5598), with its window open:
  - The debug build installed over the made-up restaurant left on 18 October: Room 31 went to 32 in place, both
    receipts were kept, and nothing crashed.
  - Then the made-up shop on the offline plan:
    - Settings > Loyalty switched on (1%), and the customer Anjali made with a card from New number.
    - Three mugs (Rs 960, cash) earned 9.60.
    - A postcard set (Rs 150) used Rs 5 of points on Pay's sheet. The bill came to Rs 145, VAT fell from 19.57
      to 18.91, it was paid by card and earned 1.45, leaving a balance of 6.05.
    - One mug refunded took back 3.20.
    - One mug exchanged for a scarf: the refund half took back 3.20, and the new sale (Rs 590, Rs 270 in cash)
      earned 5.90.
    - The last mug refunded settled the remaining 3.20.
    - The postcard sale refunded gave back 5.00 and took back 1.45.
    - Anjali's card printed (Code 128 and the number). A scan of it on Sell (`DEMO_SCAN`) put her on the sale,
      and the gift wrapping (Rs 50) used all her 5.90 and earned 0.44.
    - Every paper was read off the stand-in printer: Points earned, taken back, given back and the balance were
      right each time.
  - The tablet's queue was replayed on dev (`read-till-state` and `replay-demo-outbox`, which now compare
    points): 26 operations taken. Every receipt's points, the balance, the card and the stock were the tablet's.
  - **The first replay found a fault**, now fixed: a sale earning points while the balance was below zero was
    flagged "overspent" with nothing used. The exchange's refund half had taken Anjali to −0.35 a moment before.
    The same run showed an exchange's new sale starting with no customer (fixed in `8aae460`).
  - After `8aae460`, installed over the same shop: the scarf exchanged for two mugs. The new sale named Anjali by
    itself, the refund slip took back 5.90 and printed no balance, the receipt earned 6.40 (balance 0.94), and
    Use points was not offered. The shop's whole queue (32 operations, 10 receipts with points) replayed: REPLAY
    PASS.
  - Then the made-up restaurant on the offline plan:
    - Loyalty switched on from the side menu's Settings, and Ravi made with a card.
    - Table 1 (two scarves, Rs 1,180): a scan of his card on the order screen put him on the order, and the sale
      earned 11.80.
    - Table 2 (a jacket, Rs 2,950): his card scanned, Use points took off all 11.80, and the bill was split
      equally between two guests (Rs 1,469.10 each, in cash). One receipt with two payments earned 29.38.
    - Its queue (16 operations) replayed: REPLAY PASS.
    - Not run in the restaurant: a split check, where each check is its own receipt (proved on the server, L9).

Not seen:
- a real printer, a real scanner, or a real tablet;
- the back office pages behind a sign-in;
- two connected tablets spending one balance (proved on the server only, L3);
- a Premium tablet's pull keeping a waiting balance (read in the code, not run).
