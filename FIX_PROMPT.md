# Fix the review findings

## Context

You have been building RestoPOS in this folder: Postgres migrations in `db/`, the Neon Function API in `hello.ts`, the Next.js back office in `web/`, and the Android till in `android/`.

A second reviewer read all of it without running anything. The design holds up. The problems are code paths that were written and never run, plus logic errors in the money path. This document lists every finding and the behaviour each fix must produce.

Because the findings come from reading, treat each one as a claim to verify. Reproduce it with a failing test before you change anything. If a finding does not reproduce, stop and tell me what you saw instead of changing code.

## Owner's decisions

These two answers change how item 4 is written. If either is blank, ask me before starting item 4.

- VAT: menu prices already include VAT, or VAT is added on top? Answer: ______
- A line with quantity 2 and one paid modifier: is the modifier charged once or twice? Answer: ______

## Rules

1. **Do step 0 before anything else.** Nothing is committed and every database URL points at production.
2. **Never run migrations, tests or debug scripts against the Neon `production` branch.** Production gets the new migrations only after every test passes on the dev branch and I say go.
3. **Fix forward.** Migrations 0001 to 0013 are applied and recorded in `schema_migrations`, so editing them does nothing. Put fixes in 0014 and later, using `create or replace function` and `alter table`.
4. **One item at a time, in order.** For each: write a failing test, make the fix, run the test, show me the output, commit, then move on. Items 1 to 6 come before item 7.
5. **Do not make a test pass by removing a safeguard.** RLS, the insert-only triggers and the permission checks stay.
6. **If an instruction here conflicts with the spec, stop and tell me.** Do not pick one silently. Also add the spec to the repo as `docs/spec.md`; the code cites it and it is not here.
7. **Say what you could not verify.** If you cannot build Android in your environment, say so. Do not report something as working unless you ran it.

## Step 0: make the work safe

- Create a git branch named `restopos`, add everything, and commit it as the baseline. Do not push: `origin` points at a different project (`C:\Projects\KidsCorner`).
- Create a Neon branch named `dev` from production. Point `.env.local` and `web/.env.local` at the dev branch, for both pooled and unpooled URLs.
- Switch `.neon` and `NEON_BRANCH` to dev as well, so function deploys land on dev. If Neon gives the branch its own auth and function endpoints, replace `NEON_AUTH_BASE_URL`, `NEON_AUTH_JWKS_URL` and `NEON_FUNCTION_API_BASE_URL` with the dev values. Never deploy to production.
- Run `db/migrate.cjs` and `db/tests/isolation.test.cjs` on dev and show me the output.

## 1. Tenant context helper

Where: `asTenant` in `hello.ts` (line 47) and `withTenant` in `web/lib/db.ts` (line 14).

What is wrong:

- `SET LOCAL app.tenant_id = $1` is a syntax error, because `SET` cannot take a bind parameter.
- There is no `BEGIN`, so `SET LOCAL` would have no effect even if it parsed.
- `SET ROLE` is session-level, and the connection goes through the transaction-mode pooler. The role does not reliably apply to the next statement, and the connection is the owner role, which bypasses RLS. A partial fix would let one tenant read every tenant.

Required behaviour: each call is one transaction.

```ts
await client.query("BEGIN");
await client.query("SET LOCAL ROLE app_user");
await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
// ... run the caller's queries on this client ...
await client.query("COMMIT"); // ROLLBACK on error, release in finally
```

No session-level `SET` or `set_config(..., false)` anywhere.

Also add an explicit `tenant_id = $n` predicate to queries that select or update by id, starting with `saveItem` in `web/app/backoffice/items/page.tsx`. RLS stays the main guard; this is the second one.

Test: call the real helpers (not a copy of their SQL) over the pooled URL. Run 50 interleaved calls for two tenants and assert that no call sees the other tenant's rows.

## 2. `sync_push` rejection handling

Where: `db/migrations/0010_sync_push.sql`.

What is wrong:

- Line 90 writes `tenant_id` where the variable is `tenant`. Every rejected op therefore errors inside the exception handler and rolls back the whole batch.
- `when others` stores every failure as a permanent rejection, including transient ones such as deadlocks and timeouts.
- A replayed op returns status `duplicate` even when the stored result was `rejected`, so a client reads a rejection as success.
- An op with no `type` hits the `not null` on `sync_ops_applied.type` inside the handler.

Required behaviour:

- Transient errors are not stored. These are SQLSTATE class 40 (deadlock, serialization failure), class 53 (out of resources), `55P03` (lock not available) and `57014` (query cancelled). Processing stops at that op. It and every later op in the batch come back with status `retry`, and earlier ops stay applied. Ops are ordered commands, so continuing past a transient failure would wrongly reject the ops that depend on it.
- Every other error is stored as rejected and the batch continues. Our own codes and bad payloads keep their code. Unexpected errors get code `error`, with the detail logged on the server.
- A replay returns the stored result with its original status and code, plus `"replayed": true`.

Tests: a batch of good, bad, good ops returns applied, rejected, applied. Replaying a rejected op returns rejected. Update the existing expectations in `tmp-phase2.cjs` to match.

## 3. Refunds

Where: `push_refund_create` in `db/migrations/0012_push_receipts.sql`.

What is wrong:

- It inserts the refund receipt and then updates it (lines 223 and 240). `receipts` is insert-only, so every refund fails.
- By-line refunds use a hardcoded 15% (line 238) and ignore modifiers and the original discount, so a refund can exceed what the customer paid.
- Only one refund per receipt is allowed, even after a partial refund.
- No refund payment rows are written, so the cash drawer cannot be reconciled.

Required behaviour:

- Compute all totals first, then insert the receipt once. Never update or delete a receipt.
- Refund amounts come from the original receipt's snapshots: line price, line modifiers, line taxes, and the original discount applied pro rata. A refund of every line equals the original total exactly.
- Several partial refunds are allowed. The cumulative refunded quantity per original line never exceeds the original quantity.
- The refund records how the money went back (payment type and amount), summing to the refund total.
- Refund lines carry their modifier and tax snapshots.

Tests: full refund mirrors the original; by-line refund on a discounted receipt with modifiers returns the discounted amount; a second refund of an already fully refunded line is rejected; a waiter without `sale.refund` is rejected and the batch continues.

## 4. Sales and payments

Where: `db/migrations/0011_push_tickets.sql` and `push_receipt_create` in `0012_push_receipts.sql`.

Start by running `tmp-dbg3.cjs` on dev to see the real error. `push_receipt_create` declares record variables `l` and `t` (line 30) and also uses `l` and `t` as table aliases in its queries. PL/pgSQL treats that as an ambiguous column reference. Rename the variables.

Then make these hold, each with a test:

- **Split payments.** Today, paying one line of a two-line ticket marks the whole ticket paid, and paying the second line is flagged as a double payment. Required invariants:
  - A receipt's total equals the sum of its payments.
  - A ticket becomes `paid` only when every non-void line is paid.
  - No line is charged twice across normal receipts.
  - The normal receipts of a paid ticket sum to the ticket total, never more.
  - A payment for something already paid is stored and flagged `needs_review`, never rejected.
  - Follow the spec for how a bill may be split, and tell me which model you implemented.
- **Modifier prices.** They are added once per line today (line 69). Apply the owner's decision above.
- **Tax.** Only `added` taxes are computed (line 102). Handle `included` taxes as well, per the owner's VAT decision, so `tax_total` is right in both cases.
- **Server authority.** `rounding` and `service_charge` are taken from the payload unchecked (lines 108 and 109). Derive them from configuration or bound them by the spec's rule. If the spec has no rule, reject a rounding of one rupee or more and tell me.
- **Discounts.** Cap percent at 100 and total discount at the subtotal. A discount with `requires_approval` needs an approver who holds the right permission, stored in `approved_by`. A discount with no `discount_id` needs a permission too. Use the permission names from the spec.
- **Offline sales are never lost.** Today the server prices a line at sync time and rejects it if the item changed price or became unavailable while the till was offline. The sale already happened. The line op must carry the price the cashier saw. If it differs from the catalog, or the item is now unavailable, accept the sale at the till's price and flag the receipt `needs_review`. The same goes for a receipt number collision: store it with a disambiguated number and flag it.
- **Paid lines are protected.** `ticket.void_line`, `ticket.move_lines` and `ticket.merge` must refuse lines that are already paid.
- Replace the `_disc` temp table with a local jsonb or array variable.

## 5. `sync_pull`

Where: `db/migrations/0013_sync_pull_transactions.sql`, and `PullWorker` in `android/.../core/sync/Sync.kt`.

What is wrong:

- The limit is per table, but `next_cursor` is the highest sequence seen in any table. When one table is truncated at the limit and another table has a newer row, the rest of the truncated table is never sent.
- Each table is read in its own snapshot. A write that commits between two table reads can push the cursor past a row in a table that was already read.
- `select *` on `employees` sends `pin_hash` to every device.
- Tickets and their lines are sent for every store and all time.

Required behaviour:

- A client that pages until `has_more` is false holds every row visible to it, whatever the table sizes. When any table is truncated, the cursor must not pass that table's last returned row.
- All tables are read at one point in the sequence. Taking the tenant advisory lock in shared mode at the top of the function does this, because `touch_row` takes the same lock exclusively.
- Every dynamic query has an explicit `tenant_id = current_tenant_id()` predicate.
- `employees` uses an explicit column list without `pin_hash`. Ask me how offline PIN login should work before sending any verifier to devices.
- Tickets and their child rows are scoped to the store passed in.

Test: seed 450 items and 30 newer modifiers, pull with a limit of 200 until `has_more` is false, and assert that all 480 rows arrived.

## 6. API and back office

- **`/signup`** (`hello.ts` line 67): require a verified JWT and take the user id only from its `sub`. Remove `authUserId` from the body and `tenantId` from the 409 response.
- **Error responses**: stop returning database error text in `detail`. Log it on the server.
- **`seed_demo_catalog`**: revoke execute from `PUBLIC` and set `search_path = public, pg_temp`. Check the caller with `has_perm`, not by comparing the role name.
- **`/devices/register`** (line 184): upsert on the device id. If another device already holds that code in the store, return 409. Today two tills left on the default `T1` become one device and share a receipt sequence.
- **`POST /sync/push`**: add it. The employee id comes from the token, never from the body. Cap the batch size.
- **Foreign keys**: composite keys with `on delete set null` also null `tenant_id`, which is `not null`, so the delete fails. Use `on delete set null (column)`. On insert-only tables use `no action`, since the trigger blocks the update anyway. Four tables have the nullable column inside their primary key, where it can never be nulled: `ticket_line_modifiers`, `ticket_line_taxes`, `receipt_line_modifiers` and `receipt_line_taxes`. Give those a surrogate `id` primary key, which also allows the same modifier twice on one line. `set null (column)` needs Postgres 15 or later, so check `select version()` first.
- **Tenant removal**: a tenant with receipts can never be deleted, because the insert-only triggers block the cascade. Add a purge path that only the owner role can use and that never allows updates. Propose the mechanism before building it.
- **Back office**: enforce permissions on the item and category actions, and add `web/app/backoffice/page.tsx`, since login and onboarding redirect there and get a 404.

## 7. Android

It has never been compiled. Make it build first:

- `android/settings.gradle.kts` lines 1 and 2 use `#` comments, which are invalid in Kotlin script.
- Add `gradle.properties` with `android.useAndroidX=true`, a root build file and the Gradle wrapper.
- Kotlin 2.1 needs the Compose compiler Gradle plugin. Remove `composeOptions`.
- Add the missing dependencies: `material3`, `hilt-navigation-compose`, and the androidx `hilt-compiler` for `@HiltWorker`.
- Set matching Java and Kotlin JVM targets.
- Remove the default WorkManager initializer in the manifest, or `HiltWorkerFactory` is never used.

Then fix the runtime bugs:

- `AppNav.kt` always starts at sign-in. Start from the saved session so the menu opens offline after a restart.
- `ready` and `signedIn` are plain variables, so the device screen stays on the spinner. Make them state, and navigate from a `LaunchedEffect`.
- `AuthClient.signIn` discards the token failure, so a wrong password looks like success. Check HTTP status on every call.
- `AppModule` adds a trailing slash and `AuthClient` adds another, giving `//sign-in/email`.
- Cookies are held in memory and the cached JWT is never refreshed. Persist the session and refresh the token on 401. Return `Result.retry()` from the worker on network errors.
- `OnConflictStrategy.REPLACE` with a `SET_NULL` foreign key clears the category on every item when a category re-syncs. Use `@Upsert`.
- `clearAllTables()` runs on the main thread at sign-out and will crash. Sign-out must also work offline.
- When you add Room tables for data the pull already sends, reset the pull cursor in the migration.

Acceptance: `./gradlew :app:assembleDebug` succeeds, and the three checks in `android/README.md` pass on a device.

## 8. Housekeeping

- Move `tmp-phase2.cjs` into `db/tests/`, add it to `package.json` and CI, and delete `tmp-dbg3.cjs`.
- Its cleanup loop deletes from insert-only tables, which the triggers block, so it fails on every run. Drop the delete-based cleanup. Run CI on a throwaway Neon branch per job, created at the start and deleted at the end.
- Restore the blanket `.env*` rule (keeping `.env.example`) and `.opencode/` in `.gitignore`.
- Pin `@neondatabase/auth` to an exact version instead of `latest`.
- List the test tenants left on production (`P2-Probe`, `dbg`, `P0-A-*`, `P0-B-*`). Do not delete them until I confirm.

## Final report

End with a table: item, status, test that proves it, and anything you could not verify.
