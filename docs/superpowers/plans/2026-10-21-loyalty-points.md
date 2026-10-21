# Loyalty points: implementation plan

> **For agentic workers:** this plan is run inline in one session, one task after another. Subagents are not
> used: the owner is cost-sensitive, and the project memory says to keep token use lean. Steps use checkboxes.

**Goal:** loyalty points on every plan, for restaurants and shops: earned on a sale, spent on Pay as a Points
discount, taken back on refunds, shown on the receipt, on the tablet and in the back office, and working on an
offline tablet.

**Architecture:** the balance is `customers.points`, and each receipt carries `customer_id`, `points_earned` and
`points_used` (spec section 4). The tablet works the figures out with one pure object, `LoyaltyRules`. It sends them
in `receipt.create` and `refund.create`, and moves its own copy of the balance in the same transaction. The server
stores the till's figures, holds them to bounds, and flags anything odd without refusing it. `sync_pull` already
sends whole rows.

**Tech stack:**
- Postgres functions (plpgsql), on Neon dev only;
- Kotlin with Room, Compose and Hilt on the tablet;
- Next.js server components in the back office;
- node test suites in `db/tests`.

**Spec:** `docs/superpowers/specs/2026-10-21-loyalty-points-design.md`

---

## Files

| Area | File | What changes |
|---|---|---|
| Server | `db/migrations/0128_loyalty_points.sql` (new) | columns, review reason, five functions from their live definitions |
| Server | `db/tests/loyalty.test.cjs` (new) | the suite, in one transaction rolled back |
| Tablet | `core/data/LoyaltyRules.kt` (new) + `src/test/.../LoyaltyRulesTest.kt` | earned, most usable, refund share, card number, words |
| Tablet | `core/database/Customers.kt`, `Transactions.kt`, `TillDatabase.kt`, `Migrations` | Room 32: `points`, `card`; receipt's three columns; queries |
| Tablet | `core/data/PosSettings.kt`, `core/sync/OwnSettings.kt`, `core/data/LocalAnswers.kt` | `loyalty`, `loyaltyBp` |
| Tablet | `core/data/TicketRepository.kt` (`pay`, `saveCustomer`), `DiscountPick` | the points entry and block, the local balance |
| Tablet | `core/data/OrderOps.kt` (`refund`, `marked`) | take back and give back, the slip, the reprint |
| Tablet | `core/print/Docs.kt` (`ReceiptDoc`, card slip), `core/print/PaperWalk.kt` | the lines |
| Tablet | `core/sync/PullApplier.kt`, `core/sync/Fetched.kt` | keep the tablet's balance while waiting, and while alone |
| Tablet | `core/data/GoLive.kt` (or wherever Go live clears the sales) | balances to zero |
| Tablet | `feature/pay/Pay.kt` | Use points |
| Tablet | `feature/customers/Customers.kt` | points column, card field, print card, balance in the picker |
| Tablet | `feature/order/OrderViewModel.kt`, `feature/retail/RetailViewModel.kt` | a card scan puts the customer on the sale |
| Tablet | `feature/settings/…` | the Loyalty page |
| Web | `web/lib/settings.ts`, `web/app/backoffice/settings/page.tsx` | the Loyalty card |
| Web | `web/app/backoffice/customers/page.tsx`, `table.tsx` | Points column, card, history |
| Web | `web/lib/papers.ts`, `db/tests/fixtures/papers/points-80.json` (new) | the receipt's points lines |

---

### Task 1: The server (migration 0128) and its suite

**Files:**
- Create: `db/tests/loyalty.test.cjs`
- Create: `db/migrations/0128_loyalty_points.sql`

- [ ] **Step 1: Write the suite first.** Copy the harness of `db/tests/accounts.test.cjs`: one transaction, rolled
  back; `platform.create_tenant_of_type`; `push` and `pull` as `app_user`.

  Set up a shop on Offline with `loyalty: on` and `loyaltyBp: 100`, a toy at 100.00, and the customers Anjali and
  Ravi. Use `bal(cust)` for `customers.points`, and `sumOf(cust)` for
  `sum(points_earned - points_used) from receipts where customer_id = cust`.

  Checks:
  - **L1, a sale earns:** 3 toys, cash 300.00, `points: {customer_id: anjali, earned: 300}`. The receipt has
    `points_earned` 300, `customer_id` anjali, and `bal` 300.
  - **L2, a sale uses points:** discounts `[{type: 'amount', value: 200, name: 'Points', amount: 200, points: true}]`,
    one toy, cash 98.00, earned 98. It is applied by Cara, whose role holds no `sale.apply_discount`. Nothing is
    flagged. `bal` is 300 − 200 + 98 = 198. `receipt_discounts` has "Points" 200.
  - **L3, overspent:** uses 50000 against a balance of 198. It is stored, `bal` goes negative, and it is flagged
    `points` with `overspent`.
  - **L4, an unknown customer:** the points are dropped and flagged `no-customer`. The discount is still on the
    receipt.
  - **L5, earned out of bounds:** −5 is clamped to 0 and 999999 is clamped to the total; both are flagged
    `over-earned`.
  - **L6, a partial refund:** 1 of the 3 toys from L1, `points: {taken: 100, back: 0}`. The refund row has
    `points_earned` −100 and `bal` moves by −100. Then the other 2 with `taken` 200: settled. A third refund
    claiming more is `over-returned`, clamped to 0 and flagged.
  - **L7, a refund of L2 gives the points used back:** `back` 200 and `taken` 98, so `bal` moves by +102.
  - **L8, an exchange:** a refund with the exchange payment type, then a new sale paid by exchange that earns. The
    balance is right.
  - **L9, a restaurant split check:** two receipts on one ticket, each earning on its own total.
  - **L10, card:** `customer.upsert` with `card` 'EP0000000001' sets it; without `card` it is kept; with `card: ''`
    it is cleared. `points` is never touched.
  - **L11, settings:** `settings.save` takes `loyalty` on and off and `loyaltyBp` 1 to 10000. It refuses 'yes', 0
    and 10001 (`bad-payload`).
  - **L12, the pull:** it carries the customer's `points` and `card`, and the receipt's three columns.
  - **L13, invariant:** after every step, `bal` equals `sumOf` for each customer. Asserted at the end for
    everyone.
  - **L14, clear test activity:** `platform.clear_test_activity` puts `points` back to 0.
  - **L15, a sale with no points block and no points discount** is as before: zeros, no review.

- [ ] **Step 2: Run it, to see it fail** on the missing columns.
  `node db/tests/loyalty.test.cjs` should end FAIL with `column "points" does not exist`.

- [ ] **Step 3: Dump the live definitions** with `dumpone.cjs`, kept in the scratchpad: `push_receipt_create`,
  `push_refund_create`, `push_customer_upsert`, `push_settings_save`, and `platform.clear_test_activity` (by
  schema). Also read the live `receipt_reviews_reason_check`.

- [ ] **Step 4: Write `0128_loyalty_points.sql`.**
  - **Header:** the source of each function, and "Never edit after merge".
  - **The columns:**
    ```sql
    alter table customers add column if not exists points bigint not null default 0;
    alter table customers add column if not exists card text;
    create index if not exists idx_customers_card on customers (tenant_id, card) where card is not null;
    alter table receipts add column if not exists customer_id uuid;
    alter table receipts add column if not exists points_earned bigint not null default 0;
    alter table receipts add column if not exists points_used bigint not null default 0;
    alter table receipts drop constraint if exists receipts_customer_fk;
    alter table receipts add constraint receipts_customer_fk
      foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete set null (customer_id);
    ```
  - **The review reason:** the live list plus `'points'`.
  - **`push_receipt_create`:**
    1. The discount permission test counts only the entries that are not points:
       `(select count(*) from jsonb_array_elements(...) e where coalesce(e->>'points','') <> 'true') > 0`.
    2. In the loop, an entry with `points = 'true'` gets `v_why := null`, and `v_pts := v_pts + v_amt` after the
       amount is settled.
    3. After `v_total`: `v_pcust := (p->'points'->>'customer_id')::uuid`, falling back to the ticket's customer
       when absent and `v_pts > 0`. If it is not in `customers`, null it and flag `no-customer`.
       `v_earn := coalesce((p->'points'->>'earned')::bigint, 0)`, clamped to `[0, v_total]` (flag `over-earned`
       when it changed). Overspent when `v_pts > points` of the customer, read `for update`.
    4. The insert into `receipts` gains `customer_id`, `points_earned` and `points_used`; then
       `update customers set points = points + v_earn - v_pts`.
    5. A `receipt_reviews` row `'points'` with `jsonb_build_object('flags', v_pflags)`, and `v_offline` set, when
       there are flags.
  - **`push_refund_create`:**
    1. `v_ptake := coalesce((p->'points'->>'taken')::bigint, 0)` and `v_pback`.
    2. The bounds: `o.points_earned + sum(points_earned of its refunds)`, and the same for used. The refunds'
       values are ≤ 0, so `left = o.points_earned + coalesce(sum(r.points_earned), 0)`. Clamp each into
       `[0, left]`, flagging `over-returned`. With `o.customer_id` null, both are clamped to 0.
    3. The refund row: `customer_id = o.customer_id`, `points_earned = -v_ptake`, `points_used = -v_pback`.
       `update customers set points = points + v_pback - v_ptake`.
    4. The review row `'points'` when flagged, which also makes `needs_review` true.
  - **`push_customer_upsert`:** `card` (present means set, blank means null, absent means kept) in the insert and
    in the `on conflict` (`case when p ? 'card' then … else customers.card end`). It is at most 40 long.
  - **`push_settings_save`:** `loyalty` in ('on','off') and `loyaltyBp` an int from 1 to 10000, beside
    `accounts` and `accountDays`.
  - **`platform.clear_test_activity`:** `update customers set points = 0 where tenant_id = p_tenant`, before the
    receipts are cleared.

- [ ] **Step 5: Apply to dev and run the suite.** `node db/migrate.cjs`, then
  `node db/tests/loyalty.test.cjs`, which should be all PASS.

- [ ] **Step 6: Run the neighbours one at a time,** each expected to pass: `accounts`, `credit-notes`,
  `retail-till`, `till-office`, then `deposits` if it exists.

- [ ] **Step 7: Commit** `0128_loyalty_points.sql` and `loyalty.test.cjs`.

### Task 2: `LoyaltyRules` on the tablet (pure, TDD)

**Files:** create `core/data/LoyaltyRules.kt` and `app/src/test/java/com/restopos/core/data/LoyaltyRulesTest.kt`.

```kotlin
object LoyaltyRules {
    // what a receipt earns: floor(total * bp / 10000); nothing below zero
    fun earned(total: Long, bp: Int): Long = if (total <= 0 || bp <= 0) 0 else total * bp / 10000
    // the most that can be used: the balance, and never more than the bill before the points
    fun most(balance: Long, base: Long): Long = minOf(balance, base).coerceAtLeast(0)
    // a refund's share of a sale's points, rounded half up; the refund that completes the
    // sale takes what is left exactly. left = what is still to take (or give) back
    fun share(points: Long, sub: Long, ofSub: Long, last: Boolean, left: Long): Long
    // a card number: EP and ten digits, at random
    fun newCard(random: java.util.Random = java.security.SecureRandom()): String
    fun isCard(code: String): Boolean  // EP + 10 digits
    fun words(points: Long): String = "Points " + Money.format(points)
}
```

Tests:
- `earned(30000, 100) == 300`, `earned(9999, 100) == 99`, `earned(0, 100) == 0`;
- `most(500, 300) == 300`, `most(-50, 300) == 0`;
- `share(300, 10000, 30000, false, 300) == 100`, the last refund `share(300, 20000, 30000, true, 200) == 200`, and
  `share` never more than `left`;
- `newCard` matches `EP\d{10}`;
- `isCard("2000000000017")` is false.

- [ ] Write the tests, run `gradlew :app:testDebugUnitTest --tests '*LoyaltyRulesTest*'` to see them fail, write the
  object, run them to see them pass, and commit.

### Task 3: Room 32 and the settings

- `CustomerEntity` gains `points: Long = 0` and `card: String? = null`. `ReceiptEntity` gains
  `customer_id: String? = null`, `points_earned: Long = 0` and `points_used: Long = 0`.
- `TillDatabase` version 32, with `V31_V32` adding the five columns (`NOT NULL DEFAULT 0` for the longs) and
  registered where `V30_V31` is. Export the schema, and if there is an upgrade test against the exported schema,
  extend it.
- `CustomerDao`:
  - `byCard(card)`;
  - `addPoints(id, delta)`;
  - `zeroPoints()`;
  - `search` matches `card`;
  - `waitingPoints(id)`: pending outbox rows of `receipt.create` or `refund.create` whose payload contains the id.
- `ReceiptDao`: `pointsBackOf(receiptId)`, the sums of `points_earned` and `points_used` over refunds of the
  receipt.
- `PullApplier`, customers: read `points` and `card`. Where `db.customers().waitingPoints(id) > 0`, keep the
  tablet's `points`. When the tablet works alone (`Journey.alone`, the same test the stock levels use for
  `Fetched.level`), keep the tablet's `points` for every customer it has: `Fetched.customer(own, sent)`.
- `PullApplier`, receipts: read the three new columns.
- `PosSettings`: `loyalty: Boolean` (data `loyalty == "on"`) and `loyaltyBp: Int` (default 100, clamped from 1 to
  10000), with a test in the existing PosSettings test.
- `OwnSettings.WRITES["settings.save"]` gains `loyalty` and `loyaltyBp`. `LocalAnswers`' `settings.save` takes
  the two keys, by the server's rules.
- Go live on the tablet: zero the balances where the test sales are cleared.
- Backup: check that `BackupFile` carries customers and receipts as whole rows. If it lists columns, add the new
  ones.
- [ ] Build `:app:compileDebugKotlin` and run every unit test. Commit.

### Task 4: The sale, the refund and the papers on the tablet

- `DiscountPick` gains `points: Boolean = false`.
- `TicketRepository.pay`:
  - points picks skip the discount-permission check, and the restricted check too (they carry no `discountId`).
  - `Calc` takes the points pick last: Pay passes `[discount, points]`.
  - Once `totals` is known: `used = totals.discountAmounts[pointsIndex]`; `cust` = the ticket's customer;
    `require(cust != null)` when `used > 0`; `require(used <= cust.points)` ("…has Rs X in points").
    `earned = if (settings.loyalty && cust != null) LoyaltyRules.earned(totals.total, settings.loyaltyBp) else 0`.
  - The payload: the discount entry gets `"points": true`. Add a top-level `points` block when
    `earned > 0 || used > 0`.
  - The receipt row: `customer_id`, `points_earned`, `points_used`. Call `customers().addPoints(cust, earned - used)`
    in the same transaction.
  - The doc: `pointsEarned = earned` and `pointsBalance = balance after`, only when loyalty is on or points moved.
- `OrderOps.refund`:
  - `share` for taken (from `orig.points_earned`) and back (from `orig.points_used`), with `sub = parts?.sub ?:
    orig.subtotal`. `last` is when nothing of the sale is left after this refund: `back == null`, or every line's
    `done + q == qty`. `left` = the original's figure less `pointsBackOf`.
  - The payload `points` block (when either is above zero, with `customer_id = orig.customer_id`).
  - The refund row's columns; `addPoints(orig.customer_id, back - taken)`.
  - The doc gets `pointsTaken`, `pointsBack` and `pointsBalance`. The refund doc is a copy of the sale's, so its
    `pointsEarned` must be nulled.
- `OrderOps.marked` (the reprint): `pointsBalance = null` when `reprint || back > 0`, as for `owed`.
- `ReceiptDoc`: `pointsEarned: Long? = null`, `pointsBalance: Long? = null`, `pointsTaken: Long? = null`,
  `pointsBack: Long? = null`.
- `PaperWalk` "payments" block, after `owed`:
  - `pointsEarned?.takeIf { it > 0 }` prints `Row("Points earned", n)`;
  - `pointsTaken?.takeIf { it > 0 }` prints `Row("Points taken back", n)`;
  - `pointsBack?.takeIf { it > 0 }` prints `Row("Points given back", n)`;
  - `pointsBalance` prints `Row("Points balance", n)`, with a minus when below zero.
- `Docs.card(business, customer, card)`: the card slip, built with the receipt's own `Out.Bars`.
- `web/lib/papers.ts`: the same four rows in the payments block, and the doc type's four fields. A new fixture,
  `db/tests/fixtures/papers/points-80.json`, holds a receipt with a points discount, points earned and a balance;
  `PapersFixtureTest` and `papers.test.mjs` both read it.
- [ ] Compile, run the unit tests, `node web/lib/papers.test.mjs`, and commit.

### Task 5: The screens on the tablet

- **Pay:**
  - `PayUi` gains `points: PointsOffer?`: `(who, balance, most, used)`, offered when `settings.loyalty`, a
    customer is on the order, `balance > 0`, `shares.isEmpty()`, `exchangeOf == null` and `check == null`.
  - The key "Use points (Rs X)" sits beside On account and opens a small sheet: the most, a box (default the
    most), Use, and Take off.
  - `totalsFor` adds the points discount after the order's discount, and `record` passes it to `tickets.pay`.
  - `PayDone` gains `earned`, and the done card says "Points earned Rs X".
- **Customers:**
  - a Points column (when loyalty is on);
  - the form gets Card, a field with New number and Print card. Save refuses a card another customer holds,
    naming them.
  - `saveCustomer` takes `card` and puts it in `customer.upsert` (always, as blank when it is cleared).
- **Picker:** "Rs X in points" under the name when loyalty is on.
- **Scanner:** in `OrderViewModel` and `RetailViewModel`, where a scan finds no product, try
  `customers().byCard(code)`. If one is found, put that customer on the order and say
  "<name> on the sale · Points Rs X".
- **Settings > Loyalty:** the switch and the percentage. Save through `ServiceRepository`'s `settings.save`, as the
  Accounts settings do, under the same permission.
- [ ] Compile, run the unit tests, and commit.

### Task 6: The back office

- `web/lib/settings.ts`: `loyalty` and `loyaltyBp` in the type, the defaults and the read.
- POS settings page: a Loyalty card with the switch and a percentage box (0.01 to 100, saved as basis points), and
  a server action with the same bounds.
- Customers:
  - `points` and `card` in the query, a Points column, and Card on the form, refused when another customer has it;
  - "Points history": a details row listing the last 50 receipts with points (date, number, earned, used).
- Reviews and Exceptions: find where reasons are worded (grep `credit-overspent` in `web/`) and add `points` with
  its four details.
- [ ] Type-check (`npx tsc --noEmit` in `web/`), run `node web/lib/papers.test.mjs` and the `shop-pages` and
  `pos-pages` suites, and commit.

### Task 7: Run it

- [ ] Every unit test of the tablet, and the suites of task 1 again.
- [ ] Emulator, per `restopos-emulator-is-shared`:
  - read the note whole, check recent commits and free memory, and say beforehand what will run;
  - start 5598 with its window and install the debug build;
  - switch loyalty on in Settings, sell to a customer, use points, refund part and then the rest, make an
    exchange, print a card and scan it (the scan faked with `sendevent`, as in the scanners note);
  - read the receipts printed through `printer_listen.cjs`.
- [ ] Replay the emulator's queue on dev, rolled back (`replay_real.cjs` or `replay-demo-outbox.cjs`). The server's
  balances must equal the tablet's.
- [ ] Write what was run and what was not seen into the spec as section 11, and commit.
