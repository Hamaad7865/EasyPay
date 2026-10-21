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
