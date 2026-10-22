# The back office's MRA page (MRA phase 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A client on MRA sees in its back office whether each till is connected to the MRA, and every invoice its tills sent, with the MRA's answer.

**Architecture:** One read-only page, `/backoffice/mra`, and its CSV, drawn from what is already on the server: `pos_devices.mra_status` (each till's report) and `mra_records` (every invoice, migration 0132). The queries, words and rules live in a pure file, `web/lib/mra-page.ts`, tested by Node, and the queries are run against dev on a probe client in a transaction that is rolled back. The menu gains a line that only an MRA client has. No migration, no till change, no API change.

**Tech Stack:** Next.js (App Router, server components) in `web/`, Postgres on Neon (dev), Node's own TypeScript for `web/lib/*.test.mjs`, `db/tests/*.test.cjs` against dev with `db/tests/page.cjs` to draw the page without a sign-in.

**Built 2026-10-22** on `restopos` (`ed40e50a`..`c090b7c0`), with the four suggested choices, which the owner took. Seen: the page drawn from MRA Pilot's real invoices on dev in both looks, and the CSV route run read-only. Not seen: the menu line in a browser, the page behind a real sign-in.

---

## For the owner: what you will see

A new line in the back office menu, **MRA e-invoicing**, only for a client on Premium MRA (setting up, training or
live). Nothing on the page can change what was sent; it only shows.

1. **Needs attention**, at the top, only when something is wrong: a till whose MRA login was refused, a till not
   signed in, a till whose invoices have waited more than 2 hours, a till with invoices sent twice and never
   answered, or a live client's till the MRA still counts as TEST.
2. **Tills**, by branch. Each till says:
   - connected or not, and since when it is signed in until;
   - how many invoices wait, and when the MRA last fiscalised one;
   - how many the MRA refused;
   - whether it has its EBS MRA ID yet.

   The back office only knows what a till said at its last sync, so each till says when that was.
3. **Invoices sent to the MRA**, newest first, 200 on the page:
   - date, branch, till, number, type (sale, credit note, debit note, pro forma, training), amount and status;
   - a click on the status opens the MRA's answer: the IRN and the QR code, or the reason it refused;
   - filters by branch, till, type, status and dates, and **Download CSV** for all of them.

### Your choices (my suggestion first; say if you want another)

| | Suggested | Other way |
|---|---|---|
| A. Where in the menu | Finance, under Receipts | Admin, under Company details |
| B. Who may see it | Anyone whose role may see reports (the same as Sales summary) | The owner only |
| C. A till's sign-in | "Signed in until 23 Oct, 13:18", with "as of its sync at 21:24" (the till sends when its sign-in ends, not when it began) | — |
| D. Credit notes | Shown with a minus (−57.50) on the page and in the CSV, though the MRA holds them as positive | Shown as the MRA holds them (57.50) |

**What it is not:** no "send again" from the back office (that stays on the till, which holds the invoice), no
number in the menu, nothing on the tablet.

**Done when:** the page and the CSV are drawn for MRA Pilot's real invoices on dev, read-only, with screenshots in
the light and the dark look; every test below passes; and, if you can sign in to MRA Pilot's back office on
`localhost:3000`, you see the same there.

---

## Facts this plan rests on (checked on dev, 2026-10-22)

- `mra_records.qr` is the MRA's own QR picture, a base64 PNG (starts `iVBORw0KGgo`, about 750 characters). The page
  shows it as `<img src="data:image/png;base64,…">`; nothing is generated.
- `app_user`, the role every back office page runs as, may read `mra_records` (0003's default privileges).
- `pos_devices.mra_status` holds `at`, `connected`, `until`, `refused`, `problem`, `check`, `refused_invoices`,
  `waiting`, `counter`, `last_fiscalised` and, from 0.9.24, `environment`. It has no time of sign-in.
- A credit note's `totalAmtPaid` is positive in what was sent (MP-T1-R000027: "57.50").
- Clear test activity deletes `pos_devices` rows; the invoices stay. The list joins tills and branches with
  `left join` and still shows such an invoice.
- Statuses: `waiting`, `unsure` (sent, no answer), `check` (sent twice, no answer), `fiscalised`, `refused`.
  Types: `STD`, `CRN`, `DRN`, `PRF`, `TRN`.

## Files

| File | What it does |
|---|---|
| Create `web/lib/mra-page.ts` | Pure: the words for types and statuses, the filters read from the address, the "needs attention" rule, the signed amount, a CSV line, the two SQL questions and their parameters |
| Create `web/lib/mra-page.test.mjs` | Node tests of the above (CI runs every `web/lib/*.test.mjs`) |
| Create `web/app/backoffice/mra/page.tsx` | The page |
| Create `web/app/backoffice/mra/export/route.ts` | The CSV, the same question with the same filters |
| Modify `web/app/backoffice/nav.ts` | A link may be `mra: true`; `groupsFor`, `sectionsFor`, `over`, `groupOf`, `pagesOf` take `mra` (default `false`) |
| Modify `web/app/backoffice/side.tsx`, `web/app/backoffice/search-box.tsx`, `web/app/backoffice/layout.tsx` | Pass whether the client is on MRA down to the menu and the search |
| Modify `web/lib/nav.test.mjs` | The line is there for an MRA client only |
| Create `db/tests/mra-page.test.cjs` | The questions on dev for a probe client (rolled back): tills, invoices, filters, a till that is gone, another client's invoices unseen; the page drawn with `page.cjs` (CI runs every `db/tests/*.test.cjs`) |

---

### Task 1: The words and rules (`web/lib/mra-page.ts`)

**Files:**
- Create: `web/lib/mra-page.ts`
- Test: `web/lib/mra-page.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// mra-page.test.mjs — what the back office's MRA page says (web/lib/mra-page.ts).
// Usage: node web/lib/mra-page.test.mjs   (Node runs the .ts file itself)
import assert from "node:assert/strict";
import { attention, csvLine, mraFilters, mraQuery, MRA_TYPES, reasons, signedCents, statusWords, WAITING_HOURS } from "./mra-page.ts";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("PASS " + name);
  } catch (e) {
    failures += 1;
    console.log("FAIL " + name + " " + (e && e.message ? e.message.split("\n")[0] : e));
  }
}

const ID = "3b774aab-4c3f-43cf-83ed-47ef5f4c6639";
const from = (o) => (k) => o[k] ?? "";

check("M1 the filters keep only what they should", () => {
  assert.deepEqual(mraFilters(from({ store: ID, till: "nope", type: "CRN", status: "waiting", from: "2026-10-22", to: "22/10/2026" })),
    { store: ID, till: null, type: "CRN", status: "waiting", from: "2026-10-22", to: null });
  assert.deepEqual(mraFilters(from({ type: "XYZ", status: "unsure" })), { store: null, till: null, type: null, status: null, from: null, to: null });
  assert.equal(mraFilters(from({ from: "2026-02-31" })).from, null);
  assert.equal(mraFilters(from({ from: "2026-13-45" })).from, null);
});

check("M1 the filters back as the end of an address", () => {
  assert.equal(mraQuery({ store: null, till: null, type: "STD", status: null, from: "2026-10-01", to: null }), "?type=STD&from=2026-10-01");
  assert.equal(mraQuery({ store: null, till: null, type: null, status: null, from: null, to: null }), "");
});

check("M2 every type and status has its words", () => {
  assert.equal(MRA_TYPES.CRN, "Credit note");
  assert.equal(MRA_TYPES.TRN, "Training");
  assert.equal(statusWords("fiscalised"), "Fiscalised");
  assert.equal(statusWords("unsure"), "Sent, no answer yet");
  assert.equal(statusWords("check"), "Sent twice, no answer: check it on the till");
  assert.equal(statusWords("something new"), "something new");
});

check("M3 a credit note reads with a minus; the others as sent", () => {
  assert.equal(signedCents("CRN", "57.50"), -5750);
  assert.equal(signedCents("STD", "480.00"), 48000);
  assert.equal(signedCents("STD", "0.1"), 10);
  assert.equal(signedCents("STD", null), null);
  assert.equal(signedCents("STD", "abc"), null);
});

check("M4 the MRA's reasons, one line", () => {
  assert.equal(reasons(["ERR0500: TAN of registered user does not match", "ERR0600: Invalid seller BRN"]), "ERR0500: TAN of registered user does not match; ERR0600: Invalid seller BRN");
  assert.equal(reasons([]), "");
  assert.equal(reasons(null), "");
});

const now = new Date("2026-10-22T18:00:00Z");
const fine = { connected: true, refusedLogin: null, waiting: 0, oldestWaiting: null, check: 0, countedAsTest: false };

check("M5 a till that is fine needs nothing", () => {
  assert.deepEqual(attention(fine, now), []);
  assert.deepEqual(attention({ ...fine, waiting: 3, oldestWaiting: new Date(now.getTime() - 60 * 60_000) }, now), []);
});

check("M5 what makes a till need attention, in words", () => {
  assert.deepEqual(attention({ ...fine, connected: false, refusedLogin: "Wrong password" }, now), ["The MRA refused its login: Wrong password"]);
  assert.deepEqual(attention({ ...fine, connected: false }, now), ["Not signed in to the MRA"]);
  assert.deepEqual(attention({ ...fine, countedAsTest: true }, now), ["The MRA counts its sales as TEST"]);
  assert.deepEqual(attention({ ...fine, check: 2 }, now), ["2 sent twice with no answer: check them on the till"]);
  assert.deepEqual(attention({ ...fine, waiting: 4, oldestWaiting: new Date(now.getTime() - (WAITING_HOURS * 60 + 1) * 60_000) }, now),
    [`4 waiting for more than ${WAITING_HOURS} hours`]);
});

check("M6 a CSV line quotes what needs it", () => {
  assert.equal(csvLine(["2026-10-22 21:30", "Main store", "Till 1", "MP-T1-R000027", "Credit note", "-57.50", "Fiscalised", 'He said "no", then yes', ""]),
    '2026-10-22 21:30,Main store,Till 1,MP-T1-R000027,Credit note,-57.50,Fiscalised,"He said ""no"", then yes",');
  assert.equal(csvLine([null, undefined, "a;b"]), ',,"a;b"');
});

if (failures) {
  console.log(failures + " failed");
  process.exit(1);
}
console.log("all passed");
```

- [ ] **Step 2: Run it to see it fail**

Run: `node web/lib/mra-page.test.mjs`
Expected: it stops at the import with `ERR_MODULE_NOT_FOUND` (`mra-page.ts` does not exist yet).

- [ ] **Step 3: Write `web/lib/mra-page.ts`**

```ts
// The back office's MRA page (phase 3 of docs/superpowers/plans/2026-10-21-mra-e-invoicing-plan.md):
// each till's connection to the MRA, and every invoice the tills sent, with
// the MRA's answer. The page and its CSV ask the same question, so the file
// holds what the page showed. Read-only: nothing here changes what was sent.
// Pure, with no imports, so `node web/lib/mra-page.test.mjs` can ask it.

export const MRA_TYPES = { STD: "Sale", CRN: "Credit note", DRN: "Debit note", PRF: "Pro forma", TRN: "Training" } as const;
export type MraType = keyof typeof MRA_TYPES;

const STATUS_WORDS: Record<string, string> = {
  fiscalised: "Fiscalised",
  waiting: "Waiting to send",
  unsure: "Sent, no answer yet",
  check: "Sent twice, no answer: check it on the till",
  refused: "Refused",
};
export const statusWords = (s: string) => STATUS_WORDS[s] ?? s;

// What the status filter offers: waiting covers the three that have no answer yet.
export const STATUS_FILTERS = { fiscalised: "Fiscalised", waiting: "Waiting for an answer", refused: "Refused" } as const;
export type StatusFilter = keyof typeof STATUS_FILTERS;

export type MraFilters = { store: string | null; till: string | null; type: MraType | null; status: StatusFilter | null; from: string | null; to: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isDay = (v: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(v + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

// What the address asks for, with anything that is not what it should be left out.
export function mraFilters(get: (k: string) => string): MraFilters {
  const id = (k: string) => (UUID.test(get(k)) ? get(k) : null);
  const day = (k: string) => (isDay(get(k)) ? get(k) : null);
  const type = get("type");
  const status = get("status");
  return {
    store: id("store"),
    till: id("till"),
    type: Object.hasOwn(MRA_TYPES, type) ? (type as MraType) : null,
    status: Object.hasOwn(STATUS_FILTERS, status) ? (status as StatusFilter) : null,
    from: day("from"),
    to: day("to"),
  };
}

// The same filters, as the end of an address.
export function mraQuery(f: MraFilters): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? "?" + s : "";
}

// A credit note gives money back, so it reads with a minus, though the MRA
// holds it as a positive figure. Cents, or null when there is no figure.
export function signedCents(type: string, paid: string | null): number | null {
  if (paid === null || paid === "") return null;
  const n = Number(paid);
  if (!Number.isFinite(n)) return null;
  const cents = Math.round(n * 100);
  return type === "CRN" ? -Math.abs(cents) : cents;
}

// The MRA's reasons for a refusal, or its warnings, as one line.
export const reasons = (list: unknown): string => (Array.isArray(list) ? list.map(String).join("; ") : "");

// A till's invoices waiting longer than this are a worry.
export const WAITING_HOURS = 2;

export type TillAttention = {
  connected: boolean;
  refusedLogin: string | null;
  waiting: number;
  oldestWaiting: Date | null;
  check: number;
  countedAsTest: boolean;
};

// Why a till is at the top of the page; none when it is fine.
export function attention(t: TillAttention, now: Date): string[] {
  const out: string[] = [];
  if (t.refusedLogin) out.push(`The MRA refused its login: ${t.refusedLogin}`);
  else if (!t.connected) out.push("Not signed in to the MRA");
  if (t.countedAsTest) out.push("The MRA counts its sales as TEST");
  if (t.check > 0) out.push(`${t.check} sent twice with no answer: check them on the till`);
  if (t.waiting > 0 && t.oldestWaiting && now.getTime() - t.oldestWaiting.getTime() > WAITING_HOURS * 3_600_000) {
    out.push(`${t.waiting} waiting for more than ${WAITING_HOURS} hours`);
  }
  return out;
}

// One line of the CSV: a cell with a comma, semicolon, quote or line break is quoted.
export function csvLine(cells: unknown[]): string {
  return cells
    .map((v) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    })
    .join(",");
}

export type MraTillRow = {
  id: string; name: string; code: string; store_id: string; store: string; tz: string; ebs: string | null;
  status: Record<string, unknown> | null; waiting: number; oldest_waiting: string | null; to_check: number;
  last_fiscalised: string | null; refused: number;
};

// $1 tenant. Every till of the business, by branch, with what its invoices say.
export const TILLS_SQL = `
  select d.id, d.name, d.code, s.id as store_id, s.name as store, s.timezone as tz, d.mra_ebs_id as ebs, d.mra_status as status,
         coalesce(w.waiting, 0) as waiting, w.oldest_waiting, coalesce(w.to_check, 0) as to_check,
         w.last_fiscalised, coalesce(w.refused, 0) as refused
    from pos_devices d
    join stores s on s.tenant_id = d.tenant_id and s.id = d.store_id
    left join lateral (
      select count(*) filter (where m.status in ('waiting', 'unsure', 'check'))::int as waiting,
             min(m.issued_at) filter (where m.status in ('waiting', 'unsure', 'check')) as oldest_waiting,
             count(*) filter (where m.status = 'check')::int as to_check,
             max(m.answered_at) filter (where m.status = 'fiscalised') as last_fiscalised,
             count(*) filter (where m.status = 'refused')::int as refused
        from mra_records m
       where m.tenant_id = d.tenant_id and m.device_id = d.id and m.deleted_at is null
    ) w on true
   where d.tenant_id = $1 and d.deleted_at is null
   order by lower(s.name), lower(d.name), d.code`;

export type MraInvoiceRow = {
  id: string; at: string; type: string; identifier: string; ref: string | null; status: string; paid: string | null;
  errors: unknown; warnings: unknown; irn: string | null; qr: string | null; differs: unknown;
  store: string; tz: string; till: string; till_code: string | null;
};

// $1 tenant, $2 branch, $3 till, $4 type, $5 status (fiscalised, waiting, refused), $6 from, $7 to (days in
// the branch's time zone), $8 how many, $9 with the QR picture (the CSV leaves it out). An invoice whose till or
// branch was removed is still listed.
export const INVOICES_SQL = `
  select m.id, m.issued_at as at, m.doc_type as type, m.identifier, m.ref_identifier as ref, m.status,
         (m.invoice::jsonb)->>'totalAmtPaid' as paid, m.errors, m.warnings, m.irn,
         case when $9::boolean then m.qr end as qr, m.differs,
         coalesce(s.name, 'A branch no longer there') as store, coalesce(s.timezone, 'Indian/Mauritius') as tz,
         coalesce(d.name, 'A till no longer set up') as till, d.code as till_code
    from mra_records m
    left join stores s on s.tenant_id = m.tenant_id and s.id = m.store_id
    left join pos_devices d on d.tenant_id = m.tenant_id and d.id = m.device_id
   where m.tenant_id = $1 and m.deleted_at is null
     and ($2::uuid is null or m.store_id = $2::uuid)
     and ($3::uuid is null or m.device_id = $3::uuid)
     and ($4::text is null or m.doc_type = $4::text)
     and ($5::text is null or (case when m.status in ('unsure', 'check') then 'waiting' else m.status end) = $5::text)
     and ($6::date is null or (m.issued_at at time zone coalesce(s.timezone, 'Indian/Mauritius'))::date >= $6::date)
     and ($7::date is null or (m.issued_at at time zone coalesce(s.timezone, 'Indian/Mauritius'))::date <= $7::date)
   order by m.issued_at desc, m.counter desc
   limit $8`;

export const invoiceParams = (tenantId: string, f: MraFilters, limit: number, withQr: boolean) =>
  [tenantId, f.store, f.till, f.type, f.status, f.from, f.to, limit, withQr];
```

- [ ] **Step 4: Run the test**

Run: `node web/lib/mra-page.test.mjs`
Expected: every line `PASS`, then `all passed`.

- [ ] **Step 5: Commit**

```bash
git add web/lib/mra-page.ts web/lib/mra-page.test.mjs
git commit -m "back office: the MRA page's words, filters and questions (MRA phase 3)"
```

---

### Task 2: The questions on dev (`db/tests/mra-page.test.cjs`, part 1)

**Files:**
- Create: `db/tests/mra-page.test.cjs`

The probe client is made the way `db/tests/mra-till.test.cjs` makes one, inside one transaction that is rolled back
at the end, so dev keeps nothing.

- [ ] **Step 1: Write the test**

```js
// mra-page.test.cjs — the back office's MRA page (web/lib/mra-page.ts, web/app/backoffice/mra):
// its two questions asked as the business's own connection, for a probe client on dev whose
// invoices are written the way the server keeps them (mra_records, 0132), then the page itself
// drawn with no sign-in (page.cjs). Everything is rolled back.
// Usage: node db/tests/mra-page.test.cjs
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const devguard = require('./require-dev.cjs');

let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? ' ' + extra : ''));
  if (!cond) failures++;
}

// the page's questions and words, compiled from the TypeScript they live in
function loadPage() {
  const web = path.join(__dirname, '..', '..', 'web');
  const ts = require(path.join(web, 'node_modules', 'typescript'));
  const js = ts.transpileModule(fs.readFileSync(path.join(web, 'lib', 'mra-page.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', js)(require, mod, mod.exports);
  return mod.exports;
}

(async () => {
  const p = loadPage();
  const c = new Client({ connectionString: devguard.envMap().DATABASE_URL_UNPOOLED, ssl: { require: true } });
  await c.connect();
  await c.query('BEGIN');
  const one = async (sql, params) => (await c.query(sql, params)).rows[0];
  const as = (t) => c.query(`select set_config('app.tenant_id', $1, true)`, [t]);
  // a question as the business's own connection, as every back office page asks it
  async function read(tenant, sql, params) {
    await c.query('SAVEPOINT r');
    try {
      await c.query('SET LOCAL ROLE app_user');
      await as(tenant);
      const rows = (await c.query(sql, params)).rows;
      await c.query('RELEASE SAVEPOINT r');
      return rows;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT r');
      throw e;
    } finally {
      await c.query('SET LOCAL ROLE none');
    }
  }
  try {
    const admin = crypto.randomUUID();
    await c.query(`insert into platform.admins (auth_user_id, email) values ($1, 'admin-mra-page@example.com')`, [admin]);
    const make = async (name, code) =>
      (await one(`select platform.create_tenant($1,$2,'Main',$3,'Owner',$4,'premium') as r`, [admin, name, code, crypto.randomUUID()])).r;
    const t = (await make('MRA Page', 'MRP1')).tenant_id;
    const other = (await make('MRA Page Other', 'MRP2')).tenant_id;
    await as(t);
    const store = (await one(`select id from stores where tenant_id = $1`, [t])).id;
    await c.query(`update stores set timezone = 'Indian/Mauritius' where id = $1`, [store]);
    const till = async (tenant, st, name, code) => (await one(`insert into pos_devices (tenant_id, store_id, name, code) values ($1, $2, $3, $4) returning id`, [tenant, st, name, code])).id;
    const tA = await till(t, store, 'Till A', 'TA');
    const tB = await till(t, store, 'Till B', 'TB');
    const gone = crypto.randomUUID(); // a till that was removed: its invoices stay
    await c.query(`update pos_devices set mra_ebs_id = 'EBS-A', mra_status = $2::jsonb where id = $1`,
      [tA, JSON.stringify({ at: '2026-10-22T17:24:00Z', connected: true, until: '2026-10-23T09:18:00Z', refused: null, check: 0, environment: 'TEST' })]);
    await c.query(`update pos_devices set mra_status = $2::jsonb where id = $1`, [tB, JSON.stringify({ at: '2026-10-22T17:00:00Z', connected: false, refused: 'Wrong password' })]);

    let n = 0;
    const rec = async (tenant, st, dev, type, ident, status, issued, paid, more = {}) => {
      n += 1;
      await as(tenant);
      await c.query(
        `insert into mra_records (id, tenant_id, store_id, device_id, ebs_id, doc_type, counter, identifier, ref_identifier, previous_hash, invoice, issued_at, status, irn, qr, errors, answered_at)
         values ($1,$2,$3,$4,'EBS-A',$5,$6,$7,$8,'h',$9,$10,$11,$12,$13,$14::jsonb,$15)`,
        [crypto.randomUUID(), tenant, st, dev, type, n, ident, more.ref ?? null, JSON.stringify({ totalAmtPaid: paid }), issued, status,
          status === 'fiscalised' ? 'IRN-' + ident : null, status === 'fiscalised' ? 'iVBORw0KGgoAAAA' : null,
          JSON.stringify(more.errors ?? []), status === 'waiting' ? null : issued],
      );
    };
    await rec(t, store, tA, 'STD', 'MRP1-TA-000001', 'fiscalised', '2026-10-21T08:00:00Z', '480.00');
    await rec(t, store, tA, 'CRN', 'MRP1-TA-R000002', 'fiscalised', '2026-10-21T09:00:00Z', '57.50', { ref: 'MRP1-TA-000001' });
    // 21:30 UTC on the 21st is 01:30 on the 22nd in Mauritius
    await rec(t, store, tA, 'STD', 'MRP1-TA-000003', 'refused', '2026-10-21T21:30:00Z', '100.00', { errors: ['ERR0600: Invalid seller BRN'] });
    await rec(t, store, tA, 'STD', 'MRP1-TA-000004', 'waiting', '2026-10-22T10:00:00Z', '140.00');
    await rec(t, store, tA, 'STD', 'MRP1-TA-000005', 'check', '2026-10-22T11:00:00Z', '140.00');
    await rec(t, store, tB, 'TRN', 'TRN00000006', 'fiscalised', '2026-10-20T08:00:00Z', '115.00');
    await rec(t, store, gone, 'PRF', 'MRP1-TX-PRF000007', 'fiscalised', '2026-10-19T08:00:00Z', '270.00');
    await as(other);
    const otherStore = (await one(`select id from stores where tenant_id = $1`, [other])).id;
    const otherTill = await till(other, otherStore, 'Their till', 'T1');
    await rec(other, otherStore, otherTill, 'STD', 'OTHER-000001', 'fiscalised', '2026-10-22T08:00:00Z', '10.00');

    const none = { store: null, till: null, type: null, status: null, from: null, to: null };
    const list = (f, withQr = true) => read(t, p.INVOICES_SQL, p.invoiceParams(t, { ...none, ...f }, 500, withQr));
    const ids = (rows) => rows.map((r) => r.identifier);

    // P1 the tills
    const tills = await read(t, p.TILLS_SQL, [t]);
    check('P1 both tills, in order', tills.map((r) => r.code).join(',') === 'TA,TB', tills.map((r) => r.code).join(','));
    const a = tills.find((r) => r.code === 'TA');
    check('P1 Till A: two without an answer, one of them sent twice; one refused', a.waiting === 2 && a.to_check === 1 && a.refused === 1, JSON.stringify({ w: a.waiting, c: a.to_check, r: a.refused }));
    check('P1 Till A: the oldest waiting is the 10:00 one', new Date(a.oldest_waiting).toISOString() === '2026-10-22T10:00:00.000Z');
    check('P1 Till A: last fiscalised is the credit note', new Date(a.last_fiscalised).toISOString() === '2026-10-21T09:00:00.000Z');
    check('P1 Till A keeps its EBS ID and its report', a.ebs === 'EBS-A' && a.status.connected === true && a.status.environment === 'TEST');
    const b = tills.find((r) => r.code === 'TB');
    check('P1 Till B: nothing waits', b.waiting === 0 && b.oldest_waiting === null && b.refused === 0);

    // P2 the invoices
    const all = await list({});
    check('P2 every invoice of this business, newest first', ids(all).join(',') === 'MRP1-TA-000005,MRP1-TA-000004,MRP1-TA-000003,MRP1-TA-R000002,MRP1-TA-000001,TRN00000006,MRP1-TX-PRF000007', ids(all).join(','));
    check('P2 another business\'s invoice is never seen', !ids(all).includes('OTHER-000001'));
    const crn = all.find((r) => r.type === 'CRN');
    check('P2 a credit note names its sale and reads with a minus', crn.ref === 'MRP1-TA-000001' && p.signedCents(crn.type, crn.paid) === -5750);
    const lost = all.find((r) => r.identifier === 'MRP1-TX-PRF000007');
    check('P2 an invoice whose till is gone is still listed', lost && lost.till === 'A till no longer set up' && lost.till_code === null);
    check('P2 the QR comes with it, and not for the CSV', crn.qr === 'iVBORw0KGgoAAAA' && (await list({}, false)).every((r) => r.qr === null));
    check('P2 a refusal keeps the MRA\'s reason', p.reasons(all.find((r) => r.status === 'refused').errors) === 'ERR0600: Invalid seller BRN');

    // P3 the filters
    check('P3 by type', ids(await list({ type: 'CRN' })).join(',') === 'MRP1-TA-R000002');
    check('P3 waiting covers sent and sent twice', ids(await list({ status: 'waiting' })).join(',') === 'MRP1-TA-000005,MRP1-TA-000004');
    check('P3 by till', ids(await list({ till: tB })).join(',') === 'TRN00000006');
    check('P3 by branch: all seven are in its one branch, the gone till's too', (await list({ store })).length === 7);
    check('P3 dates are the branch\'s own: 21:30 UTC on the 21st is the 22nd', ids(await list({ from: '2026-10-22', to: '2026-10-22' })).join(',') === 'MRP1-TA-000005,MRP1-TA-000004,MRP1-TA-000003');
    check('P3 the page\'s limit holds', (await read(t, p.INVOICES_SQL, p.invoiceParams(t, none, 2, true))).length === 2);
  } finally {
    await c.query('ROLLBACK');
    await c.end();
  }
  if (failures) {
    console.log(failures + ' failed');
    process.exit(1);
  }
  console.log('all passed');
})().catch((e) => {
  console.log('FAILED ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
```

- [ ] **Step 2: Run it**

Run: `node db/tests/mra-page.test.cjs`
Expected: every line `PASS`, then `all passed`. Never run two `db/tests` suites at the same time.

If `create_tenant`'s arguments differ, copy the call from `db/tests/mra-till.test.cjs` line 79 as it is then.

- [ ] **Step 3: Commit**

```bash
git add db/tests/mra-page.test.cjs
git commit -m "db tests: the MRA page's questions on a probe client (MRA phase 3)"
```

---

### Task 3: The page (`web/app/backoffice/mra/page.tsx`)

**Files:**
- Create: `web/app/backoffice/mra/page.tsx`
- Modify: `db/tests/mra-page.test.cjs` (draw it)

- [ ] **Step 1: Add the failing page checks to the test**

In `db/tests/mra-page.test.cjs`, after the P3 checks and before `} finally {`, add:

```js
    // P4 the page itself, drawn for this business with no sign-in
    const { open, text } = require('./page.cjs');
    const owner = (await one(`select id from employees where tenant_id = $1 order by created_at limit 1`, [t])).id;
    const ctx = {
      userId: crypto.randomUUID(), employeeId: owner, tenantId: t, role: 'Owner', status: 'active', statusReason: null,
      mode: 'restaurant', premium: true, mra: 'live', tenantName: 'MRA Page', employeeName: 'Owner', admin: false,
    };
    const draw = async (c2, sp) => {
      await c.query('SAVEPOINT page');
      try { return text(await open(c, c2, '/backoffice/mra', sp)); }
      catch (e) { return 'ERROR ' + e.message; }
      finally { await c.query('ROLLBACK TO SAVEPOINT page'); }
    };
    const says = await draw(ctx, {});
    check('P4 the page draws', !says.startsWith('ERROR'), says.slice(0, 200));
    check('P4 Till B is at the top: its login was refused', says.includes('Needs attention') && says.includes('The MRA refused its login: Wrong password'));
    check('P4 Till A is at the top too: live, and the MRA counts it as TEST', says.includes('The MRA counts its sales as TEST'));
    check('P4 every invoice is listed with its words', says.includes('MRP1-TA-R000002') && says.includes('Credit note') && says.includes('Sent twice, no answer: check it on the till'));
    check('P4 the credit note reads with a minus', /[-−]\s?(Rs\s?)?57\.50/.test(says), (says.match(/.{0,12}57\.50/) || [''])[0]);
    check('P4 the sign-in says until when, as of the sync', says.includes('Signed in until') && says.includes('as of'));
    check('P4 a filter is applied', !(await draw(ctx, { type: 'TRN' })).includes('MRP1-TA-000001'));
    check('P4 a client not on MRA has no such page', (await draw({ ...ctx, mra: 'off' }, {})).startsWith('ERROR not found'));
```

- [ ] **Step 2: Run it to see the P4 checks fail**

Run: `node db/tests/mra-page.test.cjs`
Expected: P1 to P3 `PASS`; `FAIL P4 the page draws` with an error saying the page file is not found.

- [ ] **Step 3: Write `web/app/backoffice/mra/page.tsx`**

```tsx
import Link from "next/link";
import { notFound } from "next/navigation";
import { Download, FileCheck } from "lucide-react";
import { tenantContext } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { basics } from "@/lib/report";
import { money, withDefaults } from "@/lib/settings";
import { MRA_STATE_WORDS, onMra, testAtMra, tillConnected } from "@/lib/mra";
import {
  attention, INVOICES_SQL, invoiceParams, MRA_TYPES, type MraInvoiceRow, mraFilters, mraQuery, type MraTillRow, reasons,
  signedCents, STATUS_FILTERS, statusWords, TILLS_SQL,
} from "@/lib/mra-page";
import { Card, Empty, one, PageHead, type Search } from "../ui";

const PATH = "/backoffice/mra";
const MOST = 200;
// what a till last said of itself (pos_devices.mra_status, 0132)
type Reported = { connected?: boolean; refused?: string | null; environment?: string | null; at?: string; until?: string } | null;

// MRA e-invoicing, for a client on Premium MRA: each till's connection to the
// MRA, and every invoice the tills sent with the MRA's answer. The back office
// only knows what a till said at its last sync, so a till's line says when that
// was. Read-only: an invoice is sent, and sent again, by its till.
export default async function MraPage({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const ctx = await tenantContext();
  if (!onMra(ctx.mra)) notFound();
  const f = mraFilters((k) => one(sp[k]));
  const d = await readTenant(ctx.tenantId, async (c) => {
    const b = await basics(c, ctx.tenantId, ctx.employeeId);
    if (!b.ok) return { ok: false as const };
    const [tills, invoices] = await Promise.all([c.query(TILLS_SQL, [ctx.tenantId]), c.query(INVOICES_SQL, invoiceParams(ctx.tenantId, f, MOST + 1, true))]);
    return { ok: true as const, decimals: withDefaults(b.settings).decimals, tills: tills.rows as MraTillRow[], invoices: invoices.rows as MraInvoiceRow[] };
  });
  const head = (
    <PageHead
      title="MRA e-invoicing"
      lede="What your tills send to the MRA: whether each till is connected, and every invoice with the MRA's answer. Nothing here changes what was sent."
    >
      <span className={ctx.mra === "live" ? "badge green" : "badge amber"}>{MRA_STATE_WORDS[ctx.mra]}</span>
    </PageHead>
  );
  if (!d.ok) {
    return (
      <div>
        {head}
        <Empty icon={FileCheck} title="Your role cannot see reports">Ask the owner to tick See reports on your role, under Roles and permissions.</Empty>
      </div>
    );
  }
  const now = new Date();
  const at = (iso: string | null, tz: string) =>
    iso ? new Intl.DateTimeFormat("en-GB", { timeZone: tz, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(iso)) : null;
  const tills = d.tills.map((t) => {
    const s = (t.status ?? null) as Reported;
    const why = attention(
      {
        connected: tillConnected(s),
        refusedLogin: s?.refused ?? null,
        waiting: t.waiting,
        oldestWaiting: t.oldest_waiting ? new Date(t.oldest_waiting) : null,
        check: t.to_check,
        countedAsTest: testAtMra(ctx.mra, s),
      },
      now,
    );
    return { ...t, s, why };
  });
  const worried = tills.filter((t) => t.why.length > 0);
  const branches = [...new Set(tills.map((t) => t.store))];
  const shown = d.invoices.slice(0, MOST);
  const filtered = Boolean(f.store || f.till || f.type || f.status || f.from || f.to);
  const stores = [...new Map(d.tills.map((t) => [t.store_id, t])).values()];
  return (
    <div>
      {head}
      {worried.length > 0 && (
        <Card title="Needs attention">
          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
            {worried.map((t) => (
              <li key={t.id}>
                <strong>
                  {t.name} ({t.code})
                </strong>
                {branches.length > 1 ? `, ${t.store}` : ""}: {t.why.join(". ")}.
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card title="Tills" lede="Each till as it said at its last sync.">
        {tills.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>No till is set up yet.</p>
        ) : (
          branches.map((branch) => (
            <div key={branch} style={{ marginBottom: 12 }}>
              {branches.length > 1 && <h3 style={{ margin: "0 0 6px" }}>{branch}</h3>}
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
                {tills
                  .filter((t) => t.store === branch)
                  .map((t) => (
                    <li key={t.id}>
                      <strong>
                        {t.name} ({t.code})
                      </strong>{" "}
                      <span className={tillConnected(t.s) ? "badge green" : t.s?.refused ? "badge red" : "badge amber"}>
                        {tillConnected(t.s) ? "Connected" : t.s?.refused ? "Login refused" : "Not connected"}
                      </span>
                      {testAtMra(ctx.mra, t.s) && (
                        <>
                          {" "}
                          <span className="badge red">Counted as TEST by the MRA</span>
                        </>
                      )}
                      <div className="muted">
                        {!t.ebs && "No EBS MRA ID yet: EasyPay types it in. "}
                        {t.s?.until && `Signed in until ${at(t.s.until, t.tz)}, `}
                        {t.s?.at ? `as of its sync at ${at(t.s.at, t.tz)}. ` : "It has not reported yet. "}
                        {t.waiting > 0 ? `${t.waiting} waiting. ` : "Nothing waiting. "}
                        {t.last_fiscalised && `Last fiscalised ${at(t.last_fiscalised, t.tz)}. `}
                        {t.refused > 0 && `${t.refused} refused by the MRA.`}
                      </div>
                    </li>
                  ))}
              </ul>
            </div>
          ))
        )}
      </Card>
      <Card>
        <form method="get" action={PATH} className="bo-toolbar" style={{ margin: 0 }}>
          {stores.length > 1 && (
            <select name="store" defaultValue={f.store ?? ""} aria-label="Branch">
              <option value="">Every branch</option>
              {stores.map((t) => (
                <option key={t.store_id} value={t.store_id}>
                  {t.store}
                </option>
              ))}
            </select>
          )}
          <select name="till" defaultValue={f.till ?? ""} aria-label="Till">
            <option value="">Every till</option>
            {d.tills.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({t.code})
              </option>
            ))}
          </select>
          <select name="type" defaultValue={f.type ?? ""} aria-label="Type">
            <option value="">Every type</option>
            {Object.entries(MRA_TYPES).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <select name="status" defaultValue={f.status ?? ""} aria-label="Status">
            <option value="">Every status</option>
            {Object.entries(STATUS_FILTERS).map(([code, label]) => (
              <option key={code} value={code}>
                {label}
              </option>
            ))}
          </select>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            From <input type="date" name="from" defaultValue={f.from ?? ""} />
          </label>
          <label className="muted" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            to <input type="date" name="to" defaultValue={f.to ?? ""} />
          </label>
          <button type="submit" className="btn-sm">Show</button>
          {filtered && <Link href={PATH}>Show everything</Link>}
          <a href={`${PATH}/export${mraQuery(f)}`} className="btn btn-quiet btn-sm" download style={{ marginLeft: "auto" }}>
            <Download aria-hidden="true" />
            Download CSV
          </a>
        </form>
      </Card>
      {shown.length === 0 ? (
        <Empty icon={FileCheck} title={filtered ? "No invoice fits" : "Nothing sent to the MRA yet"}>
          {filtered ? "Widen the dates or choose Show everything." : "Each sale, refund or training sale of a till on MRA leaves a line here."}
        </Empty>
      ) : (
        <Card flush>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Branch</th>
                  <th>Till</th>
                  <th>Number</th>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const cents = signedCents(r.type, r.paid);
                  const why = reasons(r.errors);
                  const warned = reasons(r.warnings);
                  return (
                    <tr key={r.id}>
                      <td>{at(r.at, r.tz)}</td>
                      <td>{r.store}</td>
                      <td>{r.till}</td>
                      <td className="strong">
                        {r.identifier}
                        {r.ref && <div className="muted">for {r.ref}</div>}
                      </td>
                      <td>{MRA_TYPES[r.type as keyof typeof MRA_TYPES] ?? r.type}</td>
                      <td className="num">{cents === null ? "" : money(cents, d.decimals)}</td>
                      <td>
                        <details>
                          <summary>
                            <span className={r.status === "fiscalised" ? "badge green" : r.status === "refused" ? "badge red" : "badge amber"}>{statusWords(r.status)}</span>
                          </summary>
                          <div style={{ display: "grid", gap: 6, paddingTop: 8 }}>
                            {r.irn && <span className="muted">IRN {r.irn}</span>}
                            {r.qr && <img src={`data:image/png;base64,${r.qr}`} alt={`QR code of ${r.identifier}`} width={96} height={96} />}
                            {why && <span>The MRA said: {why}</span>}
                            {warned && <span className="muted">Warnings: {warned}</span>}
                            {r.differs !== null && r.differs !== undefined && <span className="muted">The receipt's total differs from what was sent; the MRA holds what was sent.</span>}
                            {(r.status === "unsure" || r.status === "check") && <span className="muted">The till sends it again, or check it there under Settings, MRA.</span>}
                          </div>
                        </details>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {d.invoices.length > MOST && (
            <p className="muted" style={{ padding: "12px 20px", margin: 0 }}>
              These are the latest {MOST}. Narrow the dates, or download the CSV for all of them.
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
```


- [ ] **Step 4: Run the test**

Run: `node db/tests/mra-page.test.cjs`
Expected: every line `PASS`, then `all passed`.

Run: `cd web && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/app/backoffice/mra/page.tsx web/lib/mra-page.ts db/tests/mra-page.test.cjs
git commit -m "back office: the MRA page, each till's connection and every invoice sent (MRA phase 3)"
```

---

### Task 4: The CSV (`web/app/backoffice/mra/export/route.ts`)

**Files:**
- Create: `web/app/backoffice/mra/export/route.ts`

- [ ] **Step 1: Write the route**

```ts
import { requirePerm } from "@/lib/tenant";
import { readTenant } from "@/lib/db";
import { onMra } from "@/lib/mra";
import { csvLine, INVOICES_SQL, invoiceParams, MRA_TYPES, type MraInvoiceRow, mraFilters, reasons, signedCents, statusWords } from "@/lib/mra-page";

// The invoices the MRA page shows, all of them, as a spreadsheet: the same
// question with the same filters, without the QR pictures.

export const dynamic = "force-dynamic";

const MOST = 50000;

export async function GET(req: Request) {
  let ctx;
  try {
    ctx = await requirePerm("reports.view");
  } catch (e) {
    if (e && typeof e === "object" && "digest" in e) throw e; // a redirect to the sign-in page
    return new Response("You are not allowed to download the invoices sent to the MRA.", { status: 403 });
  }
  if (!onMra(ctx.mra)) return new Response("Not found", { status: 404 });
  const f = mraFilters((k) => new URL(req.url).searchParams.get(k) ?? "");
  const rows = await readTenant(ctx.tenantId, async (c) => (await c.query(INVOICES_SQL, invoiceParams(ctx.tenantId, f, MOST, false))).rows as MraInvoiceRow[]);
  const lines = [csvLine(["Issued", "Branch", "Till", "Number", "Type", "For", "Amount", "Status", "IRN", "The MRA said", "Warnings"])];
  for (const r of rows) {
    // the branch's own clock, written so a spreadsheet reads it as a date and time
    const when = new Intl.DateTimeFormat("sv-SE", { timeZone: r.tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    const cents = signedCents(r.type, r.paid);
    lines.push(
      csvLine([
        when.format(new Date(r.at)), r.store, r.till, r.identifier, MRA_TYPES[r.type as keyof typeof MRA_TYPES] ?? r.type, r.ref,
        cents === null ? "" : (cents / 100).toFixed(2), statusWords(r.status), r.irn, reasons(r.errors), reasons(r.warnings),
      ]),
    );
  }
  // the mark at the start tells a spreadsheet the file is UTF-8, so accents survive
  return new Response("﻿" + lines.join("\r\n") + "\r\n", {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="mra-invoices.csv"`,
      "cache-control": "no-store",
    },
  });
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add web/app/backoffice/mra/export/route.ts
git commit -m "back office: the MRA page's CSV (MRA phase 3)"
```

---

### Task 5: The menu line, for an MRA client only

**Files:**
- Modify: `web/app/backoffice/nav.ts`
- Modify: `web/app/backoffice/side.tsx`, `web/app/backoffice/search-box.tsx`, `web/app/backoffice/layout.tsx`
- Test: `web/lib/nav.test.mjs`

- [ ] **Step 1: Write the failing test**

In `web/lib/nav.test.mjs`, before the closing failure count, add:

```js
check("the MRA page is in the menu for a client on MRA only", () => {
  const has = (mra) => groupsFor("restaurant", true, mra).some((g) => g.links.some((l) => l.href === "/backoffice/mra"));
  assert.equal(has(true), true);
  assert.equal(has(false), false);
  assert.equal(groupsFor("retail", true, true).some((g) => g.links.some((l) => l.href === "/backoffice/mra")), true);
  assert.ok(pagesOf("retail", true, true).some((p) => p.label === "MRA e-invoicing"));
  assert.ok(!pagesOf("retail", true).some((p) => p.label === "MRA e-invoicing"));
  assert.equal(groupOf("/backoffice/mra", "restaurant", true, true), "finance");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node web/lib/nav.test.mjs`
Expected: `FAIL the MRA page is in the menu for a client on MRA only`.

- [ ] **Step 3: Change `web/app/backoffice/nav.ts`**

1. Add `FileCheck,` to the `lucide-react` import list.
2. In the comment above `NavLink`, after the `premium` line, add:
   `// \`mra\`: a page of a client on Premium MRA (setting up, training or live), which no other client has.`
3. `NavLink` gains `mra?: true`:

```ts
export type NavLink = { href: string; label: string; icon: LucideIcon; words?: string; only?: Mode; retail?: string; retailIcon?: LucideIcon; premium?: true; mra?: true };
```

4. In the `finance` group, after the Receipts line, add:

```ts
      { href: "/backoffice/mra", label: "MRA e-invoicing", mra: true, icon: FileCheck, words: "mra e-invoicing einvoicing fiscal fiscalised irn qr code invoices tax authority ebs connected refused training test drive" },
```

5. Each function that takes `premium` takes `mra` after it, default `false`, and passes it on:

```ts
export const groupOf = (path: string, mode: Mode, premium: boolean, mra = false) =>
  groupsFor(mode, premium, mra).find((g) => g.links.some((l) => isOn(l.href, path)))?.id ?? null;
```

In `groupsFor`, the signature becomes `export function groupsFor(mode: Mode, premium: boolean, mra = false): NavGroup[]` and its link filter
becomes:

```ts
      .filter((l) => (!l.only || l.only === mode) && (!l.premium || premium) && (!l.mra || mra))
```

`sectionsFor(mode, premium, mra = false)` calls `groupsFor(mode, premium, mra)`; `over(path, mode, premium, mra = false)` calls
`groupsFor(mode, premium, mra)`; `pagesOf = (mode: Mode, premium: boolean, mra = false)` calls `groupsFor(mode, premium, mra)`.

- [ ] **Step 4: Pass it down**

- `web/app/backoffice/layout.tsx`: import `onMra` from `@/lib/mra`; give `<Side` the prop `mra={onMra(ctx.mra)}` beside
  `premium={ctx.premium}`, and `<Over mode={ctx.mode} premium={ctx.premium} mra={onMra(ctx.mra)} />`.
- `web/app/backoffice/side.tsx`:
  - `Over` takes `{ mode, premium, mra }: { mode: Mode; premium: boolean; mra: boolean }` and calls `over(usePathname(), mode, premium, mra)`;
  - `Side` takes `mra` beside `premium`, with `// a client on Premium MRA has its MRA page` and `mra: boolean;` in its props type;
  - in `Side`: `groupOf(path, mode, premium, mra)`, `useMemo(() => groupsFor(mode, premium, mra), [mode, premium, mra])`,
    `useMemo(() => sectionsFor(mode, premium, mra), [mode, premium, mra])`, and `<SearchBox mode={mode} premium={premium} mra={mra} />`.
- `web/app/backoffice/search-box.tsx`: `SearchBox({ mode, premium, mra }: { mode: Mode; premium: boolean; mra: boolean })` and
  `useMemo(() => pagesOf(mode, premium, mra), [mode, premium, mra])`.

Then search for any caller left out:

Run: `grep -rn -E "(groupsFor|sectionsFor|pagesOf|groupOf)\(|[^a-zA-Z.]over\(|<(Over|Side|SearchBox)" web/app web/lib --include=*.ts --include=*.tsx`
Expected: every call outside `nav.ts` and the tests passes `mra`.

- [ ] **Step 5: Run the tests and the type-check**

Run: `node web/lib/nav.test.mjs`
Expected: every line `PASS`.

Run: `cd web && npx tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add web/app/backoffice/nav.ts web/app/backoffice/side.tsx web/app/backoffice/search-box.tsx web/app/backoffice/layout.tsx web/lib/nav.test.mjs
git commit -m "back office: the MRA e-invoicing line in the menu, for a client on MRA only (MRA phase 3)"
```

---

### Task 6: See it, and check everything

**Files:** none committed (the drawing script lives in the session's scratchpad).

- [ ] **Step 1: Every web test, the type-check and the build**

Run: `for f in web/lib/*.test.mjs; do node "$f" || echo "FAILED $f"; done`
Expected: no `FAILED` line.

Run: `cd web && npx tsc --noEmit -p . && npm run build`
Expected: the build ends without an error and lists `/backoffice/mra` and `/backoffice/mra/export`.

- [ ] **Step 2: The database test, alone**

Run: `node db/tests/mra-page.test.cjs`
Expected: `all passed`. No other `db/tests` suite runs at the same time; the db-tests workflow is not run to check this.

- [ ] **Step 3: Draw MRA Pilot's real page, read-only**

Write `render_mra.cjs` in the session's scratchpad after the earlier `render_pos.cjs` (see the memory note on the
Point of sale pages): it opens a read-only transaction on dev, finds `MRA Pilot`, builds the context as in Task 3
(`mra: 'live'`, its owner employee), draws `/backoffice/mra` with `db/tests/page.cjs` inside the real layout and
stylesheet to HTML (`THEME=light` and `THEME=dark`), and rolls back. Screenshot both with headless Chrome (one
`--user-data-dir` per run). Look for:
- the Tills part says Till 1 is connected, as of its last sync;
- the list has its 41 invoices: TRN00000040 to 57, MP-T1-000019 to 000038, MP-T1-R000027 with a minus,
  MP-T1-PRF000078, MP-T1-DRN000079, MP-T1-STD000080 refused with ERR0500;
- a status opens onto its IRN and QR, or onto the MRA's reason.

- [ ] **Step 4: Show the owner**

Send the two screenshots. Say plainly what was seen and what was not (the page behind a real sign-in, unless the
owner signs in on `localhost:3000`). Nothing is pushed until the owner says so; no tag.
