# A customer's history: implementation plan

> Carried out in the session that wrote it, on the owner's "write spec and plan and build". Spec:
> `docs/superpowers/specs/2026-10-26-customer-history-design.md`.

**Goal:** a back office page per customer with their visits, what they spent, what they buy most and every receipt;
and number boxes whose words sit beside them.

**Architecture:** a server page at `web/app/backoffice/customers/[customer]/page.tsx`, laid out like the account
page (`accounts/[customer]`). The Orders report's receipt card and its three queries move to one shared file, used by
both pages. One CSS rule for the `check` label.

**Tech:** Next (app router, server components), `pg` through `readTenant`, `db/tests/page.cjs` to open pages with no
login.

## Files

- Create `web/app/backoffice/receipt-card.tsx`:
  - `type ReceiptHead`, `type ReceiptParts`;
  - `receiptParts(c, tenantId, ids)`: lines, payments and discounts, as the Orders report reads them now;
  - `ReceiptCard`: the `<details>` card, with an optional `extra` line under the head and an optional `foot`.
- Modify `web/app/backoffice/reports/orders/page.tsx`: use both. What it draws stays the same.
- Create `web/app/backoffice/customers/[customer]/page.tsx`: the history.
- Modify `web/app/backoffice/customers/table.tsx`: the name is a link, and the open panel gets a History link.
- Modify `web/app/backoffice/accounts/[customer]/page.tsx`: a History button.
- Modify `web/app/globals.css`: the `check` label centres a box that is not a checkbox.
- Create `db/tests/customer-history.test.cjs`: a throwaway restaurant in one rolled-back transaction.

## Task 1: the suite first

`db/tests/customer-history.test.cjs`, set up as `shop-pages.test.cjs` is: `platform.create_tenant_of_type`, then a
till's ops through `sync_push`. The data:

- customer Ravi has three orders:
  - one paid as a split bill: two receipts on one ticket;
  - one with a line refunded;
  - one with two of the same item.
- customer Mia has none.

The suite then checks:

- H1: the page opens for Ravi as the owner.
- H2: Visits 3, Spent equal to Customers' Spent for Ravi, average Spent / 3, and both first and last visit shown.
- H3: Buys most lists the item bought most first, with the refunded one taken off.
- H4: every receipt is listed, the refund among them, each with its items.
- H5: for a role without `reports.view`, the page opens with the name, and shows no figures and no receipts.
- H6: Mia's page says nothing was bought yet.
- H7: a removed customer's page opens and says they were removed.
- H8: an unknown id is not found.
- H9: Orders still opens and draws the same receipts.
- H10: Customers links each name to its page.

Run it with `node db/tests/customer-history.test.cjs`. It is expected to fail until Task 3, because the page does
not exist yet.

## Task 2: the shared receipt card

Move `Head`, `Line`, `Pay`, `Disc`, the three queries and the `<details>` body out of `reports/orders/page.tsx`, into
`receipt-card.tsx`. Orders keeps its own head query, because it has filters, and calls `receiptParts` and
`ReceiptCard`. Check it with `shop-pages.test.cjs`: its Orders checks must still pass.

## Task 3: the history page

- **Route:** `UUID.test(customer)` or `notFound()`.
- **Data:** `readTenant`, then `reportStart` for `l`, `ok` and `s`. The queries:
  - the customer row, removed or not;
  - the figures, over `receipts r join tickets t on t.tenant_id = r.tenant_id and t.id = r.ticket_id where
    r.tenant_id = $1 and t.customer_id = $2 and r.deleted_at is null`, exactly the Customers Spent join:
    - Visits: `count(distinct r.ticket_id) filter (where type = 'sale')`;
    - Spent: `sum(case when refund then -total else total end)`;
    - first and last: `min` and `max` of `coalesce(device_time, created_at)` over the sales;
  - Buys most: `receipt_lines` over the same receipts, `sum(± qty)` grouped by `name_snapshot`,
    `having > 0`, the top 5;
  - the receipts: the latest 200, with the store name, the cashier, the waiter, the dining option, the table,
    `refund_of`'s number, `points_earned` and `points_used`;
  - shop links: whether any `account_bills`, `deposits` or `credit_notes` carry the customer;
  - the number of stores.
- **Without `ok`:** the head, then a note that the history is shown to those allowed to see reports.

## Task 4: the links

On Customers, the name cell becomes a `Link`, with `stopPropagation` so the row does not open, and the open panel
gets a History link. On the account page, a History button.

## Task 5: the words beside a box

In `globals.css`, after `.check input`:

```css
.check:has(> input:not([type="checkbox"]):not([type="radio"])), .check:has(> select) { align-items: center; }
.check > input:not([type="checkbox"]):not([type="radio"]), .check > select { margin-top: 0 !important; }
```

Then find every `className="check"` that holds a number box, a time or a list (`grep`), draw those pages with the real
stylesheet, and look at them light and dark.

## Task 6: checks and commit

- `tsc --noEmit -p web/tsconfig.json`;
- `next build`, its output to a file;
- `customer-history`, `shop-pages` and `seats-customers`, one at a time;
- the page for the real dev clients, read-only: every customer's Spent against Customers'.

Commit on `restopos`, staging files by name. Do not push.
