# Restaurant POS: Build Spec

Multi-tenant, offline-first, Loyverse-style restaurant POS for the Mauritian market.

**How to use this file:** build phase by phase (section 13). Each phase has exit criteria. Do not start a phase until the previous one passes. Sections 4, 5 and 15 are non-negotiable rules; everything else can be adjusted.

**Assumptions made (change these first if wrong):**

| Decision | Choice | Why |
|---|---|---|
| POS client | Android, Kotlin + Jetpack Compose | Requirement |
| Backend | Supabase (Postgres, Auth, RLS, Edge Functions, Realtime, Storage) | Row-level security gives tenant isolation at the database, not in app code |
| Back office | Next.js (App Router) + TypeScript + Tailwind | Web, same Supabase project |
| Tenancy | Shared database, shared schema, `tenant_id` on every row | Cheapest to run, simplest to migrate |
| Devices per store | Multiple (cashier + waiters + kitchen) | Restaurant reality; single-device still works |
| Currency | MUR, stored as integer cents | No floats near money |

> NOTE (Neon adaptation, decided after this spec was written): the project builds
> on Neon (Lakebase Postgres + Neon Auth + Neon Functions + Object Storage),
> not Supabase. RLS, `tenant_id` stamping, offline-first sync and all of
> sections 4, 5 and 15 carry over unchanged; Supabase Auth / Edge Functions /
> Realtime / Storage map to Neon Auth / Neon Functions / SSE-via-Functions /
> Object Storage. Where this file says Supabase, read Neon unless a decision
> record says otherwise.

---

## 1. What we're building

Three surfaces, one backend:

1. **POS app** (Android tablet and phone). Takes orders, takes payment, prints. Works with no internet.
2. **KDS mode** (same Android app, different launch mode). Kitchen screen showing tickets per station.
3. **Back office** (web). Menu, employees, stores, devices, reports, settings. Online only.

Later: customer-facing display, owner dashboard app, QR table ordering.

Business model: self-serve SaaS. A restaurant owner signs up on the web, gets a tenant, creates a store, installs the app, signs in, and is selling within ten minutes without talking to anyone.

---

## 2. "Loyverse-style": what that means here

Loyverse is the reference for UX and product shape, not for code. Copy the concepts, not the pixels.

| Loyverse concept | Our implementation |
|---|---|
| One account, many stores, many POS devices per store | `tenants → stores → pos_devices` |
| Owner signs in with email on the device, staff switch with PIN | Supabase Auth session on device + local PIN check against synced employees |
| Sale screen: item grid on one side, ticket on the other | Same. Two-pane on tablet, grid with a collapsible ticket bar on phone |
| Items as coloured tiles or images, category tabs, custom pages | `items.tile_color`, `items.image_path`, `grid_pages` for custom layouts |
| Open tickets (save an order, pay later) | `tickets` table, mutable until paid |
| Predefined tickets (used as tables) | `tables` with optional floor-plan coordinates; opening a table creates or resumes its ticket |
| Split, merge, move items between tickets | Ticket operations in section 7.4 |
| Dining options (Dine in, Take out, Delivery) | `dining_options`, per-tenant, selectable per ticket |
| Modifiers | `modifier_groups` + `modifiers`, attached to items |
| Kitchen printers and kitchen displays by station | `printer_groups` (stations) mapped to categories; a station outputs to a printer, a KDS, or both |
| Shifts with cash management | `shifts` + `cash_movements` |
| Receipts list with refund from receipt | Receipts screen, section 7.6 |
| Feature toggles in settings (shifts, open tickets, kitchen printers, dining options, time clock...) | `tenant_settings.features` JSON; UI hides anything switched off |
| Back office on the web | Section 9 |
| Free core, paid add-ons | `plans` + `tenant_features`; gate inventory, employee management, multi-store |

Design principle taken from Loyverse: a new user must be able to make a sale with zero configuration. Everything restaurant-specific is a toggle that reveals more UI.

---

## 3. Stack and repo layout

**Android:** Kotlin, Compose, Hilt, Room, WorkManager, Ktor client (or supabase-kt behind an interface), DataStore, kotlinx.serialization, Coil. Min SDK 26. Use the latest stable versions at project start and pin them in a version catalog.

**Backend:** Supabase. All schema in SQL migrations. Business writes go through Postgres functions (RPC). Edge Functions only for things that need secrets or third-party calls (signup, MRA, email receipts).

**Web:** Next.js App Router, Supabase SSR auth, server components for reads, server actions for writes.

```
/                               # (Neon: db/migrations + hello.ts functions + web/ + android/)
├── android/
│   ├── app/                    # navigation, DI wiring, launch modes (POS, KDS)
│   ├── feature/
│   │   ├── auth/  sale/  tickets/  payment/  receipts/
│   │   ├── shift/  items/  settings/  kds/
│   └── core/
│       ├── model/              # pure Kotlin domain models
│       ├── database/           # Room entities, DAOs, migrations
│       ├── data/               # OfflineFirst* repositories
│       ├── sync/               # outbox, push/pull workers, cursor store
│       ├── network/            # API client, DTOs
│       ├── printing/           # ESC/POS, printer transports, print queue
│       ├── fiscal/             # FiscalService interface + MRA implementation
│       ├── designsystem/  ui/  common/  testing/
├── supabase/
│   ├── migrations/             # numbered SQL, never edited after merge
│   ├── functions/              # edge functions
│   └── tests/                  # pgTAP: RLS and sync tests
├── web/                        # Next.js back office
└── docs/
```

Each Android feature module: `XScreen.kt`, `XViewModel.kt`, `XUiState.kt` (sealed interface), `XAction.kt`. ViewModels expose one `StateFlow<UiState>` and one `onAction()`.

---

## 4. Multi-tenancy (non-negotiable)

### 4.1 Hierarchy

```
tenant (the merchant account)
 ├── stores (branches)
 │    ├── pos_devices
 │    ├── tables, printers, printer_groups
 │    └── shifts, tickets, receipts
 ├── employees (PIN users, assigned to one or more stores)
 └── catalog (items, categories, modifiers, taxes, discounts): tenant-wide,
     with per-store price and availability overrides
```

### 4.2 Rules

1. Every table has `tenant_id uuid not null`. No exceptions, including join tables.
2. Row-level security is enabled on every table. A table without a policy is a failed code review.
3. `tenant_id` comes from the JWT, never from the request body. The server stamps it.
4. Cross-tenant foreign keys must be impossible. Use composite keys: parent has `unique (tenant_id, id)`, child has `foreign key (tenant_id, parent_id) references parent (tenant_id, id)`.
5. One auth user belongs to exactly one tenant in v1.
6. The service-role key never ships in the Android app or the browser.
7. A device's local database holds one tenant only. Signing out wipes Room, and is blocked while the outbox is not empty.
8. Storage paths are prefixed `tenant_id/…` with a storage policy that checks the prefix.

### 4.3 Implementation

`tenant_id` and `role` live in the user's `app_metadata`, which only the service role can write. A signup Edge Function creates the tenant, the first store, the owner employee, and sets `app_metadata`.

```sql
create or replace function auth_tenant_id() returns uuid
language sql stable as $$
  select nullif(auth.jwt() -> 'app_metadata' ->> 'tenant_id', '')::uuid
$$;

alter table items enable row level security;

create policy tenant_isolation on items
  using (tenant_id = auth_tenant_id())
  with check (tenant_id = auth_tenant_id());
```

Apply the same policy to every table through a migration helper so nobody hand-writes it. Add a pgTAP test that fails if any table in `public` has RLS disabled or zero policies.

> NOTE (Neon): Neon Auth JWTs carry no custom claims, so there is no
> `auth.jwt() → app_metadata` path. Tenant context comes from a
> transaction-local GUC (`app.tenant_id`) set per request by the Function
> after verifying the JWT and looking up `employees.auth_user_id`. RLS,
> `FORCE RLS`, and the least-privilege `app_user` role enforce the same rules.

### 4.4 Platform admin

A separate `platform_admins` table and a separate admin area in the web app, reached with the service role on the server only. Used to view tenants, change plans, and suspend accounts. A suspended tenant can still sync existing sales up (never trap their data) but cannot open new shifts.

---

## 5. Offline-first architecture and sync (non-negotiable)

### 5.1 Rules

1. Room is the single source of truth. Screens read Flows from Room and write to Room. No screen calls the network.
2. Every mutation writes its data and an outbox row in one Room transaction.
3. All IDs are client-generated UUIDv7.
4. Every outbox operation has its own `op_id`. The server applies each `op_id` at most once.
5. Pull uses a server-assigned sequence, never device clocks.
6. Deletes are soft (`deleted_at`).
7. Receipts and payments are immutable. Corrections are new records.
8. A recorded payment is never discarded by sync. If it conflicts, accept it and flag it.

### 5.2 Flow

```
Compose UI ──Flow──► Room ◄──────────────── pull worker
     │                 ▲                         ▲
     └─ write (1 txn) ─┤                         │
                       ▼                         │
                    outbox ──► push worker ──► sync_push()   sync_pull()
                                                   └── Postgres ──┘
```

### 5.3 Server sequence

A single global sequence stamped by trigger on every synced table. The advisory lock serialises writes per tenant so that sequence order equals commit order within a tenant. Without it, a slow transaction can commit a lower number after a client has already pulled past it, and that row is never synced.

```sql
create sequence sync_seq;

create or replace function touch_row() returns trigger
language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.tenant_id::text, 0));
  new.server_seq := nextval('sync_seq');
  new.updated_at := now();
  return new;
end $$;

-- on every synced table:
create trigger trg_touch before insert or update on items
  for each row execute function touch_row();
```

Index every synced table on `(tenant_id, server_seq)`.

### 5.4 Push: `sync_push(ops jsonb) returns jsonb`

Transactional data is pushed as commands, not row upserts:

```
ticket.create        ticket.add_line       ticket.void_line
ticket.update_meta   ticket.move_lines     ticket.merge
receipt.create       refund.create
shift.open           shift.close           cash_movement.create
timeclock.punch      item.upsert (limited, from POS quick-edit)
```

Each op: `{ op_id, type, payload, device_id, employee_id, device_time }`.

Server behaviour:
- Look up `op_id` in `sync_ops_applied`. If present, return the stored result and do nothing.
- Apply each op inside its own savepoint. One bad op must not block the queue behind it.
- Return a result per op: `applied`, `duplicate`, or `rejected` with an error code.
- Stamp `tenant_id` from the JWT. Validate that `device_id` and `store_id` belong to that tenant.

Client behaviour:
- WorkManager unique work, network constraint, exponential backoff. Also triggered immediately after any local write when online.
- Send in creation order, in batches of up to 50.
- `applied` or `duplicate`: delete the outbox row.
- `rejected`: move to a dead-letter state, show a badge for the manager, keep the local data.
- Network failure: leave everything, retry later.

### 5.5 Pull: `sync_pull(store_id, cursor, limit) returns jsonb`

Returns `{ changes: { table: [rows] }, next_cursor, has_more }`, ordered by `server_seq`.

Scope:
- Tenant-wide: catalog, taxes, discounts, dining options, payment types, employees, settings.
- Store-wide: tables, printers, stations, overrides, open tickets, shifts.
- Receipts: this store, last 30 days (configurable), so refunds work from any device.

Client applies each page in one Room transaction, then saves `next_cursor` in that same transaction. First sync loops until `has_more` is false and shows progress.

Pull triggers: app start, after each push, every 15 minutes, on manual refresh, and on a Supabase Realtime message. Realtime is only a nudge to pull; it never carries data the app trusts.

### 5.6 Conflict rules

| Data | Rule |
|---|---|
| Catalog, taxes, settings, employees | Server wins. POS edits go through `item.upsert` and are re-pulled |
| Ticket lines | Append-only. Two devices adding lines both succeed. Voids are flags, not deletes |
| Ticket metadata (table, dining option, note) | Last write wins by server arrival |
| Paying a ticket | First `receipt.create` closes the ticket. A second one for the same ticket is accepted, stored, and flagged `needs_review` |
| Stock | Append-only `stock_movements` with deltas |
| Shifts | One open shift per device. Enforced locally and on the server |

### 5.7 Receipt numbers

Format `{store_code}-{device_code}-{sequence}`, for example `PL1-T2-000482`. The sequence is per device, incremented locally in the same transaction as the receipt, and mirrored to `pos_devices.last_receipt_seq` so a reinstall resumes instead of restarting. Check MRA numbering rules before finalising the format.

### 5.8 Time

Store both `device_time` (when it happened, device clock) and `received_at` (server clock). Reports use `device_time`. Sync ordering uses `server_seq`. If device and server clocks differ by more than five minutes at sign-in, warn the user.

### 5.9 LAN hub (phase 7)

For multi-device restaurants when the internet is down but Wi-Fi is up. One device is the hub: it runs an embedded Ktor server, advertises itself over NSD, and exposes the same `push` and `pull` contract as the cloud. Other devices sync to the hub when the cloud is unreachable. The hub forwards everything to the cloud when it comes back. Because the contract is identical, the client sync code needs only a different base URL. Design sections 5.4 and 5.5 so this stays true.

---

## 6. Data model

Every table also has: `id uuid pk`, `tenant_id`, `created_at`, `updated_at`, `deleted_at`, `server_seq`. Store-scoped tables add `store_id`. Money is `bigint` cents. Quantities are `integer` thousandths (so 1.5 kg is 1500 and 2 burgers is 2000).

**Platform**
- `tenants` (name, brn, vat_number, country, currency, plan_id, status)
- `plans`, `tenant_features`
- `tenant_settings` (features json, receipt header/footer, default language, rounding rule, service charge config)

**Organisation**
- `stores` (name, code, address, phone, timezone)
- `pos_devices` (store_id, name, code, last_receipt_seq, last_seen_at, app_version, is_hub)
- `employees` (name, pin_hash, role_id, auth_user_id nullable, is_active)
- `roles` (name, permissions json)
- `employee_stores`

**Catalog**
- `categories` (name, color, sort_order, printer_group_id)
- `items` (category_id, name, price, cost, sku, barcode, sold_by: each or weight, tile_color, tile_shape, image_path, is_available, track_stock, dietary_tags text[])
- `item_variants` (item_id, name, price, sku, barcode)
- `modifier_groups` (name, min_select, max_select), `modifiers` (group_id, name, price), `item_modifier_groups`
- `taxes` (name, rate_bp in basis points, type: included or added, is_default), `item_taxes`
- `discounts` (name, type: percent or amount, value, requires_approval)
- `store_item_overrides` (store_id, item_id, price, is_available)
- `grid_pages`, `grid_page_items` (custom sale-screen layouts)

**Restaurant setup**
- `dining_options` (name, is_default, sort_order)
- `tables` (store_id, name, area, seats, x, y)
- `printer_groups` (stations), `printers` (store_id, name, transport, address, paper_width, purposes, printer_group_id)
- `payment_types` (name, kind: cash, card, wallet, qr, other; opens_drawer, is_active)

**Transactions**
- `tickets` (store_id, table_id, dining_option_id, name, status: open, paid, cancelled; opened_by, customer_id, note, covers)
- `ticket_lines` (ticket_id, item_id, variant_id, name_snapshot, unit_price, qty, note, course, sent_to_kitchen_at, voided_at, voided_by, void_reason, kitchen_status)
- `ticket_line_modifiers` (line_id, modifier_id, name_snapshot, price)
- `ticket_line_taxes` (line_id, tax_id, name_snapshot, rate_bp, type)
- `receipts` (store_id, device_id, shift_id, ticket_id, number, type: sale or refund; refund_of, subtotal, discount_total, tax_total, service_charge, rounding, total, employee_id, customer_id, device_time, needs_review)
- `receipt_lines`, `receipt_line_modifiers`, `receipt_line_taxes` (full snapshots; never joined back to the catalog for display)
- `receipt_payments` (receipt_id, payment_type_id, amount, tendered, change, reference)
- `receipt_discounts` (receipt_id, line_id nullable, discount_id, name_snapshot, amount, approved_by)
- `shifts` (store_id, device_id, opened_by, opened_at, opening_float, closed_by, closed_at, expected_cash, counted_cash)
- `cash_movements` (shift_id, type: pay_in or pay_out, amount, reason, employee_id)
- `fiscal_documents` (receipt_id, status: pending, submitted, accepted, rejected; request, response, attempts)
- `audit_log` (employee_id, device_id, action, entity, entity_id, details, device_time)

**Later phases**
- `customers`, `loyalty_ledger`, `stock_levels`, `stock_movements`, `recipes`, `suppliers`, `purchase_orders`, `time_entries`

**Sync plumbing**
- Server: `sync_ops_applied` (op_id pk, tenant_id, type, result, applied_at)
- Device only (Room): `outbox` (op_id, type, payload, created_at, attempts, state, last_error), `sync_state` (cursor), `print_jobs`

Room entities mirror the server tables one to one, same names, same column names.

---

## 7. POS app

### 7.1 Sign-in and device setup
1. Email and password (Supabase Auth).
2. Pick a store, then pick or create a POS device for this tablet.
3. First sync with progress.
4. PIN screen. Every later app open lands on the PIN screen.

### 7.2 PIN and permissions
Four to six digit PIN, checked locally against the synced hash. Lock after inactivity (configurable). Any action the current employee lacks permission for prompts for a manager PIN, and the override is written to `audit_log`.

### 7.3 Sale screen
- Left: category tabs, item grid (tiles with colour or image), search, barcode scan.
- Right: current ticket with lines, modifiers, notes, totals, and one large Charge button showing the total.
- Tap item: adds it. If it has required modifiers or variants, a sheet opens first.
- Tap a line: quantity, note, discount, void.
- Ticket header: dining option, table, customer, covers.
- Buttons: Save (becomes an open ticket), Open tickets, Send to kitchen.
- Must stay responsive with 2,000 items. Grid and search read from Room with paging.

### 7.4 Open tickets and tables
- List view and table view. Table tiles show status, elapsed time, and running total.
- Operations: assign or change table, rename, split (by item, by seat, evenly), merge, move lines, reassign to another employee.
- Send to kitchen sends only unsent lines. Each send is a numbered kitchen order.
- Voiding a line that was already sent prints a void slip at the station and needs a reason.

### 7.5 Payment
- Totals: subtotal, discounts, service charge, VAT breakdown, rounding, total.
- Payment types from `payment_types`. Cash shows quick amounts (exact, next notes). Wallet and QR types take an optional reference.
- Split payment across types. Partial payments keep the ticket open until fully paid.
- On completion, in one Room transaction: create receipt, lines, payments; close the ticket; bump the receipt sequence; write the outbox op; enqueue print jobs; enqueue the fiscal job.
- Result screen: change due, print, email, new sale.

### 7.6 Receipts
List with search by number, amount, date. Detail view. Refund full or by line (creates a `refund` receipt linked by `refund_of`). Reprint is marked as a copy.

### 7.7 Shift
Open with a float. Pay in, pay out. Close with a blind count: expected, counted, variance. Shift report (X while open, Z on close) is printable and lists sales by payment type, refunds, discounts, voids, and cash movements.

### 7.8 Settings on device
Printers (discover, test print, assign purposes), station mapping, language, sync status with outbox count and last sync time, dead-letter list, sign out.

### 7.9 UX rules
- Tablet landscape is the primary layout. Phone portrait must be fully usable.
- A cash sale of one item is three taps: item, Charge, Cash.
- A small persistent indicator shows offline state and the number of unsynced operations. Offline is never an error dialog.
- Touch targets at least 48 dp. Sale and KDS screens support dark theme.

---

## 8. KDS mode

- Same APK. Chosen during device setup. Bound to one or more stations.
- Tickets as cards in arrival order with dining option, table, lines, modifiers, notes, and an elapsed timer that changes colour at configurable thresholds.
- Tap a line to mark it done. Bump the card when everything is done. Recall the last bumped card.
- Sound on new order. Voided lines are shown struck through, never silently removed.
- Data arrives through normal sync, and through the LAN hub once phase 7 exists.

---

## 9. Back office (web)

- **Onboarding:** sign up, verify email, business details (name, BRN, VAT number), first store.
- **Dashboard:** today versus the same day last week, sales by hour, top items.
- **Items:** items, categories, modifiers, discounts, CSV import and export, per-store overrides.
- **Reports:** sales summary; by item, category, employee, payment type, dining option; receipts; discounts; voids; refunds; taxes (VAT report); shifts. Filter by store, date range, employee. Export CSV.
- **Employees:** list, roles and permissions, PIN reset, store access, time cards.
- **Stores and devices:** stores, POS devices (rename, deactivate, last seen), tables, stations.
- **Settings:** features toggles, taxes, payment types, dining options, receipt design, service charge, rounding, language.
- **Billing:** plan and add-ons.
- **Needs review:** receipts flagged by sync conflicts, and rejected operations.

Reports read from SQL views or materialised views. Never aggregate in the browser.

---

## 10. Printing and hardware

- `Printer` interface with transports: network (TCP 9100), Bluetooth, USB.
- ESC/POS command builder. 58 mm and 80 mm widths. Logo as a raster image.
- Purposes per printer: receipts, kitchen orders, bills (pre-payment), shift reports.
- `print_jobs` table in Room. A worker drains it with retries. A failed print never blocks a sale, and the user can reprint from the queue.
- Kitchen routing: line → item → category → station → printer and/or KDS.
- Cash drawer kick through the receipt printer, only for payment types with `opens_drawer`, and logged.
- Barcode scanners as keyboard input, plus camera scanning.

---

## 11. Mauritius requirements

- **VAT:** rate stored in basis points and configurable (do not hard-code 15%). Support inclusive and added taxes, zero-rated and exempt items. Receipts show the VAT breakdown, the business BRN and VAT number, and optionally the customer's BRN and VAT number for B2B.
- **MRA e-invoicing:** hide it behind a `FiscalService` interface with a no-op implementation until phase 8. Fiscalisation is an outbox-style job stored in `fiscal_documents`: the sale completes locally and submission happens when online. Build the real implementation strictly from the MRA e-invoicing developer documentation (JSON format, registration, what must be printed on the receipt, credit notes for refunds, offline rules, numbering). Do not guess field names or flows. Whether a tenant must fiscalise depends on turnover thresholds that keep dropping, so make it a per-tenant setting.
- **Payment types seeded for new tenants:** Cash, Card, Juice, my.t money, Blink, MauCAS QR, Bank transfer. Recorded manually with an optional reference in v1. Integrated dynamic QR is a later phase.
- **Languages:** English, French, Kreol Morisien (`values`, `values-fr`, `values-b+mfe`). No hard-coded strings. Kitchen ticket language is a store setting.
- **Dietary tags on items:** veg, vegan, halal, no beef, no pork, spicy. Shown on tiles and kitchen tickets.
- **Service charge:** off by default, percentage, optionally only for dine-in.
- **Cash rounding:** configurable rule, shown as its own line on the receipt.
- **Foreign cash (later):** tender in EUR, USD, GBP at a store-set rate, change in MUR.
- **Timezone:** `Indian/Mauritius` default per store. Business day cutoff is configurable for places open past midnight.

---

## 12. Permissions

Stored as a JSON set on `roles`. Seed four roles: Owner, Manager, Cashier, Waiter.

```
sale.create            sale.apply_discount     sale.apply_restricted_discount
sale.void_line         sale.void_sent_line     sale.refund
ticket.view_all        ticket.reassign         ticket.split_merge
payment.take           drawer.open_no_sale
shift.open_close       shift.view_report       cash.pay_in_out
items.edit             settings.device         receipts.view_all
receipts.reprint       backoffice.access       reports.view
```

Waiter defaults: create sales, manage own tickets, send to kitchen. No payment, no voids of sent lines, no discounts.

---

## 13. Build phases

**Phase 0: Foundation**
Repo, CI, Supabase project, migration tooling, the `tenant_isolation` policy helper, `touch_row` trigger, signup Edge Function, pgTAP RLS tests, Android skeleton with modules and Hilt, web skeleton with auth.
*Exit:* two test tenants exist and neither can read or write the other's rows through any endpoint. Test proves it.

**Phase 1: Catalog and pull sync**
Back office CRUD for categories, items, variants, modifiers, taxes, payment types, dining options. Android sign-in, store and device selection, Room schema, pull worker, sale screen grid rendered from Room.
*Exit:* edit an item on the web, see it on the tablet within seconds. Turn on airplane mode, restart the app, the menu is still there.

**Phase 2: Sales and push sync**
Ticket building, modifiers, taxes, discounts, cash and other payment types, split payment, receipts, receipt numbering, outbox, push worker, `sync_push` with idempotency, receipts list.
*Exit:* make 50 sales offline, reconnect, all 50 appear in the back office exactly once, including when the app is killed mid-push.

**Phase 3: Restaurant flow**
Open tickets, tables, dining options, split, merge, move, send to kitchen, ESC/POS printing (receipts, bills, kitchen orders), stations, print queue.
*Exit:* a full dine-in service works on one device with a receipt printer and one kitchen printer.

**Phase 4: Staff and cash control**
Employees, PIN, roles, manager override, audit log, shifts, pay in and out, X and Z reports, refunds, voids with reasons.
*Exit:* a waiter cannot refund; a manager PIN allows it; the audit log shows who and when.

**Phase 5: Reports and back office completion**
All reports in section 9, CSV export, receipt design, feature toggles, needs-review queue, multi-store views.
*Exit:* an accountant can produce a monthly VAT figure from the VAT report alone.

**Phase 6: KDS and multi-device**
KDS mode, open tickets shared across devices through cloud sync, Realtime nudges, duplicate-payment flagging.
*Exit:* a waiter's phone, a cashier tablet, and a kitchen screen run a service together while online.

**Phase 7: LAN hub**
Embedded server, NSD discovery, hub election (manual in v1), failover between cloud and hub.
*Exit:* unplug the router's internet. Waiter, cashier, and kitchen keep working together. Plug it back in and everything reaches the cloud with no duplicates.

**Phase 8: MRA fiscalisation**
Real `FiscalService`, fiscal data on receipts, credit notes for refunds, retry and monitoring screens.
*Exit:* passes MRA's own test and certification process.

**Phase 9: SaaS and growth features**
Plans and billing, platform admin, customers and loyalty, inventory and recipes, time clock, customer display, integrated QR payments, QR table ordering.

Phases 0 to 4 are the sellable MVP for a single-device restaurant.

---

## 14. Test scenarios that must pass

1. Tenant A's token cannot select, insert, update, or delete any row of tenant B, on every table. Automated.
2. The same push batch sent three times creates each record once.
3. App killed after the server applied a batch but before the client saw the response: next push produces no duplicates.
4. A batch with one invalid op: the other ops apply, the bad one lands in dead-letter.
5. Two devices add lines to the same ticket while offline: both sets of lines exist after sync.
6. Two devices pay the same ticket while offline: both payments are stored, the second is flagged `needs_review`.
7. Item price changed in the back office after a sale: the old receipt still shows the old price.
8. A slow transaction committing late is never skipped by a client that has already pulled (the test for 5.3).
9. Sign-out is blocked while the outbox has pending ops.
10. Reinstalling the app on a device continues the receipt sequence.
11. Printer unplugged during payment: the sale completes, the print job waits, reprint works.
12. Totals: for every receipt, lines + taxes + service charge + rounding − discounts equals total, and payments − change equals total. Property-based test.
13. Device clock set to the wrong day: sync still works, and the user is warned.

---

## 15. Rules for whoever (or whatever) writes the code

- No network call from a ViewModel or a composable. Repositories only, and repositories only write to Room and the outbox.
- No `Float` or `Double` for money or quantities. Ever.
- No server-generated IDs for anything created on a device.
- No hard deletes on synced tables.
- No table without `tenant_id`, RLS, a policy, and the `touch_row` trigger.
- No trusting `tenant_id`, `store_id`, or `employee_id` from a payload without checking it against the JWT's tenant.
- Receipts, payments, cash movements, and audit rows are insert-only on the server. Add a trigger that blocks updates.
- Every Room schema change ships with a migration and a migration test. Never use destructive fallback in release builds.
- Every Supabase schema change is a new migration file. Never edit a merged one.
- New columns are additive and nullable or defaulted, because old app versions will still be syncing.
- Sync contract changes are versioned: the client sends `app_version` and `schema_version`, and the server can refuse clients that are too old with a clear "update required" result.
- All user-facing strings go in resources in all three languages.
- One feature at a time, with tests, before the next.

---

## 16. Open questions

1. Product name and package ID.
2. Pricing: fully free core like Loyverse with paid add-ons, or a flat monthly fee per store?
3. Target for v1: single-device takeaways and snacks first, or full-service restaurants (which need phases 6 and 7)?
4. Which thermal printer models will the first customers use? Buy one of each before phase 3.
5. Does the first paying customer already fall under MRA e-invoicing? If yes, phase 8 moves up.
6. iOS later? If likely, keep `core/model`, `core/sync`, and `core/data` free of Android dependencies so they can move to Kotlin Multiplatform.
