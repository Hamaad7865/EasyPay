# A shop's deposits (layaway): implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** goods held for a customer who pays part now, collected later, as the spec
`docs/superpowers/specs/2026-10-16-shop-deposits-design.md` says, on a connected tablet and on one that works alone,
switched on per client in `/admin`.

**Architecture:** one new server document (`deposits`, with its lines and payments inside one pulled row), four push
operations, and a built-in payment type `deposit` that pays for the goods on an ordinary `receipt.create`. Cash moves
through `cash_movements` (the drawer already counts those), stock through `stock_move`, a cancel to a note through
`credit_notes` (refund_id made optional, deposit_id added). The tablet keeps the same document in Room, writes
everything itself in one transaction with its outbox op (as a sale), and the server re-checks on arrival and flags
rather than loses money that already moved.

**Tech stack:** PostgreSQL (Neon dev branch), node test suites (`db/tests/*.test.cjs`), Kotlin/Compose/Room till,
Next.js back office (`web/`).

**User's instruction for this build:** build and test every scenario; **do not commit, push or release** until they
give the green light. Work stays in the working tree of `restopos`.

---

## Contracts (fixed here; every task uses these names)

**Feature switch.** `tenants.features text[] not null default '{}'`. `has_feature(tenant, name) → boolean`: for
`'deposits'`, true when `has_premium(tenant)` or `'deposits' = any(features)`. `platform.set_tenant_features(admin,
tenant, features text[])` writes `tenants.features` and `pos_settings.data.features` (a JSON array) in one
transaction, audited `tenant.features`. The till reads `PosSettings.features: Set<String>` and
`PosSettings.deposits: Boolean` = shop AND (premium plan OR "deposits" in features) AND setting `deposits` not off.

**Settings keys** (`pos_settings.data`, saved by `push_settings_save` under `settings.device`):
`deposits` ("on"|"off", missing on), `depositCancel` ("refund"|"credit"|"keep", missing credit), `depositDays`
(1..365, missing 30), `depositOverdue` ("show"|"cancel", missing show), `depositGrace` (0..365, missing 7),
`depositCustomer` ("required"|"optional", missing required).

**Server tables.**
```sql
deposits (id uuid pk (the tablet's), tenant_id, store_id, device_id, number text, customer_id uuid null,
  collect_by date, status text check in ('open','collected','cancelled'), total bigint,
  paid bigint default 0,       -- money in, cached under the row's lock
  given_back bigint default 0, -- money out on cancel/give back
  used bigint default 0,       -- taken by live collection receipts (Deposit-type payments)
  kept bigint default 0,       -- kept by the shop on cancel (keep)
  owed bigint default 0,       -- to give back, not yet paid out (auto-cancel under refund)
  cancel_outcome text null check in ('refund','credit','keep'), cancel_reason text, auto_cancelled boolean default false,
  credit_note_id uuid null, flags jsonb default '[]', created_by, cancelled_by, approved_by uuid null,
  device_time timestamptz, created_at, updated_at, deleted_at, server_seq)
  unique (tenant_id, number)
deposit_lines (id uuid pk, tenant_id, deposit_id, item_id, variant_id null, name text, qty int (thousandths),
  qty_collected int default 0, unit_price bigint, list_price bigint null, price_kind text null, price_label text null,
  sort int)
deposit_payments (id uuid pk, tenant_id, deposit_id, payment_type_id, amount bigint (<0 = money back), tendered,
  change, shift_id null, device_id, employee_id, kind text check in ('in','back'), device_time, created_at)
```
`free = paid − given_back − used − kept − owed` (never stored). A change to lines or payments updates the deposit row
so `server_seq` moves and the till gets the whole document again.

**Push operations** (`sync_push` cases, each refused `not-entitled` when `has_feature` is false, except `deposit.pay`,
`deposit.cancel` and `deposit.give_back` on a deposit that already exists):
- `deposit.create {id, store_id, device_id, number, customer_id?, collect_by, device_time, lines:[{id,item_id,
  variant_id?,name,qty,unit_price,list_price?,price_kind?,price_label?,price_by?}], payment?:{id,payment_type_id,
  amount,tendered?,change?,shift_id?}}`. Holds stock (`stock_move(-qty,'deposit',null,'deposit',id,…)`).
- `deposit.pay {deposit_id, device_id, device_time, payment:{…}}`.
- `deposit.cancel {deposit_id, device_id, device_time, reason, outcome, auto?, approved_by?, back:[{id,
  payment_type_id,amount,shift_id?}], credit_note?:{id,number,amount,valid_to}}`. Releases stock
  (`'deposit_release'`), records the outcome. Idempotent on a deposit already cancelled.
- `deposit.give_back {deposit_id, device_id, device_time, back:[…]}`: pays out `owed`.
- Collection: `ticket.add_line` takes `deposit_line_id` (stored on `ticket_lines.deposit_line_id`);
  `receipt.create` pays with the `deposit` kind type, `reference` = the deposit's number.

A cash payment (type kind `cash`) of any of these writes a `cash_movements` row, id = the payment's id, type `in`
(money in) or `out` (money back), reason `Deposit <number>`. The tablet writes the same row locally with the same id
and no `cash.move` op of its own.

**Review reasons** added: `deposit-overused` (a collection used more than was free, took more than was held, or came
after a cancel). Deposit-level problems go into `deposits.flags` (`{"why":"closed-payment"|"price-unapproved",…}`).

**Credit note from a deposit.** `credit_notes.refund_id` nullable, `credit_notes.deposit_id uuid null`, check one of
the two. Number = `<deposit number>-CN`.

**Till Room** (database 30): `deposits`, `deposit_lines`, `deposit_payments` mirroring the server (plus `pulled`),
`ticket_lines.deposit_line_id`. Numbers `<store>-<till>-D<6 digits>`, counted by `pos_devices`-local
`SessionStore.nextDeposit()`.

**Fixes after review (2026-10-16), binding on every task:**
1. Stock: holds are added up per product through `stock_parts` (as a sale), `ref_type 'deposit'`; a release is
   `ref_type 'deposit_release'` (its own pair, so `stock_move`'s once-per-document rule never drops it). The till's
   `moveStock` adds up the same way.
2. The `deposit` payment type is made for every shop **inactive** (`is_active = false`): a till built before this
   lists only active types, so it never offers it. `push_receipt_create` accepts kind `deposit` whatever
   `is_active` says; the new till finds it by kind. The back office's payment types page leaves it out.
3. Credit notes from a deposit: `refund_id` null, `deposit_id` set; on the till `refund_id` is "" (as a pull
   already writes it). Reports: the deposit's note counts under "Deposits put on credit notes", not
   "Credit notes issued" (that line stays what refunds issued). The credit notes page names the deposit.
4. Refunding a collection receipt: the cashier picks the tender (the deposit type is never offered), the goods go
   back on the shelf as for any refund. Nothing special; a suite case proves it.
5. Numbers: the next deposit number is one past the highest this till has in Room (so a restore or a move keeps
   counting). The server never refuses a `deposit.create` that carries money: a number taken gets a suffix
   (`-2`…) and a flag; `not-entitled` with money is stored and flagged too (cash already moved), without money it
   is refused.
6. Backups copy the whole database file: the three tables are in them with nothing to do.
7. `platform.clear_test_activity` and `platform.till_is_bare` know `deposits`, `deposit_lines`,
   `deposit_payments`, and `credit_notes` (0109 left credit notes out: clearing a client with one fails today).
8. `deposits_expire` skips a client on the offline plan (its tablet does it at day open). The API runs
   `sync_pull` inside a read-write transaction (`hello.ts`), so the call goes at its start.
9. `cash_movements.deposit_id` (server and till): the drawer counts these rows; the X/Z and back office list them
   as deposits, not as manual pay-ins/outs.
10. A deposit's total is `Calc` over its frozen lines with their taxes, so "To pay" equals what the collection
    receipt charges.

---

## Task 1: migration 0113 (server)

**Files:** create `db/migrations/0113_deposits.sql` (functions rebuilt from their live dev text, dumped with
`db/scripts/dump-function.cjs`: `push_receipt_create`, `push_ticket_add_line`, `push_settings_save`,
`push_payment_correct`, `sync_pull`, `sync_push`, `platform.set_tenant_business_type` (ensure the deposit type));
new: `has_feature`, `platform.set_tenant_features`, `ensure_deposit_type`, `deposit_free`, `deposit_cash`,
`push_deposit_create`, `push_deposit_pay`, `push_deposit_cancel`, `push_deposit_give_back`, `deposits_expire`.

- [ ] Write the tables, constraints, RLS, `touch_row` triggers, `server_seq` indexes as credit_notes has them.
- [ ] Payment type kind `deposit` (constraint widened, one live per shop index, `ensure_deposit_type` as
  `ensure_credit_note_type`, run for every shop; `set_tenant_business_type` calls it).
- [ ] `push_receipt_create`: Deposit-kind payments collected into `v_deps` (number + amount); lines with
  `deposit_line_id` compared with the frozen price (not the catalogue, no `price-unapproved` for them);
  under `for update` of each deposit: held portion per line, used/flags, `qty_collected`, status `collected` when
  every line is taken; stock moved only for what was not held; `deposit-overused` flag with detail.
- [ ] `push_payment_correct`: refused from or to kind `deposit`.
- [ ] `sync_pull`: `deposits_expire(tenant)` first (before the shared lock), then a `deposits` block in the retail
  section: open ones and those changed in 30 days, every store, with `lines` and `payments` inside.
- [ ] `sync_push`: the four cases and `not-entitled` in its list of codes.
- [ ] Apply on dev: `node db/migrate.cjs`; expected: 0113 applied, no error.

## Task 2: server suite `db/tests/deposits.test.cjs`

Scenarios, each with its expected figures (one transaction per scenario where the harness allows, as
`credit-notes.test.cjs` does):
1. Not entitled: Standard shop without the feature → `deposit.create` refused `not-entitled`; switched on with
   `set_tenant_features` → taken; premium → taken; `pos_settings.data.features` follows.
2. Create with cash 500 on 2000: deposit open, paid 500, free 500, stock down by the lines, cash_movement in 500.
3. Zero-down create; `depositCustomer` is the till's rule (server takes no customer).
4. Pay by card 700: paid 1200, no cash movement; pay on a cancelled deposit: stored, flag `closed-payment`.
5. Price rise after deposit, collect line A (one of two): receipt total at the frozen price, no price-drift, Deposit
   payment 1200 capped to the receipt; stock not moved again; status stays open.
6. Collect the rest with Deposit (free) + cash: status collected; stock unchanged.
7. Over-use: Deposit payment above free → receipt stored, `deposit-overused`.
8. Cancel under `refund` with cash: stock released for uncollected, given_back, cash_movement out; a second
   identical cancel is a no-op.
9. Cancel under `credit`: credit note `<number>-CN` for free, refund_id null, deposit_id set; spent on a later sale.
10. Cancel under `keep`: kept = free.
11. Collect after cancel: stock moves as a sale, `deposit-overused`.
12. Expiry: `depositOverdue=cancel`, grace 0, collect_by yesterday → `deposits_expire` cancels it (credit → note;
    refund → owed; keep → kept); `show` → untouched. Give back pays the owed out.
13. Cancel without `sale.refund` and no approver → `forbidden`; with an approver → taken.
14. Pull: open deposits come with lines and payments; collected older than 30 days do not.
15. `payment.correct` to the deposit type refused.
16. Settings: the six keys saved and refused out of range.
- [ ] Run alone: `node db/tests/deposits.test.cjs` → all pass. Then `credit-notes`, `retail-till`, `stock-sales`,
  `made-of`, `push-policy`, `premium-gate`, `shop-pages` one at a time → pass.

## Task 3: till data (Room 30, rules, offline)

**Files:** `core/database/Deposits.kt` (entities + `DepositDao`), `TillDatabase.kt` (version 30, entities, dao),
`Migrations.kt` (29→30), `Transactions.kt` (`TicketLineEntity.deposit_line_id`), `core/data/DepositRules.kt`
(pure: free, to pay, cap, overdue/grace days, slip sentence, cancel outcome words, number), `core/data/Deposits.kt`
(the repository: create, pay, cancel, giveBack, collect (puts lines on a fresh sale), expireAlone), `PosSettings.kt`
(keys + `features`), `PullApplier.kt` (deposits, skipping ones with pending ops), `TicketRepository.pay` (Deposit
payments raise `used`/`qty_collected` locally; held lines move no stock), `RetailSales` (add a deposit line),
`CashOps.period` (four lines; deposit kind out of tenders), `Daos.kt` (tender list leaves `deposit` out).
- [ ] Unit tests `DepositRulesTest.kt` first (free, cap, overdue in whole days with the day it turns, grace,
  sentences, number), then the rules; `./gradlew :app:testDebugUnitTest` → pass.

## Task 4: till screens and paper

**Files:** `feature/sell/*` (Deposit key beside Pay for a shop with deposits), `feature/deposits/DepositsScreen.kt`
(list, search, scan, detail with Add payment / Collect / Cancel / Give back / Print), the take-deposit sheet,
`feature/pay/Pay.kt` (the deposit paid first on a collection), `core/print/Docs.kt` + `DocBuilder.kt` (deposit
slip, payment slip; credit note slip for a deposit), navigation and Help, settings rows on the tablet (offline
edition), the X/Z lines, Stock history words for `deposit` / `deposit_release`, Rejected screen words for
`not-entitled` and `deposit-overused`.
- [ ] `./gradlew :app:assembleDebug` → builds; unit tests pass.

## Task 5: back office and /admin

**Files:** `web/app/backoffice/deposits/page.tsx` (+ view), nav entry (shop, Sales group, hidden without the
feature), Receipts (collected deposit named), Customers (open deposits), POS settings rows, Day closing and Sales
summary lines and tender lists leaving `deposit` out, `/admin` client page switch (Deposits) calling
`platform.set_tenant_features`.
- [ ] `npx tsc --noEmit` in `web/` → clean; `shop-pages` extended for the page and lines → pass.

## Task 6: run it

- [ ] Test emulator (mine, 5598, windowed, said first), the made-up shop on the offline plan with deposits on:
  take with cash, add by card, collect in two visits, cancel under credit, spend the note, the Z adds up; overdue
  under cancel at day open; the stand-in printer catches every slip.
- [ ] A connected run: dev server, a deposit made on one till and collected on another (DEMO_PULL).
- [ ] Write section 14 of the spec (what was run), the memory note, and the user's test guide.
