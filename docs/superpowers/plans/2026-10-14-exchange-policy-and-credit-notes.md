# Exchange policy and credit notes: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A shop says whether it refunds, exchanges only, or exchanges with the rest on a credit note; the till and the server hold to it, a 7-day window needs a manager past it, a credit note is printed, kept and spent, and the one-tap swap to another variant is on the exchange sheet.

**Architecture:** The exchange stays a refund plus a sale (0079). A second built-in payment type (`credit_note`) carries the part of a refund that becomes a note; the note is a row (`credit_notes`) written with the refund in one push operation and spent as a payment on a sale that names it. Three keys in `pos_settings.data` carry the policy to tills. The till keeps notes in its own table (database 25 → 26) and is sent the shop's open ones with the pull.

**Tech Stack:** PostgreSQL (plpgsql, fix-forward migrations rebuilt from `db/scripts/dump-function.cjs`), Node test suites in `db/tests` (one rolled-back transaction on dev), Kotlin + Room + Compose on the till, Next.js server actions + plain CSS in the back office.

**Spec:** `docs/superpowers/specs/2026-10-14-exchange-policy-and-credit-notes-design.md`.

**Conventions you must keep:** dev only, never production; suites run one at a time; never push or tag; the shared emulator rule (`easypay_claude_test`, port 5584, never the user's); amounts are cents in `Long`/`bigint`; a migration that changes a live function starts from `node db/scripts/dump-function.cjs <name>` and edits that text, never an older migration file.

---

## File map

**Server**
- Create `db/migrations/0109_returns_policy_and_credit_notes.sql`: the settings keys, the `credit_note` kind, `ensure_credit_note_type`, the `credit_notes` table, the three review reasons, `push_refund_create` (policy, window, the note), `push_receipt_create` (spending a note), `push_payment_correct` (refused for the kind), `push_settings_save` (the three keys), `sync_pull` (open notes), `platform.set_tenant_business_type` (the type follows the kind of business), `credit_note_void`.
- Create `db/tests/credit-notes.test.cjs`.
- Modify `db/tests/shop-pages.test.cjs` (section Y: the page, the report lines, the settings).

**Till (android/app/src/main/java/com/restopos/)**
- Modify `core/data/PosSettings.kt`: `returns`, `returnDays`, `noteMonths`.
- Modify `core/database/Transactions.kt`: `CreditNoteEntity`; `core/database/TicketDaos.kt` (`ReceiptDao`): its queries; `core/database/TillDatabase.kt` (version 26, entity); `core/database/Migrations.kt` (`V25_V26`).
- Create `core/data/ReturnRules.kt`: pure rules (window, what Pay says, slip text, the swap keys' list, the tender's cap). Tested.
- Create `core/data/CreditNotes.kt`: issue (inside the exchange's transaction), find, spend, what the pull brings.
- Modify `core/data/OrderOps.kt` (`refund`: policy + window + `toNote`), `core/data/Exchange.kt` (`complete` with the note), `core/data/TicketRepository.kt` (`pay` takes a note payment and takes its balance down), `core/sync/PullApplier.kt` (`credit_notes`), `core/data/LocalAnswers.kt` (`refund.create`/`receipt.create` are the tablet's own already; nothing to add unless a note is pulled: a tablet alone has none), `core/print/Docs.kt` (`CreditNoteDoc`, `creditNote()`), `core/data/DocBuilder.kt` or `OrderOps.afterExchange` (print the slip).
- Modify `feature/receipts/ReceiptsScreen.kt` (Refund key by policy, window text, swap keys), `feature/pay/Pay.kt` (the three states, the Credit note tender), `feature/retail/RetailSell.kt` (the total row's words), `feature/retail/RetailViewModel.kt` (`scanned`: a note's number opens Pay), `feature/sync/RejectedScreen.kt` (two codes in words), `feature/settings/SettingsScreen.kt` (`SHOP_HELP` entries).
- Tests: `app/src/test/java/com/restopos/core/data/ReturnRulesTest.kt`, `PosSettingsTest.kt` (three keys).

**Back office (web/)**
- Modify `lib/settings.ts` (three keys), `app/backoffice/settings/page.tsx` (the Returns card, shop only).
- Create `app/backoffice/credit-notes/page.tsx` (+ `void` action), add to `nav.ts` (Finance group, `only: "retail"`).
- Modify `app/backoffice/receipts/page.tsx` (`describe`: two reasons), `app/backoffice/reports/day-close/page.tsx` and `app/backoffice/page.tsx` or the sales summary (the two lines; the two kinds left out of "by payment type"), `app/backoffice/customers/[id]` (open notes).

---

## Part A: the server

### Task A1: migration 0109, the schema

**Files:**
- Create: `db/migrations/0109_returns_policy_and_credit_notes.sql`

- [ ] **Step 1: Write the header and the schema part of the migration**

```sql
-- 0109: a shop's return policy, and credit notes.
--
-- The owner, 2026-10-14: "We dont refund we only exchange, if another thing
-- added customer pays difference"; when the replacement is worth less the
-- shop chooses between refusing it and leaving the rest on a credit note.
-- Spec: docs/superpowers/specs/2026-10-14-exchange-policy-and-credit-notes-design.md
--
-- pos_settings.data gains three keys for a shop: "returns" (exchange |
-- credit | refund; missing is exchange), "returnDays" (0..365, missing 7),
-- "noteMonths" (0..36, missing 6). push_settings_save takes them under
-- settings.device, as the kitchen notes are taken (0108).
--
-- A second built-in payment type, kind credit_note, beside the exchange type
-- of 0079: a refund pays to it the part that becomes a note; a sale is paid
-- from it the part a note covers, naming the note (reference). Neither is a
-- payment option the back office edits nor a tender a till offers by itself.
--
-- credit_notes: the note, written with the refund that backs it in the same
-- push operation (refund.create carries "credit_note"); balance is the
-- server's cache of amount - sum(what sales took from it), recomputed under
-- the row's lock on every spend.
--
-- push_refund_create: a plain refund (money back) from a shop whose policy is
-- not "refund" is refused (refund-policy); a refund or exchange past the
-- window with no approver is refused (refund-window); the note is written
-- with its refund, or the refund is refused (bad-payment) when the two do not
-- agree. push_receipt_create: a payment from the credit-note type takes the
-- note's balance down; a note not found, void, expired or used flags the
-- sale (credit-note-refused), one spent past its balance by two tills apart
-- flags it (credit-overspent) and closes the note. push_payment_correct:
-- refused from or to the kind. sync_pull: a shop's open notes.
--
-- Every function below is rebuilt from its live definition
-- (db/scripts/dump-function.cjs on dev, 2026-10-14).

alter table payment_types drop constraint if exists payment_types_kind_check;
alter table payment_types add constraint payment_types_kind_check
  check (kind in ('cash', 'card', 'wallet', 'qr', 'other', 'exchange', 'credit_note'));
create unique index if not exists payment_types_one_credit_note
  on payment_types (tenant_id) where kind = 'credit_note' and deleted_at is null;

alter table receipt_reviews drop constraint if exists receipt_reviews_reason_check;
alter table receipt_reviews add constraint receipt_reviews_reason_check
  check (reason in ('double-pay', 'underpaid', 'overpaid', 'price-drift', 'number-collision', 'price-unapproved',
                    'exchange-unmatched', 'discount-unapproved', 'refund-unapproved', 'credit-note-refused', 'credit-overspent'));

create table if not exists credit_notes (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  store_id uuid not null references stores(id),
  device_id uuid not null references pos_devices(id),
  number text not null,
  amount bigint not null check (amount > 0),
  balance bigint not null check (balance >= 0),
  refund_id uuid not null references receipts(id),
  customer_id uuid references customers(id),
  valid_to date,
  status text not null default 'open' check (status in ('open', 'used', 'void')),
  issued_by uuid references employees(id),
  void_reason text,
  voided_by uuid,
  voided_at timestamptz,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint not null default 0,
  unique (tenant_id, number)
);
create index if not exists credit_notes_open on credit_notes (tenant_id, store_id) where status = 'open' and deleted_at is null;
alter table credit_notes enable row level security;
drop policy if exists tenant_isolation on credit_notes;
create policy tenant_isolation on credit_notes using (tenant_id = current_tenant_id());
grant select, insert, update on credit_notes to app_user;
-- the pull orders by server_seq, as every table it sends: touch_row keeps it
drop trigger if exists credit_notes_touch on credit_notes;
create trigger credit_notes_touch before insert or update on credit_notes for each row execute function touch_row();

-- the shop's credit-note type: as ensure_exchange_type (0079)
create or replace function ensure_credit_note_type(p_tenant uuid) returns uuid
language plpgsql set search_path = public as $fn$
declare v_id uuid; v_name text := 'Credit note';
begin
  select id into v_id from payment_types where tenant_id = p_tenant and kind = 'credit_note' and deleted_at is null;
  if found then return v_id; end if;
  select id into v_id from payment_types where tenant_id = p_tenant and kind = 'credit_note' order by deleted_at desc limit 1;
  if found then
    update payment_types set deleted_at = null, is_active = true where tenant_id = p_tenant and id = v_id;
    return v_id;
  end if;
  if exists (select 1 from payment_types where tenant_id = p_tenant and name = v_name) then v_name := 'Credit note (returns)'; end if;
  if exists (select 1 from payment_types where tenant_id = p_tenant and name = v_name) then v_name := 'Credit note ' || left(gen_random_uuid()::text, 8); end if;
  insert into payment_types (tenant_id, name, kind, opens_drawer, sort_order)
    values (p_tenant, v_name, 'credit_note', false, 998) returning id into v_id;
  return v_id;
end $fn$;
```

Check first how `touch_row` and the RLS policy are named on `receipts` (`grep -n "touch_row\|tenant_isolation" db/migrations/0004_catalog.sql db/migrations/0009_transactions.sql`) and use the same names; if the trigger function is called something else, use that.

- [ ] **Step 2: Append the voiding function and the business-type hook**

```sql
-- The owner voids a note from the back office, with a reason: its balance
-- goes to 0 and it is never spent. The refund that issued it stands.
create or replace function credit_note_void(p_tenant uuid, p_emp uuid, p_id uuid, p_reason text) returns void
language plpgsql set search_path = public as $fn$
declare v_status text;
begin
  if nullif(btrim(coalesce(p_reason, '')), '') is null then raise exception 'bad-payload'; end if;
  select status into v_status from credit_notes where id = p_id and tenant_id = p_tenant and deleted_at is null for update;
  if not found then raise exception 'bad-note'; end if;
  if v_status <> 'open' then raise exception 'note-closed'; end if;
  update credit_notes set status = 'void', balance = 0, void_reason = left(btrim(p_reason), 200), voided_by = p_emp, voided_at = now()
    where id = p_id and tenant_id = p_tenant;
end $fn$;

-- dump platform.set_tenant_business_type (0079) and add, beside ensure_exchange_type:
--   if v_type = 'retail' then perform ensure_exchange_type(p_tenant); perform ensure_credit_note_type(p_tenant);
--   else update payment_types set deleted_at = now() where tenant_id = p_tenant and kind in ('exchange', 'credit_note') and deleted_at is null; end if;
-- (paste the rebuilt function here)

-- every shop there is
select ensure_credit_note_type(id) from tenants where business_type = 'retail';
```

- [ ] **Step 3: Rebuild `platform.set_tenant_business_type` from dev and paste it in place of the comment**

Run: `node db/scripts/dump-function.cjs platform.set_tenant_business_type > C:\Users\sheik\AppData\Local\Temp\claude\C--Projects-RestoPOS\ee207e58-ada5-4f02-9ca2-6032e0aa30b7\scratchpad\sbt.sql`
Edit the two lines as the comment says, paste into the migration.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0109_returns_policy_and_credit_notes.sql
git commit -m "server: the credit-note payment type, the credit_notes table and the review reasons (0109, part 1). Nothing applied yet."
```

### Task A2: `push_settings_save` takes the three keys

**Files:**
- Modify: `db/migrations/0109_returns_policy_and_credit_notes.sql`

- [ ] **Step 1: Dump the live function**

Run: `node db/scripts/dump-function.cjs push_settings_save > <scratchpad>/pss.sql`

- [ ] **Step 2: Add the three keys where `kitchenNotes` is handled (0108)**

Find the block that reads `p->'kitchenNotes'` and builds `v_patch`. After it, add:

```sql
  -- a shop's return policy (0109): each key is taken when sent, left as it was when not
  if p ? 'returns' then
    if p->>'returns' not in ('exchange', 'credit', 'refund') then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('returns', p->>'returns');
  end if;
  if p ? 'returnDays' then
    if (p->>'returnDays')::int not between 0 and 365 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('returnDays', (p->>'returnDays')::int);
  end if;
  if p ? 'noteMonths' then
    if (p->>'noteMonths')::int not between 0 and 36 then raise exception 'bad-payload'; end if;
    v_patch := v_patch || jsonb_build_object('noteMonths', (p->>'noteMonths')::int);
  end if;
```

Use the variable the function really uses for the patch (read the dump; in 0108 it is the object merged into `pos_settings.data`). Paste the whole rebuilt function into the migration.

- [ ] **Step 3: Commit**

```bash
git add db/migrations/0109_returns_policy_and_credit_notes.sql
git commit -m "server: push_settings_save takes returns, returnDays and noteMonths (0109, part 2)"
```

### Task A3: `push_refund_create`: policy, window, the note

**Files:**
- Modify: `db/migrations/0109_returns_policy_and_credit_notes.sql`

- [ ] **Step 1: Dump the live function**

Run: `node db/scripts/dump-function.cjs push_refund_create > <scratchpad>/prc.sql` (last written by 0105).

- [ ] **Step 2: Declare the new variables**

In `declare`, add:

```sql
  v_policy text; v_days int; v_months int; v_age int;
  v_exch bigint := 0; v_note bigint := 0; v_back bigint := 0;
  v_ptkind text; cn jsonb; v_cn_id uuid; v_cn_number text; v_cn_amount bigint; v_cn_customer uuid; v_cn_valid date;
```

- [ ] **Step 3: After the original receipt is found (`select * into o ...`), read the policy and the window**

```sql
  -- the shop's return policy (0109); a restaurant has none and refunds as before
  select data->>'returns', coalesce((data->>'returnDays')::int, 7), coalesce((data->>'noteMonths')::int, 6)
    into v_policy, v_days, v_months
    from pos_settings where tenant_id = p_tenant and deleted_at is null;
  if exists (select 1 from tenants where id = p_tenant and business_type = 'retail') then
    v_policy := coalesce(v_policy, 'exchange');
  else
    v_policy := 'refund'; v_days := 0;
  end if;
  -- past the window, a manager: whole days from the sale to now on the server's clock
  v_age := extract(day from (now() - o.device_time))::int;
  if v_days > 0 and v_age > v_days and nullif(p->>'approved_by', '') is null then
    raise exception 'refund-window';
  end if;
  if v_days = 0 and nullif(p->>'approved_by', '') is null and not has_perm(p_emp, 'sale.refund') then
    raise exception 'refund-window';
  end if;
```

Note: with window 0 every refund needs a manager; the existing `may(p_emp, p, 'sale.refund')` check at the top already lets a cashier with the right through, so the second `if` only bites when the person has no right and nobody approved, which `may` already refused. Keep it anyway: it documents the rule and costs nothing.

- [ ] **Step 4: In the payments loop, sort each payment by kind, and keep the note's payload**

Replace the loop body's `v_chunk := v_chunk + v_pamt;` with:

```sql
    select kind into v_ptkind from payment_types where id = v_ptype and tenant_id = p_tenant;
    if v_ptkind = 'exchange' then v_exch := v_exch + v_pamt;
    elsif v_ptkind = 'credit_note' then v_note := v_note + v_pamt;
    else v_back := v_back + v_pamt; end if;
    v_chunk := v_chunk + v_pamt;
```

After the loop, after `if v_chunk <> v_total then raise exception 'bad-payment'; end if;`:

```sql
  -- money back to the customer only where the shop refunds
  if v_back > 0 and v_policy <> 'refund' then raise exception 'refund-policy'; end if;
  -- a credit note only out of an exchange, under that policy, and only with its refund
  cn := p->'credit_note';
  if v_note > 0 then
    if v_policy <> 'credit' or v_exch = 0 then raise exception 'refund-policy'; end if;
    if cn is null or jsonb_typeof(cn) <> 'object' then raise exception 'bad-payment'; end if;
    v_cn_id := (cn->>'id')::uuid; v_cn_number := nullif(cn->>'number', ''); v_cn_amount := (cn->>'amount')::bigint;
    v_cn_customer := nullif(cn->>'customer_id', '')::uuid;
    v_cn_valid := nullif(cn->>'valid_to', '')::date;
    if v_cn_id is null or v_cn_number is null or v_cn_amount is distinct from v_note then raise exception 'bad-payment'; end if;
    if exists (select 1 from credit_notes where tenant_id = p_tenant and (id = v_cn_id or number = v_cn_number)) then raise exception 'bad-payment'; end if;
  elsif cn is not null then
    raise exception 'bad-payment';
  end if;
```

- [ ] **Step 5: After the refund's payments are inserted, write the note**

```sql
  if v_note > 0 then
    insert into credit_notes (id, tenant_id, store_id, device_id, number, amount, balance, refund_id, customer_id, valid_to, issued_by)
      values (v_cn_id, p_tenant, v_store, v_device, v_cn_number, v_cn_amount, v_cn_amount, v_id, v_cn_customer, v_cn_valid, p_emp);
  end if;
```

And in the returned object add `'credit_note', case when v_note > 0 then v_cn_number else null end`.

- [ ] **Step 6: Paste the rebuilt function into the migration; commit**

```bash
git add db/migrations/0109_returns_policy_and_credit_notes.sql
git commit -m "server: push_refund_create holds the return policy and the window, and writes the credit note with its refund (0109, part 3)"
```

### Task A4: `push_receipt_create` spends a note; `push_payment_correct` refuses the kind

**Files:**
- Modify: `db/migrations/0109_returns_policy_and_credit_notes.sql`

- [ ] **Step 1: Dump both**

Run: `node db/scripts/dump-function.cjs push_receipt_create > <scratchpad>/prcr.sql` and `node db/scripts/dump-function.cjs push_payment_correct > <scratchpad>/ppc.sql`.

- [ ] **Step 2: In `push_receipt_create`, declare and collect**

In `declare`: `v_notes jsonb := '[]'::jsonb; v_refused jsonb := '[]'::jsonb; v_over jsonb := '[]'::jsonb; nt record; v_cn credit_notes%rowtype; v_take bigint;`

In the payments loop, beside the exchange test:

```sql
    if exists (select 1 from payment_types where id = v_ptype and tenant_id = p_tenant and kind = 'credit_note') then
      v_notes := v_notes || jsonb_build_object('amount', v_pamt, 'number', coalesce(pay->>'reference', ''));
    end if;
```

- [ ] **Step 3: After the exchange-matching loop, spend each note**

```sql
  -- A credit note spent: its balance comes down under its lock. One that is
  -- not there, void, expired or used up, or that two tills apart spent past
  -- its balance, leaves a sale paid in part with nothing on the books: the
  -- sale happened, so it is stored and says so (as exchange-unmatched, 0079).
  for nt in select (e->>'amount')::bigint as amount, e->>'number' as number from jsonb_array_elements(v_notes) e loop
    select * into v_cn from credit_notes where tenant_id = p_tenant and number = nt.number and deleted_at is null for update;
    if not found then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'not-found');
    elsif v_cn.status = 'void' then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'void');
    elsif v_cn.valid_to is not null and v_cn.valid_to < (case when p->>'device_time' is null then now() else (p->>'device_time')::timestamptz end)::date then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'expired', 'valid_to', v_cn.valid_to);
    elsif v_cn.balance <= 0 then
      v_offline := true; v_refused := v_refused || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'why', 'used');
    else
      v_take := least(nt.amount, v_cn.balance);
      if nt.amount > v_cn.balance then
        v_offline := true; v_over := v_over || jsonb_build_object('amount', nt.amount, 'number', nt.number, 'balance', v_cn.balance, 'excess', nt.amount - v_cn.balance);
      end if;
      update credit_notes set balance = balance - v_take,
        status = case when balance - v_take = 0 then 'used' else status end,
        used_at = case when balance - v_take = 0 then now() else used_at end
        where id = v_cn.id and tenant_id = p_tenant;
    end if;
  end loop;
```

- [ ] **Step 4: Write the two reviews where the others are written**

```sql
  if jsonb_array_length(v_refused) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'credit-note-refused', jsonb_build_object('notes', v_refused));
  end if;
  if jsonb_array_length(v_over) > 0 then
    insert into receipt_reviews (tenant_id, receipt_id, reason, detail)
      values (p_tenant, v_id, 'credit-overspent', jsonb_build_object('notes', v_over));
  end if;
```

- [ ] **Step 5: In `push_payment_correct`, widen the exchange refusal**

Change `kind = 'exchange'` in the `if exists (select 1 from payment_types where id in (v_from, v_to) ...` line to `kind in ('exchange', 'credit_note')`.

- [ ] **Step 6: Paste both rebuilt functions; commit**

```bash
git add db/migrations/0109_returns_policy_and_credit_notes.sql
git commit -m "server: a credit note is spent on a sale under its lock, and flagged when it cannot be; a payment is not corrected from or to the kind (0109, part 4)"
```

### Task A5: `sync_pull` sends a shop's open notes

**Files:**
- Modify: `db/migrations/0109_returns_policy_and_credit_notes.sql`

- [ ] **Step 1: Dump `sync_pull` (last written by 0102) and add, inside the `if ... businessType = 'retail'` block, after `stock_count_lines`:**

```sql
    -- the shop's credit notes (0109): open ones, and ones that changed in the
    -- last 30 days so a till learns a note was used up or voided
    select coalesce(jsonb_agg(t order by t.server_seq), '[]'::jsonb), coalesce(max(t.server_seq), cur), count(*)
      into r, m, c
      from (select x.* from credit_notes x
             where x.server_seq > cur and x.tenant_id = current_tenant_id()
               and (x.status = 'open' or x.updated_at > now() - interval '30 days')
             order by x.server_seq limit lim) t;
    changes := changes || jsonb_build_object('credit_notes', r);
    if c > 0 then
      if high is null or m > high then high := m; end if;
      if c >= lim and (low_cut is null or m < low_cut) then low_cut := m; end if;
    end if;
    if c >= lim then more := true; end if;
```

(Every store's notes: a note is spent at any till of the shop.)

- [ ] **Step 2: Paste; apply the migration on dev; commit**

Run: `node db/scripts/migrate.cjs` (or whatever the repo's runner is: `ls db/scripts`, read its usage line; it applies every file in the folder not yet applied). Expected: `0109 applied`.

```bash
git add db/migrations/0109_returns_policy_and_credit_notes.sql
git commit -m "server: the pull sends a shop's credit notes (0109, part 5). Applied on dev."
```

### Task A6: the suite `credit-notes`

**Files:**
- Create: `db/tests/credit-notes.test.cjs`

- [ ] **Step 1: Write the suite** (copy the harness of `db/tests/retail-till.test.cjs` lines 11–82: `check`, `op`, `asApp`, `push`, `tag`, `tags`, a retail tenant, a device, cash, a `shirt` with variants M and L, a `mug`, the `ticket`/`add`/`receipt` helpers). Then the checks:

```js
    const exch = (await one(`select id from payment_types where tenant_id = $1 and kind = 'exchange' and deleted_at is null`, [tid])).id;
    const noteType = (await one(`select id from payment_types where tenant_id = $1 and kind = 'credit_note' and deleted_at is null`, [tid])).id;
    check('T1 a shop has one credit-note type, made with the exchange type', !!noteType);
    const setReturns = (returns, days = 7, months = 6) => c.query(`update pos_settings set data = data || $2::jsonb where tenant_id = $1`, [tid, JSON.stringify({ returns, returnDays: days, noteMonths: months })]);
    const saleOf = async (amount) => { const tk = await ticket(); const [l, o1] = add(tk, { item_id: shirt, variant_id: shirtM, name_snapshot: 'Shirt, M', unit_price: amount }); const [rc, o2] = receipt(tk, amount); const out = await push([o1, o2]); if (tags(out) !== 'applied applied') throw new Error(tags(out)); return { rc, l, tk }; };
    const refundOp = (rc, lines, payments, extra = {}) => { const rf = id(); seq++; return [rf, op('refund.create', { id: rf, refund_of: rc, store_id: store, device_id: dev, number: 'RT-R' + seq, device_seq: seq, device_time: new Date().toISOString(), reason: 'exchange', lines, payments, ...extra })]; };

    // ---- T2 policy: a plain refund is refused unless the shop refunds ----
    {
      await setReturns('exchange');
      const s = await saleOf(11500);
      const [, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }]);
      let out = await push([r1]);
      check('T2 under exchange-only a refund in cash is refused', tag(out[0]) === 'rejected:refund-policy', tag(out[0]));
      await setReturns('refund');
      out = await push([r1]);
      check('T2 under refund it is taken', tag(out[0]) === 'applied', tag(out[0]));
    }

    // ---- T3 the window ----
    {
      await setReturns('refund', 7);
      const s = await saleOf(11500);
      await c.query(`update receipts set device_time = now() - interval '9 days' where id = $1`, [s.rc]);
      const [, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }]);
      let out = await push([r1]);
      check('T3 nine days old, no approver: refused', tag(out[0]) === 'rejected:refund-window', tag(out[0]));
      const [, r2] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }], { approved_by: owner });
      out = await push([r2]);
      check('T3 with an approver: taken', tag(out[0]) === 'applied', tag(out[0]));
      await setReturns('refund', 0);
      const s2 = await saleOf(11500);
      const [, r3] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: cash, amount: 11500 }]);
      out = await push([r3]);
      check('T3 window 0: the owner refunds alone, as before', tag(out[0]) === 'applied', tag(out[0]));
    }

    // ---- T4 a note is written with its refund, or neither is ----
    let noteNo, noteId;
    {
      await setReturns('credit', 7, 6);
      const s = await saleOf(59000);
      noteId = id(); noteNo = 'CN-T1-000001';
      // the exchange's refund: 32000 to the exchange, 27000 to the note
      const [rf, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: exch, amount: 32000 }, { payment_type_id: noteType, amount: 27000 }],
        { credit_note: { id: noteId, number: noteNo, amount: 27000, valid_to: '2027-04-14' } });
      const out = await push([r1]);
      const row = await one(`select * from credit_notes where id = $1`, [noteId]);
      check('T4 the note is written with the refund', tag(out[0]) === 'applied' && row && Number(row.amount) === 27000 && Number(row.balance) === 27000 && row.status === 'open' && row.refund_id === rf, tag(out[0]) + ' ' + JSON.stringify(row));
      // a note whose amount is not the payment's
      const s2 = await saleOf(59000);
      const [, bad] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: exch, amount: 32000 }, { payment_type_id: noteType, amount: 27000 }],
        { credit_note: { id: id(), number: 'CN-T1-000002', amount: 20000 } });
      check('T4 a note that does not match its payment is refused with the refund', tag((await push([bad]))[0]) === 'rejected:bad-payment');
      // a note with nothing to the exchange type: not an exchange
      const [, bad2] = refundOp(s2.rc, [{ ticket_line_id: s2.l, qty: 1000 }], [{ payment_type_id: noteType, amount: 59000 }], { credit_note: { id: id(), number: 'CN-T1-000003', amount: 59000 } });
      check('T4 a note from a plain return is refused', tag((await push([bad2]))[0]) === 'rejected:refund-policy');
    }

    // ---- T5 spending ----
    {
      const spend = async (amount, ref, extraPay = []) => { const tk = await ticket(); const [, o1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: amount + extraPay.reduce((a, p) => a + p.amount, 0) }); const rc = id(); seq++; const o2 = op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'RT-' + seq, device_seq: seq, device_time: new Date().toISOString(), payments: [{ payment_type_id: noteType, amount, reference: ref }, ...extraPay] }); const out = await push([o1, o2]); return { rc, said: tags(out) }; };
      let r = await spend(10000, noteNo);
      let row = await one(`select balance, status from credit_notes where id = $1`, [noteId]);
      check('T5 Rs 100 of the note spent: balance 170, open, nothing flagged', r.said === 'applied applied' && Number(row.balance) === 17000 && row.status === 'open' && (await reviews(r.rc)) === '', JSON.stringify(row));
      r = await spend(17000, noteNo, [{ payment_type_id: cash, amount: 5000 }]);
      row = await one(`select balance, status, used_at from credit_notes where id = $1`, [noteId]);
      check('T5 the rest spent with cash beside it: used', r.said === 'applied applied' && Number(row.balance) === 0 && row.status === 'used' && row.used_at !== null, JSON.stringify(row));
      r = await spend(5000, noteNo);
      check('T5 spent again: stored and flagged as used', (await reviews(r.rc)) === 'credit-note-refused' && (await one(`select detail from receipt_reviews where receipt_id = $1`, [r.rc])).detail.notes[0].why === 'used');
      r = await spend(5000, 'CN-T1-009999');
      check('T5 a note nobody issued: flagged as not found', (await reviews(r.rc)) === 'credit-note-refused');
    }

    // ---- T6 overspent by two tills apart ----
    {
      const s = await saleOf(30000);
      const nid = id(), nno = 'CN-T1-000010';
      const [, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: exch, amount: 10000 }, { payment_type_id: noteType, amount: 20000 }], { credit_note: { id: nid, number: nno, amount: 20000 } });
      await push([r1]);
      const spend = async (amount) => { const tk = await ticket(); const [, o1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: amount }); const rc = id(); seq++; const o2 = op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'RT-' + seq, device_seq: seq, device_time: new Date().toISOString(), payments: [{ payment_type_id: noteType, amount, reference: nno }] }); await push([o1, o2]); return rc; };
      const a = await spend(15000), b = await spend(15000);
      const row = await one(`select balance, status from credit_notes where id = $1`, [nid]);
      const why = (await one(`select detail from receipt_reviews where receipt_id = $1 and reason = 'credit-overspent'`, [b])).detail.notes[0];
      check('T6 the first is clean, the second is flagged overspent by Rs 100 and the note is used', (await reviews(a)) === '' && (await reviews(b)) === 'credit-overspent' && Number(why.excess) === 10000 && Number(row.balance) === 0 && row.status === 'used', JSON.stringify(row) + ' ' + JSON.stringify(why));
    }

    // ---- T7 expired, void, corrections, the pull ----
    {
      const s = await saleOf(30000);
      const nid = id(), nno = 'CN-T1-000020';
      const [, r1] = refundOp(s.rc, [{ ticket_line_id: s.l, qty: 1000 }], [{ payment_type_id: exch, amount: 10000 }, { payment_type_id: noteType, amount: 20000 }], { credit_note: { id: nid, number: nno, amount: 20000, valid_to: '2020-01-01' } });
      await push([r1]);
      const tk = await ticket(); const [, o1] = add(tk, { item_id: mug, name_snapshot: 'Mug', unit_price: 5000 }); const rc = id(); seq++;
      await push([o1, op('receipt.create', { id: rc, ticket_id: tk, store_id: store, device_id: dev, number: 'RT-' + seq, device_seq: seq, device_time: new Date().toISOString(), payments: [{ payment_type_id: noteType, amount: 5000, reference: nno }] })]);
      check('T7 an expired note is flagged', (await reviews(rc)) === 'credit-note-refused' && (await one(`select detail from receipt_reviews where receipt_id = $1`, [rc])).detail.notes[0].why === 'expired');
      await asApp(tid, () => c.query(`select credit_note_void($1, $2, $3, 'slip proven forged')`, [tid, owner, nid]));
      const row = await one(`select status, balance, void_reason from credit_notes where id = $1`, [nid]);
      check('T7 voided: balance 0, reason kept', row.status === 'void' && Number(row.balance) === 0 && row.void_reason === 'slip proven forged');
      let threw = null; try { await asApp(tid, () => c.query(`select credit_note_void($1, $2, $3, 'again')`, [tid, owner, nid])); } catch (e) { threw = e.message; }
      check('T7 voided twice: refused', /note-closed/.test(threw || ''), threw);
      const corr = await push([op('payment.correct', { id: id(), receipt_id: rc, from_payment_type_id: noteType, to_payment_type_id: cash })]);
      check('T7 a payment is not corrected from the credit-note type', tag(corr[0]) === 'rejected:bad-payment', tag(corr[0]));
      const pulled = await asApp(tid, async () => (await c.query('select sync_pull($1, 0, 500) as r', [store])).rows[0].r);
      const sent = (pulled.changes.credit_notes || []).map((x) => x.number);
      check('T7 the pull sends the shop\'s notes, the void one too (it changed)', sent.includes(noteNo) && sent.includes(nno), sent.join());
      check('T7 the pull sends the credit-note type', (pulled.changes.payment_types || []).some((x) => x.kind === 'credit_note'));
    }

    // ---- T8 settings ----
    {
      const out = await push([op('settings.save', { returns: 'credit', returnDays: 14, noteMonths: 12 })]);
      const d = (await one(`select data from pos_settings where tenant_id = $1`, [tid])).data;
      check('T8 the three keys are saved from a till', tag(out[0]) === 'applied' && d.returns === 'credit' && d.returnDays === 14 && d.noteMonths === 12, tag(out[0]) + ' ' + JSON.stringify(d));
      const bad = await push([op('settings.save', { returns: 'maybe' })]);
      check('T8 a value nobody knows is refused', tag(bad[0]) === 'rejected:bad-payload', tag(bad[0]));
    }
```

(T3: the refund past the window is pushed by `owner`, who has every right; the window still asks for `approved_by`. Check how `settings.save` is dispatched in `sync_push` and what payload shape `push_settings_save` wants: read the dump from A2 and shape T8's payload to it.)

- [ ] **Step 2: Run it**

Run: `node db/tests/credit-notes.test.cjs`
Expected: every line `PASS`, `0 failures`. Fix the migration (a new fix-forward is not needed before it is pushed: edit 0109 and re-apply on dev with the runner's re-run of that file, or roll back by hand with the `drop`/`create` the runner offers) until it does.

- [ ] **Step 3: Run the two suites this touches**

Run: `node db/tests/retail-till.test.cjs` then `node db/tests/shop-pages.test.cjs` (one at a time). Expected: both pass as before (section E still green: an exchange under the default policy `exchange` with money back... **note**: E3 gives Rs 35 back in cash; under the default `exchange` it is now refused. Set the test tenant's policy to `refund` at the top of section E with the `update pos_settings` line, and say so in a comment: "the shop refunds (0109)").

- [ ] **Step 4: Commit**

```bash
git add db/tests/credit-notes.test.cjs db/tests/retail-till.test.cjs
git commit -m "tests: credit-notes (policy, window, a note with its refund, spending in parts, overspent by two tills, expired, void, correction refused, the pull, the settings); retail-till section E says the shop refunds"
```

---

## Part B: the till's rules and data

### Task B1: the settings

**Files:**
- Modify: `android/app/src/main/java/com/restopos/core/data/PosSettings.kt`
- Test: `android/app/src/test/java/com/restopos/core/data/PosSettingsTest.kt`

- [ ] **Step 1: Write the failing test** (append to `PosSettingsTest.kt`, in its style)

```kotlin
    @Test fun `a shop's return policy, with its defaults`() {
        val none = PosSettings.parse("""{"businessType":"retail"}""")
        assertEquals("exchange", none.returns); assertEquals(7, none.returnDays); assertEquals(6, none.noteMonths)
        val set = PosSettings.parse("""{"businessType":"retail","returns":"credit","returnDays":14,"noteMonths":0}""")
        assertEquals("credit", set.returns); assertEquals(14, set.returnDays); assertEquals(0, set.noteMonths)
        val bad = PosSettings.parse("""{"returns":"maybe","returnDays":900,"noteMonths":-1}""")
        assertEquals("exchange", bad.returns); assertEquals(7, bad.returnDays); assertEquals(6, bad.noteMonths)
        // a restaurant refunds as it always did, whatever the keys say
        assertEquals("refund", PosSettings.parse("""{"businessType":"restaurant","returns":"exchange"}""").returns)
    }
```

- [ ] **Step 2: Run it**: `cd android && .\gradlew.bat :app:testDebugUnitTest --tests "*PosSettingsTest*"` → FAIL (unresolved `returns`).

- [ ] **Step 3: Add the three fields and their parsing**

In the data class, after `tableOrdering`:

```kotlin
    // A shop's return policy (server 0109): exchange (no money back), credit
    // (an exchange's rest goes on a credit note) or refund. Days inside which
    // a cashier returns alone (0: always a manager), and months a note is
    // valid (0: never expires). A restaurant refunds as it always did.
    val returns: String = "exchange",
    val returnDays: Int = 7,
    val noteMonths: Int = 6,
```

In `parse`, after `tableOrdering = ...`:

```kotlin
                returns = if (d.str("businessType") != "retail") "refund" else d.str("returns")?.takeIf { it == "exchange" || it == "credit" || it == "refund" } ?: "exchange",
                returnDays = runCatching { d["returnDays"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..365 } ?: 7,
                noteMonths = runCatching { d["noteMonths"]?.jsonPrimitive?.intOrNull }.getOrNull()?.takeIf { it in 0..36 } ?: 6,
```

- [ ] **Step 4: Run it** → PASS. **Step 5: Commit** `git commit -am "till: the shop's return policy in its settings"`.

### Task B2: `ReturnRules`, the pure rules

**Files:**
- Create: `android/app/src/main/java/com/restopos/core/data/ReturnRules.kt`
- Test: `android/app/src/test/java/com/restopos/core/data/ReturnRulesTest.kt`

- [ ] **Step 1: Write the failing tests**

```kotlin
package com.restopos.core.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ReturnRulesTest {
    private val day = 24L * 3600 * 1000

    @Test fun `the window in whole days`() {
        val sold = 1_000_000_000_000L
        assertEquals(false, ReturnRules.pastWindow(sold, sold + 7 * day - 1, 7))
        assertEquals(true, ReturnRules.pastWindow(sold, sold + 8 * day, 7))
        assertEquals(true, ReturnRules.pastWindow(sold, sold, 0)) // 0: always a manager
    }

    @Test fun `what Pay says for an exchange, by policy and by the sign of what is due`() {
        // due = sale total - credit
        assertEquals(ReturnRules.PayState.Pay(27000), ReturnRules.payState("exchange", 59000, 32000))
        assertEquals(ReturnRules.PayState.Even, ReturnRules.payState("exchange", 32000, 32000))
        assertEquals(ReturnRules.PayState.Short(59000), ReturnRules.payState("exchange", 32000, 59000))
        assertEquals(ReturnRules.PayState.Note(27000), ReturnRules.payState("credit", 32000, 59000))
        assertEquals(ReturnRules.PayState.Back(27000), ReturnRules.payState("refund", 32000, 59000))
    }

    @Test fun `what a note may cover on a sale`() {
        assertEquals(17000L, ReturnRules.noteCover(balance = 17000, due = 25000))
        assertEquals(25000L, ReturnRules.noteCover(balance = 40000, due = 25000))
        assertEquals(0L, ReturnRules.noteCover(balance = 0, due = 25000))
    }

    @Test fun `when a note runs out`() {
        assertNull(ReturnRules.validTo(1_700_000_000_000L, 0))
        // 6 months on, same day of the month
        val from = java.time.LocalDate.of(2026, 10, 14)
        assertEquals(java.time.LocalDate.of(2027, 4, 14), ReturnRules.validTo(from, 6))
    }

    @Test fun `the swap keys are the product's other live variants, the returned one left out`() {
        val vs = listOf(Triple("m", "Navy · M", false), Triple("l", "Navy · L", false), Triple("gone", "Red · S", true))
        assertEquals(listOf("l"), ReturnRules.swaps(returned = "m", variants = vs.map { ReturnRules.Variant(it.first, it.second, it.third) }).map { it.id })
        assertEquals(emptyList<ReturnRules.Variant>(), ReturnRules.swaps(returned = null, variants = emptyList()))
    }
}
```

- [ ] **Step 2: Run** → FAIL (no `ReturnRules`).

- [ ] **Step 3: Write the module**

```kotlin
package com.restopos.core.data

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

// A shop's return rules, as rules with nothing to do: the window, what the
// payment screen says of an exchange under each policy, what a credit note
// may cover, when it runs out, and which variants a returned line can be
// swapped for. The screens and the writers ask here.
object ReturnRules {
    private const val DAY = 24L * 3600 * 1000

    // Past the window, a manager. Whole days from the sale to now; window 0
    // is always a manager.
    fun pastWindow(soldAt: Long, now: Long, days: Int): Boolean = days == 0 || (now - soldAt) / DAY > days

    fun windowText(soldAt: Long, now: Long, days: Int): String =
        if (days == 0) "A return needs a manager." else "This receipt is ${(now - soldAt) / DAY} days old, past the $days-day window. A manager must approve."

    // What Pay does with an exchange: the customer pays, nothing changes
    // hands, the sale is still short of the credit (exchange only), the rest
    // goes on a note (credit), or the shop gives money back (refund).
    sealed class PayState {
        data class Pay(val amount: Long) : PayState()
        object Even : PayState()
        data class Short(val needed: Long) : PayState()
        data class Note(val amount: Long) : PayState()
        data class Back(val amount: Long) : PayState()
    }

    fun payState(policy: String, saleTotal: Long, credit: Long): PayState {
        val due = saleTotal - credit
        return when {
            due > 0 -> PayState.Pay(due)
            due == 0L -> PayState.Even
            policy == "credit" -> PayState.Note(-due)
            policy == "refund" -> PayState.Back(-due)
            else -> PayState.Short(credit)
        }
    }

    fun noteCover(balance: Long, due: Long): Long = minOf(balance, due).coerceAtLeast(0)

    fun validTo(issuedAt: Long, months: Int): LocalDate? =
        validTo(Instant.ofEpochMilli(issuedAt).atZone(ZoneId.systemDefault()).toLocalDate(), months)

    fun validTo(issued: LocalDate, months: Int): LocalDate? = if (months <= 0) null else issued.plusMonths(months.toLong())

    data class Variant(val id: String, val label: String, val gone: Boolean)

    // The other live variants of the returned line's product, one key each.
    fun swaps(returned: String?, variants: List<Variant>): List<Variant> =
        if (returned == null) emptyList() else variants.filter { it.id != returned && !it.gone }
}
```

- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `git add -A android/app/src/main/java/com/restopos/core/data/ReturnRules.kt android/app/src/test/java/com/restopos/core/data/ReturnRulesTest.kt && git commit -m "till: the return rules as a module with nothing to do (window, what Pay says, a note's cover and date, the swap keys)"`.

### Task B3: the note on the tablet (entity, DAO, database 26)

**Files:**
- Modify: `core/database/Transactions.kt`, `core/database/TicketDaos.kt` (`ReceiptDao`), `core/database/TillDatabase.kt`, `core/database/Migrations.kt`

- [ ] **Step 1: The entity** (append to `Transactions.kt`)

```kotlin
// A credit note (server 0109): what is left of a return once the new sale
// used its part. Made on this tablet with its refund, or sent by the server
// (pulled) so a note from another till can be spent here. balance is what
// the tablet believes; the server's figure replaces it on the next pull.
@Entity(tableName = "credit_notes", indices = [Index("number")])
data class CreditNoteEntity(
    @PrimaryKey val id: String,
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val number: String,
    val amount: Long,
    val balance: Long,
    val refund_id: String,
    val customer_id: String? = null,
    val valid_to: String? = null, // yyyy-mm-dd
    val status: String = "open", // open | used | void
    val issued_by: String? = null,
    val created_at: Long = System.currentTimeMillis(),
    val server_seq: Long? = null,
    val pulled: Boolean = false,
)
```

- [ ] **Step 2: The DAO** (add to `ReceiptDao`)

```kotlin
    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertNotes(rows: List<CreditNoteEntity>)

    @Query("SELECT * FROM credit_notes WHERE number = :number LIMIT 1")
    suspend fun noteByNumber(number: String): CreditNoteEntity?

    @Query("SELECT * FROM credit_notes WHERE id = :id")
    suspend fun note(id: String): CreditNoteEntity?

    @Query("SELECT * FROM credit_notes WHERE refund_id = :refund LIMIT 1")
    suspend fun noteOfRefund(refund: String): CreditNoteEntity?

    @Query("UPDATE credit_notes SET balance = :balance, status = :status WHERE id = :id")
    suspend fun setNoteBalance(id: String, balance: Long, status: String)

    // the shop's credit-note type (server 0109); a restaurant has none
    @Query("SELECT * FROM payment_types WHERE kind = 'credit_note' AND deleted_at IS NULL AND is_active LIMIT 1")
    suspend fun creditNoteType(): PaymentTypeEntity?
```

- [ ] **Step 3: Database version 26 and the migration**

In `TillDatabase.kt`: add `CreditNoteEntity::class` to the entities, `version = 26`, and a comment line "Version 26 adds a shop's credit notes (server 0109)." In `Migrations.kt`:

```kotlin
    // 25 -> 26: a shop's credit notes.
    val V25_V26 = object : Migration(25, 26) {
        override fun migrate(db: SupportSQLiteDatabase) {
            db.execSQL("CREATE TABLE IF NOT EXISTS `credit_notes` (`id` TEXT NOT NULL, `tenant_id` TEXT NOT NULL, `store_id` TEXT NOT NULL, `device_id` TEXT NOT NULL, `number` TEXT NOT NULL, `amount` INTEGER NOT NULL, `balance` INTEGER NOT NULL, `refund_id` TEXT NOT NULL, `customer_id` TEXT, `valid_to` TEXT, `status` TEXT NOT NULL, `issued_by` TEXT, `created_at` INTEGER NOT NULL, `server_seq` INTEGER, `pulled` INTEGER NOT NULL, PRIMARY KEY(`id`))")
            db.execSQL("CREATE INDEX IF NOT EXISTS `index_credit_notes_number` ON `credit_notes` (`number`)")
        }
    }
```

Register `V25_V26` where `V24_V25` is registered (grep `V24_V25` outside `Migrations.kt`). Build: `.\gradlew.bat :app:assembleDebug`. Room's exported schema (`android/app/schemas/.../26.json`) is generated; compare its `CREATE TABLE` for `credit_notes` with the migration's and make them identical.

- [ ] **Step 4: Commit** `git commit -am "till: credit_notes on the tablet (database 26)"`.

### Task B4: the pull brings the shop's notes

**Files:**
- Modify: `core/sync/PullApplier.kt` (after `receipt_payments`)

- [ ] **Step 1: Apply the rows**

```kotlin
            // A shop's credit notes (server 0109). The server's balance and
            // status win: a note this tablet spent is overwritten by the
            // figure the server worked out once the sale got there.
            changes["credit_notes"]?.let { rows ->
                receipts.upsertNotes(rows.mapNotNull {
                    CreditNoteEntity(
                        id(it), str(it, "tenant_id") ?: "", str(it, "store_id") ?: store, str(it, "device_id") ?: "", str(it, "number") ?: return@mapNotNull null,
                        lng(it, "amount") ?: 0, lng(it, "balance") ?: 0, str(it, "refund_id") ?: "", str(it, "customer_id"), str(it, "valid_to")?.take(10),
                        str(it, "status") ?: "open", str(it, "issued_by"), time(it, "created_at") ?: System.currentTimeMillis(), lng(it, "server_seq"), pulled = true,
                    )
                })
            }
```

- [ ] **Step 2: Build; commit** `git commit -am "till: the pull brings the shop's credit notes"`.

### Task B5: issuing a note with the exchange's refund

**Files:**
- Modify: `core/data/OrderOps.kt` (`refund`), `core/data/Exchange.kt` (`complete`), `core/print/Docs.kt`, `core/data/CreditNotes.kt` (create)

- [ ] **Step 1: `OrderOps.refund` learns the policy, the window and `toNote`**

Signature: add `toNote: Long = 0` after `toExchange`. After `staff.allow("sale.refund", "refund", approver)`:

```kotlin
        val settings = PosSettings.parse(db.ops().settings())
        val orig = db.ops().receipt(receiptId) ?: error("That receipt is not on this tablet")
        // past the window a manager approves, whoever is at the till (0109)
        if (settings.retail && ReturnRules.pastWindow(orig.device_time, System.currentTimeMillis(), settings.returnDays) && approver?.can("sale.refund") != true && !(settings.returnDays == 0 && staff.can("sale.refund"))) {
            throw NeedsApproval("sale.refund", "return past the ${settings.returnDays}-day window")
        }
```

(Remove the later duplicate `val orig = ...` line.) Where `rest` is computed:

```kotlin
        require(toNote in 0..amount && toExchange + toNote <= amount) { "More than comes back cannot be kept" }
        val noteType = if (toNote > 0) db.receipts().creditNoteType() ?: error("This till has not been sent the shop's Credit note payment type yet. Let it sync.") else null
        val rest = amount - toExchange - toNote
        // money back only where the shop refunds (0109)
        require(rest == 0L || settings.returns == "refund") { "This shop does not refund. Exchange instead." }
```

The doc's payments: add `if (toNote > 0) DocPayment("Credit note, kept for the customer", toNote) else null,`. The entity payments and the payload's payments: add the note's payment (`payment_type_id = noteType.id, amount = toNote, reference = noteNumber`). For that the refund needs the note's number before it is written: add parameters `noteId: String? = null, noteNumber: String? = null, noteValidTo: String? = null, noteCustomer: String? = null`, and in the payload:

```kotlin
                if (toNote > 0 && noteId != null && noteNumber != null) put("credit_note", buildJsonObject {
                    put("id", noteId); put("number", noteNumber); put("amount", toNote)
                    noteValidTo?.let { put("valid_to", it) }; noteCustomer?.let { put("customer_id", it) }
                })
```

- [ ] **Step 2: `CreditNotes`, the writer and the finder**

```kotlin
package com.restopos.core.data

import com.restopos.core.database.CreditNoteEntity
import com.restopos.core.database.TillDatabase
import javax.inject.Inject
import javax.inject.Singleton

// A shop's credit notes on this tablet: issued with an exchange's refund,
// found by number to be spent, and their balance taken down when a sale
// uses them. The server's figure replaces the tablet's on the next pull.
@Singleton
class CreditNotes @Inject constructor(private val db: TillDatabase, private val session: SessionStore) {
    // the next number of this till's series: CN-<store>-<till>-<n>, counted with the receipts
    suspend fun nextNumber(): Pair<String, Long> {
        val deviceId = session.deviceId() ?: error("no device")
        val device = db.catalog().device(deviceId) ?: error("no device")
        val store = db.catalog().store(device.store_id) ?: error("no store")
        val seq = device.last_receipt_seq + 1
        return "CN-${store.code}-${device.code}-${seq.toString().padStart(6, '0')}" to seq
    }

    suspend fun find(number: String): CreditNoteEntity? = db.receipts().noteByNumber(number.trim().uppercase())

    // Why a note cannot be spent, in words; null when it can.
    fun refusal(n: CreditNoteEntity?, today: String): String? = when {
        n == null -> "This till does not know that note. Let it sync and try again, or take another payment."
        n.status == "void" -> "Credit note ${n.number} was cancelled by the shop."
        n.status == "used" || n.balance <= 0 -> "Credit note ${n.number} has been used up."
        n.valid_to != null && n.valid_to < today -> "Credit note ${n.number} expired on ${n.valid_to}."
        else -> null
    }

    // inside the sale's transaction: what the sale took
    suspend fun spend(id: String, amount: Long) {
        val n = db.receipts().note(id) ?: return
        val left = (n.balance - amount).coerceAtLeast(0)
        db.receipts().setNoteBalance(id, left, if (left == 0L) "used" else n.status)
    }
}
```

Numbering: the note takes the **refund's** sequence number (the refund and the note are one event), so `nextNumber` is not needed: in `Exchanges.complete` the number is built from the refund's `seq`. Replace `nextNumber` with `fun numberFor(refundNumber: String) = refundNumber.replaceFirst("-R", "-CN")` (a refund is `STORE-TILL-R000012`; its note is `STORE-TILL-CN000012`). Delete the `nextNumber` function.

- [ ] **Step 3: `Exchanges.complete` writes the note**

Signature: add `note: Long = 0` after `backTypeId`. In the transaction, after the refund:

```kotlin
            val noteRow = if (note > 0) {
                val number = CreditNotes.numberFor(refund.number)
                val settings = PosSettings.parse(db.ops().settings())
                val valid = ReturnRules.validTo(System.currentTimeMillis(), settings.noteMonths)?.toString()
                CreditNoteEntity(noteId, tenant, store, deviceId, number, note, note, refund.id, ticket.customer_id, valid, issued_by = staff.id())
            } else null
```

Since the refund needs the note's id and number **before** it is written, compute them first: `val noteId = Uuid7.next()`, and the number from the refund's `seq` which `OrderOps.refund` computes inside; simplest: let `OrderOps.refund` accept `note: NoteSpec?` (`data class NoteSpec(val id: String, val amount: Long, val validTo: String?, val customerId: String?)`) and have it build the number from its own `number` (`number.replaceFirst("-R", "-CN")`), write the `CreditNoteEntity` row itself inside its transaction (`db.receipts().upsertNotes(listOf(...))`), and return the refund. Do it that way: one place knows the number. Then `Exchanges.complete` passes `NoteSpec(Uuid7.next(), rest, validTo, ticket.customer_id)` when `rest > 0 && policy == "credit"`, and `settled`/`rest` are computed from `ReturnRules.payState(settings.returns, saleTotal, credit)`: `Pay` → difference required; `Even`; `Note(amount)` → `toNote = amount`; `Back(amount)` → `backTypeId` required; `Short` → `error("Pick something worth at least ${Money.format(credit)}")`.

- [ ] **Step 4: The slip** (`Docs.kt`)

```kotlin
@Serializable
data class CreditNoteDoc(val number: String, val amount: Long, val validTo: String?, val customer: String?, val fromReceipt: String, val time: Long, val cashier: String?)

    // The paper a customer keeps: it is the note.
    fun creditNote(d: CreditNoteDoc, shop: Shop, paper: Paper, decimals: Int, logo: Raster? = null): ByteArray {
        val p = EscPos(paper.columns)
        p.head(shop, logo)
        p.rule()
        p.align(EscPos.Align.Center).bold(true).big(true).line("CREDIT NOTE").big(false)
        p.tall(true).line(d.number).tall(false).bold(false).align(EscPos.Align.Left)
        p.rule()
        p.bold(true).tall(true).row("VALUE", "Rs " + num(d.amount, decimals)).tall(false).bold(false)
        p.row("Valid to", d.validTo?.let { stampDate(it) } ?: "Does not expire")
        d.customer?.takeIf { it.isNotBlank() }?.let { p.row("Customer", it) }
        p.row("From exchange of", d.fromReceipt)
        p.row(stamp(d.time), d.cashier ?: "")
        p.rule()
        p.wrapped("Spend it on any purchase at this shop, in one go or in parts. Keep this slip: it is the note.")
        p.line(); p.barcode(d.number)
        p.end(paper)
        return p.bytes()
    }
```

(`stampDate`: a helper that prints `2027-04-14` as `14 April 2027`; add it beside `stamp`.) Print it from `OrderOps.afterExchange(refund, sale)` after the receipt: look the note up with `db.receipts().noteOfRefund(refund.id)` and print through the same path `docs.print` uses (read `afterExchange` and `Docs.print` for how bytes reach the printer; a `printing.report` on failure).

- [ ] **Step 5: Build; unit tests; commit** `git commit -am "till: an exchange's rest goes on a credit note under that policy, written with the refund and printed as a slip; money back only where the shop refunds; a manager past the window"`.

### Task B6: spending a note on Pay

**Files:**
- Modify: `core/data/TicketRepository.kt` (`pay`), `feature/pay/Pay.kt`

- [ ] **Step 1: `pay` takes the note's balance down**

In the transaction after `insertPayments`:

```kotlin
            // a credit note spent: what this sale took comes off it here; the server's figure returns with the pull
            val noteType = db.receipts().creditNoteType()
            payments.filter { noteType != null && it.paymentTypeId == noteType.id && it.reference != null }.forEach { p ->
                db.receipts().noteByNumber(p.reference!!)?.let { creditNotes.spend(it.id, p.amount) }
            }
```

(Inject `CreditNotes` into `TicketRepository`; beware of a Hilt cycle: `CreditNotes` must not depend on `TicketRepository`; it does not.)

- [ ] **Step 2: `PayUi` and the view model**

Add to `PayUi`: `val note: CreditNoteEntity? = null, val noteAmount: Long = 0, val noteAsk: Boolean = false`. In the methods list, the `credit_note` type is shown only on a shop and only as a tender key "Credit note" that opens a sheet (`noteAsk = true`) asking for the number (typed, or the scanner's next code). On a number: `creditNotes.find(it)` then `creditNotes.refusal(note, today)`; refused → `Toaster.say(reason)`; found → `note = it, noteAmount = ReturnRules.noteCover(it.balance, s.amount)`, and the key reads "Credit note · Rs 170.00 of it". The amount typed may be lowered, never above the cover. `charge()` with a note: the shares are `[PayInput(noteType.id, noteAmount, reference = note.number, label = "Credit note ${note.number}")]` plus the rest by the method picked, as a split by amount is recorded today (`record` with two shares). One note per sale: a second "Credit note" key press replaces the first.

- [ ] **Step 3: The exchange's three states on Pay**

Where `amount`/`back` are computed in `show(s)`, use `ReturnRules.payState(settings.returns, remaining, s.credit)`; add `val shortBy: Long = 0` and `val noteOut: Long = 0` to `PayUi`. The big key: `Short` → disabled, text "Pick something worth at least Rs 590"; `Note` → "Credit note for Rs 270"; `Back` → "Give back Rs 270" (as today); `Pay` → "Charge Rs 270"; `Even` → "Exchange · nothing to pay". The dashed panel's sentence for `Note`: "The goods that come back are worth Rs 270 more than this sale. The rest stays with the customer on a credit note, printed with the receipt." Cash short of the gap: `ui.short` already blocks the key (`ok = ... && !ui.short`); make sure `exchange()` keeps its `got < s.amount` refusal (it does).

Also on `RetailSell.kt` line 254–268: the total row and the Pay key read from `ReturnRules.payState(settings.returns, ui.totals.total, exchange.credit)`: `Short` → `TotalRow("Pick something worth at least", ...)` with the credit and the Pay key off; `Note` → key "Credit note Rs 270"; else as today.

- [ ] **Step 4: A scanned note on Sell opens Pay** (`RetailViewModel.scanned`): before `sales.find(code)`, `creditNotes.find(code)?.let { Scanner.say(true, "Credit note · ${it.number}"); onNote(it.number); return@launch }` with a new callback `onNote: (String) -> Unit` that the shell wires to opening Pay with `noteAsk` answered.

- [ ] **Step 5: Build; commit** `git commit -am "till: a credit note is spent on Pay by its number, typed or scanned, in full or in part; what Pay says of an exchange under each policy"`.

### Task B7: the Receipts sheet: policy, window, swap keys

**Files:**
- Modify: `feature/receipts/ReceiptsScreen.kt`, `ReceiptsViewModel`

- [ ] **Step 1: The Refund key by policy**: the view model exposes `policy: StateFlow<String>` (from `PosSettings.parse(db.ops().settings()).returns`, refreshed with `retail`). In `Detail`: the Refund `OutlinedButton` is drawn only when `policy == "refund"`; under the other two the key is "Exchange" (it opens the same sheet with `exchange = true` forced) and the sheet's title reads "Exchange ${Money.format(amount)}" and hides `TypeGrid` and the "Refund" confirm button.

- [ ] **Step 2: The window line**: under the title, when `retail && ReturnRules.pastWindow(r.device_time, now, returnDays)`: `Text(ReturnRules.windowText(...), color = Pos.Warn)`. The PIN prompt itself comes from `NeedsApproval` thrown by `OrderOps.refund`/`Exchanges.start` (add the same window check to `Exchanges.start`, before `sales.open()`), which the screen already handles.

- [ ] **Step 3: The swap keys**: `RefundLine` gains `itemId: String?, variantId: String?` (fill them in the view model from the receipt's lines → ticket line → item/variant). Under each line with `picks[l.id] > 0` and a product with other variants (`db.retail().variantsOf(itemId)` → `ReturnRules.swaps(variantId, ...)`), a `FlowRow` of small keys labelled by the variant's name; a tap calls `vm.swap(itemId, variantId)` which, if no exchange is started yet, starts it as the Exchange key does and then adds the variant to the sale (`sales.put(item, variant)` as `RetailViewModel.put` does; reuse by moving `put` into `RetailSales` if it is not there). The user is sent to Sell as today.

- [ ] **Step 4: Build; commit** `git commit -am "till: the receipt's sheet follows the return policy, says when the window is past, and swaps a returned line for another variant with one tap"`.

### Task B8: words

**Files:**
- Modify: `feature/sync/RejectedScreen.kt` (`"refund-policy" -> "This shop does not refund. Exchange instead."`, `"refund-window" -> "Past the return window: a manager must approve."`), `feature/settings/SettingsScreen.kt` (`SHOP_HELP`: "An exchange" rewritten for the policy; new "A credit note" and "Spending a credit note" entries), `core/data/CashOps.kt` + `feature/reports/Print.kt` (the two lines "Credit notes issued" / "Credit notes redeemed" from `paidBetween` rows whose type's kind is `credit_note`, and both kinds left out of the by-type list).

- [ ] **Step 1: Make the edits; build; run all unit tests** `.\gradlew.bat :app:testDebugUnitTest` → all pass.
- [ ] **Step 2: Commit** `git commit -am "till: the two refusals in words, Help, and the two credit-note lines on the X and Z reports"`.

---

## Part C: the back office

### Task C1: settings

**Files:**
- Modify: `web/lib/settings.ts`, `web/app/backoffice/settings/page.tsx`

- [ ] **Step 1: `settings.ts`**: in the type `returns: "exchange" | "credit" | "refund"; returnDays: number; noteMonths: number;`, defaults `returns: "exchange", returnDays: 7, noteMonths: 6`, in `withDefaults`:

```ts
    returns: d.returns === "credit" || d.returns === "refund" ? d.returns : "exchange",
    returnDays: typeof d.returnDays === "number" && d.returnDays >= 0 && d.returnDays <= 365 ? Math.round(d.returnDays) : 7,
    noteMonths: typeof d.noteMonths === "number" && d.noteMonths >= 0 && d.noteMonths <= 36 ? Math.round(d.noteMonths) : 6,
```

- [ ] **Step 2: `saveGeneral`**: in the `ctx.mode === "retail"` branch:

```ts
        ? {
            returns: (["exchange", "credit", "refund"] as const).find((v) => v === f.get("returns")) ?? "exchange",
            returnDays: int(f, "returnDays", 0, 365, 7),
            noteMonths: int(f, "noteMonths", 0, 36, 6),
          }
```

- [ ] **Step 3: The card**, after "Closing the day", `{shop && (<Card title="Returns"> ...)}` with three `.setting` rows in the page's own markup: a `.seg` of three radios (`Exchange only` / `Exchange; the rest on a credit note` / `Exchange or refund`) each with a `<small>` sentence of what the till does; a number input `returnDays` ("Inside it a cashier with the right to refund acts alone; after it a manager's PIN. 0: always a manager."); a number input `noteMonths` ("0: a note never expires.").

- [ ] **Step 4: `npm run typecheck` (or `npx tsc --noEmit` in `web`); commit** `git commit -am "back office: a shop's return policy on POS settings"`.

### Task C2: the Credit notes page, nav, receipts, customers

**Files:**
- Create: `web/app/backoffice/credit-notes/page.tsx`
- Modify: `web/app/backoffice/nav.ts`, `web/app/backoffice/receipts/page.tsx`, `web/app/backoffice/customers/[id]/page.tsx` (find the file), `web/app/backoffice/counts/route.ts` (optional count of open notes; skip if the counts file needs more than a query)

- [ ] **Step 1: nav**: in the `finance` group after Receipts: `{ href: "/backoffice/credit-notes", label: "Credit notes", only: "retail", icon: Ticket, words: "return exchange slip balance voucher" }` (import `Ticket` from lucide-react).

- [ ] **Step 2: The page** (pattern: `receipts/page.tsx`; `readTenant` + a query; `act("settings.device", ...)` for void):

```tsx
const PATH = "/backoffice/credit-notes";
async function voidNote(f: FormData) {
  "use server";
  await act("settings.device", PATH, async (c, ctx) => {
    const id = uuid(f, "id"); const reason = text(f, "reason", 3, 200);
    await c.query(`select credit_note_void($1, $2, $3, $4)`, [ctx.tenantId, ctx.employeeId, id, reason]);
    return "The note was cancelled. Its refund stands.";
  });
}
export default async function CreditNotesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams; const ctx = await tenantContext();
  if (ctx.mode !== "retail") notFound();
  const show = one(sp.show) === "closed" ? "closed" : "open"; const q = (one(sp.q) ?? "").trim();
  const rows = await readTenant(ctx, (c) => c.query(
    `select n.id, n.number, n.amount, n.balance, n.valid_to, n.status, n.created_at, n.void_reason,
            r.number as refund_no, cu.name as customer, e.name as issued_by,
            (select count(*) from receipt_payments rp join payment_types pt on pt.id = rp.payment_type_id where rp.tenant_id = n.tenant_id and rp.reference = n.number and pt.kind = 'credit_note') as spends
       from credit_notes n join receipts r on r.id = n.refund_id
       left join customers cu on cu.id = n.customer_id left join employees e on e.id = n.issued_by
      where n.tenant_id = $1 and n.deleted_at is null
        and (case when $2 = 'open' then n.status = 'open' and (n.valid_to is null or n.valid_to >= current_date) else not (n.status = 'open' and (n.valid_to is null or n.valid_to >= current_date)) end)
        and ($3 = '' or n.number ilike '%' || $3 || '%' or cu.name ilike '%' || $3 || '%')
      order by n.created_at desc limit 300`, [ctx.tenantId, show, q]));
  // table: Number, Issued (date · by), From refund, Customer, Amount, Left, Valid to (or "Expired on", "Used", "Cancelled: reason"), Spent on (n sales), Void (a small form with a reason, open only)
}
```

Write the JSX in the page's house style (`PageHead`, `Card`, a `<table>`, `Flash`, a `.seg` of two links Open / Closed, a search box as other pages have).

- [ ] **Step 3: `receipts/page.tsx` `describe`**:

```ts
    case "credit-note-refused": {
      const notes = (Array.isArray(d.notes) ? d.notes : []) as { amount?: number; number?: string; why?: string; valid_to?: string }[];
      return notes.map((n) => `${rs(n.amount)} of it was paid with credit note ${n.number || "(not named)"}, which ${n.why === "not-found" ? "was never issued" : n.why === "void" ? "was cancelled" : n.why === "expired" ? `expired on ${n.valid_to}` : "was already used up"}: that part of the sale is not covered`).join("; ");
    }
    case "credit-overspent": {
      const notes = (Array.isArray(d.notes) ? d.notes : []) as { amount?: number; number?: string; balance?: number; excess?: number }[];
      return notes.map((n) => `credit note ${n.number} had ${rs(n.balance)} left and this sale took ${rs(n.amount)}: ${rs(n.excess)} is not covered (two tills spent it while apart)`).join("; ");
    }
```

Also on a receipt's row, where payments are listed by type name, a payment of kind `credit_note` reads "Credit note CN-… (Rs 270.00)" using `reference`.

- [ ] **Step 4: Customers**: on a customer's page, a small list "Credit notes" (open ones: number, left, valid to) from `credit_notes where customer_id = $1 and status = 'open'`.

- [ ] **Step 5: Typecheck; commit** `git commit -am "back office: Credit notes (open, closed, search, void with a reason), the two review reasons in words, a customer's open notes"`.

### Task C3: the two report lines

**Files:**
- Modify: `web/app/backoffice/reports/day-close/page.tsx` and its loader; the sales summary (`web/app/backoffice/reports/sales/page.tsx`); `web/app/backoffice/page.tsx` (`loadRange`'s "by payment type" if it lists types)

- [ ] **Step 1**: Where "Taken by payment method" is loaded, leave out `pt.kind in ('exchange','credit_note')` from the list and add two sums for the period: `issued = sum(rp.amount) on refunds to kind credit_note`, `redeemed = sum(rp.amount) on sales from kind credit_note`. Draw `<dt>Credit notes issued</dt><dd>{m(issued)}</dd><dt>Credit notes redeemed</dt><dd>{m(redeemed)}</dd>` under the method list when either is non-zero. Same on Sales summary.

- [ ] **Step 2: `shop-pages.test.cjs` section Y**: a shop set to `credit`, an exchange that issues a note and a sale that spends part of it (through `sync_push`, as section X does), then: the Credit notes page opens and lists the note with its balance; the Receipts page names the note on both receipts; Day closing's text has "Credit notes issued" and "redeemed" with the figures and no "Credit note" line among the methods; the settings page shows the Returns card for a shop and not for a restaurant; a flagged overspent sale reads its sentence.

- [ ] **Step 3: Run** `node db/tests/shop-pages.test.cjs` → PASS. **Commit** `git commit -am "back office: credit notes issued and redeemed on Day closing and Sales summary, the two kinds out of the methods; shop-pages section Y"`.

---

## Part D: run it, record it

### Task D1: on the test emulator

- [ ] Say to the user you are starting the emulator `easypay_claude_test` with its window (the memory rule), then install the debug build over the made-up shop (`DEMO_SHOP`), confirm the database went 25 → 26 with no fault, and run: (1) policy `exchange`: an exchange worth less shows "Pick something worth at least"; (2) policy `credit`: the same exchange prints a slip, the note is on Receipts beside the refund; (3) the note spent in part on a sale by typing its number, then the rest with cash beside it; (4) a note from "another tablet" fed by `DEMO_PULL`; (5) the window: a receipt back-dated 9 days (edit `device_time` through `read-till-state`/`adb` or wait: use `settings.returnDays = 0` to force the PIN). Record what was seen and not in the spec's last section ("What was run").
- [ ] Extend `db/tests/fixtures/demo-till-exchange.json` with the night's operations read by `db/scripts/read-till-state.cjs` and run `node db/tests/retail-till-replay.test.cjs` → the note's balance on the server equals the tablet's.
- [ ] Through the stand-in printer (`10.0.2.2:9100`; see the emulator memory note on how papers are read), read the slip and a receipt that spent a note.
- [ ] Commit the spec's record; raise the till version in the usual place only when the user says to.

---

## Self-review (done while writing)

- Spec coverage: §3 settings → A2, B1, C1; §4 receipt/window/swaps → A3, B5 (window), B7; §5 Pay states and cash short → B6; §6 books (types, table, issuing, redeeming, expiry, void, reports) → A1, A3, A4, B5, B8, C3; §7 spending on the till, scanned, "not found", receipt wording → B6; §8 back office → C2, C3; §9 testing → A6, B2, C3 step 2, D1; §11 not built → nothing planned for them.
- Placeholders: the migration tasks say "dump and edit" with the exact inserted SQL, which is this repo's own way (0108); the page's JSX and the Compose keys are described by their pieces with the house pattern named, because their exact code depends on helpers (`Card`, `TypeGrid`, `FlowRow`) the executor reads at the spot.
- Names used consistently: `credit_note` (kind), `credit_notes` (table/entity/DAO), `CreditNotes` (Kotlin module), `ReturnRules.payState`, keys `returns`/`returnDays`/`noteMonths`, reasons `refund-policy`/`refund-window`/`credit-note-refused`/`credit-overspent`, number `STORE-TILL-CN000012` (from the refund `STORE-TILL-R000012`); the spec's `CN-<till>-<n>` is this, said precisely.
