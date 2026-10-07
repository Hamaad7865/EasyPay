# Retail Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A tenant is a restaurant or a retail shop, chosen by the platform admin; all stock moves through one engine that keeps a quantity and an average cost per shop and per product; the back office menu and pages follow the tenant's type.

**Architecture:** `tenants.business_type` is the one source of truth, written only by `platform.*` functions, and copied into `pos_settings.data.businessType` so tills learn it through the pull they already make. `stock_move()` is the only code that writes a stock movement and changes a level; the two receipt functions and the back office Stock page call it. The back office reads the type in `tenantContext()` and filters `nav.ts` by it.

**Tech Stack:** Postgres on Neon (plpgsql, RLS), Node test suites in `db/tests` (`pg`, one file per suite), Next.js 16 back office in `web/` (server actions, no test runner: checked with `tsc` and a build).

**Spec:** `docs/superpowers/specs/2026-10-07-retail-mode-design.md`, piece 1. Approved prototype: https://claude.ai/artifact/GfTY9m9TFyXfNt5inwRh14 (the Admin board is Task 8).

**Out of this plan (later pieces):** the Stock group's pages, variants in the catalog, suppliers, labels, sending `stock_levels` to tills, the retail sell screen, the "update required" gate for old APKs, `ensure_pos_basics` for a shop.

---

## Before starting

Read these once. They are how this repo works, and the plan assumes them.

- **Run everything from the repo root** `C:\Projects\RestoPOS`. `.env.local` there points at the Neon branch `dev-review`. Never point anything at production (host `ep-soft-poetry-b3lyjmxs`).
- **Migrations:** `node db/migrate.cjs` applies every file in `db/migrations` not yet recorded in `schema_migrations`, in name order, each in its own transaction. A migration file is never edited after it is applied: a mistake is fixed in the next numbered file.
- **Tests:** `node db/tests/<name>.test.cjs`. Each prints `PASS`/`FAIL` lines and exits non-zero on a failure. `require-dev.cjs` refuses to run against production. Never run `truncate.test.cjs`, `api6`, `signup-lock` or `platform-auth`.
- **Quantities are thousandths** (3 units is `3000`). **Money is cents** (Rs 40.00 is `4000`).
- **Commits:** branch `restopos`, one commit per task, `git add` the named files only (never `git add -A`: `.claude/` and other people's files stay out). No push. Message style: `area: what it now does, in a sentence`. End every message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Other people's uncommitted work (checked 2026-10-07):** `web/app/backoffice/nav.ts` (the Point of sale group), `db/migrations/0064_device_activity.sql` (already applied on dev), `web/app/backoffice/pos/`, `web/lib/pos.ts`, three test files. **Part A touches none of them. Part B edits `nav.ts`, so Part B does not start until that work is committed.** Run `git status --short` first and stop if `nav.ts` is still modified.
- **Another session was working in this tree while this plan was written.** At 21:28 on 2026-10-07 it added and applied `db/migrations/0065_insert_only_grants.sql` and changed `db/tests/pos-operations.test.cjs`, neither committed. This plan's migrations are therefore 0066, 0067 and 0068. Do not start while that session is still working: two sessions applying migrations to one dev database, and editing one tree, undo each other. Ask the user first.
- If `db/migrations/` already holds a `0066_*` file when you start, shift this plan's three numbers up and keep their order.
- `pos-operations.test.cjs` must pass as it stands when you start (run it once before Task 1 and keep the output). "Unchanged" in Task 3 means unchanged by this plan.

## File map

| File | Created or changed | What it holds |
|---|---|---|
| `db/migrations/0066_business_type.sql` | create | the column and the two platform functions |
| `db/tests/business-type.test.cjs` | create | suite for 0066 |
| `db/migrations/0067_stock_engine.sql` | create | `stock_levels`, wider `stock_movements`, `first_store`, `stock_move` |
| `db/tests/stock-engine.test.cjs` | create | suite for 0067 |
| `db/tests/require-dev.cjs` | change | `stock_levels` in the cleanup list |
| `db/scripts/dump-function.cjs` | create | prints a live function definition |
| `db/migrations/0068_stock_through_engine.sql` | create | quantities carried over, sale and refund redefined |
| `db/tests/stock-sales.test.cjs` | create | suite for 0068 |
| `web/app/backoffice/data/export/route.ts` | change | `stock_levels` in the backup |
| `web/app/backoffice/stock/page.tsx` | change | adjustments go through `stock_move` |
| `web/lib/mode.ts` | create | the `Mode` type and the words that differ |
| `web/lib/tenant.ts` | change | `mode` in the context, `onlyFor()` |
| `web/app/backoffice/nav.ts` | change | which pages each mode has, and their names |
| `web/app/backoffice/side.tsx`, `search-box.tsx`, `layout.tsx` | change | draw the menu and search for the mode |
| `web/app/backoffice/{tables,tables/plan,bookings,addons}/page.tsx` | change | not found for a shop |
| `web/app/backoffice/{categories,settings,items}/…`, `page.tsx` | change | restaurant-only parts hidden for a shop |
| `web/lib/platform.ts`, `web/app/admin/page.tsx`, `web/app/admin/tenants/[id]/page.tsx` | change | the admin's switch |

---

# Part A: the server

### Task 1: The business type

**Files:**
- Create: `db/migrations/0066_business_type.sql`
- Test: `db/tests/business-type.test.cjs`

- [ ] **Step 1: Write the failing test**

Create `db/tests/business-type.test.cjs`:

```js
// business-type.test.cjs — migration 0066: a tenant is a restaurant or a retail shop.
//   - every tenant starts as a restaurant
//   - only a live platform admin changes the type; the change is logged
//   - the type is copied into the settings a till pulls, beside what is there
//   - a change is refused while an order is open
//   - a tenant can be created as a shop in one step
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/business-type.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  // runs a statement that is expected to fail, without losing the transaction
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const said = (e) => (e ? e.message : 'no error');
  try {
    const admin = crypto.randomUUID(), stranger = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-bt@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Type Test','Main','BT1','Owner',$2,'standard') as r`, [admin, crypto.randomUUID()])).r;
    const tid = made.tenant_id;
    const typeOf = async (t) => (await one(`select business_type from tenants where id = $1`, [t])).business_type;
    const key = async (t) => ((await one(`select data->>'businessType' as k from pos_settings where tenant_id = $1`, [t])) || {}).k ?? null;
    const logged = async (t) => (await one(`select count(*)::int as n from platform.audit where tenant_id = $1 and action = 'tenant.business_type'`, [t])).n;

    // B1 every tenant starts as a restaurant
    check('B1 a new tenant is a restaurant', (await typeOf(tid)) === 'restaurant');
    check('B1 and its settings need no key to say so', (await key(tid)) === null);

    // B2 the admin makes it a shop
    await c.query(`update pos_settings set data = data || '{"servicePct": 10}'::jsonb where tenant_id = $1`, [tid]);
    await c.query(`select platform.set_tenant_business_type($1, $2, ' Retail ')`, [admin, tid]);
    const s = await one(`select data from pos_settings where tenant_id = $1`, [tid]);
    check('B2 the type is changed', (await typeOf(tid)) === 'retail');
    check('B2 the tills are told through the settings, which keep what they held',
      s.data.businessType === 'retail' && s.data.servicePct === 10, JSON.stringify(s.data));
    const a = await one(`select detail from platform.audit where tenant_id = $1 and action = 'tenant.business_type'`, [tid]);
    check('B2 the change is logged with from and to', a && a.detail.from === 'restaurant' && a.detail.to === 'retail', JSON.stringify(a));

    // B3 the same type again is no change
    await c.query(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, tid]);
    check('B3 setting the same type again logs nothing', (await logged(tid)) === 1);

    // B4 what is refused
    let e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'hotel')`, [admin, tid]);
    check('B4 an unknown type is refused', e && e.message === 'bad-business-type', said(e));
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [stranger, tid]);
    check('B4 a non-admin is refused', e && e.message === 'not-a-platform-admin', said(e));
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, crypto.randomUUID()]);
    check('B4 an unknown tenant is refused', e && e.message === 'unknown-tenant', said(e));
    e = await failsWith(`update tenants set business_type = 'hotel' where id = $1`, [tid]);
    check('B4 the column itself takes nothing else', e && e.code === '23514', e ? e.code : 'no error');

    // B5 not while an order is open
    const tk = (await one(`insert into tickets (tenant_id, store_id) values ($1, $2) returning id`, [tid, made.store_id])).id;
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [admin, tid]);
    check('B5 a change is refused while an order is open', e && e.message === 'open-orders' && (await typeOf(tid)) === 'retail', said(e));
    await c.query(`update tickets set status = 'cancelled' where id = $1`, [tk]);
    await c.query(`select platform.set_tenant_business_type($1, $2, 'restaurant')`, [admin, tid]);
    check('B5 and goes through once it is closed',
      (await typeOf(tid)) === 'restaurant' && (await key(tid)) === 'restaurant' && (await logged(tid)) === 2);

    // B6 created as a shop in one step
    const shop = (await one(`select platform.create_tenant_of_type($1,'Shop Test','Main','BT2','Owner',$2,'standard','retail') as r`, [admin, crypto.randomUUID()])).r;
    const roles = (await one(`select count(*)::int as n from roles where tenant_id = $1`, [shop.tenant_id])).n;
    check('B6 a tenant can be created as a shop, complete',
      (await typeOf(shop.tenant_id)) === 'retail' && (await key(shop.tenant_id)) === 'retail' && roles === 4 && Boolean(shop.store_id));
    const plain = (await one(`select platform.create_tenant_of_type($1,'Resto Test','Main','BT3','Owner',$2,'standard','restaurant') as r`, [admin, crypto.randomUUID()])).r;
    check('B6 or as a restaurant, which logs no change of type',
      (await typeOf(plain.tenant_id)) === 'restaurant' && (await logged(plain.tenant_id)) === 0);
    e = await failsWith(`select platform.create_tenant_of_type($1,'Nowhere Test','Main','BT4','Owner',$2,'standard','hotel')`, [admin, crypto.randomUUID()]);
    const none = (await one(`select count(*)::int as n from tenants where name = 'Nowhere Test'`)).n;
    check('B6 an unknown type creates nothing', e && e.message === 'bad-business-type' && none === 0, said(e));

    // B7 the tenant role is locked out
    await c.query('SET LOCAL ROLE app_user');
    e = await failsWith(`select platform.set_tenant_business_type($1, $2, 'retail')`, [admin, tid]);
    check('B7 the tenant role cannot call it', e && e.code === '42501', e ? e.code : 'no error');
    await c.query('SET LOCAL ROLE none');
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'BUSINESS TYPE PASS' : `BUSINESS TYPE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
```

- [ ] **Step 2: Run it and see it fail**

Run: `node db/tests/business-type.test.cjs`
Expected: `TEST_FAILED:` with `column "business_type" does not exist`.

- [ ] **Step 3: Write the migration**

Create `db/migrations/0066_business_type.sql`:

```sql
-- 0066: a tenant is a restaurant or a retail shop.
--
-- tenants.business_type says which. Every tenant that exists is a restaurant,
-- so nothing changes for them. Only the platform admin sets it:
--   platform.set_tenant_business_type(admin, tenant, type)
--   platform.create_tenant_of_type(..., type)   create_tenant, then the type,
--                                                in the one transaction
-- A change is refused while the tenant has an open order, and is logged as
-- 'tenant.business_type'. The type is copied into pos_settings.data
-- (businessType), which every till already pulls and reads loosely: a till
-- that does not know the key ignores it, and a missing key means restaurant.
-- create_tenant keeps its seven arguments: an eighth with a default would be
-- a second function, and every call with seven would stop being unique.

alter table tenants add column if not exists business_type text not null default 'restaurant';
alter table tenants drop constraint if exists tenants_business_type_check;
alter table tenants add constraint tenants_business_type_check check (business_type in ('restaurant', 'retail'));

create or replace function platform.set_tenant_business_type(p_admin uuid, p_tenant uuid, p_type text)
returns void
language plpgsql set search_path = public as $fn$
declare
  v_type text := lower(btrim(coalesce(p_type, '')));
  v_old text;
begin
  perform platform.require_admin(p_admin);
  if v_type not in ('restaurant', 'retail') then raise exception 'bad-business-type'; end if;
  select business_type into v_old from tenants where id = p_tenant;
  if not found then raise exception 'unknown-tenant'; end if;
  if v_old = v_type then return; end if;
  -- an order opened on a table has nowhere to go in a shop
  if exists (select 1 from tickets where tenant_id = p_tenant and status = 'open' and deleted_at is null) then
    raise exception 'open-orders';
  end if;
  perform set_config('app.tenant_id', p_tenant::text, true);
  update tenants set business_type = v_type where id = p_tenant;
  insert into pos_settings (tenant_id, data) values (p_tenant, jsonb_build_object('businessType', v_type))
    on conflict (tenant_id) do update set data = pos_settings.data || excluded.data;
  insert into platform.audit (admin_auth_user_id, action, tenant_id, detail)
    values (p_admin, 'tenant.business_type', p_tenant, jsonb_build_object('from', v_old, 'to', v_type));
end $fn$;

create or replace function platform.create_tenant_of_type(
  p_admin uuid, p_name text, p_store_name text, p_store_code text,
  p_owner_name text, p_owner_auth uuid, p_plan text, p_type text
) returns jsonb
language plpgsql set search_path = public as $fn$
declare r jsonb;
begin
  if lower(btrim(coalesce(p_type, ''))) not in ('restaurant', 'retail') then
    raise exception 'bad-business-type';
  end if;
  r := platform.create_tenant(p_admin, p_name, p_store_name, p_store_code, p_owner_name, p_owner_auth, p_plan);
  perform platform.set_tenant_business_type(p_admin, (r->>'tenant_id')::uuid, p_type);
  return r;
end $fn$;
```

- [ ] **Step 4: Apply it and run the test**

Run: `node db/migrate.cjs`
Expected: `apply 0066_business_type.sql`, then `migrations ok`. Every earlier file says `skip`.

Run: `node db/tests/business-type.test.cjs`
Expected: every line `PASS`, last line `BUSINESS TYPE PASS`.

- [ ] **Step 5: Run the platform suite, which must not have moved**

Run: `node db/tests/platform.test.cjs`
Expected: last line `PLATFORM PASS`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0066_business_type.sql db/tests/business-type.test.cjs
git commit -m "server: a tenant is a restaurant or a retail shop: the platform admin sets it, a change is refused while an order is open and is logged, and the tills are told through the settings they already pull

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The stock engine

**Files:**
- Create: `db/migrations/0067_stock_engine.sql`
- Test: `db/tests/stock-engine.test.cjs`
- Modify: `db/tests/require-dev.cjs` (the `CHILD_FIRST` list, line 5)
- Modify: `web/app/backoffice/data/export/route.ts` (the `TABLES` list)

What it must do, in one place to read:

- `stock_levels` holds one row per shop and per product (an item, or one variant of it): quantity and average cost. No foreign keys to `items`, `stores` or `item_variants`, the same as `stock_movements`: the truncate test and the purge rewrite those tables together.
- `stock_move(tenant, store, item, variant, qty, reason, unit_cost, ref_type, ref_id, employee, note)` writes one movement, changes the level, and keeps `items.stock_qty` (the item's total over shops and variants) in step. It returns the movement's id, or null when nothing moved.
- Stock coming in **with** a cost moves the average: `(q*a + n*c) / (q + n)`, or simply `c` when `q` is zero or below. Everything else moves at the average of that moment and leaves it alone.
- A document (`ref_type` + `ref_id`) moves one product in one shop once. A second call with the same reference does nothing.
- The first level ever made for an item starts from the quantity the item already carried, so a quantity set before this migration is not lost.
- `stock_level_for()` makes and locks a level. Everything locks the level first and the item's row second, so a sale and an adjustment can never each hold what the other waits for.
- `stock_count_item(tenant, store, item, counted, employee, note)` sets an item's total to what was counted, working out the difference under that lock. Kids Corner (`C:\Projects\KidsCorner`, the user's own retail system) had to fix exactly this in its migration 045: two people counting one product at once, the second overwriting the first.

- [ ] **Step 1: Write the failing test**

Create `db/tests/stock-engine.test.cjs`:

```js
// stock-engine.test.cjs — migration 0067: one stock engine.
//   - a delivery with a cost moves the average; a sale leaves at the average
//   - selling below zero is allowed; the next delivery's cost becomes the average
//   - a document moves a product in a shop once
//   - a variant, and a second shop, each have their own level; the item's
//     total covers them all
//   - the first level made for an item starts from the quantity it carried
//   - the tenant role can use it, inside its own tenant only
// Runs in ONE transaction that is rolled back: it leaves nothing behind.
// Usage: node db/tests/stock-engine.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  let sp = 0;
  async function failsWith(sql, params) {
    const name = 'sp' + (++sp);
    await c.query('SAVEPOINT ' + name);
    try { await c.query(sql, params); await c.query('RELEASE SAVEPOINT ' + name); return null; }
    catch (e) { await c.query('ROLLBACK TO SAVEPOINT ' + name); return e; }
  }
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const id = () => crypto.randomUUID();
  try {
    const admin = id();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-se@example.com')`, [admin]);
    const made = (await one(`select platform.create_tenant($1,'Stock Test','Main','SE1','Owner',$2,'standard') as r`, [admin, id()])).r;
    const tid = made.tenant_id, store = made.store_id, emp = made.employee_id;
    const store2 = (await one(`insert into stores (tenant_id, name, code, created_at) values ($1,'Second','SE2', now() + interval '1 second') returning id`, [tid])).id;
    const item = async (name, cost, qty) => (await one(
      `insert into items (tenant_id, name, price, cost, stock_qty, track_stock) values ($1,$2,10000,$3,$4,true) returning id`, [tid, name, cost, qty])).id;
    const move = async (st, it, va, qty, reason, cost, refType, refId) => (await one(
      `select stock_move($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,null) as id`, [tid, st, it, va, qty, reason, cost, refType, refId, emp])).id;
    const level = async (st, it, va) => one(
      `select qty, avg_cost::float8 as avg from stock_levels
        where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is not distinct from $4`, [tid, st, it, va]);
    const total = async (it) => (await one(`select stock_qty from items where id = $1`, [it])).stock_qty;
    const mv = async (m) => one(
      `select qty, reason, unit_cost::float8 as cost, store_id, receipt_id, ref_type, ref_id from stock_movements where id = $1`, [m]);

    const A = await item('Shirt', 4000, null);

    // E1 a delivery of 10 at Rs 40
    let m = await move(store, A, null, 10000, 'receive', 4000, 'delivery', id());
    let l = await level(store, A, null), r = await mv(m);
    check('E1 a delivery makes the level, at its cost', l.qty === 10000 && near(l.avg, 4000), JSON.stringify(l));
    check('E1 the movement keeps the shop and the cost', r.qty === 10000 && r.reason === 'receive' && near(r.cost, 4000) && r.store_id === store, JSON.stringify(r));
    check('E1 the item total follows', (await total(A)) === 10000);

    // E2 ten more at Rs 50: the average is Rs 45
    await move(store, A, null, 10000, 'receive', 5000, 'delivery', id());
    l = await level(store, A, null);
    check('E2 a dearer delivery moves the average', l.qty === 20000 && near(l.avg, 4500), JSON.stringify(l));

    // E3 a sale of 3 leaves at the average and does not move it
    const r1 = id();
    m = await move(store, A, null, -3000, 'sale', null, 'receipt', r1);
    l = await level(store, A, null); r = await mv(m);
    check('E3 a sale leaves at the average of that moment', near(r.cost, 4500) && r.receipt_id === r1 && r.ref_type === 'receipt', JSON.stringify(r));
    check('E3 and leaves the average alone', l.qty === 17000 && near(l.avg, 4500) && (await total(A)) === 17000, JSON.stringify(l));

    // E4 the same document again moves nothing
    m = await move(store, A, null, -3000, 'sale', null, 'receipt', r1);
    const n = (await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and ref_id = $2`, [tid, r1])).n;
    l = await level(store, A, null);
    check('E4 a document moves a product once', m === null && n === 1 && l.qty === 17000, `${m} ${n} ${l.qty}`);

    // E5 selling more than there is
    await move(store, A, null, -20000, 'sale', null, 'receipt', id());
    l = await level(store, A, null);
    check('E5 a sale is never refused for stock', l.qty === -3000 && (await total(A)) === -3000, JSON.stringify(l));

    // E6 a delivery onto nothing: its cost is the average
    await move(store, A, null, 5000, 'receive', 6000, 'delivery', id());
    l = await level(store, A, null);
    check('E6 from zero or below, the delivery cost becomes the average', l.qty === 2000 && near(l.avg, 6000), JSON.stringify(l));

    // E7 a customer return comes back at the cost it is given
    await move(store, A, null, 1000, 'refund', 4500, 'receipt', id());
    l = await level(store, A, null);
    check('E7 a return at its own cost joins the average', l.qty === 3000 && near(l.avg, 5500), JSON.stringify(l));

    // E8 damaged goods leave at the average; E9 found goods arrive at it
    m = await move(store, A, null, -1000, 'damaged', null, null, null);
    r = await mv(m); l = await level(store, A, null);
    check('E8 an adjustment out leaves at the average', near(r.cost, 5500) && l.qty === 2000 && near(l.avg, 5500), JSON.stringify(r));
    m = await move(store, A, null, 1000, 'found', null, null, null);
    r = await mv(m); l = await level(store, A, null);
    check('E9 stock found comes in at the average', near(r.cost, 5500) && l.qty === 3000 && near(l.avg, 5500), JSON.stringify(r));

    // E10 a variant has its own level
    const V = (await one(`insert into item_variants (tenant_id, item_id, name, price) values ($1,$2,'Large',12000) returning id`, [tid, A])).id;
    await move(store, A, V, 2000, 'receive', 7000, 'delivery', id());
    const lv = await level(store, A, V); l = await level(store, A, null);
    check('E10 a variant keeps its own quantity and cost', lv.qty === 2000 && near(lv.avg, 7000) && l.qty === 3000 && near(l.avg, 5500), JSON.stringify(lv));
    check('E10 the item total covers its variants', (await total(A)) === 5000);

    // E11 a second shop has its own level
    await move(store2, A, null, 4000, 'receive', 4000, 'delivery', id());
    const l2 = await level(store2, A, null); l = await level(store, A, null);
    check('E11 each shop keeps its own', l2.qty === 4000 && near(l2.avg, 4000) && l.qty === 3000, JSON.stringify(l2));
    check('E11 the item total covers its shops', (await total(A)) === 9000);

    // E12 an item that carried a quantity before any level existed
    const B = await item('Legacy', 2500, 10000);
    await move(store, B, null, -1000, 'sale', null, 'receipt', id());
    l = await level(store, B, null);
    check('E12 the first level starts from what the item carried', l.qty === 9000 && near(l.avg, 2500) && (await total(B)) === 9000, JSON.stringify(l));
    await move(store2, B, null, 1000, 'found', null, null, null);
    const lb2 = await level(store2, B, null);
    check('E12 a later level in another shop starts from nothing', lb2.qty === 1000 && (await total(B)) === 10000, JSON.stringify(lb2));

    // E13 what does nothing, and what is refused
    m = await move(store, A, null, 0, 'adjust', null, null, null);
    check('E13 a move of nothing writes nothing', m === null);
    let e = await failsWith(`select stock_move($1,$2,$3,null,1000,'gift',null,null,null,$4,null)`, [tid, store, A, emp]);
    check('E13 an unknown reason is refused', e && e.code === '23514', e ? e.code : 'no error');
    e = await failsWith(`select stock_move($1,$2,$3,null,1000,'found',null,null,null,$4,null)`, [tid, store, id(), emp]);
    check('E13 an unknown item is refused', e && e.message === 'unknown-item', e ? e.message : 'no error');

    // E14 the first shop is the oldest
    check('E14 first_store is the oldest shop', (await one(`select first_store($1) as s`, [tid])).s === store);

    // E16 a count sets the item's total, whatever it was
    const C = await item('Counted', 3000, null);
    await move(store, C, null, 8000, 'receive', 3000, 'delivery', id());
    let d = (await one(`select stock_count_item($1,$2,$3,$4,$5,$6) as d`, [tid, store, C, 5000, emp, 'shelf count'])).d;
    l = await level(store, C, null);
    const cm = await one(`select qty, unit_cost::float8 as cost, note from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'count'`, [tid, C]);
    check('E16 a count sets the total and writes the difference, at the average',
      d === -3000 && l.qty === 5000 && (await total(C)) === 5000 && cm.qty === -3000 && near(cm.cost, 3000) && cm.note === 'shelf count', `${d} ${JSON.stringify(l)}`);
    d = (await one(`select stock_count_item($1,$2,$3,$4,$5,null) as d`, [tid, store, C, 5000, emp])).d;
    const counts = (await one(`select count(*)::int as n from stock_movements where tenant_id = $1 and item_id = $2 and reason = 'count'`, [tid, C])).n;
    check('E16 counting what is there writes nothing', d === 0 && counts === 1, `${d} ${counts}`);
    e = await failsWith(`select stock_count_item($1,$2,$3,-1,$4,null)`, [tid, store, C, emp]);
    check('E16 a count below zero is refused', e && e.message === 'bad-count', e ? e.message : 'no error');

    // E15 the tenant role, with the two calls the back office makes
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
    m = (await one(`select stock_move($1, $2, $3, null, $4, 'adjust', null, null, null, $5, $6) as id`, [tid, store, A, 1000, emp, 'a note'])).id;
    d = (await one(`select stock_count_item($1, $2, $3, $4, $5, $6) as d`, [tid, store, C, 6000, emp, null])).d;
    check('E15 the tenant role can adjust and count its own stock', Boolean(m) && d === 1000, `${m} ${d}`);
    await c.query(`select set_config('app.tenant_id', $1, true)`, [id()]);
    const seen = (await one(`select count(*)::int as n from stock_levels`)).n;
    check('E15 and sees no other tenant\'s levels', seen === 0, String(seen));
    await c.query('SET LOCAL ROLE none');
    await c.query(`select set_config('app.tenant_id', '', true)`);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  console.log(failures === 0 ? 'STOCK ENGINE PASS' : `STOCK ENGINE FAIL (${failures})`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
```

- [ ] **Step 2: Run it and see it fail**

Run: `node db/tests/stock-engine.test.cjs`
Expected: `TEST_FAILED:` with `function stock_move(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `db/migrations/0067_stock_engine.sql`:

```sql
-- 0067: one stock engine.
--
-- Until now a sale and a refund each wrote stock_movements and items.stock_qty
-- themselves, and the back office Stock page did the same a third time. Stock
-- was one number per item: no shop, no variant, no cost.
--
--   - stock_levels: one row per shop and per product (an item, or one variant
--     of it): the quantity on hand and its average cost. Like stock_movements
--     it has no foreign key to items, stores or item_variants: those tables
--     are rewritten together by the truncate path and the purge.
--   - stock_movements gains the shop, the variant, the cost at that moment
--     and the document the movement came from (ref_type, ref_id). A document
--     moves one product in one shop once: that is what makes a receipt that
--     arrives twice, or a button pressed twice, count once.
--   - stock_move(): the only code that writes a movement and changes a level.
--     It keeps items.stock_qty as the item's total, so the tills and pages
--     that read that number go on working.
--   - the reasons a movement can have are widened for what is coming
--     (deliveries, counts, losses); nothing is renamed.
-- Nothing here is pulled by a till. This migration changes no behaviour by
-- itself: 0068 moves the sale and the refund onto the engine.

create table if not exists stock_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants (id) on delete cascade,
  store_id uuid not null,
  item_id uuid not null,
  variant_id uuid,
  qty integer not null default 0,
  avg_cost numeric(18,4) not null default 0,
  reorder_point integer,
  reorder_qty integer,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
create unique index if not exists uq_stock_levels_product on stock_levels
  (tenant_id, store_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid));
alter table stock_levels enable row level security;
alter table stock_levels force row level security;
drop policy if exists tenant_isolation on stock_levels;
create policy tenant_isolation on stock_levels
  using (tenant_id = current_tenant_id())
  with check (tenant_id = current_tenant_id());
drop trigger if exists trg_touch on stock_levels;
create trigger trg_touch before insert or update on stock_levels
  for each row execute function touch_row();
create index if not exists idx_stock_levels_tenant_seq on stock_levels (tenant_id, server_seq);
create index if not exists idx_stock_levels_item on stock_levels (tenant_id, item_id);

alter table stock_movements add column if not exists store_id uuid;
alter table stock_movements add column if not exists variant_id uuid;
alter table stock_movements add column if not exists unit_cost numeric(18,4);
alter table stock_movements add column if not exists ref_type text;
alter table stock_movements add column if not exists ref_id uuid;
alter table stock_movements drop constraint if exists stock_movements_reason_check;
alter table stock_movements add constraint stock_movements_reason_check check (reason in (
  'sale', 'refund', 'adjust', 'count',
  'receive', 'supplier_return', 'opening', 'damaged', 'expired', 'lost', 'internal', 'found'));
create unique index if not exists uq_stock_movements_ref on stock_movements
  (tenant_id, ref_type, ref_id, store_id, item_id, coalesce(variant_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where ref_id is not null;

-- The shop a tenant started with: where stock that belongs to no named shop is kept.
create or replace function first_store(p_tenant uuid) returns uuid
language sql stable set search_path = public as $fn$
  select id from stores where tenant_id = p_tenant and deleted_at is null order by created_at, id limit 1
$fn$;

-- The level of one product in one shop: made on first use, and locked until
-- this transaction ends, so two changes to one product wait their turn. The
-- first level ever made for an item starts from the quantity the item already
-- carried, so nothing counted before the engine existed is lost; any later
-- one starts from nothing.
-- Everything that changes stock takes this lock first and the item's row
-- second. Nothing may lock the item's row and then ask for a level: a sale
-- and that caller would each hold what the other waits for.
create or replace function stock_level_for(p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid)
returns stock_levels
language plpgsql set search_path = public as $fn$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_level stock_levels%rowtype;
begin
  if p_store is null or p_item is null then raise exception 'bad-stock-move'; end if;
  insert into stock_levels (tenant_id, store_id, item_id, variant_id, qty, avg_cost)
    select p_tenant, p_store, p_item, p_variant,
           case when exists (select 1 from stock_levels x where x.tenant_id = p_tenant and x.item_id = p_item)
                then 0 else coalesce(i.stock_qty, 0) end,
           coalesce(i.cost, 0)
      from items i where i.tenant_id = p_tenant and i.id = p_item
    on conflict do nothing;
  select * into v_level from stock_levels
   where tenant_id = p_tenant and store_id = p_store and item_id = p_item
     and coalesce(variant_id, v_zero) = coalesce(p_variant, v_zero)
   for update;
  if not found then raise exception 'unknown-item'; end if;
  return v_level;
end $fn$;

create or replace function stock_move(
  p_tenant uuid, p_store uuid, p_item uuid, p_variant uuid, p_qty integer, p_reason text,
  p_unit_cost numeric, p_ref_type text, p_ref_id uuid, p_emp uuid, p_note text
) returns uuid
language plpgsql set search_path = public as $fn$
declare
  v_zero constant uuid := '00000000-0000-0000-0000-000000000000';
  v_level stock_levels%rowtype;
  v_cost numeric;
  v_avg numeric;
  v_id uuid;
begin
  if p_qty is null or p_qty = 0 then return null; end if;
  v_level := stock_level_for(p_tenant, p_store, p_item, p_variant);

  -- a document moves a product in a shop once
  if p_ref_id is not null and exists (select 1 from stock_movements m
       where m.tenant_id = p_tenant and m.ref_type = p_ref_type and m.ref_id = p_ref_id
         and m.store_id = p_store and m.item_id = p_item
         and coalesce(m.variant_id, v_zero) = coalesce(p_variant, v_zero)) then
    return null;
  end if;

  if p_qty > 0 and p_unit_cost is not null then
    -- stock coming in at a known cost moves the average
    v_cost := p_unit_cost;
    v_avg := case when v_level.qty <= 0 then p_unit_cost
                  else round((v_level.qty * v_level.avg_cost + p_qty * p_unit_cost) / (v_level.qty + p_qty), 4) end;
  else
    -- everything else moves at the average of this moment
    v_cost := v_level.avg_cost;
    v_avg := v_level.avg_cost;
  end if;

  insert into stock_movements (tenant_id, store_id, item_id, variant_id, qty, reason, unit_cost,
      ref_type, ref_id, receipt_id, employee_id, note)
    values (p_tenant, p_store, p_item, p_variant, p_qty, p_reason, v_cost,
      p_ref_type, p_ref_id, case when p_ref_type = 'receipt' then p_ref_id end, p_emp, p_note)
    returning id into v_id;
  update stock_levels set qty = v_level.qty + p_qty, avg_cost = v_avg where id = v_level.id;
  update items set stock_qty = coalesce(stock_qty, 0) + p_qty where tenant_id = p_tenant and id = p_item;
  return v_id;
end $fn$;

-- The shelf was counted: an item's total becomes what was counted. The
-- difference is worked out only after the item's level is locked, so two
-- people counting the same item at the same moment build on each other's
-- figure instead of the second overwriting the first (the fault Kids Corner
-- fixed in its migration 045). Returns the difference that was written.
create or replace function stock_count_item(
  p_tenant uuid, p_store uuid, p_item uuid, p_counted integer, p_emp uuid, p_note text
) returns integer
language plpgsql set search_path = public as $fn$
declare
  v_total integer;
  v_delta integer;
begin
  if p_counted is null or p_counted < 0 then raise exception 'bad-count'; end if;
  perform stock_level_for(p_tenant, p_store, p_item, null);
  select coalesce(stock_qty, 0) into v_total from items where tenant_id = p_tenant and id = p_item;
  v_delta := p_counted - v_total;
  perform stock_move(p_tenant, p_store, p_item, null, v_delta, 'count', null, null, null, p_emp, p_note);
  return v_delta;
end $fn$;
```

- [ ] **Step 4: Apply it and run the test**

Run: `node db/migrate.cjs`
Expected: `apply 0067_stock_engine.sql`, then `migrations ok`.

Run: `node db/tests/stock-engine.test.cjs`
Expected: every line `PASS`, last line `STOCK ENGINE PASS`.

If E7 fails on the average: `(2000*6000 + 1000*4500) / 3000 = 5500`. If E12 fails: the first-level rule (the `case when exists` in the insert) is the part to look at.

- [ ] **Step 5: Add the new table to the test cleanup and to the backup**

In `db/tests/require-dev.cjs`, line 5, the list `CHILD_FIRST` starts `['bookings','approvals','drawer_counts','customers','stock_movements',`. Insert `'stock_levels',` straight after `'stock_movements',`:

```js
const CHILD_FIRST = ['bookings','approvals','drawer_counts','customers','stock_movements','stock_levels',
```

(Keep the rest of the line exactly as it is.)

In `web/app/backoffice/data/export/route.ts`, the `TABLES` list has the entry `"stock_movements",`. Add `"stock_levels",` straight after it.

- [ ] **Step 6: The isolation suite still passes**

Run: `node db/tests/isolation.test.cjs`
Expected: its usual pass line, exit code 0. (It checks that every tenant table has forced row level security.)

- [ ] **Step 7: Commit**

```bash
git add db/migrations/0067_stock_engine.sql db/tests/stock-engine.test.cjs db/tests/require-dev.cjs web/app/backoffice/data/export/route.ts
git commit -m "server: one stock engine: a quantity and an average cost per shop and per product, every change written as one movement with its cost and the document it came from, and a document moves a product once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Sales and refunds go through the engine

**Files:**
- Create: `db/scripts/dump-function.cjs`
- Create: `db/migrations/0068_stock_through_engine.sql`
- Test: `db/tests/stock-sales.test.cjs`

- [ ] **Step 1: Write the failing test**

Create `db/tests/stock-sales.test.cjs`:

```js
// stock-sales.test.cjs — migration 0068: a sale and a refund move stock
// through the one engine (0067).
//   - a sale writes one movement per product, with the shop and the cost
//   - pushed twice, it moves stock once
//   - a refund puts the goods back at the cost they left at
//   - selling more than there is goes through
// Usage: node db/tests/stock-sales.test.cjs
const crypto = require('crypto');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}
const op = (type, payload) => ({ op_id: crypto.randomUUID(), type, payload });
const near = (a, b) => Math.abs(Number(a) - b) < 0.01;

(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const tid = crypto.randomUUID();
  const q1 = async (sql, args) => (await c.query(sql, args)).rows[0];
  await c.query(`insert into tenants (id, tenant_id, name) values ('${tid}','${tid}','SS-Probe')`);
  try {
    const store = (await q1(`insert into stores (tenant_id, name, code) values ('${tid}','Main','SS1') returning id`)).id;
    const dev = (await q1(`insert into pos_devices (tenant_id, store_id, name, code) values ('${tid}','${store}','T1','T1') returning id`)).id;
    const role = (await q1(`insert into roles (tenant_id, name, permissions) values ($1,'Owner','["*"]'::jsonb) returning id`, [tid])).id;
    const owner = (await q1(`insert into employees (tenant_id, name, role_id) values ($1,'Owner',$2) returning id`, [tid, role])).id;
    await c.query(`select seed_demo_catalog('${tid}')`);
    const dp = await q1(`select id, category_id from items where tenant_id='${tid}' and name='Dholl puri'`);
    const other = (await q1(`select id from items where tenant_id='${tid}' and category_id <> $1 limit 1`, [dp.category_id])).id;
    const cash = (await q1(`select id from payment_types where tenant_id='${tid}' and name='Cash'`)).id;

    async function asApp(fn) {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE app_user');
      await c.query(`select set_config('app.tenant_id', $1, true)`, [tid]);
      try { const out = await fn(); await c.query('COMMIT'); return out; }
      catch (e) { await c.query('ROLLBACK'); throw e; }
    }
    const push = (ops) => asApp(async () => (await c.query('select sync_push($1, $2::jsonb) as r', [owner, JSON.stringify(ops)])).rows[0].r);
    const tag = (o) => o.status + (o.code ? ':' + o.code : '');
    let seq = 0;
    const level = () => q1(`select qty, avg_cost::float8 as avg from stock_levels where tenant_id = $1 and store_id = $2 and item_id = $3 and variant_id is null`, [tid, store, dp.id]);
    const total = async () => (await q1(`select stock_qty from items where id = $1`, [dp.id])).stock_qty;
    const moves = async (receipt) => (await c.query(
      `select qty, reason, unit_cost::float8 as cost, store_id, ref_type, ref_id from stock_movements where receipt_id = $1`, [receipt])).rows;
    const sale = (qtys, rc, amount) => {
      const tk = crypto.randomUUID();
      return [
        op('ticket.create', { id: tk, store_id: store }),
        ...qtys.map((q) => op('ticket.add_line', { id: crypto.randomUUID(), ticket_id: tk, item_id: q.item || dp.id, qty: q.qty })),
        op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'SS-' + (++seq), device_seq: seq,
          payments: [{ payment_type_id: cash, amount }], device_time: new Date(Date.parse('2026-03-02T05:00:00Z') + seq * 60000).toISOString() }),
      ];
    };

    // Dholl puri is counted, costs Rs 25, and 10 arrive (it sells at Rs 50)
    await c.query(`update items set track_stock = true, cost = 2500 where id = $1`, [dp.id]);
    await c.query(`select stock_move($1,$2,$3,null,10000,'receive',2500,'delivery',$4,$5,null)`, [tid, store, dp.id, crypto.randomUUID(), owner]);

    // K1 a sale of 3
    const rc1 = crypto.randomUUID();
    const ops1 = sale([{ qty: 3000 }], rc1, 15000);
    const r1 = await push(ops1);
    let mv = await moves(rc1), l = await level();
    check('K1 the sale is applied', tag(r1[r1.length - 1]) === 'applied', tag(r1[r1.length - 1]));
    check('K1 one movement, with the shop, the cost and the receipt',
      mv.length === 1 && mv[0].qty === -3000 && mv[0].reason === 'sale' && near(mv[0].cost, 2500)
        && mv[0].store_id === store && mv[0].ref_type === 'receipt' && mv[0].ref_id === rc1, JSON.stringify(mv));
    check('K1 the level and the item total go down', l.qty === 7000 && (await total()) === 7000, JSON.stringify(l));

    // K2 the same operations arriving again
    await push(ops1);
    mv = await moves(rc1); l = await level();
    check('K2 a sale that arrives twice moves stock once', mv.length === 1 && l.qty === 7000 && (await total()) === 7000, `${mv.length} ${l.qty}`);

    // K3 a dearer delivery, then a refund of one from the first sale
    await c.query(`select stock_move($1,$2,$3,null,10000,'receive',3500,'delivery',$4,$5,null)`, [tid, store, dp.id, crypto.randomUUID(), owner]);
    const avgBefore = (await level()).avg; // (7000*2500 + 10000*3500) / 17000
    check('K3 the delivery moved the average', near(avgBefore, 3088.24), String(avgBefore));
    const line = await q1(`select id from receipt_lines where receipt_id = $1`, [rc1]);
    const rf = crypto.randomUUID();
    const back = await push([op('refund.create', { id: rf, refund_of: rc1, store_id: store, device_id: dev, number: 'SS-R' + (++seq), device_seq: seq,
      reason: 'wrong size', lines: [{ receipt_line_id: line.id, qty: 1000 }], payments: [{ payment_type_id: cash, amount: 5000 }] })]);
    mv = await moves(rf); l = await level();
    check('K3 the refund is applied', tag(back[0]) === 'applied', tag(back[0]));
    check('K3 what comes back comes back at the cost it left at',
      mv.length === 1 && mv[0].qty === 1000 && mv[0].reason === 'refund' && near(mv[0].cost, 2500), JSON.stringify(mv));
    check('K3 and joins the average at that cost', l.qty === 18000 && near(l.avg, (17000 * avgBefore + 1000 * 2500) / 18000), JSON.stringify(l));

    // K4 two lines of one product on one order are one movement
    const rc2 = crypto.randomUUID();
    await push(sale([{ qty: 1000 }, { qty: 2000 }], rc2, 15000));
    mv = await moves(rc2);
    check('K4 two lines of one product make one movement', mv.length === 1 && mv[0].qty === -3000, JSON.stringify(mv));

    // K5 selling more than there is
    const rc3 = crypto.randomUUID();
    const r3 = await push(sale([{ qty: 20000 }], rc3, 100000));
    l = await level();
    check('K5 a sale is not refused for stock', tag(r3[r3.length - 1]) === 'applied' && l.qty === -5000 && (await total()) === -5000, JSON.stringify(l));

    // K6 an item that is not counted
    const rc4 = crypto.randomUUID();
    await push(sale([{ qty: 1000, item: other }], rc4, 1));
    const none = (await q1(`select count(*)::int as n from stock_levels where tenant_id = $1 and item_id = $2`, [tid, other])).n;
    check('K6 an item that is not counted has no level and no movement', none === 0 && (await moves(rc4)).length === 0);
  } finally {
    await devguard.cleanupTenant(c, tid);
    await c.end();
  }
  console.log(failures ? `STOCK SALES FAIL (${failures})` : 'STOCK SALES PASS');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('TEST_FAILED:' + (e.stack || e.message)); process.exit(1); });
```

- [ ] **Step 2: Run it and see it fail**

Run: `node db/tests/stock-sales.test.cjs`
Expected: several `FAIL` lines. `K1 one movement, with the shop, the cost and the receipt` fails because the old code writes no shop, cost or reference; `K1 the level and the item total go down` fails because the old code never touches a level; K3 fails on the cost. `K1 the sale is applied` passes.

- [ ] **Step 3: Add the script that prints a live function**

Create `db/scripts/dump-function.cjs`:

```js
// dump-function.cjs — prints the definition a public function has now on the
// linked dev branch. A fix-forward migration starts from that text, not from
// an older migration file, because a later migration may have replaced it.
// Usage: node db/scripts/dump-function.cjs push_receipt_create > some-file.sql
const { Client } = require('pg');
const devguard = require('../tests/require-dev.cjs');

(async () => {
  const name = process.argv[2];
  if (!name) throw new Error('usage: node db/scripts/dump-function.cjs <function name>');
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const r = await c.query(
    `select pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.proname = $1`, [name]);
  await c.end();
  if (r.rowCount !== 1) throw new Error(`${r.rowCount} functions named ${name}`);
  process.stdout.write(r.rows[0].def + ';\n');
})().catch((e) => { console.error('DUMP_FAILED:' + e.message); process.exit(1); });
```

- [ ] **Step 4: Start the migration: its header and the carry-over**

Create `db/migrations/0068_stock_through_engine.sql` with this, and nothing else yet:

```sql
-- 0068: a sale and a refund move stock through the one engine (0067).
-- Source: push_receipt_create and push_refund_create as they stood on the dev
-- branch on 2026-10-07 (pg_get_functiondef), changed in two places each: one
-- more variable (v_sm), and the stock block.
--
--   - every quantity an item carried becomes a level in the tenant's first
--     shop, at the item's cost, so restaurants go on from where they were
--   - the movements already written learn the receipt they came from and its
--     shop, so they sit under the same "once per document" rule
--   - a sale writes one movement per product (item and variant) through
--     stock_move, at the average cost of that moment, in a fixed order so two
--     receipts never wait on each other's levels the wrong way round
--   - a refund puts the goods back at the cost their sale left at (the sale's
--     movement on any receipt of the same order), or at the average when that
--     sale was made before costs were kept

insert into stock_levels (tenant_id, store_id, item_id, variant_id, qty, avg_cost)
  select i.tenant_id, first_store(i.tenant_id), i.id, null, i.stock_qty, coalesce(i.cost, 0)
    from items i
   where i.stock_qty is not null
     and first_store(i.tenant_id) is not null
     and not exists (select 1 from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id);

update stock_movements m
   set ref_type = 'receipt', ref_id = m.receipt_id,
       store_id = (select r.store_id from receipts r where r.tenant_id = m.tenant_id and r.id = m.receipt_id)
 where m.receipt_id is not null and m.ref_id is null;
update stock_movements m set store_id = first_store(m.tenant_id) where m.store_id is null;
```

- [ ] **Step 5: Append the two live functions**

Run (the scratch files go in your scratchpad directory, not in the repo):

```bash
node db/scripts/dump-function.cjs push_receipt_create > "$SCRATCH/receipt.sql"
node db/scripts/dump-function.cjs push_refund_create > "$SCRATCH/refund.sql"
```

Expected: two files, each starting `CREATE OR REPLACE FUNCTION public.push_…` and ending `$function$;`.

Append the whole of `receipt.sql`, then the whole of `refund.sql`, to `db/migrations/0068_stock_through_engine.sql`, each after a blank line. Change nothing else in them except the two edits per function below.

- [ ] **Step 6: Edit `push_receipt_create` in the migration**

**(a)** In its `declare` section, add one line before `begin`:

```sql
  v_sm record;
```

**(b)** Find the block that begins with the comment `-- stock: an item that is counted (its own flag, or its category's) goes down` and runs to the `end if;` that closes `if not v_review then`. It contains one `insert into stock_movements` and one `update items i set stock_qty`. Replace the whole block, comment included, with:

```sql
  -- stock: an item that is counted (its own flag, or its category's) goes down
  -- by what was sold, through the one stock engine (0067). Not on the review
  -- path: those lines were sold before. One movement per product, in a fixed
  -- order.
  if not v_review then
    for v_sm in
      select l.item_id, l.variant_id, sum(l.qty)::int as qty
        from ticket_lines l join items i on i.tenant_id = p_tenant and i.id = l.item_id
        left join categories c on c.tenant_id = p_tenant and c.id = i.category_id
       where l.id = any(covered) and (i.track_stock or coalesce(c.is_stock, false))
       group by l.item_id, l.variant_id
       order by l.item_id, l.variant_id
    loop
      perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, -v_sm.qty, 'sale', null, 'receipt', v_id, p_emp, null);
    end loop;
  end if;
```

After the edit, `push_receipt_create` in this file must contain no `insert into stock_movements` and no `set stock_qty`.

- [ ] **Step 7: Edit `push_refund_create` in the migration**

**(a)** In its `declare` section, add one line before `begin`:

```sql
  v_sm record;
```

**(b)** Find the block that begins with the comment `-- stock: what comes back goes back on the shelf` and ends with the `update items i set stock_qty … where i.tenant_id = p_tenant and i.id = s.item_id;` statement. Replace the whole block, comment included, with:

```sql
  -- stock: what comes back goes back on the shelf of the shop taking it back,
  -- at the cost its sale left at
  for v_sm in
    select tl.item_id, tl.variant_id, sum(rr.r_qty)::int as qty
      from _rlines rr join _rshare sx on sx.oline = rr.oline
      join ticket_lines tl on tl.tenant_id = p_tenant and tl.id = sx.tlid
      join items i on i.tenant_id = p_tenant and i.id = tl.item_id
      left join categories c on c.tenant_id = p_tenant and c.id = i.category_id
     where i.track_stock or coalesce(c.is_stock, false)
     group by tl.item_id, tl.variant_id
     order by tl.item_id, tl.variant_id
  loop
    perform stock_move(p_tenant, v_store, v_sm.item_id, v_sm.variant_id, v_sm.qty, 'refund',
      (select m.unit_cost from stock_movements m
        where m.tenant_id = p_tenant and m.reason = 'sale' and m.ref_type = 'receipt'
          and m.item_id = v_sm.item_id
          and coalesce(m.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
            = coalesce(v_sm.variant_id, '00000000-0000-0000-0000-000000000000'::uuid)
          and m.ref_id in (select r.id from receipts r where r.tenant_id = p_tenant and r.ticket_id = o.ticket_id)
        order by m.created_at desc limit 1),
      'receipt', v_id, p_emp, null);
  end loop;
```

(`o` is the record of the receipt being refunded and `v_store` the shop in the refund's payload; both are already declared in the function.)

After the edit, the migration file as a whole must contain `insert into stock_movements` nowhere and `set stock_qty` nowhere.

Run: `grep -c "insert into stock_movements\|set stock_qty" db/migrations/0068_stock_through_engine.sql`
Expected: `0`

- [ ] **Step 8: Apply it and run the new suite**

Run: `node db/migrate.cjs`
Expected: `apply 0068_stock_through_engine.sql`, then `migrations ok`.

Run: `node db/tests/stock-sales.test.cjs`
Expected: every line `PASS`, last line `STOCK SALES PASS`.

- [ ] **Step 9: Check that every quantity was carried over**

Create `$SCRATCH/carried.cjs` (scratchpad, not the repo):

```js
const { Client } = require('C:/Projects/RestoPOS/node_modules/pg');
const devguard = require('C:/Projects/RestoPOS/db/tests/require-dev.cjs');
(async () => {
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  const r = await c.query(`
    select count(*)::int as items_with_levels,
           count(*) filter (where coalesce(i.stock_qty, 0) <> s.qty)::int as differ
      from items i join (select tenant_id, item_id, sum(qty)::int as qty from stock_levels group by 1, 2) s
        on s.tenant_id = i.tenant_id and s.item_id = i.id`);
  const m = await c.query(`select count(*)::int as n from items i where i.stock_qty is not null
      and first_store(i.tenant_id) is not null
      and not exists (select 1 from stock_levels l where l.tenant_id = i.tenant_id and l.item_id = i.id)`);
  console.log(JSON.stringify(r.rows[0]), 'items with a quantity and no level:', m.rows[0].n);
  await c.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
```

Run from the repo root: `node "$SCRATCH/carried.cjs"`
Expected: `"differ":0` and `items with a quantity and no level: 0`.

- [ ] **Step 10: The existing suites pass unchanged**

This is the proof that restaurants are not disturbed. Run from the repo root (logs go to the scratchpad):

```bash
for s in pos-operations refund-order-line refund-shares refund-snapshots receipt-accept receipt-deltas split-check vat-included approval-count seats-customers service-v2 ticket-merge ticket-cancel item-price offline-price phase2 push-policy review-reasons platform isolation tables staff-shifts device-keys pull-pages helpers guard fk-setnull crash-reports business-type stock-engine stock-sales; do node db/tests/$s.test.cjs > "$SCRATCH/$s.log" 2>&1 && echo "ok   $s" || echo "FAIL $s"; done
```

Expected: every line `ok`. For any `FAIL`, read `$SCRATCH/<name>.log`. `pos-operations` check `T8` is the one that watches stock: it must show `PASS T8 selling 3 of a counted item takes 3 from its stock` and `PASS T8 refunding 1 puts 1 back` with no change to that test file.

Do not edit an existing test to make it pass. If one fails, the migration is wrong: fix it in a new file `0069_…sql` (0068 is applied and is not edited).

Run the suites one at a time, and only while nothing else is running suites on the same dev database. Two suites at once disturb each other. That was seen twice on 2026-10-07: a suite started by hand while the loop was running failed in its setup, and `refund-shares` reported `retry:transient` on two refunds in the minutes another session was running its own suites. How they collide was not established (each suite's cleanup switches triggers off on the receipt tables inside a transaction, which is one candidate). Before blaming a migration for a `retry:transient`, run that suite alone.

---

## What happened when this plan was run (2026-10-07)

- Parts A and B were built as written, with these differences:
  - **One more suite, `db/tests/stock-locks.test.cjs`** (two connections). It holds the engine to its lock order: a sale already holding the tenant's lock and a back office change that begins with stock both go through. It passed without any change to the engine: `stock_level_for`'s insert fires `touch_row` even when the level exists, so the tenant's lock is always reached before a level. No migration 0069 was needed.
  - `web/app/backoffice/nav.ts` still held another session's uncommitted Point of sale group. Only this plan's own changes to that file were committed (`git apply --cached` of a patch of them alone).
- `refund-shares` failed once in the first full run (`retry:transient` on two refunds) and passed three times alone. Another session committed and ran its own suites on dev in those same minutes.
- The menu in both modes was read from the server's HTML of the temporary page (the browser tab moved on to the sign-in screen by itself; the cause was not looked into).
- Checked afterwards: "delete all transactions" (`purge_transactions`) deletes stock movements and leaves both `items.stock_qty` and `stock_levels` as they are, so the two stay in step after a purge. Migration 0064 (another session's, applied on dev, not committed) does not redefine the two functions 0068 was built from.

**Not seen by anyone yet:** the two admin pages, and every retail back office page except the menu. They type-check and build; nobody has opened them signed in.

**Left for later pieces, found while building:**

- The item panel (`items/editor.tsx`) still offers add-ons to a shop.
- The search (`/backoffice/search`) still returns tables for a shop; the link leads to "not found".
- `stock_count_item` sets an item's total over all shops and variants and writes the difference on the first shop's plain level. That is right while an item has one level, as restaurants do. Piece 3 counts per level.
- A client switched to retail still gets the restaurant screens on its till until piece 4 (the sell screen and the "update required" gate). Do not switch a client that is trading.
- Production needs migrations 0064 to 0068 in that order; 0064 is not in git.

- [ ] **Step 11: Commit**

```bash
git add db/scripts/dump-function.cjs db/migrations/0068_stock_through_engine.sql db/tests/stock-sales.test.cjs
git commit -m "server: a sale and a refund move stock through the one engine: one movement per product with its shop and cost, a refund comes back at the cost it left at, and every quantity an item carried becomes its level in the first shop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

# Part B: the back office

**Stop here if `git status --short` still shows ` M web/app/backoffice/nav.ts`.** That file holds someone else's unfinished work; Part B edits it.

### Task 4: The Stock page adjusts through the engine

**Files:**
- Modify: `web/app/backoffice/stock/page.tsx` (the `change` server action, lines 19-44)

Today this action inserts into `stock_movements` and updates `items.stock_qty` itself. Left like that, an adjustment would change the item's total and not its level. It also reads the quantity and writes the difference as two steps, which is the fault Kids Corner fixed in its migration 045.

- [ ] **Step 1: Replace the `change` action**

Replace the whole function `change` (from its two comment lines `// "Set to" is a count…` through its closing `}`) with:

```tsx
// "Set to" is a count: the shelf was counted and this is what is there.
// "Add" is a delivery (or, with a minus, something thrown away).
// Both go through the one stock engine (migration 0067), which writes the
// movement and keeps the shop's level and the item's total in step.
async function change(f: FormData) {
  "use server";
  await act("items.edit", backTo(f, PATH), async (c, ctx) => {
    const id = uuid(f, "id");
    const mode = f.get("mode") === "add" ? "add" : "set";
    const qty = amount(f, "qty");
    if (mode === "set" && qty < 0) throw new Refused("A count cannot be less than zero.");
    // The item's row is read, not locked: the engine locks the item's level
    // first and its row second, and a lock taken here the other way round
    // could leave a sale and this change each waiting on the other.
    const cur = await c.query(
      `select name, first_store(tenant_id) as store from items where tenant_id = $1 and id = $2 and deleted_at is null`,
      [ctx.tenantId, id],
    );
    if (cur.rowCount !== 1) throw new Refused("That item no longer exists.");
    const args = [ctx.tenantId, cur.rows[0].store, id, qty, ctx.employeeId, text(f, "note", 120) || null];
    let moved: boolean;
    if (mode === "add") {
      moved = qty !== 0;
      if (moved) await c.query(`select stock_move($1, $2, $3, null, $4, 'adjust', null, null, null, $5, $6) as id`, args);
    } else {
      // the difference is worked out inside, under the level's lock: two
      // people counting the same item at once build on each other
      const r = await c.query(`select stock_count_item($1, $2, $3, $4, $5, $6) as d`, args);
      moved = Number(r.rows[0].d) !== 0;
    }
    if (!moved) return "Nothing changed.";
    const now = await c.query(`select coalesce(stock_qty, 0) as q from items where tenant_id = $1 and id = $2`, [ctx.tenantId, id]);
    return `${cur.rows[0].name}: ${units(Number(now.rows[0].q))} in stock.`;
  });
}
```

(These are the two calls the engine suite's check `E15` makes as the tenant role.)

- [ ] **Step 2: Type-check**

Run from `web/` (TypeScript is installed there, not at the root): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 3: Commit**

```bash
git add web/app/backoffice/stock/page.tsx
git commit -m "back office: a stock adjustment goes through the one stock engine, so the shop's level and the item's total cannot drift apart

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: The back office knows the tenant's type

**Files:**
- Create: `web/lib/mode.ts`
- Modify: `web/lib/tenant.ts`

- [ ] **Step 1: Create `web/lib/mode.ts`**

```ts
// A tenant is a restaurant or a retail shop (tenants.business_type, set by
// the platform admin and by nobody else). Pages ask this file what to call
// things; what each kind of business has is said in backoffice/nav.ts.
export type Mode = "restaurant" | "retail";

// anything that is not plainly "retail" is a restaurant: the column's default
export const asMode = (v: unknown): Mode => (v === "retail" ? "retail" : "restaurant");

// The few words that differ between the two.
const WORDS = {
  restaurant: { place: "restaurant", Place: "Restaurant", catalog: "menu", item: "item", items: "items", Items: "Items" },
  retail: { place: "shop", Place: "Shop", catalog: "catalog", item: "product", items: "products", Items: "Products" },
} as const;
export const words = (mode: Mode) => WORDS[mode];
```

- [ ] **Step 2: Carry the type in `tenantContext()`**

In `web/lib/tenant.ts`:

Change the imports at the top from

```ts
import { redirect } from "next/navigation";
```

to

```ts
import { notFound, redirect } from "next/navigation";
import { asMode, type Mode } from "@/lib/mode";
```

In the `TenantContext` type, add after `statusReason: string | null;`:

```ts
  // a restaurant or a retail shop: decides which pages exist and what they are called
  mode: Mode;
```

In the query inside `tenantContext`, change

```ts
    `select e.id, e.tenant_id, e.name as employee_name, r.name as role, t.status, t.status_reason, t.name as tenant_name
```

to

```ts
    `select e.id, e.tenant_id, e.name as employee_name, r.name as role, t.status, t.status_reason, t.name as tenant_name, t.business_type
```

In the object it returns, add after `statusReason: (row.status_reason as string | null) ?? null,`:

```ts
    mode: asMode(row.business_type),
```

After the `tenantContext` function, add:

```ts
// A page that belongs to one kind of business does not exist for the other:
// a shop that types the address of Tables gets "not found", the same as for
// any page that was never built.
export async function onlyFor(mode: Mode): Promise<TenantContext> {
  const ctx = await tenantContext();
  if (ctx.mode !== mode) notFound();
  return ctx;
}
```

- [ ] **Step 3: Type-check**

Run from `web/` (TypeScript is installed there, not at the root): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add web/lib/mode.ts web/lib/tenant.ts
git commit -m "back office: every page knows whether its tenant is a restaurant or a shop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: The menu and the search follow the type

**Files:**
- Modify: `web/app/backoffice/nav.ts`
- Modify: `web/app/backoffice/side.tsx`
- Modify: `web/app/backoffice/search-box.tsx`
- Modify: `web/app/backoffice/layout.tsx`

For a shop in this piece: no Tables, no Bookings, no Add-ons; the Menu group is called Catalog, Items is called Products, the Restaurant group is called Shop, and Menu performance is called Product performance. The Stock group's own pages are added to `nav.ts` when they are built, not before (the file's own rule).

- [ ] **Step 1: `nav.ts`: say which mode a page belongs to**

Add to the imports at the top of `web/app/backoffice/nav.ts`, after the `lucide-react` import:

```ts
import type { Mode } from "@/lib/mode";
```

Replace the two type lines

```ts
export type NavLink = { href: string; label: string; icon: LucideIcon; words?: string };
export type NavGroup = { id: string; title: string; icon: LucideIcon; links: NavLink[] };
```

with

```ts
// `only`: the one kind of business that has this page (none: both have it).
// `retail`: what a shop calls it, when that differs.
export type NavLink = { href: string; label: string; icon: LucideIcon; words?: string; only?: Mode; retail?: string };
export type NavGroup = { id: string; title: string; icon: LucideIcon; links: NavLink[]; retail?: string };
```

In `GROUPS`, make these six changes and no others (each is one added property):

```ts
      { href: "/backoffice/insights/menu", label: "Menu performance", retail: "Product performance", icon: TrendingUp, words: "best sellers popular slow items not selling ranking" },
```

```ts
    id: "menu",
    title: "Menu",
    retail: "Catalog",
```

```ts
      { href: "/backoffice/items", label: "Items", retail: "Products", icon: UtensilsCrossed, words: "products dishes prices barcode" },
      { href: "/backoffice/addons", label: "Add-ons", only: "restaurant", icon: SlidersHorizontal, words: "options modifiers extras" },
```

```ts
    id: "restaurant",
    title: "Restaurant",
    retail: "Shop",
```

```ts
      { href: "/backoffice/tables", label: "Tables", only: "restaurant", icon: LayoutGrid, words: "floor plan rooms areas seats" },
      { href: "/backoffice/bookings", label: "Bookings", only: "restaurant", icon: CalendarClock, words: "reservations" },
```

Replace the last block of the file

```ts
// Every page with the group it sits in, for the search.
export const PAGES: (NavLink & { group: string | null })[] = [
  { ...HOME, group: null },
  ...GROUPS.flatMap((g) => g.links.map((l) => ({ ...l, group: g.title }))),
];
```

with

```ts
// The groups one kind of business has, under the names it uses. The menu and
// the search both draw from this, so they cannot disagree about what exists.
export function groupsFor(mode: Mode): NavGroup[] {
  return GROUPS.map((g) => ({
    ...g,
    title: mode === "retail" && g.retail ? g.retail : g.title,
    links: g.links
      .filter((l) => !l.only || l.only === mode)
      .map((l) => (mode === "retail" && l.retail ? { ...l, label: l.retail } : l)),
  })).filter((g) => g.links.length > 0);
}

// Every page with the group it sits in, for the search.
export const pagesOf = (mode: Mode): (NavLink & { group: string | null })[] => [
  { ...HOME, group: null },
  ...groupsFor(mode).flatMap((g) => g.links.map((l) => ({ ...l, group: g.title }))),
];
```

(`groupOf` and `isOn` stay as they are: group ids are the same for both.)

- [ ] **Step 2: `side.tsx`: draw the mode's groups**

In `web/app/backoffice/side.tsx`:

Change `import { useCallback, useEffect, useRef, useState } from "react";` to

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
```

Change `import { GROUPS, HOME, groupOf, isOn, type NavCount } from "./nav";` to

```ts
import { groupsFor, HOME, groupOf, isOn, type NavCount } from "./nav";
import type { Mode } from "@/lib/mode";
```

Change the start of the component from

```tsx
export function Side({
  restaurant, id, employee, role, signOut, folded, opened, drawn,
}: {
  restaurant: string;
```

to

```tsx
export function Side({
  restaurant, id, employee, role, signOut, folded, opened, drawn, mode,
}: {
  // a restaurant or a shop: which pages the menu has, and what it calls them
  mode: Mode;
  restaurant: string;
```

Straight after the line `const here = groupOf(path);` add:

```tsx
  const groups = useMemo(() => groupsFor(mode), [mode]);
```

Replace both uses of `GROUPS.map(` (one in the rail, `{GROUPS.map((g) => (`, and one in the menu, `{GROUPS.map((g) => {`) with `groups.map(`.

Change `<SearchBox />` to `<SearchBox mode={mode} />`.

- [ ] **Step 3: `search-box.tsx`: search the mode's pages**

In `web/app/backoffice/search-box.tsx`:

Change `import { PAGES } from "./nav";` to

```ts
import { pagesOf } from "./nav";
import type { Mode } from "@/lib/mode";
```

Replace the function `pagesFor` with:

```ts
type Page = ReturnType<typeof pagesOf>[number];

function pagesFor(q: string, all: Page[]): Row[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = words.length
    ? all.filter((p) => {
        const hay = `${p.label} ${p.group ?? ""} ${p.words ?? ""}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      }).sort((a, b) => Number(b.label.toLowerCase().startsWith(words[0])) - Number(a.label.toLowerCase().startsWith(words[0])))
    : START.map((href) => all.find((p) => p.href === href)).filter((p): p is Page => Boolean(p));
  return list.slice(0, 7).map((p) => ({ key: p.href, title: p.label, sub: p.group ?? "Home", href: p.href, icon: p.icon }));
}
```

Change `export function SearchBox() {` to

```tsx
export function SearchBox({ mode }: { mode: Mode }) {
  const all = useMemo(() => pagesOf(mode), [mode]);
```

Inside the `sections` memo, change `const pages = pagesFor(term);` to `const pages = pagesFor(term, all);`, and add `all` to that `useMemo`'s dependency array (the array at the end of the same `useMemo<Section[]>(() => { … }, […])` call).

- [ ] **Step 4: `layout.tsx`: hand the mode to the shell**

In `web/app/backoffice/layout.tsx`:

Add after the `import { Side } from "./side";` line:

```ts
import { words } from "@/lib/mode";
```

In the `<Side … />` element, add the prop `mode={ctx.mode}` as its first prop, and change

```tsx
        restaurant={ctx.tenantName ?? "Restaurant"}
```

to

```tsx
        restaurant={ctx.tenantName ?? words(ctx.mode).Place}
```

- [ ] **Step 5: Type-check**

Run from `web/` (TypeScript is installed there, not at the root): `npx tsc --noEmit`
Expected: no output, exit code 0. An error naming `PAGES` or `GROUPS` means a use of the old name was missed: `grep -rn "PAGES\|GROUPS" web/app/backoffice --include=*.tsx --include=*.ts` (the `GROUPS` in `roles/page.tsx` is that page's own list and stays).

- [ ] **Step 6: Commit**

```bash
git add web/app/backoffice/nav.ts web/app/backoffice/side.tsx web/app/backoffice/search-box.tsx web/app/backoffice/layout.tsx
git commit -m "back office: the menu and the search follow the tenant's type: a shop has no Tables, Bookings or Add-ons, and reads Catalog, Products and Shop

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Pages follow the type

**Files:**
- Modify: `web/app/backoffice/tables/page.tsx:13`, `web/app/backoffice/tables/plan/page.tsx:17`, `web/app/backoffice/bookings/page.tsx:81`, `web/app/backoffice/addons/page.tsx:86`
- Modify: `web/app/backoffice/categories/page.tsx`, `web/app/backoffice/categories/table.tsx`
- Modify: `web/app/backoffice/settings/page.tsx`
- Modify: `web/app/backoffice/items/page.tsx:198`
- Modify: `web/app/backoffice/page.tsx` (the dashboard)

- [ ] **Step 1: Four pages a shop does not have**

In each of `tables/page.tsx`, `tables/plan/page.tsx`, `bookings/page.tsx` and `addons/page.tsx`, inside the page's default export, change

```ts
  const ctx = await tenantContext();
```

to

```ts
  const ctx = await onlyFor("restaurant");
```

and in that file's import from `@/lib/tenant`, add `onlyFor` (leave `tenantContext` in the import if the file still uses it elsewhere; remove it if `tsc` or the linter says it is unused).

- [ ] **Step 2: Categories: no kitchen printers and no Counted tick for a shop**

In `web/app/backoffice/categories/page.tsx`, inside `saveCategory`, straight after the line `if (!name) throw new Refused("A category needs a name.");` add:

```ts
    if (ctx.mode === "retail") {
      // a shop's form has no printers and no Counted tick: both are left as they are
      await c.query(
        `update categories set name = $3, color = $4, sort_order = $5 where tenant_id = $1 and id = $2 and deleted_at is null`,
        [ctx.tenantId, id, name, HEX.test(color) ? color : null, int(f, "sort_order", 0, 999, 0)],
      );
      return `${name} saved.`;
    }
```

In the page's JSX, change the `<PageHead … />` so its `lede` depends on the mode. Replace `lede="The groups of the menu, …"` (the whole attribute, one long string) with:

```tsx
        lede={
          ctx.mode === "retail"
            ? "The groups of the catalog, shown above the products on the till's sell screen. The sequence is their order, and the colour is the colour of the group and of its products."
            : "The groups of the menu, shown above the items on the till's order screen. The sequence is their order, the colour is the colour of the group and of its items, and the printers are where a category's items come out when an order is sent (and its stations on the kitchen display)."
        }
```

(The second string is the one already there, unchanged.)

Change `<CategoriesTable key={startKey(sp, start)} rows={rows} printers={d.printers} start={start} save={saveCategory} />` to

```tsx
        <CategoriesTable key={startKey(sp, start)} rows={rows} printers={d.printers} start={start} save={saveCategory} mode={ctx.mode} />
```

Wrap the three notes under the table so a shop does not see them. Change

```tsx
      {d.printers.length === 0 && (
```

to

```tsx
      {ctx.mode === "restaurant" && d.printers.length === 0 && (
```

change

```tsx
      {d.onePrinter && (
```

to

```tsx
      {ctx.mode === "restaurant" && d.onePrinter && (
```

and change the last note from `<p className="muted">A counted category has …</p>` to

```tsx
      {ctx.mode === "restaurant" && (
        <p className="muted">A counted category has its items&apos; quantities under <Link href="/backoffice/stock">Stock</Link>: each sale takes from them.</p>
      )}
```

In `web/app/backoffice/categories/table.tsx`:

Add to the imports: `import type { Mode } from "@/lib/mode";`

Change the component's signature to

```tsx
export function CategoriesTable({ rows, printers, start, save, mode }: { rows: Category[]; printers: { id: string; name: string }[]; start: Start; save: Action; mode: Mode }) {
  const shop = mode === "retail";
  // a shop's categories have no "Prints on" and no "Stock" column
  const cols = shop ? 4 : 6;
```

In the `<thead>`, change

```tsx
              <th>Prints on</th>
              <th>Stock</th>
```

to

```tsx
              {!shop && <th>Prints on</th>}
              {!shop && <th>Stock</th>}
```

In each row, change

```tsx
                  <td>{where.length ? where.join(", ") : <span className="muted">No printer</span>}</td>
                  <td>{r.is_stock ? <span className="badge blue">Counted</span> : <span className="muted">Not counted</span>}</td>
```

to

```tsx
                  {!shop && <td>{where.length ? where.join(", ") : <span className="muted">No printer</span>}</td>}
                  {!shop && <td>{r.is_stock ? <span className="badge blue">Counted</span> : <span className="muted">Not counted</span>}</td>}
```

Replace every `cols={6}` and `colSpan={6}` in the file with `cols={cols}` and `colSpan={cols}`.

In the opened row's form, change

```tsx
                          <label className="check" style={{ margin: 0 }}>
                            <input type="checkbox" name="is_stock" defaultChecked={r.is_stock} />
                            Stock is counted
                          </label>
```

to

```tsx
                          {!shop && (
                            <label className="check" style={{ margin: 0 }}>
                              <input type="checkbox" name="is_stock" defaultChecked={r.is_stock} />
                              Stock is counted
                            </label>
                          )}
```

and, in the `<div className="open-form-line">` that follows, wrap only the "Prints on" label and the printers (not the spacer and not the Save button). Change

```tsx
                            <span className="muted">Prints on</span>
                            {printers.length === 0 ? (
                              <span className="muted">No printers are set up.</span>
                            ) : (
                              printers.map((p) => (
                                <label key={p.id} className="check" style={{ margin: 0 }}>
                                  <input type="checkbox" name="printer" value={p.id} defaultChecked={r.printer_ids.includes(p.id)} />
                                  {p.name}
                                </label>
                              ))
                            )}
```

to

```tsx
                            {!shop && <span className="muted">Prints on</span>}
                            {!shop &&
                              (printers.length === 0 ? (
                                <span className="muted">No printers are set up.</span>
                              ) : (
                                printers.map((p) => (
                                  <label key={p.id} className="check" style={{ margin: 0 }}>
                                    <input type="checkbox" name="printer" value={p.id} defaultChecked={r.printer_ids.includes(p.id)} />
                                    {p.name}
                                  </label>
                                ))
                              ))}
```

- [ ] **Step 3: POS settings: no Service card and no order types for a shop**

In `web/app/backoffice/settings/page.tsx`:

In `saveGeneral`, replace the `await saveSettings(c, ctx.tenantId, { … });` call with:

```ts
    await saveSettings(c, ctx.tenantId, {
      decimals,
      billNumbering: f.get("billNumbering") === "reset" ? "reset" : "continuous",
      dayCloseDetailed: on(f, "dayCloseDetailed"),
      drawerByNotes: on(f, "drawerByNotes"),
      lockMinutes: int(f, "lockMinutes", 0, 120, 0),
      // a shop's form has no Service card: what those settings held is left as it is
      ...(ctx.mode === "retail"
        ? {}
        : {
            servicePct: int(f, "servicePct", 0, 30, 0),
            prepMinutes: int(f, "prepMinutes", 1, 180, 15),
            kitchenSound: on(f, "kitchenSound"),
            kitchenNotes: String(f.get("kitchenNotes") ?? "").split("\n").map((n) => n.trim().slice(0, 40)).filter(Boolean).slice(0, 12),
          }),
    });
```

In `SettingsPage`, the tab is worked out before the context is known. Change

```ts
  const tab = one(sp.tab) === "payments" ? "payments" : one(sp.tab) === "orders" ? "orders" : "general";
  const ctx = await tenantContext();
```

to

```ts
  const ctx = await tenantContext();
  const shop = ctx.mode === "retail";
  // a shop has no order types: its address for that tab shows General
  const tab = one(sp.tab) === "payments" ? "payments" : one(sp.tab) === "orders" && !shop ? "orders" : "general";
```

Change the third tab link from

```tsx
        <Link href={PATH + "?tab=orders"} className={tab === "orders" ? "on" : undefined}>Order types and kitchen<Wait /></Link>
```

to

```tsx
        {!shop && <Link href={PATH + "?tab=orders"} className={tab === "orders" ? "on" : undefined}>Order types and kitchen<Wait /></Link>}
```

Wrap the whole Service card. Change its opening `<Card title="Service">` to

```tsx
          {!shop && (
          <Card title="Service">
```

and its closing `</Card>` (the one straight before `<Card title="Security">`) to

```tsx
          </Card>
          )}
```

- [ ] **Step 4: Items is called Products for a shop**

In `web/app/backoffice/items/page.tsx`, change the `<PageHead title="Items" lede="…" />` line to:

```tsx
      <PageHead
        title={ctx.mode === "retail" ? "Products" : "Items"}
        lede={
          ctx.mode === "retail"
            ? "What the till sells. Find a product, change its price or take it off sale in the list; tap its name for the rest: its tax, category and barcode."
            : "What the till sells. Find an item, change its price or take it off sale in the list; tap its name for the rest: its tax, add-ons, category and barcode."
        }
      />
```

(`ctx` is the page's `await tenantContext()`. If the page names it differently, use that name.)

- [ ] **Step 5: The dashboard shows no tables and no bookings to a shop**

In `web/app/backoffice/page.tsx`, inside the "Right now" pane, change

```tsx
            {now.tables > 0 ? (
```

to

```tsx
            {ctx.mode === "restaurant" && now.tables > 0 ? (
```

Then wrap the whole "Next bookings" section. Change its opening line

```tsx
      <section className="pane rise" style={{ ...rise(3), marginBottom: 8 }}>
```

to

```tsx
      {ctx.mode === "restaurant" && (
      <section className="pane rise" style={{ ...rise(3), marginBottom: 8 }}>
```

and that section's closing `</section>` (the last one before the `</>` that ends `head`) to

```tsx
      </section>
      )}
```

- [ ] **Step 6: Type-check and build**

Run from `web/` (TypeScript is installed there, not at the root): `npx tsc --noEmit`
Expected: no output, exit code 0.

Run (the build's output goes to a file; piped into `head` it is cut short): `cd web && npx next build > "$SCRATCH/build.log" 2>&1; echo "exit $?"; cd ..`
Expected: `exit 0`, and `tail -5 "$SCRATCH/build.log"` shows the route table, no error.

- [ ] **Step 7: Commit**

```bash
git add web/app/backoffice/tables/page.tsx web/app/backoffice/tables/plan/page.tsx web/app/backoffice/bookings/page.tsx web/app/backoffice/addons/page.tsx web/app/backoffice/categories/page.tsx web/app/backoffice/categories/table.tsx web/app/backoffice/settings/page.tsx web/app/backoffice/items/page.tsx web/app/backoffice/page.tsx
git commit -m "back office: pages follow the tenant's type: Tables, Bookings and Add-ons do not exist for a shop, and Categories, POS settings, Products and the dashboard leave out what only a restaurant has, without resetting it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: The admin's switch

**Files:**
- Modify: `web/lib/platform.ts`
- Modify: `web/app/admin/page.tsx`
- Modify: `web/app/admin/tenants/[id]/page.tsx`

- [ ] **Step 1: Words for the two new refusals**

In `web/lib/platform.ts`, in `MESSAGES`, add after the `"plan-required"` line:

```ts
  "bad-business-type": "Choose restaurant or retail.",
  "open-orders": "This client has open orders. Close or cancel them on the till first, then change the type.",
```

and after `export const PLANS = …;` add:

```ts
// What a client is given: a restaurant or a retail shop. Only set here.
export const BUSINESS_TYPES = ["restaurant", "retail"] as const;
```

- [ ] **Step 2: Choose the type when creating a client**

In `web/app/admin/page.tsx`:

Add `BUSINESS_TYPES` to the import from `@/lib/platform`:

```ts
import { BUSINESS_TYPES, PLANS, adminMessage, requirePlatformAdmin } from "@/lib/platform";
```

In `createTenant`, after `const plan = text("plan") || "standard";` add:

```ts
  const type = text("type") === "retail" ? "retail" : "restaurant";
```

Change the creating query from

```ts
    const made = await db().query(`select platform.create_tenant($1, $2, $3, $4, $5, $6, $7) as r`, [
      admin.userId,
      name,
      store,
      code,
      ownerName,
      userId,
      plan,
    ]);
```

to

```ts
    const made = await db().query(`select platform.create_tenant_of_type($1, $2, $3, $4, $5, $6, $7, $8) as r`, [
      admin.userId,
      name,
      store,
      code,
      ownerName,
      userId,
      plan,
      type,
    ]);
```

In the form, after the closing `</select>` of the plan select and before the submit button, add:

```tsx
        <select name="type" defaultValue="restaurant" aria-label="Business type">
          {BUSINESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
```

In the list query, change `select t.id, t.name, t.plan, t.status,` to `select t.id, t.name, t.business_type, t.plan, t.status,`. In the table, add `<th>Type</th>` after `<th>Restaurant</th>`, and `<td>{t.business_type}</td>` after the cell holding the `<Link>` to the tenant. If the page has a type for a list row, add `business_type: string;` to it.

- [ ] **Step 3: Change the type on a client's page**

In `web/app/admin/tenants/[id]/page.tsx`:

Add `BUSINESS_TYPES` to the import from `@/lib/platform`.

In the `Tenant` type, add after `plan: string;`:

```ts
  business_type: string;
```

After the `setPlan` function, add:

```ts
async function setBusinessType(formData: FormData) {
  "use server";
  const { adminId, tenantId } = await tenantOf(formData);
  try {
    await db().query(`select platform.set_tenant_business_type($1, $2, $3)`, [adminId, tenantId, String(formData.get("type") ?? "")]);
  } catch (e) {
    back(tenantId, "error", adminMessage(e));
  }
  revalidatePath(`/admin/tenants/${tenantId}`);
  back(tenantId, "notice", "Business type saved. Their back office follows at once, their tills at the next sync.");
}
```

In `ACTIONS`, add after the `"tenant.plan"` line:

```ts
  "tenant.business_type": "Business type changed",
```

In the function that describes an audit row, change

```ts
  if (a.action === "tenant.plan") return `${String(d.from)} to ${String(d.to)}`;
```

to

```ts
  if (a.action === "tenant.plan" || a.action === "tenant.business_type") return `${String(d.from)} to ${String(d.to)}`;
```

In the tenant query, change `select id, name, brn, vat_number, plan, status,` to `select id, name, brn, vat_number, plan, business_type, status,`.

In the summary line under the `<h1>`, change `Plan <strong>{tenant.plan}</strong> · Status{" "}` to

```tsx
        Type <strong>{tenant.business_type}</strong> · Plan <strong>{tenant.plan}</strong> · Status{" "}
```

Straight before `<h2>Plan and status</h2>`, add:

```tsx
      <h2>Business type</h2>
      <form action={setBusinessType} style={{ marginBottom: 12 }}>
        <input type="hidden" name="tenant" value={tenant.id} />
        <select name="type" defaultValue={tenant.business_type} aria-label="Business type">
          {BUSINESS_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>{" "}
        <button type="submit">Change type</button>
        <p style={{ margin: "6px 0 0", color: "#555" }}>
          A restaurant has tables, bookings and the kitchen. A shop has none of them. Changing is refused while the client
          has open orders, and deletes nothing: pages are only hidden.
        </p>
      </form>
```

- [ ] **Step 4: Type-check**

Run from `web/` (TypeScript is installed there, not at the root): `npx tsc --noEmit`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add web/lib/platform.ts web/app/admin/page.tsx "web/app/admin/tenants/[id]/page.tsx"
git commit -m "admin: the platform admin chooses restaurant or retail when creating a client and can change it on the client's page; the change is in the log

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: See it

Nothing here is committed. It is the check that what was built is what shows.

- [ ] **Step 1: The menu in both modes, without a login**

Signing in to the back office is the user's to do (Claude does not sign in on the hosted auth service). To see the menu without a login, create a temporary page `web/app/zz-preview/page.tsx`:

```tsx
import { Side } from "../backoffice/side";

// TEMPORARY: delete before any commit. The back office menu as a shop sees it.
export default async function Preview({ searchParams }: { searchParams: Promise<{ mode?: string }> }) {
  const mode = (await searchParams).mode === "restaurant" ? "restaurant" : "retail";
  async function nothing() {
    "use server";
  }
  return (
    <div className="bo">
      <Side mode={mode} drawn={0} folded={false} opened={["menu", "restaurant", "insights"]} restaurant="Preview" id="PREVIEW0" employee="Tester" role="Owner" signOut={nothing} />
    </div>
  );
}
```

Start the `web` preview from `.claude/launch.json` (check first that whatever listens on its port is this project). Open `/zz-preview?mode=retail` and read the page.

Expected for retail: groups **Catalog** (Categories, Products, Taxes, Discounts, Stock) and **Shop** (Customers, Printers, Receipt design); no Add-ons, Tables or Bookings; Insights lists **Product performance**.

Open `/zz-preview?mode=restaurant`.
Expected: **Menu** with Items and Add-ons; **Restaurant** with Tables and Bookings; Insights lists **Menu performance**. Exactly as before this plan.

- [ ] **Step 2: Delete the temporary page**

Delete `web/app/zz-preview/page.tsx` (and the folder). Run `git status --short` and confirm `zz-preview` is not listed.

- [ ] **Step 3: Every suite once more**

Run the loop from Task 3, Step 10.
Expected: every line `ok`.

- [ ] **Step 4: Hand the signed-in checks to the user**

Tell the user, in these words, what Claude ran and what is theirs to click:

- Ran by Claude: the three new database suites and the existing ones; type-check and build; the menu in both modes on a temporary page.
- For the user, signed in as platform admin on dev: create a client with type retail; open an existing client and change its type; see the line in "What was done here".
- For the user, signed in as that shop's owner: the menu reads Catalog and Shop; `/backoffice/tables` says not found; POS settings has no Service card; saving General keeps the restaurant's old service charge; a stock adjustment on Stock still works.
- Not changed by this plan: the till (no new APK), the API (no deploy), production (migrations 0066 to 0068 are additive and wait for the user's word).
