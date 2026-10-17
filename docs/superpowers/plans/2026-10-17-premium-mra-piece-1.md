# Premium MRA, piece 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client can be put on Premium MRA from `/admin` (state `setting_up`), the checklist says what the move still needs, the owner fills the MRA details in the back office, and the first rules for MRA clients hold. Nothing is sent to the MRA.

**Architecture:** Migration 0116 adds the MRA columns, a trigger tying `mra` to the premium plan, a trigger refusing payment corrections on a live MRA client, `mra_checklist`, and three `platform.*` functions in the pattern of `set_tenant_plan` (admin check, `app.tenant_id`, settings the tills pull, audit). The back office reads `mra` in `tenantContext` and shows the MRA fields only when it is not `off`. `/admin` gets a "Premium MRA" choice and an MRA panel. Spec: `docs/superpowers/specs/2026-10-17-premium-mra-design.md`.

**Tech Stack:** Postgres (Neon dev branch), plpgsql; Next.js server components and actions; node test scripts.

---

## Files

- Create `db/migrations/0116_premium_mra.sql`: columns, checks, triggers, `mra_checklist`, `platform.mra_checklist`, `platform.set_tenant_mra`, `platform.set_till_mra_id`.
- Create `db/tests/mra-setup.test.cjs`: one transaction, rolled back.
- Modify `db/scripts/delete-client.cjs`: refuse a client with `mra_live_since`.
- Create `web/lib/mra.ts` and `web/lib/mra.test.mjs`: states, codes, the code suggested for a tax, the checklist in words.
- Modify `web/lib/tenant.ts`: `mra` in `TenantContext` (both queries).
- Modify `web/app/backoffice/company/page.tsx`: legal name, TAN, what the business sells, branch addresses, the checklist.
- Modify `web/app/backoffice/taxes/page.tsx`: MRA code per tax.
- Modify `web/app/backoffice/categories/page.tsx` and `table.tsx`: goods or services per category.
- Modify `web/lib/platform.ts`: messages, plan help.
- Create `web/app/admin/tenants/[id]/mra.tsx`: the MRA panel.
- Modify `web/app/admin/tenants/[id]/page.tsx` and `view.tsx`: the Premium MRA choice, the panel, its actions, audit words.

### Task 1: Migration 0116 and its test

- [ ] **Step 1: Write the failing test** `db/tests/mra-setup.test.cjs` in the pattern of `premium-gate.test.cjs` (one transaction, savepoints, a push as `app_user`), with these checks:
  - M1 a new tenant is `mra = 'off'`; `mra` refuses `'other'`; `taxes.mra_code` refuses `'TC09'`; `categories.mra_nature` refuses `'food'`.
  - M2 `set_tenant_mra(setting_up)` on an offline client is refused with `mra-needs-premium`; on a premium one it is taken, the settings carry `mra: setting_up`, the audit has `tenant.mra` from off to setting_up.
  - M3 a premium MRA client moved to plan offline is refused with `mra-needs-premium`; `set_tenant_mra('live')` and `('x')` are refused with `bad-mra-state`.
  - M4 `mra_checklist` on a bare premium client: every line false, the missing names given (company: legal name, TAN, BRN; the branch without an address; the taxes without a code; the items without a tax; the till without an ID); filled in, every line true.
  - M5 `set_till_mra_id`: taken, audited as `till.mra_id`; the same ID on a second till of the client refused with `mra-id-taken`; `'a b'` refused with `bad-mra-id`; empty clears it.
  - M6 a payment correction pushed for a sale of a client at `mra = 'live'` is rejected and nothing is written; at `mra = 'off'` it is applied.
- [ ] **Step 2: Run it** `node db/tests/mra-setup.test.cjs`. Expected: fails at M1 (column `mra` does not exist).
- [ ] **Step 3: Write `db/migrations/0116_premium_mra.sql`** (full text in the file; parts):

```sql
alter table tenants add column if not exists legal_name text;
alter table tenants add column if not exists tan text;
alter table tenants add column if not exists mra text not null default 'off';
alter table tenants add column if not exists mra_nature text;
alter table tenants add column if not exists mra_live_since timestamptz;
alter table tenants add constraint tenants_mra_check check (mra in ('off', 'setting_up', 'training', 'live'));
alter table tenants add constraint tenants_mra_nature_check check (mra_nature in ('goods', 'services'));
alter table taxes add column if not exists mra_code text;
alter table taxes add constraint taxes_mra_code_check check (mra_code in ('TC01', 'TC02', 'TC03', 'TC04', 'TC05', 'TC06'));
alter table categories add column if not exists mra_nature text;
alter table categories add constraint categories_mra_nature_check check (mra_nature in ('goods', 'services'));
alter table pos_devices add column if not exists mra_ebs_id text;
create unique index if not exists pos_devices_mra_ebs_id on pos_devices (tenant_id, mra_ebs_id) where mra_ebs_id is not null;

create or replace function tenants_mra_needs_premium() returns trigger
language plpgsql as $fn$
begin
  if new.mra <> 'off' and lower(btrim(coalesce(new.plan, ''))) <> 'premium' then raise exception 'mra-needs-premium'; end if;
  return new;
end $fn$;
create trigger trg_mra_needs_premium before insert or update of plan, mra on tenants
  for each row execute function tenants_mra_needs_premium();

create or replace function payment_corrections_mra() returns trigger
language plpgsql set search_path = public as $fn$
begin
  if exists (select 1 from tenants where id = new.tenant_id and mra = 'live') then raise exception 'mra-no-correction'; end if;
  return new;
end $fn$;
create trigger trg_payment_corrections_mra before insert on payment_corrections
  for each row execute function payment_corrections_mra();
```

  plus `mra_checklist(p_tenant)` returning a JSON array of `{key, ok, missing?, count?}` for `company`, `nature`, `addresses`, `taxes`, `items`, `tills`; `platform.mra_checklist(p_admin, p_tenant)` (admin check, `app.tenant_id`, then the public one); `platform.set_tenant_mra(p_admin, p_tenant, p_state)` accepting `off` and `setting_up` only; `platform.set_till_mra_id(p_admin, p_device, p_id)`.
- [ ] **Step 4: Apply to dev and run** `node db/migrate.cjs`, then `node db/tests/mra-setup.test.cjs`. Expected: every line PASS.
- [ ] **Step 5: Run the neighbours** `premium-gate`, `setting-up`, `backoffice-plan`, `pos-operations`, `platform`. Expected: PASS as before.
- [ ] **Step 6: Commit** the migration and the test.

### Task 2: `delete-client.cjs` keeps a client that went live on MRA

- [ ] In `remove()`, after `clientOf`, ask `select mra_live_since from tenants where id = $1`; when set, throw `this client went live with the MRA: its sales were sent to the MRA and are kept for good`.
- [ ] Check by reading: the rehearsal path throws before anything is deleted (the throw is inside the transaction's `try`, which rolls back). Commit with Task 1 or alone.

### Task 3: `web/lib/mra.ts` and its test

- [ ] **Step 1:** `web/lib/mra.test.mjs`: `asMra` (unknown → `off`), `MRA_CODES` has TC01 to TC06, `suggestCode` (1500 → TC01; 0 named "Exempt" → TC03; 0 → TC02; 1000 → null), `checklistWords` gives a title and a detail for each key and says what is missing.
- [ ] **Step 2:** run `node web/lib/mra.test.mjs`; expected: fails (module not found).
- [ ] **Step 3:** write `web/lib/mra.ts`.
- [ ] **Step 4:** run it; expected: PASS. Commit.

### Task 4: Back office

- [ ] `lib/tenant.ts`: `mra: MraState` in `TenantContext`, `t.mra` in both selects, `asMra(row.mra)`.
- [ ] Company page: when `ctx.mra !== "off"`: Legal name, TAN, "What you sell" (goods / services), and with more than one branch a Branches card (an address per branch, `stores.address`); with one branch the company address is written to that branch too. The checklist (`mra_checklist`) in words above the form.
- [ ] Taxes page: when MRA, a column "MRA code" (select of `MRA_CODES`, default the saved code or `suggestCode`), saved by `saveTax`.
- [ ] Categories: when MRA, "Goods or services" in the open row (`As the business` = null), saved by `saveCategory`.
- [ ] `db/scripts/prepare-web-sql.cjs` on the three pages; `npx tsc --noEmit -p web`. Commit.

### Task 5: `/admin`

- [ ] `lib/platform.ts`: messages `mra-needs-premium`, `bad-mra-state`, `bad-mra-id`, `mra-id-taken`, `mra-no-correction`; a sentence on Premium MRA in `PLAN_HELP`.
- [ ] `page.tsx`: tenant query adds `mra`; tills query adds `mra_ebs_id`; `platform.mra_checklist`; `setPlan` handles `premium_mra` (plan premium, then MRA setting_up) and refuses moving off Premium MRA through the list; `setMra` (off) and `setTillMraIds`.
- [ ] `view.tsx`: the list offers Premium MRA; the lede and a badge say it; the MRA panel when `mra` is not `off`; audit words for `tenant.mra` and `till.mra_id`.
- [ ] `mra.tsx`: state, the checklist with ticks, one EBS MRA ID field per till in use, Turn MRA off (confirm).
- [ ] tsc; the panel drawn on a temporary preview page with sample rows and seen in the browser; the page removed. Commit.

### Task 6: Finish

- [ ] Run every suite touched and the web unit tests; tsc; review the diff; commit; record what was run at the end of this plan.
