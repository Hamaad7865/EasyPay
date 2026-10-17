# A shop's customer accounts: selling on account, payments against bills, statements: design

2026-10-17. The owner: "if you look at carfectionist, we can sell to customers on credit and then we have
reconciliation modules customer statement etc... Can we have something similar in the retail version of
easypay". Carfectionist (`C:/Projects/Carfection`) is the reference: an "On account" method at the counter,
a settle panel that ticks open bills, a Reconciliation page (Owed, Exceptions), a customer page (aged balance,
bills and their payments, a ledger with a running balance) and an A4 statement of account.

The owner's answers, one question at a time:

1. Who may buy on account: **any named customer** ("C"): no account flag, no credit limit.
2. Where money paid off an account is taken: **on the tablet only** ("B"): every rupee goes through a till
   and its day closing; a transfer or a cheque is taken at the till under its own payment type.
3. Which bills a payment goes to: **the cashier ticks them** ("A"), a part payment leaves the rest open.
4. Statements: **an A4 page in the back office printed or saved as PDF by the browser, and a short one printed
   by the tablet** ("A"): no e-mail service, nothing to pay for.
5. **A paid extra** like deposits ("A"): switched on in `/admin`, Premium and trial carry it.

Then, before the rest of the design was read: "build the whole feature test end to end if everything works,
commit push and release". What follows past section 1 of what was shown to the owner is therefore mine;
section 12 lists it.

## 1. Shape: "On account" is a payment type on an ordinary sale (chosen)

Of three ways (a payment type; Carfectionist's separate invoices; a bare running balance) the first is
built. An on-account sale is an ordinary receipt: stock, VAT, returns, reports, the receipt itself stay as
they are. Its part paid by the built-in payment type of kind **`account`** ("On account") is a **bill** on
the customer. A separate invoice table would double every report and return path; a bare balance cannot do
what the owner chose (ticking bills, part payments).

**Revenue once.** The sale is revenue on the day it is made, whatever paid it. Money paid later on the
account is never a sale: it is money into the drawer (or the card terminal...), reported as its own line.

## 2. Data (migration 0114)

- `payment_types.kind` gains `account`; one live per shop, made **inactive** for every shop (as Deposit is),
  so a till built before this never offers it. `ensure_account_type`.
- **`account_bills`**: one row per sale with an on-account part. `id` is the receipt's id; `customer_id`
  fixed when the sale is made; `number` (the receipt's); `store_id`, `device_id`, `day` (the store's day of
  the sale); `amount` (the on-account part), `paid` (payments put on it), `returned` (taken off it by
  returns). **Owed = amount − paid − returned.** Below zero it is *paid over*. `flags` (jsonb, what the
  server found wrong), `server_seq`, `touch_row`, RLS.
- **`account_payments`**: money taken at a till against a customer's bills: `id` (the till's), `number`
  (`<till prefix>-A<n>`, the till's), `customer_id`, `store_id`, `device_id`, `shift_id`, `employee_id`,
  `payment_type_id`, `amount`, `tendered`, `change`, `reference`, `device_time`, `flags`.
- **`account_payment_lines`**: `account_payment_id`, `bill_id`, `amount`: what the payment put on each bill;
  they add up to the payment's amount.
- `cash_movements.account_payment_id`: cash taken on an account is a drawer row (`in`) under the payment's
  own id, as a deposit's is, so the expected cash counts it and reports tell it from a pay-in.
- `receipt_reviews.reason` gains **`account`** (the server stored something it could not square; `detail`
  says what: `no-customer`, `over-paid`, `over-returned`, `bill-unknown`, `not-entitled`).
- `tenants.features` may hold **`accounts`**; `has_feature(t, 'accounts')` is true on premium and trial as
  for deposits. `platform.set_tenant_features` accepts it.

## 3. Selling on account (receipt.create)

- The till offers **On account** on Pay only when: the shop has the extra and its setting on, the sale names
  a customer, and the person paying has **`sale.on_account`** ("Sell on account", a new permission given to
  roles on the Roles page; only the owner's `*` holds it at first: never granted by code).
- It pays the whole sale or what is left after other tenders; it is never more than what is due and gives
  no change.
- `push_receipt_create` takes the account type though it is inactive, and writes the bill. The sale is never
  refused for it (the goods left): with no customer the bill is written with none and flagged `no-customer`;
  from a client without the extra, or a person without the right, stored and flagged (`not-entitled`; the
  right as an unapproved action, as a price change is).
- The receipt prints "On account Rs X" and, under it, "Balance owed Rs Y" (all the customer's bills).
- Pay's done card says "On account Rs X", and counts it in no "paid by" tally.

## 4. Taking a payment (account.pay, new)

- On the tablet: More → **Accounts** (beside Deposits): the customers who owe, largest first, searchable;
  one opens to its open bills, oldest first, each ticked or not, its date, number, amount and owed.
- **Take payment**: the ticked bills' total is offered; the cashier may type less. Then the method: the
  shop's real payment types (never exchange, credit note, deposit or account). Cash asks what was handed
  over and shows the change. The amount goes on the ticked bills **oldest first**, so a part payment leaves
  the last ticked bill part paid.
- A slip prints: the payment, the bills it went to, what each still owes, the balance after.
- The op carries the lines as the till split them. The server checks each bill is the customer's and still
  owes at least that much. **Money that moved is never refused**: what goes past a bill's owed is stored,
  the bill goes below zero (paid over) and the payment is flagged `over-paid` (two tills apart took the same
  bill). An unknown bill: stored, flagged `bill-unknown`.
- Needs `payment.take`. Works with the extra switched off later (the customer still owes).
- The X and Z, the drawer screens and Reports: **Account payments** by method, cash in the expected drawer.

## 5. Returns from an on-account sale (refund.create)

- The till's return of a sale with an on-account part first takes the refund **off the bill**, up to what
  the bill still owes, as a payment of the account type; only the rest is money (refund, credit note or
  exchange as the shop's Returns setting says).
- `push_refund_create`: the account type is taken though inactive; its part **skips the policy check** (no
  money moves); it may be at most what the bill still owes and at most the refund's total. Past what is owed
  (settled meanwhile at another till): stored, `returned` raised, flagged `over-returned`. Money back may be
  at most the refund less the account part, and at most what was really paid.

## 6. Settings (shop only, POS settings and the offline tablet's Settings)

| Setting | Key | Values | Default |
|---|---|---|---|
| **Customer accounts** | `accounts` | on · off | on |
| **Overdue after** | `accountDays` | days, 1 to 365 | 30 |

Ageing on the pages and the statement is by the bill's day: 0–30, 31–60, 61–90, over 90 days.

## 7. Sync

- `sync_pull` sends **`account_bills`** (every store's; open ones, paid over ones, ones changed in the last
  30 days) and **`account_payments`** (the last 30 days, with their lines inside). A tablet keeps a bill it
  has a change of its own waiting on.
- `sync_push` knows `account.pay`; codes `not-entitled`, `bad-account`.
- The offline plan: the tablet's LocalAnswers answers `account.pay` and the settings itself.
- `clear_test_activity` clears bills and payments; a till that sold on account is not bare.

## 8. Back office

- **Accounts** (Finance): Carfectionist's Reconciliation. **Owed**: total owed, customers owing, unpaid past
  the overdue days; one line per customer: open bills, oldest bill and its age (red past the overdue days),
  balance, Statement. **Exceptions**: overdue customers, bills paid over, receipts flagged `account`.
  Without the extra: "Customer accounts are an extra. Ask EasyPay to add them."
- **One customer** (`/backoffice/accounts/<customer>`): balance owed, open bills, oldest unpaid; the aged
  balance; each bill with the payments put on it (and returns); the ledger (debits: bills; credits: payments
  and returns) with a running balance, the last 200 lines; Print statement.
- **Statement** (`/backoffice/accounts/<customer>/statement`): A4, the shop's name and details, "Statement of
  account as at <day>", the customer, the aged balance, the open bills (date, number, amount, paid, owed),
  the balance owed. Print (the browser prints or saves a PDF).
- **Customers**: a column **Owes** with a link, and a filter "Owe money", for a shop with the extra.
- **POS settings**: an Accounts card (the two settings), or that it is an extra.
- **Day closing, Sales summary**: on-account sales; account payments taken, by method; the account type left
  out of the methods (as the other built-in kinds are). **Receipts**: names the on-account part and its bill.
- **/admin**: Extras gains **Customer accounts** beside Deposits.

## 9. Tablet papers

- Receipt: "On account Rs X / Balance owed Rs Y".
- Account payment slip (section 4).
- Short statement (Accounts → a customer → Print): the customer, each open bill (date, number, owed), the
  aged balance, the balance owed.
- X and Z: on-account sales; account payments by method.

## 10. What is not built

- Credit limits, account flags, interest, reminders, e-mailing statements (the owner's answers).
- Taking a payment in the back office (answer 2).
- Correcting or voiding an account payment: a mistake is put right with another payment or a note in the
  back office's review; `payment.correct` refuses the account type, both kinds of side.
- Restaurants: retail only.

## 11. Tests

- `db/tests/accounts.test.cjs`: selling on account, every refusal and flag, part payments over ticked bills,
  two tills paying one bill, returns off the bill (exchange-only shop), money back capped, the drawer, the
  pull, clear test activity, settings.
- The till's unit tests: the split oldest first, owed, the return's split, ageing.
- `shop-pages` (Accounts, the customer page, the statement, Customers' column), `till-office` (settings),
  the replay of the emulator's queue (`retail-till-replay`), and every suite deposits ran.
- On my emulator with the made-up offline shop: sell on account, return part of it, take a part payment and
  a full one in cash and by card, the slip, the statement, X and Z, then replay its queue on dev.

## 12. Decisions that were mine (the owner did not see them before the build)

- The bill table and the names (`account_bills`, `account_payments`), the kind `account`, the number `-A<n>`.
- A return takes off the bill first, then money (shown to the owner in section 1 of the design).
- The receipt always prints the balance owed on an on-account sale (I had offered it as a setting; one fewer
  setting).
- Two settings (on/off, overdue days); fixed ageing buckets.
- Money that moved is never refused: over-payment and over-return are stored, flagged, shown on Exceptions.
- No void or correction of an account payment.
- `sale.on_account` held only by the owner until a role is given it.

## 13. What was built and run (2026-10-17)

Built as designed, with these changes found while running it:

- **A return of a sale still on account** takes off the bill first, also inside an exchange: only what was paid of
  the sale goes to the new sale (and to a credit note, as the shop's Returns say). An exchange of a sale nothing was
  paid on is refused with "return it instead". The return dialog says how much comes off the bill and whether money
  changes hands, and is titled Return when none does.
- **The refund slip** prints what the customer owes on account after the return; a reprint of a sale on account
  leaves out the balance of the day of the sale (it is not what is owed now).
- **The tablet's statement** prints its ages with a plain hyphen (0-30 days): the receipt printer drops the dash.
- **Sales journal** (asked during the build: "Also build the sales journal the sales journal should be available in
  the standard and premium plan", then "the sales journal should be similar to how it is in carfectionist"): Finance,
  Sales journal, for every business with a back office (Standard, Premium, trial; the offline plan has none, and the
  platform admin looking in is told so). Carfectionist's: one period (Today, Yesterday, Current month, Previous
  month, or any two days), compared with the previous period, month or year, filtered by till, by who rang it up, by
  an item and by hours; cash basis (every figure is money received in the period, whatever sale it paid); KPI tiles,
  Sale methods (a shop: one line, "Sales [shop]"; a restaurant: its order types), Taxes, Payments, Categories,
  People, each footing to the money received to the cent (each sale scaled to the share of it paid in the period,
  then split over its lines, largest remainder); under Payments the bridge to what was sold: money received, less
  money on sales made earlier, plus what was settled without money (returned goods, credit notes, deposits, taken
  off earlier accounts), plus what is still on account. Deposits are said apart (money, not a sale). Its
  Taxes table has no discount column (Carfectionist's has one).

Run:

- `db/tests/accounts.test.cjs` (60 checks): selling on account and every flag, payments on ticked bills, two tills
  paying one bill, returns off the bill in an exchange-only shop, money back before money came in, double pay,
  payment corrections, the pull, settings, clearing a test client.
- `db/tests/journal.test.cjs` (16 checks) on a day with a cash sale, a sale on account part paid, an earlier sale
  paid on, a return off a bill, an exchange and a deposit: every table foots to Rs 560.00 and the bridge comes to
  the Rs 460.00 the Sales summary says was sold; a restaurant on Premium; the offline plan told no.
- `web/lib/journal.test.mjs`: the money maths, and 500 random periods footing to the cent.
- `shop-pages` section A (Accounts, a customer's account and statement, Customers' Owes column and filter, Day
  closing, Sales summary, the dashboard, Receipts, Exceptions), and every other dev suite one after another (23).
- The till's 660 unit tests (AccountRules, the settings both ways), the Room upgrade 30 to 31 against the exported
  schema, and the debug build on the emulator with the made-up offline shop and its deposits: a mug all on account,
  a scarf part cash part on account, a part payment of Rs 500 with Rs 1,000 handed over (Rs 320 and Rs 180 on the two
  bills, oldest first, the slip, the drawer), a postcard set on account then returned off the bill, the statement, the
  X report (Rs 860 sold on account, Rs 150 returned off, Rs 500 paid in cash; expected drawer Rs 5,200), the scarf
  exchanged for a mug (Rs 210 off the bill, Rs 320 to the mug, Rs 60 on a credit note). Its queue (66 operations)
  replayed on dev: every operation taken, receipts, payments, drawer, stock and the three bills the till's, nothing
  flagged (`retail-till-replay`, the accounts fixture).

Not seen: two connected tablets paying one bill (proven on the server only), the back office pages in a browser
behind a sign-in (drawn by the page harness), a statement printed from a browser to paper.
