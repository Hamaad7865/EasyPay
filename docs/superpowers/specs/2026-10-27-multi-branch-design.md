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
