# Multi-branch

Asked 2026-10-27: "Can we build the multi branch now?" The design was settled with the owner in three rounds of
questions (the grill-me skill), every recommended answer taken ("Yes to all"), and confirmed with "Yes, that's it.
Write the spec and the plan."

The public site already sells it, in words that stay as they are (`site/README.md`): one account for all the
branches; each branch has its own tills, printers and tables (a restaurant) or stock (a shop); the menu or catalog,
the staff and the prices are shared.

## 1. What is there already

- The data follows the branch: tills, printers, tables, bookings, table cards, receipts, shifts, day closes, drawer
  counts, clock punches, deposits, account payments, purchase orders, deliveries, counts and stock levels each carry
  `store_id`. A stock level holds its own average cost.
- Only EasyPay adds a branch: `platform.add_store`, on the client's page in /admin. Every member of staff is put on
  the new branch.
- Printers, tables, bookings and table cards already list or pick a branch. Company details already takes each
  branch's address, which the MRA receives with its sales.
- A till lets in only the staff on its branch, or staff on no branch at all (`Staff.kt`). A shop's till pulls its own
  branch's stock levels, orders, deliveries and counts.

## 2. Who and what it costs

- A branch is added by EasyPay only, in /admin, as now.
- No extra charge: any account with a back office (trial or Premium) can have branches. An offline account has one
  branch: /admin does not offer Add store for it, and `platform.add_store` refuses it (`offline-one-branch`).
- An account with two or more branches cannot be moved to the offline plan: /admin refuses it and says why. This is
  a default taken while writing the plan, not one of the owner's answers; the owner was told.
- Restaurants and shops get the same design. No client is waiting for it.

## 3. What stays shared

- The menu or catalog, the prices and promotions. A markdown applies at every branch; a slow mover is judged on the
  stock of all branches together.
- Customers and their money: a customer's history, accounts and statements, deposits and credit notes cover the whole
  account. With two or more branches, their lists get a Branch column saying where each line happened.

## 4. The branch picker and reports (piece 1)

- **The picker:** a list at the top of the pages it covers, "All branches" and each branch by name. It is shown only
  when the account has two or more branches. It opens on All branches the first time, then remembers the last pick in
  that browser (a cookie, `bo-branch`). A pick that is no longer a branch of the account reads as All branches.
- **It covers:** the dashboard; every report (Sales, Items, Orders, Tax, Journal, Day closing, Time cards, Stock) and
  its CSV/Excel download; Insights (menu, sales, staff); the stock pages (section 6).
- **It does not cover:** pages for the whole account (menu, staff, taxes, settings and the rest) and the customer
  money pages (section 3), which do not show it. Printers, tables, bookings, table cards, Point of sale and the MRA
  page keep their own branch lists, as now.
- **All branches:** the combined figures, with a "By branch" table on the dashboard and on Sales (each branch's sales,
  refunds and net). The Orders and Day closing lists get a Branch column.
- **One branch:** only that branch's figures. The dashboard shows that branch's name and address where it shows the
  first branch's today.
- A download names the branch it was made for.

## 5. Staff per branch (piece 2)

- Staff gets "Works at": a tick for each branch, shown only with two or more branches. A new member of staff starts on
  every branch, as now. At least one branch must stay ticked.
- The tills already obey it; nothing changes on the till.
- A branch EasyPay adds gets only the staff who work at every branch. Staff limited to some branches stay limited.
- Time cards follow the picker (section 4).

## 6. Stock per branch (piece 3)

- Stock on hand, stock counts, purchase orders, stock movements, the Stock report and the item page work for the
  picked branch, where they now take the first branch (`first_store`).
- **All branches:** stock on hand shows the total and a column for each branch. Low stock is judged per branch,
  against that branch's reorder point.
- **The item page** lists each branch's stock and reorder point; the reorder point is set per branch.
- **Coming in:** a purchase order belongs to one branch, chosen when it is made (it starts on the picked branch). A
  stock count is for one branch: with All branches picked, starting one asks which. A spreadsheet import puts its
  stock in the branch picked on the import page.
- **The engine:** every stock function is read in its live definition on dev for a branch's figure taken from the
  item's total (`items.stock_qty`, which stays the total of all branches). Found while writing this:
  `stock_count_item` works out a count's difference from the item's total, which is wrong for a branch when there
  are two. Each such function is fixed forward in a migration, with a test of two branches.

## 7. Transfers (piece 4)

- A page under Stock: Transfers, a list of past transfers (when, from, to, items, who), and New transfer.
- **One step:** pick the From branch, the To branch, the items and the quantities, and save. The stock leaves one
  branch and arrives at the other at the same moment, at the sending branch's average cost; the receiving branch's
  average moves with it. No "in transit" and no receiving step.
- It needs the Adjust stock permission (`stock.adjust`). No new permission.
- It refuses to send more of an item than the From branch has, and names the item and how many are left there.
- Each transfer has a printable note: the two branches, the date, who, and the items with their quantities.
- No undo: a mistake is sent back with another transfer.
- It is not a sale: no receipt, no VAT, nothing sent to the MRA. It shows in stock movements at both branches, as
  "Transfer to <branch>" and "Transfer from <branch>".
- The tills of both branches get their new stock levels at their next pull, as for any stock change.
- Server: tables `stock_transfers` and `stock_transfer_lines`, and `stock_transfer()`, which checks as
  `stock_adjust` does (the item counts stock, a variant is picked where there are variants, enough at the From
  branch) and moves each line with `stock_move` twice under one reference.

## 8. Receipts and papers (piece 5, the till build)

- The top of a receipt: the company name; under it the branch name, only when the account has two or more branches;
  then the branch's address and phone. A branch with no address or phone set prints the company's.
- The same head on the printed and emailed Z report and day-close papers.
- Company details takes each branch's name and phone beside its address (the address is there already).
- The till keeps the branch's phone (a new column on its `stores`, Room 35 to 36) and knows how many branches the
  account has from its pull.
- No till is forced to update (`MIN_TILL_VERSION` stays): an older till prints the company's address until it gets
  the build.

## 9. How it is built

- In the order of the pieces above, each tested on dev and committed on its own on `restopos`.
- Migrations from 0136, applied on dev only.
- Tests use a client with two branches on dev, made inside the test and rolled back, as the other suites do. Suites
  run one at a time.
- Pushed to GitHub when all five are done. No tag: putting it live is the owner's.

## 10. Not built

Back office logins that see only their own branch (later). A different menu, catalog or price per branch. Transfers
from a till, or with an "in transit" step. Adding a branch from the back office.

## 11. Built and checked (2026-10-27)

Commits on `restopos`: piece 1 `8af22c78`, piece 2 `cee3141e` (0136), piece 3 `d4cb2fa0` (0137), piece 4 `9019e5ab`
(0138), piece 5 `35afe5d3` (till 0.9.29, build 41, Room 36). Migrations 0136 to 0138 are on dev only.

- **Found while building:**
  - `stock_count_item` wrote -7 at Port Louis for a count of 3 there with 10 at Main (fixed in 0137).
  - `catalog_import` skipped opening stock at a second branch (fixed in 0137).
  - Three suites (stock-reports, made-of, deposits) passed six parameters to `RECEIPTS` and broke once it took the
    branch; they pass it now.
- **What was decided while building:**
  - With All branches of several, the stock pages are read-only: a count, an order, a delivery, an adjustment or a
    transfer is for one branch, picked at the top or chosen in its form.
  - A branch's line on paper is in the name block's style (big) on a designed receipt, and normal size on the other
    papers.
  - A transfer of a product whose cost is not known (0) leaves the receiving branch's average as it was.
  - An account with two or more branches cannot be put on the offline plan (told to the owner).
- **Run:**
  - `db/tests/multi-branch.test.cjs`: 71 PASS. It uses a restaurant with two then three branches, a one-branch
    restaurant and a two-branch shop, with sales through `sync_push`. It opens every report, Insights, the
    dashboard and every stock page at each pick, then exercises staff, stock, transfers and Company details.
  - One at a time: customer-history 26, journal 17, shop-pages 116, pos-pages 126, platform 38, backoffice-saves 75,
    business-type 16, stock-reports 38, purchase-orders 45, catalog-import 25, made-of 30, promotions 31,
    deposits 86, retail-till 49, count-from-alone 15, sold-by 33, isolation (row security) 11, delete-client 14,
    remove-test-clients 14. All PASS.
  - setting-up: the transfer tables are listed with what "Clear test activity" keeps, as deliveries and counts are
    (their movements were already kept). Its X6 still fails on `mra_records` (0132), a table left off its lists
    before this work; which list it belongs on is for whoever owns the MRA records.
  - Removing a client: the transfer tables are write-once (`block_update`), and removal deletes under
    `app.purge_tenant`, which `block_update` lets through; delete-client passes.
  - A till before 0.9.29 that pulls a transfer's movements says "Correction" (an unknown reason falls through);
    0.9.29 says "Sent to a branch" and "Arrived from a branch".
  - `nav.test` and `papers.test` PASS. `tsc` is clean, and `next build` passes.
  - Android: `testDebugUnitTest` (901 tests) and `assembleDebug` pass. The shared paper example `branch-80.json`
    prints the same lines on the till and in the back office preview.
- **Looked at:** Sales, the dashboard, New transfer and a transfer's note, drawn read-only with the real stylesheet
  in headless Chrome.
- **Not seen:**
  - any page signed in, in a real browser;
  - the till on a tablet or an emulator (no emulator was running, and none was started);
  - a paper from a real printer;
  - a till pulling a transfer's stock levels, beyond the level's sequence moving on.
- **Another session in the same checkout:** another session edited this folder at the same time ("a shop's own
  words", `75050cc6`, which touched the company page, the dashboard and Insights). Each commit here was staged file
  by file, and the company page was staged from that commit plus this change.
