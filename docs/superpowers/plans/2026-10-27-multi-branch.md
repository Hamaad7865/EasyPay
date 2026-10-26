# Multi-branch: implementation plan

> Carried out in the session that wrote it, piece by piece, on the owner's "Write the spec and the plan". Spec:
> `docs/superpowers/specs/2026-10-27-multi-branch-design.md`. Steps use checkboxes (`- [ ]`).

**Goal:** one account, several branches, seen in the back office branch by branch or together; staff, stock and
receipts per branch; stock sent between branches.

**Architecture:** the branch picked in the back office is a cookie (`bo-branch`) read by `web/lib/branch.ts`. Reports
take it as one more filter, `$7` on `RECEIPTS`. Server changes are fix-forward migrations from 0136, each function
taken from its live definition on dev (`pg_get_functiondef`). The till gets the branch's phone (Room 36) and prints
the branch's head.

**Tech:** Next (app router, server components and actions), `pg` through `readTenant` / `withTenant`, Postgres
functions, `db/tests/*.test.cjs` on dev in one rolled-back transaction, `db/tests/page.cjs` to open pages with no
login. Android: Kotlin, Room, JVM unit tests.

**Rules for every piece:** read a file's committed version before editing it (`git show HEAD:<path>`); `git fetch
github` first and fast-forward if it moved; migrations on dev only (`node db/migrate.cjs`), never production; suites
one at a time, never `db-tests` on CI; commit on `restopos`, files staged by name; no push until all five pieces are
done, no tag ever.

## Files

**Piece 1, picker and reports**
- Create `web/lib/branch.ts`: `BRANCH_COOKIE`, `type Branch`, `branches(c, tenantId)`, `pickedOf(all)`.
- Create `web/app/backoffice/branch-actions.ts`: the server action that sets the cookie.
- Create `web/app/backoffice/branch-picker.tsx`: the list, drawn in a page's `PageHead`.
- Modify `web/lib/report.ts`: `Filters.store`, `filters(sp, tz, store)`, `args` with `$7`, `RECEIPTS` filtered by it,
  `LISTS` with the branches.
- Modify the reports: `reports/{sales,items,orders,tax,journal,day-close,timecards,stock}/page.tsx`,
  `insights/{menu,sales,staff}/page.tsx` and `insights/parts.tsx`, `web/lib/journal-db.ts`,
  `web/lib/stock-reports.ts`.
- Modify `web/app/backoffice/page.tsx` (the dashboard).
- Modify the customer money pages: `customers/[customer]/page.tsx`, `accounts/**`, `deposits/page.tsx`,
  `credit-notes/page.tsx` (a Branch column).
- Modify `db/tests/page.cjs`: a stand-in for `next/headers`.
- Create `db/tests/multi-branch.test.cjs`, grown piece by piece.

**Piece 2, staff:** `db/migrations/0136_branches.sql`, `web/app/backoffice/staff/page.tsx`,
`web/app/admin/tenants/[id]/view.tsx`.

**Piece 3, stock per branch:** `db/migrations/0137_stock_per_branch.sql` (what the audit finds),
`stock/on-hand.tsx`, `stock/page.tsx`, `stock-counts/**`, `purchase-orders/**`, `stock-movements/**`,
`reports/stock/page.tsx`, `items/[id]/page.tsx`, `items/import/**`.

**Piece 4, transfers:** `db/migrations/0138_stock_transfers.sql`, `web/app/backoffice/transfers/{page.tsx,new/page.tsx,
[id]/page.tsx}`, `web/app/backoffice/nav.ts`, `stock-movements/moves.ts`.

**Piece 5, receipts:** `company/page.tsx`; Android `Entities.kt`, `Migrations.kt`, `TillDatabase.kt`,
`PullApplier.kt`, `PosSettings.kt`, `print/Docs.kt`, `print/PaperWalk.kt`, `app/build.gradle.kts`; their unit tests.

---

## Piece 1: the picker and reports

### Task 1.1: a two-branch restaurant in a suite

- [ ] **Step 1:** in `db/tests/page.cjs`, add to `stubs` a stand-in for the cookie, so a test says which branch is
  picked with `ctx.branch`:

```js
    'next/headers': {
      cookies: async () => ({
        get: (k) => (k === 'bo-branch' && ctx.branch ? { value: ctx.branch } : undefined),
        set() {},
      }),
    },
```

- [ ] **Step 2:** create `db/tests/multi-branch.test.cjs`, set up as `customer-history.test.cjs`:
  `platform.create_tenant_of_type` (a restaurant, plan `premium`), then `platform.add_store($admin, $tid, 'Port
  Louis', 'PL')`, a till in each branch (`pos_devices`), and through `sync_push` from each till: Main sells two
  Mix grills (Rs 230.00), Port Louis sells one Lassi (Rs 115.00) and refunds nothing. Checks:
  - B1: `/backoffice/reports/sales` with no branch picked shows net Rs 345.00 and a By branch table with both
    branches.
  - B2: the same with `branch: <Port Louis>` shows Rs 115.00 and no By branch table.
  - B3: `/backoffice/reports/orders` lists three receipts with a Branch column; with Main picked, two.
  - B4: a branch id from another tenant, or not a UUID, reads as All branches (Rs 345.00).
  - B5: the dashboard with Port Louis picked names Port Louis.
  - B6: a one-branch tenant's Sales shows no picker and no By branch table.
- [ ] **Step 3:** `node db/tests/multi-branch.test.cjs`. Expected: B1 to B5 FAIL (no picker, no filter).

### Task 1.2: the branch, the cookie and the picker

- [ ] **Step 1:** create `web/lib/branch.ts`:

```ts
import type { PoolClient } from "pg";
import { cookies } from "next/headers";

// The branch the back office is looking at (docs/superpowers/specs/2026-10-27-multi-branch-design.md):
// picked at the top of a report or a stock page, kept in this browser. null is All branches.
export const BRANCH_COOKIE = "bo-branch";
export type Branch = { id: string; name: string; address: string | null; phone: string | null };

export async function branches(c: PoolClient, tenantId: string): Promise<Branch[]> {
  return (await c.query(
    `select id, name, address, phone from stores where tenant_id = $1 and deleted_at is null order by created_at, id`,
    [tenantId],
  )).rows as Branch[];
}

// One branch has nothing to pick. A pick that is not one of this account's branches is All branches.
export async function pickedOf(all: Branch[]): Promise<Branch | null> {
  if (all.length < 2) return null;
  const want = (await cookies()).get(BRANCH_COOKIE)?.value ?? "";
  return all.find((b) => b.id === want) ?? null;
}
```

- [ ] **Step 2:** create `web/app/backoffice/branch-actions.ts`:

```ts
"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { BRANCH_COOKIE } from "@/lib/branch";
import { UUID } from "@/lib/action";

// what the picker sends: a branch's id, or "" for All branches; checked against the account where it is read
export async function pickBranch(id: string, path: string) {
  const v = UUID.test(id) ? id : "";
  (await cookies()).set(BRANCH_COOKIE, v, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/backoffice", maxAge: v ? 60 * 60 * 24 * 365 : 0 });
  revalidatePath(path);
}
```

- [ ] **Step 3:** create `web/app/backoffice/branch-picker.tsx`, a client component: a `<select>` with "All
  branches" and each branch, `defaultValue` the picked id or `""`, `onChange` calling `pickBranch(value,
  usePathname())` in a transition and then `router.refresh()`. Draw nothing when `all.length < 2`. It sits in the
  `children` of `PageHead`, styled as the report filters' labels are (`label` with "Branch").
- [ ] **Step 4:** `tsc --noEmit -p web/tsconfig.json`. Expected: clean.

### Task 1.3: reports take the branch

- [ ] **Step 1:** in `web/lib/report.ts`:
  - `Filters` gets `store: string | null`; `filters(sp, tz, store: string | null = null)` returns it.
  - `args` becomes `[tenantId, f.from, f.to, f.employee, f.dining, f.kind, f.store]`, and the header comment of
    `RECEIPTS` says `$7 branch or null`.
  - `RECEIPTS` gets `and ($7::uuid is null or v.store_id = $7::uuid)` and selects `v.store_id, s.name as store_name`.
  - `LISTS` gets the branches: `coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name, 'address',
    s.address, 'phone', s.phone) order by s.created_at, s.id) from stores s where s.tenant_id = $1 and s.deleted_at
    is null), '[]'::json) as stores`, and `Lists` gets `stores: Branch[]`.
- [ ] **Step 2:** in `reports/orders/page.tsx` and `reports/tax/page.tsx`, the payment and tax filters move from `$7`
  to `$8`.
- [ ] **Step 3:** in each report page, after `reportStart`: `const b = await pickedOf(l.stores)`, `filters(sp, l.tz,
  b?.id ?? null)`, and `<BranchPicker all={l.stores} picked={b?.id ?? null} />` in `PageHead`. Reports that do not
  use `RECEIPTS` add the branch to their own queries:
  - Day closing: `day_closes.store_id`; a Branch column with two or more branches.
  - Time cards: `timeclock_punches.store_id`.
  - Journal (`web/lib/journal-db.ts`): every source it reads that has `store_id` (receipts, account payments,
    deposits) takes the branch.
  - Stock report: `web/lib/stock-reports.ts`, done with piece 3.
  - Sales: with All branches and two or more branches, a "By branch" card: one row per branch with sales, refunds and
    net, from `RECEIPTS` grouped by `store_id`. The deposits and account-payment figures it reads (lines 67 to 94)
    take `$7` too.
  - Orders: a Branch column with two or more branches.
  - Insights (menu, sales, staff): through `insights/parts.tsx`, which reads `RECEIPTS` and `args`.
- [ ] **Step 4:** a download (`CsvButton`, `PrintButton`) gets the branch name in its file name and title when one is
  picked.
- [ ] **Step 5:** `node db/tests/multi-branch.test.cjs`. Expected: B1 to B4 and B6 PASS.

### Task 1.4: the dashboard

- [ ] **Step 1:** in `web/app/backoffice/page.tsx`, the `NOW` query takes `$3` (branch or null): `ot`, `rv`, `bk`, `up`
  and the tables count filter by `store_id` when it is set; `store` and `address` come from the picked branch, or the
  first when none is picked and there is one branch, or the account's name when All branches is picked with several.
  The figures over days (below `NOW`) take the branch the same way.
- [ ] **Step 2:** with All branches and two or more branches, a "By branch" card: today's sales and open orders per
  branch.
- [ ] **Step 3:** `node db/tests/multi-branch.test.cjs`. Expected: B5 PASS.

### Task 1.5: a Branch column on the customer money pages

- [ ] **Step 1:** with two or more branches, add a Branch column (the store's name) to: a customer's receipts
  (`customers/[customer]`, already shows it), the account page's bills and payments (`accounts/[customer]`), Deposits
  and Credit notes. No picker there.
- [ ] **Step 2:** add B7 to the suite: a deposit taken at Port Louis shows "Port Louis" on Deposits.

### Task 1.6: checks and commit

- [ ] `tsc --noEmit -p web/tsconfig.json`; `next build`, its output to a file.
- [ ] One at a time: `multi-branch`, `customer-history`, `shop-pages`, `journal`, `pos-pages`.
- [ ] Draw Sales and the dashboard read-only for a real dev client with one branch: nothing changed for it.
- [ ] Commit: "back office: a branch picker, and reports by branch".

## Piece 2: staff per branch

### Task 2.1: tests first

- [ ] Add to the suite:
  - S1: on Staff, Works at saved for a cashier as Port Louis only leaves one `employee_stores` row for them.
  - S2: saving Works at with nothing ticked is refused, and the rows stay.
  - S3: `platform.add_store` for a third branch puts on it the staff who work at every branch, and not the cashier
    who works at Port Louis only.
  - S4: `platform.add_store` for a tenant on the offline plan raises `offline-one-branch`.
- [ ] Run. Expected: S1 to S4 FAIL.

### Task 2.2: migration 0136

- [ ] **Step 1:** read the live definition: `select pg_get_functiondef('platform.add_store(uuid,uuid,text,text)'::regprocedure)`.
- [ ] **Step 2:** create `db/migrations/0136_branches.sql`, with the usual header (what changes, the source, "Never
  edit after merge"), redefining it with two changes:

```sql
  if exists (select 1 from tenants where id = p_tenant and lower(btrim(coalesce(plan, ''))) = 'offline') then
    raise exception 'offline-one-branch';
  end if;
  ...
  -- the new branch takes the staff who work at every branch; staff kept to some branches stay so
  insert into employee_stores (tenant_id, employee_id, store_id)
    select p_tenant, e.id, v_store from employees e
     where e.tenant_id = p_tenant and e.deleted_at is null
       and not exists (select 1 from stores s
                        where s.tenant_id = p_tenant and s.deleted_at is null and s.id <> v_store
                          and not exists (select 1 from employee_stores es
                                           where es.employee_id = e.id and es.store_id = s.id and es.deleted_at is null));
```

- [ ] **Step 3:** `node db/migrate.cjs` (dev). Run the suite: S3, S4 PASS.

### Task 2.3: Works at on Staff, Add store in /admin

- [ ] **Step 1:** in `web/app/backoffice/staff/page.tsx`, with two or more branches, each person's row gets "Works
  at": a checkbox per branch and a Save, posting to a new action `setStores` (guarded by `employees.edit`, as the
  page's other actions): it checks each id is a branch of the account, refuses none ("Tick at least one branch."),
  then soft-deletes the rows not ticked (`deleted_at = now()`) and inserts or revives the ticked ones, so the tills
  get the change by sequence. The notice: "Saved. The tills get the change at their next sync."
- [ ] **Step 2:** in `web/app/admin/tenants/[id]/view.tsx`, an offline client's page shows no Add store form, and says
  "An offline client has one branch."
- [ ] **Step 3:** run the suite: S1, S2 PASS. Run `platform`, `backoffice-saves`. `tsc`. Commit: "staff: which
  branches each person works at; a new branch takes only those who work at every branch (0136)".

## Piece 3: stock per branch

### Task 3.1: the audit

- [ ] **Step 1:** on dev, list every function that reads the item's total or the first branch:
  `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public','platform')
  and p.prosrc ~ '(stock_qty|first_store)' order by 1`.
- [ ] **Step 2:** read each (`pg_get_functiondef`). Write in the spec's section 6 which take a branch's figure from the
  total (known: `stock_count_item`), which are right as they stand (`stock_move` keeps the total), and which take
  the first branch where a branch should be passed.

### Task 3.2: tests first

- [ ] Add to the suite, on a shop tenant with two branches and one counted product:
  - K1: 10 received at Main, 4 at Port Louis; a count at Port Louis of 3 leaves Main at 10 and Port Louis at 3, and
    the item's total at 13.
  - K2: Stock on hand with Port Louis picked shows 3; with All branches, 13 and a column for each branch.
  - K3: a reorder point of 5 set at Port Louis marks it low there and not at Main.
  - K4: a purchase order made with Port Louis picked belongs to Port Louis, and receiving it adds there.
  - K5: an import with Port Louis chosen puts its opening stock at Port Louis.
  - K6: Stock movements with Main picked lists Main's only.
  - and one check for each function the audit found wrong.
- [ ] Run. Expected: FAIL.

### Task 3.3: migration 0137 and the pages

- [ ] **Step 1:** `db/migrations/0137_stock_per_branch.sql`: each function the audit found, from its live
  definition, reading the branch's level instead of the total. For `stock_count_item`: the difference is
  `p_counted - v_level.qty`, with `v_level := stock_level_for(p_tenant, p_store, p_item, null)`.
- [ ] **Step 2:** the pages take `pickedOf(await branches(c, tenantId))` and pass the branch where they now pass
  `first_store($1)`:
  - `stock/on-hand.tsx` and `stock/page.tsx`: one branch, or All branches with the total and a column per branch;
  - `stock-counts/page.tsx`: starting a count with All branches picked asks which branch;
  - `purchase-orders/page.tsx`, `purchase-orders/[id]/page.tsx`, `purchase-orders/receive/page.tsx`: a new order's
    branch, shown and kept on the order; receiving goes to the order's branch;
  - `stock-movements/page.tsx`, `moves.ts`, `export/route.ts`;
  - `reports/stock/page.tsx` and `web/lib/stock-reports.ts`;
  - `items/[id]/page.tsx`: a table of each branch's stock and reorder point; `stock_set_reorder` per branch;
  - `items/import/**`: a branch list on the import page, sent as the store of `catalog_import`.
- [ ] **Step 3:** `node db/migrate.cjs`; the suite; then one at a time `stock-reports`, `purchase-orders`,
  `catalog-import`, `made-of`, `promotions`, `deposits`, `retail-till`, `count-from-alone`. `tsc`, `next build`.
- [ ] **Step 4:** commit: "stock per branch in the back office (0137)".

## Piece 4: transfers

### Task 4.1: tests first

- [ ] Add to the suite, on the shop with two branches:
  - T1: 10 at Main at Rs 20.00, 0 at Port Louis; a transfer of 4 leaves Main 6 and Port Louis 4, Port Louis's average
    Rs 20.00, the item's total still 10.
  - T2: Port Louis holding 2 at Rs 30.00 before, its average after 4 more at Rs 20.00 is Rs 23.3333.
  - T3: a transfer of 11 from Main is refused (`not-enough-stock`, naming the item), and nothing moves.
  - T4: From and To the same branch is refused (`same-branch`).
  - T5: a product with variants needs its variant (`pick-variant`); one that does not count stock is refused
    (`not-counted`).
  - T6: a role without `stock.adjust` is refused.
  - T7: two movements under one reference: `transfer_out` at Main, `transfer_in` at Port Louis.
  - T8: Port Louis's till pull after the transfer has the new level.
  - T9: the Transfers page lists it; its note page shows both branches and the line.
- [ ] Run. Expected: FAIL.

### Task 4.2: migration 0138

- [ ] **Step 1:** create `db/migrations/0138_stock_transfers.sql`: tables `stock_transfers` (id, tenant_id,
  from_store, to_store, number, note, employee_id, created_at, updated_at, deleted_at, server_seq) and
  `stock_transfer_lines` (id, tenant_id, transfer_id, item_id, variant_id, qty, unit_cost, ...), each with RLS forced,
  the `tenant_isolation` policy, the `trg_touch` trigger and the `(tenant_id, server_seq)` index, as
  `stock_counts` has them (0075); the reasons widened with `'transfer_out', 'transfer_in'` (from 0113's list).
- [ ] **Step 2:** the function:

```sql
-- One step: what leaves one branch arrives at the other, at the sending branch's average cost.
-- p_lines: [{ "item": uuid, "variant": uuid|null, "qty": integer }]
create or replace function stock_transfer(
  p_tenant uuid, p_emp uuid, p_from uuid, p_to uuid, p_lines jsonb, p_note text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_id uuid := gen_random_uuid();
  v_line jsonb;
  v_level stock_levels%rowtype;
  v_out uuid;
  v_cost numeric;
begin
  if not has_perm(p_emp, 'stock.adjust') then raise exception 'forbidden'; end if;
  if p_from = p_to then raise exception 'same-branch'; end if;
  if (select count(*) from stores where tenant_id = p_tenant and id in (p_from, p_to) and deleted_at is null) <> 2 then
    raise exception 'unknown-store';
  end if;
  if jsonb_array_length(coalesce(p_lines, '[]'::jsonb)) = 0 then raise exception 'no-lines'; end if;
  insert into stock_transfers (id, tenant_id, from_store, to_store, number, note, employee_id)
    values (v_id, p_tenant, p_from, p_to, next_transfer_number(p_tenant), nullif(btrim(coalesce(p_note, '')), ''), p_emp);
  for v_line in select * from jsonb_array_elements(p_lines) loop
    -- the same checks as stock_adjust (0073): counted, the variant, enough at the From branch
    ...
    v_level := stock_level_for(p_tenant, p_from, (v_line->>'item')::uuid, (v_line->>'variant')::uuid);
    if v_level.qty < (v_line->>'qty')::int then raise exception 'not-enough-stock:%', (v_line->>'item'); end if;
    v_out := stock_move(p_tenant, p_from, (v_line->>'item')::uuid, (v_line->>'variant')::uuid, -(v_line->>'qty')::int,
      'transfer_out', null, 'transfer', v_id, p_emp, p_note);
    select unit_cost into v_cost from stock_movements where id = v_out;
    perform stock_move(p_tenant, p_to, (v_line->>'item')::uuid, (v_line->>'variant')::uuid, (v_line->>'qty')::int,
      'transfer_in', v_cost, 'transfer', v_id, p_emp, p_note);
    insert into stock_transfer_lines (tenant_id, transfer_id, item_id, variant_id, qty, unit_cost)
      values (p_tenant, v_id, (v_line->>'item')::uuid, (v_line->>'variant')::uuid, (v_line->>'qty')::int, v_cost);
  end loop;
  return v_id;
end $fn$;
```

  The `...` is the body of `stock_adjust`'s checks, copied from its live definition (it raises `not-counted`,
  `pick-variant`, `unknown-line`, `unknown-item`). A line with a quantity of 0 or less raises `bad-quantity`.
  `next_transfer_number` follows how stock counts are numbered (read `count_start`'s numbering in 0075 and use the
  same form with a T prefix). `stock_move`'s "a document moves a product in a shop once" holds: the reference is the
  same, the branches differ.
- [ ] **Step 3:** `node db/migrate.cjs`; the suite: T1 to T8 PASS; `rls_coverage.sql`; `delete-client`.

### Task 4.3: the pages

- [ ] **Step 1:** `web/app/backoffice/transfers/page.tsx`: the list, newest first (number, date, from, to, items,
  who), New transfer for a role with `stock.adjust`. `nav.ts`: Transfers under Stock, only with two or more
  branches (`nav.test.mjs` updated).
- [ ] **Step 2:** `transfers/new/page.tsx`: From (starts on the picked branch), To, then lines added with the
  product search the stock count page uses, each with its quantity and what the From branch holds. Save calls
  `stock_transfer` and goes to the note. Refusals in words: "Only 6 of Mix grill are at Main." "Pick two different
  branches."
- [ ] **Step 3:** `transfers/[id]/page.tsx`: the note, printable (`PrintButton`): number, date, from, to, who, the
  lines with their quantities, and lines to sign for sent and received.
- [ ] **Step 4:** `stock-movements/moves.ts`: "Transfer to <branch>" and "Transfer from <branch>".
- [ ] **Step 5:** the suite: T9 PASS. `tsc`, `next build`. Commit: "stock transfers between branches (0138)".

## Piece 5: receipts and papers (the till build)

### Task 5.1: Company details

- [ ] **Step 1:** test first, B8: saving Company details with two branches saves each branch's name, address and phone;
  a blank name is refused.
- [ ] **Step 2:** in `company/page.tsx`, each branch row gets Name and Phone beside its address (`name_<id>`,
  `phone_<id>`), saved to `stores.name` and `stores.phone`. With one branch the company's address and phone are its
  own, as now.
- [ ] **Step 3:** run, commit with piece 5's till work.

### Task 5.2: the till

- [ ] **Step 1:** fetch and fast-forward; read the emulator note before touching any emulator.
- [ ] **Step 2:** a JVM test first, in the test folder next to the print tests: with a `Shop` of company "Saheer
  Resto", branch "Port Louis", address "Royal Road" and phone "5 123 4567", and `many = true`, the receipt head reads
  those four lines in that order; with `many = false` there is no branch line; a branch with no address prints the
  company's.
- [ ] **Step 3:** `StoreEntity` gets `val phone: String? = null`; `TillDatabase` version 36; `Migrations.kt`
  `MIGRATION_35_36`: `ALTER TABLE stores ADD COLUMN phone TEXT`; `PullApplier` reads `phone` off each store.
- [ ] **Step 4:** `Shop` gets `branch: String = ""`. `PosSettings.kt:130` builds it from the till's own store: the
  branch's name only when the pulled stores are two or more, its address or the company's, its phone or the
  company's.
- [ ] **Step 5:** `Docs.kt`: the receipt head (around line 356) prints `shop.branch` under the name when it is set;
  the Z report and day-close heads (around lines 502, 523, 548) print the branch line, the address and the phone
  under the name. `PaperWalk.kt`: a `branch` block beside `address` and `phone`, drawn by the receipt designer's
  head, with the fixtures in `db/tests/fixtures/papers` and the back office preview (`web/lib/papers.ts`) given the
  same block. Find where the till builds the emailed Z report it sends to the mail service (`POST /v1/z`) and give
  it the same head; the mail Worker (`cloudflare/mail`) is not changed unless the head is built there.
- [ ] **Step 6:** version 0.9.29, versionCode 41. `gradlew testDebugUnitTest`, then `assembleDebug`. `MIN_TILL_VERSION`
  unchanged.
- [ ] **Step 7:** on the emulator, only if free and after saying "I need to shadow": print a receipt and a Z report to
  the stand-in printer for a two-branch dev client and read the paper. If not free, say it was not seen.
- [ ] **Step 8:** `papers` web tests, `tsc`. Commit: "till 0.9.29 (build 41): each branch's name, address and phone
  on its receipts and papers".

## Finish

- [ ] The spec's sections are each checked against what was built; what was run and not seen goes into a section
  "Checked" at the end of the spec, as earlier specs have.
- [ ] `git fetch github`; if it moved, rebase and run the suite again.
- [ ] Push `restopos` to `github`. No tag. Hand the owner the release steps: production migrations 0136 to 0138, then
  the tag, which is theirs.
- [ ] Memory: the store hierarchy note and a new multi-branch note.
