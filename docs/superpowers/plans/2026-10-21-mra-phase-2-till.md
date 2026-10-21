# MRA e-invoicing, phase 2: the till signs in and sends. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** an Android till of a Premium MRA client signs in to the MRA, sends every sale (STD), refund (CRN) and
training sale (TRN) as it is paid, prints the MRA's QR code, or "Not Yet Fiscalised" and sends it later, and tells
our server what it sent.

**Architecture:** the invoice is made inside the sale's own Room transaction: counter, number and hash are fixed
there and the invoice is never rebuilt. It is sent after the commit, with about 10 seconds to answer, before the
receipt prints. A queue sends what waits, in order, at most 500 a request. The MRA code is a Kotlin copy of
`mra/` (sign-in, encryption, invoice, hash), held to fixtures made by `mra/invoice.cjs` and to the invoices the
MRA sandbox fiscalised. Each invoice's record and each till's MRA status reach the server through the existing
outbox. They land in a new table, `mra_records` (migration 0132), and on `pos_devices`.

**Tech stack:** Kotlin, Room (34 → 35), OkHttp, javax.crypto, zxing (tests), WorkManager, Compose; Postgres
(Neon) push functions; Next.js `/admin`; Node `mra/` for the shared rules.

Sources: the whole plan `2026-10-21-mra-e-invoicing-plan.md` ("Phase 2", "Multi-branch", "When to press Test
Drive"), the design `../specs/2026-10-17-premium-mra-design.md` sections 2, 7, 8 and 10, the MRA's technical
guide v1.3 and data structure v1.3.4 (in `.claude/mra/`, private).

---

## For the owner: what this plan needs from you before building

### Decisions

**D1. How the till gets the MRA's public key and address.** The till seals the login with the MRA's public key,
the `.crt` from the portal. It is in `.claude/mra/`, and nothing from there is committed. The guide also warns
that the certificate gets renewed, and the production address is not known yet (question 2 to the MRA).

- **(a) From our server (recommended).** `/admin` gets one field for the MRA address and the certificate, for
  every client. The tills receive both with their settings. A new certificate needs no app update. Nothing is
  committed. Cost: one small table, one `/admin` field.
- **(b) Inside the app.** The certificate is committed into `android/` (it is a public key: any registered
  developer downloads the same file). A new certificate means a new app version for every MRA client.

**D2. One test in the sandbox: does the MRA check the hash chain?** The till builds each invoice when the sale is
paid, so a sale made offline chains to the sale before it, which may not have reached the MRA yet. The script
chained to the last invoice the MRA had fiscalised. Nobody knows whether the MRA compares `previousNoteHash`
with what it holds. Task 1 adds `node mra/sandbox.cjs send probe-chain`: one sale chained to an invoice the MRA
never saw.

- Accepted: the till chains to the last invoice it issued (this plan).
- Refused: tell me. The till then has to build each invoice when it sends it, and Task 11 changes.

This is a sandbox send, like the seven cases. It does not touch the EBS on the portal.

**Answered 2026-10-21 (19:58 Mauritius), by the owner's run:** `probe-chain` (EPTSTD000019) chained to an invoice
the MRA never saw (EPTSTD999999), neither to the last one fiscalised nor to `0`, and was **fiscalised with no
warnings**. The sandbox does not check `previousNoteHash` against what it holds, so the till chains to the last
invoice it issued, as built. Test Drive or production may be stricter: case 5 still goes last.

**D3. One more sandbox test: a real sale.** The sandbox only saw whole quantities, prices with VAT inside, no
discount and one cash payment. A real sale has more. `send probe-mixed` sends one invoice with:

- an order discount spread over the lines;
- a line sold by the kilo (0.250);
- a line whose VAT goes on top;
- an add-on inside a line;
- a service charge line.

If the MRA refuses or warns, the rules in the table below change before the till is built.

**Answered 2026-10-21 (19:58):** `probe-mixed` (EPTSTD000020) was **fiscalised with no warnings**, built by the rules
below: the Rs 50 discount spread over four lines with 0.02 left for the invoice's own discount, 0.25 kg, VAT on top
(Cake: 90.66 + 13.60), an add-on in a line (Burger (Egg)), and a service charge line TC03 SERVICES; Rs 547.10 paid,
Calc's figure. The rules stand as they are.

### Choices I made, to confirm or change

1. **Service charge** goes as its own line: "Service charge", SERVICES, **TC03** (exempt), with no VAT, because
   the till never charges VAT on it. Your accountant should say whether it is TC03 or TC06 (outside the scope of
   VAT).
2. **Cash rounding is left out of the invoice.** The MRA's "total paid" is the receipt's total before it is
   rounded to the rupee. The MRA has no field for rounding.
3. **A training invoice's number** is `TRN` and the till's MRA counter (`TRN00000042`), not the receipt number.
   Receipt numbers start again at 1 when a client goes live, and a training number must never clash with a
   real one.
4. **A refund during training goes as TRN**, like the training sales. A CRN must name an STD, and there is none in
   training.
5. **`live` works from the next sale**, not from "the next day's opening" (design section 2). `/admin` says "switch
   after closing". The next-day rule would make Test Drive (case 7 in training, then the others live) take two
   days.
6. **The receipt push rule (design section 7)** is met without changing the receipt push. The server keeps each
   invoice exactly as the till sent it (`mra_records.invoice`). Its receipt keeps the server's own sums. When the
   two totals differ, the record says so (`differs`). The alternative, storing the till's sums in `receipts` for
   live clients, means rewriting `push_receipt_create`, the largest function in the database.
7. **How it was paid** (`salesTransactions`):
   - any part on account → CREDIT;
   - otherwise the largest payment: cash → CASH, card → CARD, anything else (credit note, deposit, exchange,
     mobile money) → OTHER.
8. **The cashier** is sent as the name of whoever took the payment (optional for the MRA).
9. **The till's code (T1) is sent as the counter number** (`ebsCounterNo`, optional).
10. **A live till with no EBS MRA ID takes no payment** ("This till has no EBS MRA ID: ask EasyPay"). A live till
    whose manager has not connected it yet does sell: its sales wait, print "Not Yet Fiscalised", and a red
    banner says so.
11. **A line with two taxes cannot be sent** (the MRA takes one code a line). A live MRA till refuses to take
    payment for it and names the item.
12. **Test Drive's cases 2, 5 and 6** (a debit note, a wrong TAN, a pro forma) are sent by an action that only the
    **debug** build has, through the till's own invoice, encryption and sending code. The till has no debit notes
    or pro formas, and a real till must never be able to send a wrong TAN. Cases 1, 3, 4 and 7 are made on the
    till's own screens: sales, a refund, ten sales offline then back online, a training sale.

### What you do during the build

- Run the two sandbox tests (D2, D3) when Task 1 is committed.
- On dev:
  - make a test client on Premium MRA;
  - type EasyPayPos's legal name, TAN, BRN and address in its back office (the TAN must be the one the MRA
    registered, as in `sandbox.env`);
  - give the emulator's till a tablet code and the sandbox EBS MRA ID in `/admin`.
- Type the sandbox login on the emulator's Settings, MRA, while I watch: I never type it.

---

## How a sale becomes an invoice (the rules, for Node and Kotlin alike)

Amounts are integer cents. Quantities are thousandths, as on the till. `money()` writes rupees with two
decimals. The rules live in `mra/invoice.cjs` and `com.restopos.core.mra.MraInvoice`, and both are held to
`mra/fixtures/invoices.json`.

| Invoice field | From |
|---|---|
| `invoiceCounter` | the till's MRA counter, +1 for every document it issues, never reset (`pos_devices.mra_counter`) |
| `transactionType` | `B2C` (no business buyer yet) |
| `personType` | `VATR` when the company has a VAT number, else `NVTR` |
| `invoiceTypeDesc` | `STD` for a sale and `CRN` for a refund while `mra = live`; `TRN` for both while `training` |
| `invoiceIdentifier` | the receipt number (`ST-T1-000123`, a refund `ST-T1-R000124`); a TRN `TRN` + counter in 8 digits |
| `invoiceRefIdentifier` | a CRN: its sale's receipt number; else empty |
| `previousNoteHash` | sha256 (capital hex) of the last invoice of the same type issued by this till: date-time + total paid + BRN + identifier; `0` for the first |
| `reasonStated` | a CRN: the refund's reason (the till asks for one), at most 100 characters; else empty |
| `totalVatAmount` | the sum of the lines' `vatAmt` (= the receipt's VAT) |
| `totalAmtWoVatCur`, `…Mur` | the sum of the lines' `amtWoVatCur` |
| `invoiceTotal` | VAT + without VAT |
| `discountTotalAmount` | the cents of the order discount the lines did not take (Calc's spread rounds down; usually 0.00) |
| `totalAmtPaid` | invoiceTotal − discountTotalAmount = the receipt's total before rounding |
| `dateTimeInvoiceIssued` | when it was paid, Mauritius time, `yyyyMMdd HH:mm:ss` |
| `seller` | `name` legal name, `tradeName` the business name, `tan`, `brn`, `businessAddr` the till's branch address (with one branch, the company address), `businessPhoneNo` (digits and + only), `ebsCounterNo` the till's code, `cashierID` the cashier's name |
| `buyer` | empty, `buyerType` NVTR |
| `salesTransactions` | choice 7 |

Each line of the receipt (voided lines left out), then a service charge line when there is one:

| Item field | From |
|---|---|
| `base` (input) | `Calc.lineAmount(unit_price, qty)` + its add-ons (`modSum`): what the line charges before the order discount |
| `share` (input) | its part of the order discount, as Calc spreads it: `discount * base / subtotal`, rounded down |
| `net` | base − share |
| `vatAmt` | VAT inside: `(net*bp + (10000+bp)/2) / (10000+bp)`; VAT on top: `(net*bp + 5000) / 10000`; 0 for a seller not registered |
| `amtWoVatCur`, `…Mur`, `discountedValue` | inside: net − VAT; on top: net |
| `discount` | (base without its VAT) − amtWoVatCur, i.e. the share without VAT; 0.00 with no discount |
| `unitPrice` | (base without its VAT) / quantity, rounded half up |
| `quantity` | thousandths as a number: `2`, `0.25`, `1.125` |
| `totalPrice` | amtWoVatCur + vatAmt |
| `taxCode` | the line's tax's MRA code (`taxes.mra_code`; with none, TC01 for 15 % and TC02 for 0 %) |
| `nature` | the category's (`categories.mra_nature`), else the company's (`mra_seller.nature`), in capitals |
| `itemDesc` | the line's name, with its add-ons in brackets, at most 100 characters |
| `productCodeOwn` | the item's SKU, else empty |

With no discount, this gives exactly what the sandbox fiscalised.

A refund (CRN) carries the lines given back. When the whole sale comes back, they are the sale's own items
copied from its invoice. Otherwise each line's `base` and `share` are `RefundCalc.parts(...).sub` and `.disc`.

---

## Files

**Node (`mra/`)**
- Modify `mra/invoice.cjs`: lines in the general form (`qtyMilli`, `base`, `share`, `vatBp`, `added`), `figures()`,
  `qtyText()`, `money()` for negatives.
- Create `mra/fixtures/make-invoices.cjs` and `mra/fixtures/invoices.json` (committed, made-up seller).
- Modify `mra/sandbox.cjs`: `probe-chain`, `probe-mixed`.
- Modify `mra/invoice.test.cjs`, `mra/sandbox.test.cjs`.

**Till: pure Kotlin, `android/app/src/main/java/com/restopos/core/mra/`**
- `MraJson.kt`: ordered JSON with JSON.stringify's escaping.
- `MraCrypto.kt`: hash, AES-256-ECB, key unwrap, RSA from the certificate.
- `MraInvoice.kt`: `Seller`, `Line`, `Chained`, `build()`, `money()`, `mraDateTime()`, `qtyText()`.
- `MraApi.kt`: the two requests and their answers, `mraMoment()`, `requestId()`.
- `MraLines.kt`: a receipt's lines (from Calc or RefundCalc) as `Line`s; the payment code; the checks before paying.
- `MraQr.kt`: the MRA's QR picture as a 2 x 2 cm raster.

**Till: Android**
- `core/mra/MraHttp.kt`: OkHttp with its own timeouts; answered, not reached, or no answer.
- `core/mra/MraLogin.kt`: username, password, area code, token and key in `SecretStore` (Keystore).
- `core/mra/MraIssuer.kt`: makes the invoice inside the sale's transaction.
- `core/mra/MraSender.kt`: signs in, sends one now, drains the queue, reports the status.
- `core/mra/MraWorker.kt`: WorkManager, every 15 minutes and when the network comes back.
- `core/database/Mra.kt`: `MraInvoiceEntity`, `MraDao`.
- Modify:
  - `core/database/Entities.kt`: `DeviceEntity` (mra_ebs_id, mra_counter, mra_chain), `TaxEntity.mra_code`,
    `CategoryEntity.mra_nature`, `StoreEntity.address`;
  - `TillDatabase.kt` (35), `Migrations.kt` (`V34_V35`), `app/di/AppModule.kt`;
  - `core/sync/PullApplier.kt`, `core/data/PosSettings.kt`;
  - `core/data/TicketRepository.kt` (`pay`), `core/data/OrderOps.kt` (`refund`, `paid`, `afterExchange`,
    `reprint`, `printCopy`);
  - `core/print/Docs.kt`, `core/print/PaperWalk.kt` (QR before the title);
  - `feature/settings/SettingsScreen.kt` (Page.Mra), new `feature/settings/MraPage.kt`;
  - `feature/main/MainShell.kt` (`SyncNotices`);
  - `feature/sync/RejectedScreen.kt`, `core/data/GoLiveRules.kt`.
- Debug only: `android/app/src/debug/java/com/restopos/debug/MraCases.kt` (Test Drive cases 2, 5, 6).

**Till tests: `android/app/src/test/java/com/restopos/core/mra/`**
- `MraCryptoTest.kt`, `MraInvoiceTest.kt` (fixtures), `MraSandboxInvoicesTest.kt` (local only), `MraApiTest.kt`,
  `MraLinesTest.kt`, `MraQrTest.kt`, `MraQueueTest.kt`.

**Server**
- Create `db/migrations/0132_mra_till.sql`:
  - the `mra_records` table;
  - the `pos_devices` columns;
  - `push_mra_record`, `push_mra_status`, `sync_push` rebuilt;
  - `set_tenant_mra` with training and live;
  - `mra_seller` in the settings;
  - `platform.mra_connection` (if D1 a).
- Create `db/tests/mra-till.test.cjs`.
- Modify `hello.ts` (an MRA client's tills need this build), `db/scripts/delete-client.cjs` (the new table).

**Back office and /admin**
- Modify `web/app/backoffice/company/page.tsx` (writes `mra_seller`), `web/app/admin/tenants/[id]/mra.tsx` and
  `page.tsx` (Training, Live), `web/lib/mra.ts`.
- Modify the credit notes page: "Store credit" for an MRA client.
- If D1 a: an MRA connection field in `/admin`.

---

## Phase A: the shared rules, and the two sandbox tests

### Task 1: invoice.cjs takes a real sale; the probes; the fixture

**Files:** `mra/invoice.cjs`, `mra/invoice.test.cjs`, `mra/sandbox-invoices.test.cjs` (this PC only), `mra/sandbox.cjs`,
`mra/sandbox.test.cjs`, `mra/fixtures/make-invoices.cjs`, `mra/fixtures/invoices.json`

- [ ] **Step 1: failing tests in `mra/invoice.test.cjs`**

```js
test('a quantity in thousandths is written as a number', () => {
  assert.equal(inv.qtyText(2000), '2');
  assert.equal(inv.qtyText(250), '0.25');
  assert.equal(inv.qtyText(1125), '1.125');
});

test('a negative amount keeps its sign', () => {
  assert.equal(inv.money(-5), '-0.05');
  assert.equal(inv.money(-11500), '-115.00');
});

// The till spreads an order discount over the lines and works the VAT out on
// what is left of each (core/data/Calc). The MRA is told the same VAT.
test('a line\'s part of the order discount comes off before its VAT', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(Date.UTC(2026, 9, 21, 8, 0, 0)), seller,
    lines: [{ desc: 'Curry', code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 11500, share: 1150, vatBp: 1500 }],
    payment: 'CASH',
  });
  const l = i.itemList[0];
  assert.equal(l.vatAmt, '13.50');          // (10350*1500 + 5750) / 11500
  assert.equal(l.amtWoVatCur, '90.00');     // 103.50 - 13.50
  assert.equal(l.unitPrice, '100.00');      // 115.00 without its VAT
  assert.equal(l.discount, '10.00');
  assert.equal(l.totalPrice, '103.50');
  assert.equal(i.totalAmtPaid, '103.50');
});

test('VAT on top is added to what the line charges', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: [{ desc: 'Cake', code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 1000, base: 10000, vatBp: 1500, added: true }],
    payment: 'CASH',
  });
  assert.equal(i.itemList[0].vatAmt, '15.00');
  assert.equal(i.itemList[0].amtWoVatCur, '100.00');
  assert.equal(i.invoiceTotal, '115.00');
});

test('a line sold by the kilo has a fraction for its quantity and a price for one kilo', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: [{ desc: 'Prawns', code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli: 250, base: 20000, vatBp: 1500 }],
    payment: 'CASH',
  });
  assert.equal(i.itemList[0].quantity, '0.25');
  // VAT inside 200.00 is 26.09 (2609.19 rounded down), 173.91 without it, 695.64 a kilo
  assert.equal(i.itemList[0].unitPrice, '695.64');
});

test('the cents of a discount the lines did not take are the invoice\'s own discount', () => {
  const i = inv.build({
    counter: 1, identifier: 'EP-1', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: [
      { desc: 'A', code: '', taxCode: 'TC03', nature: 'GOODS', qtyMilli: 1000, base: 100, share: 33 },
      { desc: 'B', code: '', taxCode: 'TC03', nature: 'GOODS', qtyMilli: 1000, base: 200, share: 66 },
    ],
    discount: 1, payment: 'CASH',
  });
  assert.equal(i.discountTotalAmount, '0.01');
  assert.equal(i.totalAmtPaid, '2.00'); // 300 - 100 off
});

test('the old form (whole quantities, prices with VAT) builds what the sandbox fiscalised', () => {
  const old = inv.build({ counter: 1, identifier: 'X', type: 'STD', previous: null, issuedAt: new Date(0), seller, lines: inv.testCase1Lines(), payment: 'CASH' });
  const general = inv.build({ counter: 1, identifier: 'X', type: 'STD', previous: null, issuedAt: new Date(0), seller,
    lines: inv.testCase1Lines().map(inv.general), payment: 'CASH' });
  assert.equal(JSON.stringify(general), JSON.stringify(old));
});
```

Also, first, a test for this PC only that holds `invoice.cjs` to what the MRA fiscalised, **before** any change.
`mra/sandbox-invoices.test.cjs` skips when `.claude/mra/out` is absent. For each `invoice-*.json`, it rebuilds each
invoice with `build()` from the file's own seller, counter, identifier, ref, reason and time, and from the case's
lines, and compares `JSON.stringify` byte for byte. Run it before Step 3: it passes on the code as it is. It must
still pass after Step 3, or the committed fixture would carry a change the MRA never saw into the Kotlin. The
general-vs-old test below only shows the two forms agree; this one shows they agree with the MRA.

- [ ] **Step 2: run them and see them fail**

Run: `node --test mra/invoice.test.cjs`
Expected: FAIL, `inv.qtyText is not a function` and the like. (`node --test mra/sandbox-invoices.test.cjs`: PASS.)

- [ ] **Step 3: change `mra/invoice.cjs`**

```js
const money = (cents) => {
  const c = Math.round(cents);
  const a = Math.abs(c);
  return `${c < 0 ? '-' : ''}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
};

// thousandths, as the till keeps a quantity, as a plain number
const qtyText = (milli) => {
  const whole = Math.trunc(milli / 1000);
  const rest = String(Math.abs(milli % 1000)).padStart(3, '0').replace(/0+$/, '');
  return rest ? `${whole}.${rest}` : String(whole);
};

const vatAdded = (net, bp) => (bp > 0 ? Math.floor((net * bp + 5000) / 10000) : 0);

// A test case's line (a whole quantity, a price with VAT inside) as a till's line.
const general = (l) => ({ desc: l.desc, code: l.code || '', taxCode: l.taxCode, nature: l.nature, qtyMilli: l.qty * 1000, base: l.unitPrice * l.qty, share: 0, vatBp: l.vatBp, added: false });

// What one line comes to, in cents: without VAT before and after its part of
// the order discount, and its VAT, worked out as the till works it out.
function figures({ base, share = 0, vatBp = 0, added = false }, vatRegistered) {
  const net = base - share;
  const vat = !vatRegistered ? 0 : added ? vatAdded(net, vatBp) : vatIncluded(net, vatBp);
  const exBefore = !vatRegistered || added ? base : base - vatIncluded(base, vatBp);
  return { exBefore, ex: added ? net : net - vat, vat };
}
```

In `build`, each line goes through `const L = l.qtyMilli != null ? l : general(l)`, then:

```js
    const f = figures(L, vatRegistered);
    vat += f.vat;
    ex += f.ex;
    return {
      itemNo: String(i + 1),
      taxCode: L.taxCode,
      nature: L.nature,
      productCodeMra: '',
      productCodeOwn: L.code || '',
      itemDesc: L.desc,
      quantity: qtyText(L.qtyMilli),
      unitPrice: money(Math.round((f.exBefore * 1000) / L.qtyMilli)),
      discount: money(f.exBefore - f.ex),
      discountedValue: money(f.ex),
      amtWoVatCur: money(f.ex),
      amtWoVatMur: money(f.ex),
      vatAmt: money(f.vat),
      totalPrice: money(f.ex + f.vat),
    };
```

The header is unchanged. Export `qtyText`, `vatAdded`, `figures` and `general`.

The old form gives `discount: money(0)` = `'0.00'` and `unitPrice = round((gross − v) / qty)`, as before.
`qtyText(qty*1000)` = `String(qty)`. The bytes are the same: the last test proves it.

- [ ] **Step 4: run them and see them pass**

Run: `node --test mra/*.test.cjs`
Expected: PASS, every test, the old ones included.

- [ ] **Step 5: the fixture the till is held to**

Create `mra/fixtures/make-invoices.cjs`. It builds a fixed list of invoices from a made-up seller and fixed times,
and writes `mra/fixtures/invoices.json` as `{ about, cases: [{ name, input, expected }] }`:

- `input` is exactly what `build()` took, with `issuedAt` as epoch milliseconds and lines in the general form;
- `expected` is `JSON.stringify(build(input))`.

The cases:

1. Test case 1, the six lines.
2. Test case 1 chained to the first.
3. A CRN of one line with a reason.
4. A TRN.
5. A seller not registered for VAT.
6. The discount spread over two lines with a cent left over.
7. VAT on top.
8. A kilo line.
9. A service charge line.
10. A name with `"`, `\`, `é`, a tab and `€`, to hold the escaping.
11. Test case 4's ten invoices as one list (`expected` = `JSON.stringify(list)`).

```js
// Writes fixtures/invoices.json: invoices built by invoice.cjs from fixed
// inputs, with a made-up seller. The till's Kotlin builds the same inputs and
// must give the same bytes (android .../core/mra/MraInvoiceTest.kt).
//   node mra/fixtures/make-invoices.cjs
const fs = require('node:fs');
const path = require('node:path');
const inv = require('../invoice.cjs');
const seller = { name: 'Made Up Ltd', tradeName: 'Made Up', tan: '12345678', brn: 'C07000000', businessAddr: 'Royal Road, Bel Air', businessPhoneNo: '+2302076000', vat: 'VATR' };
const at = Date.UTC(2026, 9, 21, 10, 0, 0);
function b(input) { return inv.build({ ...input, issuedAt: new Date(input.issuedAt) }); }
const line = (desc, qtyMilli, base, more = {}) => ({ desc, code: '', taxCode: 'TC01', nature: 'GOODS', qtyMilli, base, share: 0, vatBp: 1500, added: false, ...more });

const t1 = inv.testCase1Lines().map(inv.general);
const first = { counter: 1, identifier: 'MU-T1-000001', type: 'STD', previous: null, issuedAt: at, seller, lines: t1, payment: 'CASH' };
const ten = [];
for (let i = 0, prev = null; i < 10; i++) {
  const input = { ...first, counter: 10 + i, identifier: `MU-T1-${String(10 + i).padStart(6, '0')}`, previous: prev, lines: inv.testCase4Lines(i).map(inv.general) };
  ten.push(input);
  prev = inv.chained(b(input));
}
const cases = [
  { name: 'test case 1', input: first },
  { name: 'chained to the first', input: { ...first, counter: 2, identifier: 'MU-T1-000002', issuedAt: at + 60_000, previous: inv.chained(b(first)) } },
  { name: 'a credit note', input: { ...first, counter: 3, identifier: 'MU-T1-R000003', type: 'CRN', ref: 'MU-T1-000002', reason: 'Return of product', lines: inv.testCase3Lines().map(inv.general) } },
  { name: 'training', input: { ...first, counter: 4, identifier: 'TRN00000004', type: 'TRN', lines: inv.testCase7Lines().map(inv.general) } },
  { name: 'not registered for VAT', input: { ...first, seller: { ...seller, vat: 'NVTR' } } },
  // Calc: 10000 off 300.03 is 33.33 and 66.66 on the lines, a cent left over
  { name: 'a discount over two lines, a cent left', input: { ...first, discount: 1, lines: [line('A', 1000, 10001, { share: 3333 }), line('B', 2000, 20002, { share: 6666, taxCode: 'TC03', vatBp: 0 })] } },
  { name: 'VAT on top', input: { ...first, lines: [line('Cake', 1000, 10000, { code: 'CK', added: true })] } },
  { name: 'by the kilo', input: { ...first, lines: [line('Prawns', 250, 20000)] } },
  { name: 'service charge', input: { ...first, lines: [...t1, line('Service charge', 1000, 3000, { taxCode: 'TC03', nature: 'SERVICES', vatBp: 0 })] } },
  { name: 'escaping', input: { ...first, lines: [line('Say "hi" \\ café\t€', 1000, 11500)] } },
  { name: 'ten in one request', input: ten },
];
const out = cases.map(({ name, input }) => ({ name, input, expected: JSON.stringify(Array.isArray(input) ? input.map(b) : b(input)) }));
fs.writeFileSync(path.join(__dirname, 'invoices.json'), JSON.stringify({ about: 'Invoices built by mra/invoice.cjs from fixed inputs (made-up seller). The till is held to the same bytes.', cases: out }, null, 2) + '\n');
```

Add a test in `invoice.test.cjs` that rebuilds every case and compares it with the file, so the file and the code
never drift apart.

- [ ] **Step 6: the two probes in `mra/sandbox.cjs`**

```js
  // the owner's tests before the till is built (the phase 2 plan, D2 and D3)
  'probe-chain': { type: 'STD', lines: inv.testCase5Lines, chainTo: 'EPTSTD999999' },
  'probe-mixed': { type: 'STD', lines: probeMixedLines, discount: 1 },
```

- `chainTo`: `previous` = an invoice of that number, dated now, of Rs 1.00, that the MRA never saw.
- `probeMixedLines()`: general-form lines.
  - Rs 115 curry with a share of 11.50 of a 10 % order discount.
  - 0.250 kg of prawns at Rs 800 a kilo, with a share of 20.00.
  - A cake at Rs 100 with VAT on top, with a share of 10.00.
  - A burger with an egg add-on (base 120.00, "Burger (Egg)"), with a share of 12.00.
  - "Service charge" Rs 30.00, TC03 SERVICES, with no share.
  - The cent the shares leave goes in `discount`.
- The script prints, as for the cases, "fiscalised" or the MRA's reasons and warnings.

Add both names to `sandbox.test.cjs`'s stand-in run (sent and answered).

- [ ] **Step 7: run all and commit**

Run: `node --test mra/*.test.cjs` (expected PASS), then `node mra/fixtures/make-invoices.cjs` and
`git diff --stat` (only `invoices.json` new).

```bash
git add mra/invoice.cjs mra/invoice.test.cjs mra/sandbox.cjs mra/sandbox.test.cjs mra/fixtures/make-invoices.cjs mra/fixtures/invoices.json
git commit -m "mra: an invoice from a real sale (discount spread, VAT on top, kilos, service), the fixture the till is held to, two sandbox probes"
```

- [ ] **Step 8: the owner runs the probes.**

```bash
node mra/sandbox.cjs send probe-chain
```

```bash
node mra/sandbox.cjs send probe-mixed
```

Read `.claude/mra/out/send-*.json`. If either is refused or warned, change the table above and `invoice.cjs`
first. **Do not start Phase B on a refusal.**

---

## Phase B: the MRA part in Kotlin, test first

All of Phase B is plain Kotlin under `core/mra`, with no Android classes, tested with JUnit 4 like `CalcTest`.

Run every test: `cd android && ./gradlew --priority low --max-workers 2 :app:testDebugUnitTest --tests "com.restopos.core.mra.*"`

### Task 2: MraJson, the bytes Node writes

**Files:** create `core/mra/MraJson.kt`, test `core/mra/MraJsonTest.kt`

- [ ] **Step 1: failing test**

```kotlin
class MraJsonTest {
    @Test fun keysKeepTheirOrderAndNothingIsSpaced() {
        val j = MraJson.obj("b" to "1", "a" to MraJson.arr(listOf(MraJson.obj("x" to ""))))
        assertEquals("""{"b":"1","a":[{"x":""}]}""", MraJson.encode(j))
    }
    // JSON.stringify: " and \ escaped, \b \f \n \r \t by name, other controls as \u00xx, the rest as it is
    @Test fun stringsAreEscapedAsJavaScriptEscapesThem() {
        assertEquals("\"a\\\"b\\\\c\\n\\t\\u0001é€/\"", MraJson.encode(MraJson.Str("a\"b\\c\n\t\u0001é€/")))
    }
}
```

- [ ] **Step 2:** run it and see it fail (`MraJson` unresolved).

- [ ] **Step 3: implement**

```kotlin
package com.restopos.core.mra

// JSON as mra/invoice.cjs writes it with JSON.stringify: keys in the order
// given, nothing spaced, strings escaped the same way. The MRA accepted those
// bytes in its sandbox; the till sends the same.
object MraJson {
    sealed interface J
    data class Str(val v: String) : J
    data class Obj(val fields: List<Pair<String, J>>) : J
    data class Arr(val items: List<J>) : J

    fun obj(vararg f: Pair<String, Any>) = Obj(f.map { (k, v) -> k to (if (v is J) v else Str(v as String)) })
    fun arr(items: List<J>) = Arr(items)
    fun encode(j: J): String = StringBuilder().also { write(it, j) }.toString()

    private fun write(sb: StringBuilder, j: J) {
        when (j) {
            is Str -> quote(sb, j.v)
            is Obj -> { sb.append('{'); j.fields.forEachIndexed { i, (k, v) -> if (i > 0) sb.append(','); quote(sb, k); sb.append(':'); write(sb, v) }; sb.append('}') }
            is Arr -> { sb.append('['); j.items.forEachIndexed { i, v -> if (i > 0) sb.append(','); write(sb, v) }; sb.append(']') }
        }
    }

    private fun quote(sb: StringBuilder, s: String) {
        sb.append('"')
        var i = 0
        while (i < s.length) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c < ' ' -> sb.append("\\u").append(String.format("%04x", c.code))
                // a surrogate without its pair, as JSON.stringify writes it since ES2019
                c.isHighSurrogate() && (i + 1 >= s.length || !s[i + 1].isLowSurrogate()) -> sb.append("\\u").append(String.format("%04x", c.code))
                c.isLowSurrogate() && (i == 0 || !s[i - 1].isHighSurrogate()) -> sb.append("\\u").append(String.format("%04x", c.code))
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }
}
```

- [ ] **Step 4:** run it and see it pass. **Step 5:** commit
  (`till: MRA invoices written as JSON.stringify writes them`).

### Task 3: MraCrypto, held to `mra/fixtures/crypto.json`

**Files:** create `core/mra/MraCrypto.kt`, test `core/mra/MraCryptoTest.kt`

- [ ] **Step 1: failing test**, with the fixture found as `GuestTest` finds its file (walk up from
  `File("").absoluteFile` to the folder holding `mra/fixtures/crypto.json`).

```kotlin
class MraCryptoTest {
    private val fx = Json.parseToJsonElement(repoFile("mra/fixtures/crypto.json").readText()).jsonObject
    private fun s(o: String, k: String) = fx[o]!!.jsonObject[k]!!.jsonPrimitive.content
    private fun hex(h: String) = h.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun theHashIsTheFixtures() {
        val h = MraCrypto.previousNoteHash(Chained(s("hash", "dateTime"), s("hash", "totalAmtPaid"), s("hash", "brn"), s("hash", "invoiceIdentifier")))
        assertEquals(s("hash", "expected"), h)
    }
    @Test fun theFirstInvoiceOfAKindHasNoPrevious() = assertEquals("0", MraCrypto.previousNoteHash(null))
    @Test fun aesIsTheFixtures() {
        assertEquals(s("aes", "cipherBase64"), MraCrypto.aesEncrypt(hex(s("aes", "keyHex")), s("aes", "plain")))
        assertEquals(s("aes", "plain"), MraCrypto.aesDecrypt(hex(s("aes", "keyHex")), s("aes", "cipherBase64")))
    }
    @Test fun theMrasKeyIsUnwrapped() {
        val k = MraCrypto.unwrapKey(s("unwrap", "keyFromMra"), hex(s("unwrap", "ourKeyHex")))
        assertEquals(s("unwrap", "invoiceKeyBase64"), Base64.getEncoder().encodeToString(k))
    }
    // RSA with PKCS#1 v1.5 pads at random: what the public key seals, the private one opens
    @Test fun theLoginIsSealedWithThePublicKey() {
        val pair = KeyPairGenerator.getInstance("RSA").apply { initialize(2048) }.generateKeyPair()
        val sealed = MraCrypto.rsaEncrypt(pair.public, """{"username":"u"}""")
        val c = Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.DECRYPT_MODE, pair.private) }
        assertEquals("""{"username":"u"}""", String(c.doFinal(Base64.getDecoder().decode(sealed)), Charsets.UTF_8))
    }
    @Test fun aKeyOfAnotherLengthIsRefused() {
        val ours = ByteArray(32)
        val wrapped = MraCrypto.aesEncrypt(ours, Base64.getEncoder().encodeToString(ByteArray(16)))
        assertThrows(IllegalArgumentException::class.java) { MraCrypto.unwrapKey(wrapped, ours) }
    }
}
```

The certificate path is tested here too, with a made-up certificate (not the MRA's), made once and committed:
`openssl req -x509 -newkey rsa:2048 -nodes -keyout NUL -subj "/CN=EasyPay test" -days 3650 -out mra/fixtures/test-cert.crt`.

```kotlin
    @Test fun theCertificatesKeyIsRead() {
        val key = MraCrypto.publicKeyOf(repoFile("mra/fixtures/test-cert.crt").readBytes())
        assertEquals("RSA", key.algorithm)
        assertTrue(MraCrypto.rsaEncrypt(key, "x").isNotEmpty())
    }
```

- [ ] **Step 3: implement**

```kotlin
package com.restopos.core.mra

// The cryptography of the MRA e-invoicing system (technical guide v1.3), as
// mra/crypto.cjs does it and held to the same fixed values:
//   - sign-in: our own random AES-256 key goes with the login in a JSON sealed
//     with the MRA's public key (RSA, PKCS#1 v1.5), then base64;
//   - the MRA answers with a key for invoices, base64 of AES-256-ECB, under our
//     key, of the base64 of the 32 bytes that encrypt invoices;
//   - an invoice list is AES-256-ECB (PKCS#7) under those 32 bytes, base64;
//   - each invoice carries sha256 of the one before it of its kind, capital hex.
object MraCrypto {
    fun previousNoteHash(prev: Chained?): String {
        if (prev == null) return "0"
        val joined = prev.dateTime + prev.totalAmtPaid + prev.brn + prev.invoiceIdentifier
        return MessageDigest.getInstance("SHA-256").digest(joined.toByteArray(Charsets.UTF_8)).joinToString("") { "%02X".format(it) }
    }
    fun newAesKey(): ByteArray = ByteArray(32).also { SecureRandom().nextBytes(it) }
    fun aesEncrypt(key: ByteArray, plain: String): String =
        b64(aes(Cipher.ENCRYPT_MODE, key).doFinal(plain.toByteArray(Charsets.UTF_8)))
    fun aesDecrypt(key: ByteArray, base64: String): String =
        String(aes(Cipher.DECRYPT_MODE, key).doFinal(Base64.getDecoder().decode(base64)), Charsets.UTF_8)
    fun unwrapKey(keyFromMra: String, ourKey: ByteArray): ByteArray {
        val k = Base64.getDecoder().decode(aesDecrypt(ourKey, keyFromMra).trim())
        require(k.size == 32) { "the key from the MRA is ${k.size} bytes, not 32" }
        return k
    }
    fun publicKeyOf(certificate: ByteArray): PublicKey =
        CertificateFactory.getInstance("X.509").generateCertificate(certificate.inputStream()).publicKey
    fun rsaEncrypt(key: PublicKey, plain: String): String =
        b64(Cipher.getInstance("RSA/ECB/PKCS1Padding").apply { init(Cipher.ENCRYPT_MODE, key) }.doFinal(plain.toByteArray(Charsets.UTF_8)))

    // Java's "PKCS5Padding" is PKCS#7 for AES
    private fun aes(mode: Int, key: ByteArray) = Cipher.getInstance("AES/ECB/PKCS5Padding").apply { init(mode, SecretKeySpec(key, "AES")) }
    private fun b64(b: ByteArray) = Base64.getEncoder().encodeToString(b)
}
```

(`java.util.Base64` is there from Android 8, the till's lowest.)

- [ ] **Steps 4 and 5:** pass, commit (`till: the MRA's encryption, held to mra/fixtures/crypto.json`).

### Task 4: MraInvoice, byte for byte

**Files:** create `core/mra/MraInvoice.kt`, tests `core/mra/MraInvoiceTest.kt` and `core/mra/MraSandboxInvoicesTest.kt`

- [ ] **Step 1: failing tests**

`MraInvoiceTest` reads `mra/fixtures/invoices.json`. For each case it turns `input` into a `MraInvoice.Input`,
builds it, and asserts `MraJson.encode(...)` equals `expected`. A list case encodes as `[` + joined + `]`. Plus:

```kotlin
@Test fun moneyAndQuantities() {
    assertEquals("115.00", MraInvoice.money(11500)); assertEquals("0.05", MraInvoice.money(5)); assertEquals("-0.05", MraInvoice.money(-5))
    assertEquals("2", MraInvoice.qtyText(2000)); assertEquals("0.25", MraInvoice.qtyText(250)); assertEquals("1.125", MraInvoice.qtyText(1125))
}
@Test fun mauritiusTime() = assertEquals("20261022 02:00:00", MraInvoice.mraDateTime(Instant.parse("2026-10-21T22:00:00Z").toEpochMilli()))
@Test fun aNoteNamesWhatItCorrects() {
    assertThrows(IllegalArgumentException::class.java) { MraInvoice.build(input(type = "CRN", ref = "", reason = "x")) }
    assertThrows(IllegalArgumentException::class.java) { MraInvoice.build(input(type = "CRN", ref = "A-1", reason = "")) }
}
```

`MraSandboxInvoicesTest` is for this PC only. It reads `.claude/mra/out/invoice-*.json` and skips with
`Assume.assumeTrue(dir.isDirectory)` when they are absent (CI, other PCs). For each invoice in each file:

- (a) Rebuild it with Kotlin: the seller, counter, identifier, ref, reason and time are read from the file; the lines
  come from the test case its type and descriptions name (`MraTestCases`, a test helper with the same seven line
  lists as `invoice.cjs`). Compare with `JSON.stringify` of that invoice: the file is pretty-printed, so parse
  it and encode it again with `MraJson` from a tree kept in order (kotlinx's `JsonObject` keeps the file's
  order).
- (b) When `previousNoteHash` is not `0`: find the earlier invoice in the files whose `previousNoteHash(chained(earlier))`
  is that value, and fail when none is.

This holds the Kotlin to bytes the MRA actually fiscalised, without committing them.

- [ ] **Step 3: implement**

```kotlin
package com.restopos.core.mra

// An EasyPay receipt as the MRA's e-invoice, as mra/invoice.cjs builds it
// (the rules are in docs/superpowers/plans/2026-10-21-mra-phase-2-till.md),
// held to mra/fixtures/invoices.json and to what the MRA's sandbox fiscalised.
data class Seller(val name: String, val tradeName: String, val tan: String, val brn: String, val businessAddr: String, val businessPhoneNo: String = "", val vatRegistered: Boolean = true)
// one line: qtyMilli in thousandths, base what it charges before the order
// discount (cents, add-ons in), share its part of that discount, vatBp its tax
// rate, added when the tax goes on top
data class Line(val desc: String, val code: String, val taxCode: String, val nature: String, val qtyMilli: Int, val base: Long, val share: Long = 0, val vatBp: Int = 0, val added: Boolean = false)
// what the next invoice of the same type hashes, as this one was sent
data class Chained(val dateTime: String, val totalAmtPaid: String, val brn: String, val invoiceIdentifier: String)

object MraInvoice {
    data class Input(
        val counter: Long, val identifier: String, val type: String, val previous: Chained?, val issuedAt: Long,
        val seller: Seller, val lines: List<Line>, val payment: String, val discount: Long = 0,
        val transaction: String = "B2C", val counterNo: String = "1", val cashier: String = "", val ref: String = "", val reason: String = "",
    )
    class Built(val json: MraJson.Obj, val chained: Chained) { val text get() = MraJson.encode(json) }

    fun money(cents: Long): String { val a = abs(cents); return (if (cents < 0) "-" else "") + (a / 100) + "." + (a % 100).toString().padStart(2, '0') }
    fun qtyText(milli: Int): String { val rest = (abs(milli) % 1000).toString().padStart(3, '0').trimEnd('0'); return if (rest.isEmpty()) (milli / 1000).toString() else "${milli / 1000}.$rest" }
    // Mauritius is UTC+4 all year, with no summer time
    fun mraDateTime(epochMs: Long): String = DateTimeFormatter.ofPattern("yyyyMMdd HH:mm:ss").withZone(ZoneOffset.ofHours(4)).format(Instant.ofEpochMilli(epochMs))
    fun vatIncluded(gross: Long, bp: Int): Long = if (bp > 0) (gross * bp + (10000 + bp) / 2) / (10000 + bp) else 0
    fun vatAdded(net: Long, bp: Int): Long = if (bp > 0) (net * bp + 5000) / 10000 else 0

    class Figures(val exBefore: Long, val ex: Long, val vat: Long)
    fun figures(l: Line, vatRegistered: Boolean): Figures {
        val net = l.base - l.share
        val vat = if (!vatRegistered) 0 else if (l.added) vatAdded(net, l.vatBp) else vatIncluded(net, l.vatBp)
        val exBefore = if (!vatRegistered || l.added) l.base else l.base - vatIncluded(l.base, l.vatBp)
        return Figures(exBefore, if (l.added) net else net - vat, vat)
    }

    fun build(i: Input): Built {
        if (i.type == "CRN" || i.type == "DRN") {
            require(i.ref.isNotEmpty()) { "A ${i.type} names the invoice it corrects." }
            require(i.reason.isNotEmpty()) { "A ${i.type} gives its reason." }
        }
        var vat = 0L; var ex = 0L
        val items = i.lines.mapIndexed { n, l ->
            val f = figures(l, i.seller.vatRegistered)
            vat += f.vat; ex += f.ex
            MraJson.obj(
                "itemNo" to (n + 1).toString(), "taxCode" to l.taxCode, "nature" to l.nature, "productCodeMra" to "",
                "productCodeOwn" to l.code, "itemDesc" to l.desc, "quantity" to qtyText(l.qtyMilli),
                // Math.round in JavaScript: half up
                "unitPrice" to money((f.exBefore * 1000 * 2 + l.qtyMilli) / (2L * l.qtyMilli)),
                "discount" to money(f.exBefore - f.ex), "discountedValue" to money(f.ex),
                "amtWoVatCur" to money(f.ex), "amtWoVatMur" to money(f.ex), "vatAmt" to money(f.vat), "totalPrice" to money(f.ex + f.vat),
            )
        }
        val total = vat + ex
        val at = mraDateTime(i.issuedAt)
        val paid = money(total - i.discount)
        val json = MraJson.obj(
            "invoiceCounter" to i.counter.toString(), "transactionType" to i.transaction,
            "personType" to (if (i.seller.vatRegistered) "VATR" else "NVTR"), "invoiceTypeDesc" to i.type, "currency" to "MUR",
            "invoiceIdentifier" to i.identifier, "invoiceRefIdentifier" to i.ref, "previousNoteHash" to MraCrypto.previousNoteHash(i.previous),
            "reasonStated" to i.reason.take(100), "totalVatAmount" to money(vat), "totalAmtWoVatCur" to money(ex), "totalAmtWoVatMur" to money(ex),
            "invoiceTotal" to money(total), "discountTotalAmount" to money(i.discount), "totalAmtPaid" to paid, "dateTimeInvoiceIssued" to at,
            "seller" to MraJson.obj(
                "name" to i.seller.name, "tradeName" to i.seller.tradeName, "tan" to i.seller.tan, "brn" to i.seller.brn,
                "businessAddr" to i.seller.businessAddr, "businessPhoneNo" to i.seller.businessPhoneNo, "ebsCounterNo" to i.counterNo, "cashierID" to i.cashier,
            ),
            "buyer" to MraJson.obj("name" to "", "tan" to "", "brn" to "", "businessAddr" to "", "buyerType" to "NVTR", "nic" to ""),
            "itemList" to MraJson.arr(items),
            "salesTransactions" to i.payment,
        )
        return Built(json, Chained(at, paid, i.seller.brn, i.identifier))
    }

    // a request's invoices, as JSON.stringify writes a list
    fun list(invoices: List<String>) = invoices.joinToString(",", "[", "]")
}
```

JavaScript's `.slice(0, 100)` counts UTF-16 units, and so does Kotlin's `take(100)`.

- [ ] **Steps 4 and 5:** pass both, then commit
  (`till: the MRA invoice, byte for byte as mra/invoice.cjs and the sandbox`). `MraSandboxInvoicesTest` must
  have run (not skipped) on this PC before the commit: check the test report for it.

### Task 5: MraApi, the two calls as requests and answers

**Files:** create `core/mra/MraApi.kt`, test `core/mra/MraApiTest.kt`

The tests mirror `mra/api.test.cjs`, one by one:

- the sign-in's header names the user, the EBS and the area code, and the private key opens the sealed login,
  which reads `{"username":…,"password":…,"encryptKey":…,"refreshToken":"false"}` in that order;
- with no area code, there is no `areaCode` header;
- `refresh = true` gives `"true"`;
- a successful answer gives the token, the unwrapped key and when it ends (`mraMoment("20261022 17:18:00")` =
  that time at UTC+4);
- a refused answer gives its errors only;
- a transmission's body is `{"requestId","requestDateTime","signedHash":"","encryptedInvoice"}` in that order,
  decrypts to the list it was given, and has the token in its header;
- an answer gives each invoice's IRN and QR code or its errors, as `"CODE: description"`;
- a request id is at most 50 characters and two are never the same.

```kotlin
package com.restopos.core.mra

// The MRA's two calls (technical guide v1.3) as requests and answers, as
// mra/api.cjs: no network here (MraHttp sends).
object MraApi {
    const val TEST_BASE = "https://vfisc.mra.mu"
    fun tokenUrl(base: String) = "$base/einvoice-token-service/token-api/generate-token"
    fun transmitUrl(base: String) = "$base/realtime/invoice/transmit"

    data class Who(val username: String, val password: String, val ebsMraId: String, val areaCode: String)
    data class Request(val url: String, val headers: List<Pair<String, String>>, val body: String)

    fun requestId(now: Long = System.currentTimeMillis()): String = "EP$now" + ByteArray(4).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    private fun header(w: Who) = listOfNotNull("Content-Type" to "application/json", "username" to w.username, "ebsMraId" to w.ebsMraId, w.areaCode.takeIf { it.isNotEmpty() }?.let { "areaCode" to it })

    fun tokenRequest(base: String, w: Who, aesKey: ByteArray, refresh: Boolean, mraKey: PublicKey, id: String = requestId()): Request {
        val login = MraJson.encode(MraJson.obj("username" to w.username, "password" to w.password, "encryptKey" to Base64.getEncoder().encodeToString(aesKey), "refreshToken" to (if (refresh) "true" else "false")))
        return Request(tokenUrl(base), header(w), MraJson.encode(MraJson.obj("requestId" to id, "payload" to MraCrypto.rsaEncrypt(mraKey, login))))
    }

    fun transmitRequest(base: String, w: Who, token: String, invoiceKey: ByteArray, invoices: List<String>, now: Long, id: String = requestId(now)): Request =
        Request(transmitUrl(base), header(w) + ("token" to token), MraJson.encode(MraJson.obj(
            "requestId" to id, "requestDateTime" to MraInvoice.mraDateTime(now), "signedHash" to "",
            "encryptedInvoice" to MraCrypto.aesEncrypt(invoiceKey, MraInvoice.list(invoices)),
        )))

    sealed interface Token
    class Signed(val token: String, val invoiceKey: ByteArray, val expiryDate: String, val expiresAt: Long?) : Token
    data class Refused(val errors: List<String>) : Token
    fun readToken(answer: JsonObject, aesKey: ByteArray): Token {
        val status = answer.str("status"); val token = answer.str("token"); val key = answer.str("key")
        if (status != "SUCCESS" || token.isNullOrEmpty() || key.isNullOrEmpty())
            return Refused(said(answer["errors"]).ifEmpty { listOf(if (status != null) "status $status" else "no answer") })
        val expiry = answer.str("expiryDate") ?: ""
        return Signed(token, MraCrypto.unwrapKey(key, aesKey), expiry, mraMoment(expiry))
    }

    data class Fiscal(val identifier: String, val status: String, val irn: String?, val qr: String?, val errors: List<String>, val warnings: List<String>)
    data class Transmitted(val status: String, val environment: String?, val responseId: String?, val errors: List<String>, val info: List<String>, val invoices: List<Fiscal>)
    fun readTransmit(a: JsonObject) = Transmitted(
        a.str("status") ?: "", a.str("environment"), a.str("responseId"), said(a["errorMessages"]), said(a["infoMessages"]),
        (a["fiscalisedInvoices"] as? JsonArray).orEmpty().map { e ->
            val f = e.jsonObject
            Fiscal(f.str("invoiceIdentifier") ?: "", f.str("status") ?: "", f.str("irn"), f.str("qrCode"), said(f["errorMessages"]), said(f["warningMessages"]))
        },
    )

    // "yyyyMMdd HH:mm:ss" in Mauritius time as a moment
    fun mraMoment(text: String?): Long? {
        val m = Regex("""^(\d{4})(\d{2})(\d{2}) (\d{2}):(\d{2}):(\d{2})""").find(text?.trim() ?: return null) ?: return null
        val (y, mo, d, h, mi, s) = m.destructured
        return LocalDateTime.of(y.toInt(), mo.toInt(), d.toInt(), h.toInt(), mi.toInt(), s.toInt()).toInstant(ZoneOffset.ofHours(4)).toEpochMilli()
    }

    // the MRA's messages, as words or as {code, description}
    private fun said(e: JsonElement?): List<String> = (e as? JsonArray).orEmpty().map { m ->
        if (m is JsonPrimitive) m.content else m.jsonObject.let { "${(it.str("code") ?: "").trim()}: ${(it.str("description") ?: "").trim()}" }
    }
    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content
}
```

Commit: `till: the MRA's sign-in and transmission as requests and answers`.

### Task 6: MraLines, a receipt as the MRA's lines, and the checks before paying

**Files:** create `core/mra/MraLines.kt`, test `core/mra/MraLinesTest.kt`

```kotlin
// One line of a sale as the till has it: what it charges before the order
// discount (Calc's base, add-ons in), its taxes, and what the MRA needs.
data class SaleLine(val name: String, val addons: List<String>, val sku: String?, val qtyMilli: Int, val base: Long, val taxes: List<Calc.TaxRate>, val mraCode: String?, val nature: String)

object MraLines {
    // the order discount spread as Calc spreads it; the cents it leaves are the invoice's own discount
    fun ofSale(lines: List<SaleLine>, discount: Long, service: Long): Pair<List<Line>, Long>
    fun ofRefund(parts: List<Pair<SaleLine, RefundCalc.Parts>>, service: Long): Pair<List<Line>, Long>
    // the tax code a tax would have: its own, or the one its rate suggests (as web/lib/mra.ts suggests it)
    fun code(own: String?, rateBp: Int): String = own ?: if (rateBp == 1500) "TC01" else if (rateBp == 0) "TC02" else "TC01"
    fun payment(parts: List<Pair<String /*kind*/, Long>>): String   // choice 7
    // why this sale cannot go to the MRA, or null
    fun refusal(lines: List<SaleLine>): String?                      // choice 11: a line with two taxes
}
```

Tests (failing first), each with the figures worked out by hand in the test's comment:

- A sale with no discount gives `share = 0` on every line, and `MraInvoice.build` of those lines equals test case 1
  built from the old form.
- A 10 % discount on Rs 115 + Rs 230: the shares are 11.50 and 23.00, and the invoice's VAT equals
  `Calc.totals(...).tax`.
- A discount that leaves a cent: the leftover is returned as the invoice discount, and `totalAmtPaid` equals
  `Calc.totals(...).total` without its rounding.
- **For any sale made of 1 to 6 random lines** (fixed seed, 500 rounds, rates 0 or 1500, included or on top, a
  random discount): the invoice's `totalVatAmount` = `money(Calc.tax)`, and `totalAmtPaid` + service =
  `money(Calc.total − rounding)`. This holds the MRA's figures to the receipt's.
- The service charge is the last line, SERVICES, TC03, quantity 1.
- Add-ons go in brackets: "Burger (Egg, Cheese)". A name over 100 characters is cut.
- Payment: on account wins; then the largest payment; a tie goes to the first given.
- A line with two taxes is refused, and the item is named.

Commit: `till: a receipt's lines as the MRA's, held to Calc`.

### Task 7: MraQr, the QR code printed 2 x 2 cm

**Files:** create `core/mra/MraQr.kt`, test `core/mra/MraQrTest.kt`

The MRA's QR is a 350 x 350 one-bit PNG. Printed at 8 dots a millimetre, 2 cm is 160 dots.

- [ ] **Step 1: failing test**: zxing (already in the till) makes a 350 x 350 QR of a known text. `MraQr.raster`
  makes it 160 dots. The raster is turned back into pixels, and zxing's `QRCodeReader` must read the same text.

```kotlin
@Test fun theQrStillReadsAtTwoCentimetres() {
    val text = "MRA|EPTSTD000001|IRN0123456789ABCDEF|20261021 17:26:00|792.50"
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 350, 350)
    val r = MraQr.raster(350, 350) { x, y -> m.get(x, y) }
    assertEquals(160, r.height); assertEquals(20, r.widthBytes)
    val pixels = IntArray(160 * 160) { i -> val x = i % 160; val y = i / 160
        if ((r.bits[y * r.widthBytes + x / 8].toInt() shr (7 - x % 8)) and 1 == 1) 0xFF000000.toInt() else -1 }
    val read = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(160, 160, pixels))))
    assertEquals(text, read.text)
}
```

- [ ] **Step 3: implement**

```kotlin
// The QR code the MRA sends back, a PNG, printed 2 x 2 cm (the MRA's rule):
// 160 dots at 8 a millimetre, each dot the pixel at the middle of its part of
// the picture. The PNG is read by the caller (Android's BitmapFactory).
object MraQr {
    const val DOTS = 160
    fun raster(w: Int, h: Int, dots: Int = DOTS, dark: (Int, Int) -> Boolean): Raster {
        val wb = (dots + 7) / 8
        val bits = ByteArray(wb * dots)
        for (y in 0 until dots) {
            val sy = ((2 * y + 1) * h) / (2 * dots)
            for (x in 0 until dots) {
                val sx = ((2 * x + 1) * w) / (2 * dots)
                if (dark(sx, sy)) bits[y * wb + x / 8] = (bits[y * wb + x / 8].toInt() or (0x80 ushr (x % 8))).toByte()
            }
        }
        return Raster(wb, dots, bits)
    }
}
```

Commit: `till: the MRA's QR code as a 2 cm picture that still reads`.

---

## Phase C: what the till and the server learn

### Task 8: migration 0132 and its test

**Files:** create `db/migrations/0132_mra_till.sql`, `db/tests/mra-till.test.cjs`; modify `db/scripts/delete-client.cjs`

Run `git fetch github` and check again that 0132 is free. Start from the live definitions:
`node db/scripts/dump-function.cjs sync_push`, `… set_tenant_mra`, `… set_till_mra_ids`.

- [ ] **Step 1: the test first** (`db/tests/mra-till.test.cjs`, one transaction rolled back, as `mra-setup.test.cjs`)

1. `set_tenant_mra` refuses `training` while the checklist has a gap, and takes it once complete.
   - It refuses `live` while the client is still setting up (`platform.is_setting_up`).
   - It takes `live` after Go live, sets `mra_live_since` once and never clears it, and writes the audit.
   - It refuses `setting_up` from `live`.
2. `pos_settings.data` gets `mra`, `mra_seller` {legal_name, tan, nature} and (D1 a) `mra_connect` {url, certificate}.
3. `mra.record` pushed by a till:
   - it writes the row;
   - it raises `pos_devices.mra_counter` to the counter;
   - it sets `mra_chain` for its type;
   - a later answer (`fiscalised`, IRN, QR) updates only the answer columns;
   - a replay changes nothing;
   - a record of another tenant's device is refused (`bad-mra-record`).
4. A direct `update mra_records set invoice = …` as `app_user` is refused (`mra-record-fixed`), and so is `delete`.
5. `differs` is set when the receipt's total less its rounding is not the invoice's `totalAmtPaid`, and null when
   it is.
6. `mra.status` writes `pos_devices.mra_status` with the server's time.
7. `set_till_mra_ids` moving an EBS MRA ID from till A to till B carries A's counter and chains to B.
8. A payment correction on a live client now comes back as `rejected:mra-no-correction`, not `error`.

Run: `node db/tests/mra-till.test.cjs` → FAIL (no 0132). Run it alone: never two suites at once.

- [ ] **Step 2: the migration**

```sql
-- 0132_mra_till.sql — MRA e-invoicing, phase 2: the till sends, the server learns.
-- docs/superpowers/plans/2026-10-21-mra-phase-2-till.md, design 2026-10-17-premium-mra-design.md 7, 8, 10.
-- Source: live definitions (dump-function.cjs) of sync_push, set_tenant_mra, set_till_mra_ids.
-- What changes:
--   mra_records       one row per document a till issued for the MRA, as it sent it; only the MRA's
--                     answer is ever written after (a trigger), never deleted
--   pos_devices       mra_counter, mra_chain (restored to a reinstalled till by the pull), mra_status
--   sync_push         mra.record, mra.status; the codes bad-mra-record, mra-record-fixed, mra-no-correction
--   set_tenant_mra    training and live (the checklist complete; live only after Go live; mra_live_since)
--   pos_settings      mra_seller (and mra_connect) for the tills
-- Never edit after merge.

create table if not exists mra_records (
  id uuid primary key,
  tenant_id uuid not null references tenants(id),
  store_id uuid not null,
  device_id uuid not null,
  ebs_id text not null,
  receipt_id uuid,                        -- none for a test-drive document (debug build)
  doc_type text not null check (doc_type in ('STD', 'CRN', 'DRN', 'PRF', 'TRN')),
  counter bigint not null check (counter > 0),
  identifier text not null,
  ref_identifier text,
  previous_hash text not null,
  invoice text not null,                  -- the bytes sent, not jsonb (jsonb reorders keys)
  issued_at timestamptz not null,
  status text not null default 'waiting' check (status in ('waiting', 'unsure', 'check', 'fiscalised', 'refused')),
  irn text,
  qr text,
  errors jsonb not null default '[]',
  warnings jsonb not null default '[]',
  answered_at timestamptz,
  response_id text,
  differs jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  server_seq bigint,
  unique (tenant_id, id)
);
-- the tenant table shape every table has (0114:48-75): server_seq default, index, RLS forced,
-- policy tenant_isolation, trg_touch; then:
revoke delete on mra_records from app_user;

create or replace function mra_records_answer_only() returns trigger language plpgsql as $$
begin
  if (new.tenant_id, new.store_id, new.device_id, new.ebs_id, new.receipt_id, new.doc_type, new.counter, new.identifier,
      new.ref_identifier, new.previous_hash, new.invoice, new.issued_at)
     is distinct from
     (old.tenant_id, old.store_id, old.device_id, old.ebs_id, old.receipt_id, old.doc_type, old.counter, old.identifier,
      old.ref_identifier, old.previous_hash, old.invoice, old.issued_at) then
    raise exception 'mra-record-fixed';
  end if;
  return new;
end $$;
-- trg_mra_records_answer_only before update for each row

alter table pos_devices add column if not exists mra_counter bigint not null default 0;
alter table pos_devices add column if not exists mra_chain jsonb not null default '{}';
alter table pos_devices add column if not exists mra_status jsonb;
```

- `push_mra_record(p_tenant, p_emp, p)` does the following.
  - It checks the device belongs to the tenant, is not deleted, and is in `store_id`; otherwise it raises
    `bad-mra-record`.
  - It inserts, or on conflict updates only `status`, `irn`, `qr`, `errors`, `warnings`, `answered_at` and
    `response_id`. A `fiscalised` or `refused` row is final.
  - It sets `differs` from the receipt (`receipts.total − receipts.rounding` against
    `(invoice::jsonb->>'totalAmtPaid')`, in cents).
  - It updates `pos_devices`:
    - `mra_counter = greatest(mra_counter, counter)`;
    - `mra_chain = mra_chain || {type: {counter, dateTime, totalAmtPaid, brn, identifier}}` when the counter is above
      the one stored for that type.
- `push_mra_status`: `update pos_devices set mra_status = p->'status' || jsonb_build_object('at', now())`.
- `sync_push`: the two `when` branches; the three codes added to `codes`.
- `set_tenant_mra`: the allowed moves are:
  - `off` from anything;
  - `off` → `setting_up`;
  - `setting_up` ↔ `training`;
  - `training` → `live`.

  `training` and `live` need `mra_checklist` all ok (its `login` line is the till's and is not counted). `live`
  needs `not platform.is_setting_up(p_tenant)` and sets `mra_live_since = coalesce(mra_live_since, now())`. It
  writes `mra` and `mra_seller` into `pos_settings`.
- `set_till_mra_ids`: carries the counter and chains with the ID it moves.
- A backfill: `mra_seller` for every tenant whose `mra` is not `off`.
- D1 a: `create table platform.mra_connection (id int primary key default 1 check (id = 1), url text not null, certificate text not null, updated_at timestamptz)`,
  with `platform.set_mra_connection(p_admin, p_url, p_certificate)` writing `mra_connect` into every MRA client's
  `pos_settings`. `set_tenant_mra` writes it when moving to `training`.

- [ ] **Step 3:** `node db/migrate.cjs` (dev, after checking the host is dev-review), then
  `node db/tests/mra-till.test.cjs` → PASS. Then `node db/tests/mra-setup.test.cjs` and
  `node db/tests/isolation.test.cjs`, one after the other: `rls_coverage` must accept the new table.
- [ ] **Step 4:** `delete-client.cjs` deletes `mra_records` before the tenant (it already refuses a client that
  went live).
- [ ] **Step 4b: EasyPay's Go live and Clear test activity.** A client trains with the MRA while it is still
  setting up, so Go live runs over training records. Read `platform.go_live` (0104) and
  `platform.clear_test_activity` (live definitions).
  - Neither deletes `mra_records`, or fails on them (no foreign key from `mra_records` to `receipts`).
  - Neither resets `pos_devices.mra_counter` or `mra_chain`: the TRN invoices were sent to the MRA and stay.

  Add both to `mra-till.test.cjs`: clear test activity on a training client, and the records and counter are
  still there.
- [ ] **Step 5:** commit (`database: what the MRA tills send (0132): mra_records, the chain per till, training and live`).

### Task 9: back office and /admin

**Files:** `web/app/backoffice/company/page.tsx`, `web/app/admin/tenants/[id]/mra.tsx`, `web/app/admin/tenants/[id]/page.tsx`,
`web/lib/mra.ts`, `web/lib/mra.test.mjs`, the credit notes page, and the D1 a field.

- **Company save:** after it updates `tenants`, it writes `mra_seller` with `saveSettings` (the same keys as 0132).
- **`/admin` MRA panel:**
  - "Start training" (from setting up);
  - "Back to setting up" (from training);
  - "Go live with the MRA" (from training; `ConfirmSubmit`: "Every till sends real invoices from its next sale.
    Do it after the day is closed.");
  - "Turn MRA off" stays.

  `setMra`'s notice names the state reached. `MRA_STATE_WORDS` already has the words.
- **Checklist:** the `login` line says "Each till's manager connects it on the till: Settings, MRA".
- **Credit notes:** for a client on MRA, the page title and the paper say "Store credit" (design section 7).
- **D1 a:** an "MRA connection" card in `/admin`: the address (default `https://vfisc.mra.mu`) and the
  certificate as pasted PEM. It shows when the certificate ends (read with Node's `X509Certificate`).
- **Tests:** `web/lib/mra.test.mjs` for the state moves offered, then `npx tsc --noEmit` and `npm run lint` in
  `web/`.
- **Commit:** `back office: training and live for MRA clients, the seller for the tills, store credit`.

### Task 10: Room 35 and the pull

**Files:**
- Create `core/database/Mra.kt`.
- Modify `Entities.kt`, `TillDatabase.kt`, `Migrations.kt`, `AppModule.kt`, `PullApplier.kt`, `PosSettings.kt`.
- Create the test `core/data/PosSettingsMraTest.kt`.

```kotlin
// One document this till issued for the MRA, as it was sent (design section 8).
// Only the MRA's answer is written after it is made.
@Entity(tableName = "mra_invoices", indices = [Index("status"), Index("counter")])
data class MraInvoiceEntity(
    @PrimaryKey val id: String,        // the receipt's id; a test-drive document its own
    val tenant_id: String,
    val store_id: String,
    val device_id: String,
    val ebs_id: String,
    val receipt_id: String?,
    val type: String,                  // STD, CRN, TRN (DRN, PRF only from the debug build)
    val counter: Long,
    val identifier: String,
    val ref_identifier: String?,
    val previous_hash: String,
    val invoice: String,
    val issued_at: Long,
    val status: String = "waiting",    // waiting, unsure, check, fiscalised, refused
    val unanswered: Int = 0,           // sends that went and got no answer
    val irn: String? = null,
    val qr: String? = null,
    val errors: String = "[]",
    val warnings: String = "[]",
    val answered_at: Long? = null,
    val response_id: String? = null,
)
```

- **`MraDao`:**
  - `insert`;
  - `answer(id, status, irn, qr, errors, warnings, answeredAt, responseId)`;
  - `sending(ids)`, written just before a request goes: `unsure`, one more `unanswered`, or `check` when it
    reaches 2 (Task 12);
  - `notSent(ids, before)`, which puts them back as they were when a request was not reached or was refused as a
    whole;
  - `waiting(limit)`: `status in ('waiting','unsure') order by counter`;
  - `byReceipt(id)`, `counts(): Flow<MraCounts>`, `lastIssued(type)`, `latestIssuedAt()`, `problems(): Flow<List<…>>`.
- **`DeviceEntity`:** `mra_ebs_id: String? = null`, `mra_counter: Long = 0`, `mra_chain: String = "{}"`.
- **Other entities:** `TaxEntity.mra_code: String? = null`, `CategoryEntity.mra_nature: String? = null`,
  `StoreEntity.address: String? = null`.
- **`V34_V35`:** the `ALTER TABLE`s and `CREATE TABLE mra_invoices`, as Room writes them in `schemas/…/35.json`.
  The build writes that file: copy its SQL, do not write it by hand.
- **`PullApplier`:**
  - reads the new columns;
  - `mra_counter = maxOf(local, server)`;
  - `mra_chain` merged per type by the higher counter, the same way `last_receipt_seq` is kept;
  - when it applies this till's own device row, it sets `SessionStore.mraRestored = true` (design section 7: an
    MRA till does not sell until it has them back).
- **`PosSettings`:** `mra` (`off` when absent), `mraSeller` (legal name, TAN, nature) and `mraConnect` (address,
  certificate). `mraOn` is true for `training` and `live`.
- **Go live on the tablet** (`core/database/GoLive.kt`, `core/data/GoLive.kt`): `numbersFromOne` resets
  `last_receipt_seq` only, never `mra_counter` or `mra_chain`. The `mra_invoices` rows and the queued `mra.record` /
  `mra.status` ops survive it, so what was sent in training stays sent and still reaches the server. Read what Go
  live clears and what `GoLiveRules.RUNG_UP` decides before adding the two kinds. Test it in `GoLiveRulesTest` and
  in a pure test of what `numbersFromOne` changes.
- **Tests:** `PosSettingsMraTest` parses each one, and holds that a missing `mra` is `off`. Run every unit test.
  On the emulator, the Room 34 → 35 migration is seen when the build is installed over 34 (Task 18).
- **Commit:** `till: what the MRA needs comes down with the pull (Room 35)`.

---

## Phase D: the till sends

### Task 11: the invoice is made with the sale

**Files:** create `core/mra/MraIssuer.kt`; modify `TicketRepository.pay`, `OrderOps.refund`; test `core/mra/MraIssuerTest.kt`
(the pure part: what the next counter, number, type and previous are).

- `MraIssuer.plan(settings, device, sale|refund, lastOfType)` is pure. It returns `Skip`, `Refuse(reason)` or
  `Issue(type, counter, identifier, ref, previous)`.
  - `Skip` when `mra` is off or setting up.
  - `Refuse(reason)`:
    - live with no EBS MRA ID;
    - `mraRestored` false;
    - a line with two taxes;
    - the clock known to be over 5 minutes off (`ApiClient.clockAhead` not null and |value| > 300 000);
    - the clock earlier than the last invoice's `issued_at`.
- **In `pay()`:** before the transaction, `plan` runs, and `Refuse` fails the payment with its reason, as the other
  `require`s do. Inside `db.withTransaction`, after `upsertDevices`, it:
  - builds the invoice (`MraLines.ofSale`, `MraInvoice.build`);
  - inserts the `MraInvoiceEntity`;
  - updates the device's `mra_counter` and `mra_chain`;
  - queues `mra.record` (the row, waiting) after `receipt.create`.
- **In `refund()`:** the same with `MraLines.ofRefund`. A whole refund copies the sale's items from its invoice. The
  reason is the refund's reason.
- **Tests:**
  - training, then Go live on the tablet, then a live sale: the counter goes on from the training's, and the
    TRN chain and the STD chain stay apart;
  - training gives TRN with `TRN` + counter;
  - live gives STD with the receipt number;
  - a refund in live gives CRN naming its sale;
  - the counter goes up by one across types;
  - the previous is the last of the same type;
  - each refusal is given with its words.
- **Commit:** `till: every sale and refund of an MRA client is made into its invoice as it is paid`.

### Task 12: signing in, sending, the queue

**Files:** create `MraHttp.kt`, `MraLogin.kt`, `MraSender.kt`, `MraWorker.kt`; test `MraQueueTest.kt` (the queue's
rules, pure: `MraQueue.next(waiting, originals)` and `MraQueue.after(outcome)`).

- **`MraHttp`** has its own `OkHttpClient`: connect timeout 5 s, and a call timeout of 10 s at payment or 30 s for a
  batch. An `EventListener` notes `requestBodyEnd`. The outcome is one of:
  - `Answered(http, json)`;
  - `NotReached(why)`: failed before the body was sent; the MRA never saw it;
  - `NoAnswer(why)`: the body went and no answer came; it may have been fiscalised.
- **`MraLogin`** keeps everything in `SecretStore` (Keystore AES-GCM), under its own names:
  - username, password, area code;
  - token, invoice key, token's end;
  - the last refusal.

  The password is never returned to the screen.
- **`MraSender`:**
  - `connect()`: signs in now with `refreshToken = false` and gives `Connected(until)` or `Refused(reasons)`.
  - `ensureToken()`: signs in when there is no token, when it ends within 10 minutes, or on the first send of a
    new day (with `refreshToken = true` while one is held). A refused login is tried again only after the login
    is changed, or after an hour.
  - `sendNow(id, budgetMs = 10_000)`: sends that one invoice, unless an older one of this till still waits
    (then it waits behind it) or its sale has not been fiscalised (a CRN).
  - `drain()`:
    - takes the waiting ones in counter order, at most 500;
    - stops before a CRN whose sale is on this till and not fiscalised;
    - sends them in one request;
    - repeats while there are more and each request was answered.
  - **One send at a time.** A single `Mutex` in `MraSender` is held around every request, so a payment's
    `sendNow` and the worker's `drain` never send the same invoice at once. Whoever takes the lock second
    reads the rows again first.
  - **Written down before it goes**, as `sandbox.cjs` does. Just before the body is sent, its invoices are saved
    as `unsure` with `unanswered + 1` (`MraDao.sending(ids)`), in one Room write. If the app is killed, the
    tablet dies or the request hangs, the invoice comes back as one that may have reached the MRA, never as one
    that did not.
  - What each outcome does:
    - Answered, per invoice: `fiscalised` with IRN and QR, or `refused` with its reasons; never sent again.
    - Answered, refused as a whole (HTTP 4xx with no `fiscalisedInvoices`): `MraDao.notSent(ids)` puts them
      back as they were before the send (status and `unanswered`). The MRA did not see them, so it does not
      count as their one resend.
      - An invalid token signs in once and sends again.
      - Any other whole refusal keeps its reason as the till's MRA problem: ERR0020, decryption, a body error,
        "EBS status is not active". Settings, MRA and the banner show it until a request is answered.
    - NotReached: `notSent(ids)`, the same.
    - NoAnswer: they stay as saved before the send. An `unsure` invoice is sent once more at the next drain. If
      that gets no answer either (`unanswered` reaches 2), it becomes `check` and is not sent again until a
      manager presses **Send again** (Task 14). That is the guide's 9.1: once later, never in a loop.
  - **Nothing secret in a report.** `MraHttp`'s exceptions are cut down to their class and a fixed text before
    anyone keeps them. The crash reports `PullWorker` pushes, logcat and `mra.record`'s errors never hold a
    header, a body, the token, the key or the login.
  - **The token is kept fresh by the worker**, so a sale rarely spends its 10 seconds signing in first.
  - Every answer queues `mra.record` again (the answer columns).
  - `mra.status` is queued when the login state, the token's end or the problems change, and at most once a
    minute for the waiting count.
- **`MraWorker`:**
  - `drain()` and `ensureToken()`;
  - unique periodic work every 15 minutes;
  - one-off work with `NetworkType.CONNECTED` after a send that did not get through, so it runs when the line is
    back;
  - started where `SyncScheduler.startPeriodic` is.
- **Tests** (`MraQueueTest`, pure):
  - the order;
  - 500 a request;
  - a CRN held behind its sale;
  - each outcome's new status;
  - two unanswered sends gives `check`;
  - a request refused as a whole, or not reached, puts the rows back as they were;
  - **a restart in the middle of a send:** the rows saved before the send, then no outcome. The next drain sends
    them once more as `unsure`, and the one after that makes them `check`.
- **Commit:** `till: the till signs in to the MRA, sends at payment and sends what waited, once`.

### Task 13: what is printed

**Files:** `Docs.kt` (`ReceiptDoc.fiscal`, transient), `PaperWalk.kt`, `OrderOps.kt`; test `core/print/MraPaperTest.kt`.

- **`ReceiptDoc`** gets `@Transient val fiscal: Fiscal? = null`, where
  `sealed interface Fiscal { class Qr(val png: ByteArray); object NotYet }`. It is never stored in `doc`; it is
  read from `mra_invoices` each time the paper prints.
- **`PaperWalk.receipt`:** just before the `title` block (locked in every design, so always there), a
  `Fiscal.Qr` prints `Out.Picture(MraQr.raster(...))` centred, and `NotYet` prints the words
  `Not Yet Fiscalised`. A training paper also says `TRAINING` under it.
- **`paid()`** first calls `mraSender.sendNow(r.id)` (up to about 10 s; the screen has moved on, the paper waits),
  then prints with the invoice's state.
- **`refund()`** does the same before its slip. `afterExchange` does it for the CRN, then the STD.
- **`reprint` and `printCopy`** read the state as it is now: a reprint after a late answer has the QR.
- The PNG is read with `BitmapFactory.decodeByteArray`, and a pixel is dark below a luminance of 128. A PNG that
  cannot be read prints `Not Yet Fiscalised`.
- **Tests:** `MraPaperTest` builds the walk with a made-up 350-pixel QR and checks that the picture comes right
  before the title, then that `NotYet` gives the words and no picture. Also check that `PapersFixtureTest` still
  passes: no designer block was added.
- **Commit:** `till: the MRA's QR code on the receipt, or Not Yet Fiscalised, and on every reprint`.

### Task 14: Settings, MRA, and the banner

**Files:** create `feature/settings/MraPage.kt`; modify `SettingsScreen.kt` (`Page.Mra`, `icon`, `when`, shown only while
`mra` is not `off`), `MainShell.kt` (`SyncNotices`), `RejectedScreen.kt` (`what`/`why` for the new kinds and codes),
`GoLiveRules.kt` (`mra.record`, `mra.status` in `RUNG_UP`).

The page is managers only: `settings.device` with `Locked` and `guard`, as `ReportsPage`. It shows:

- **This till:** its name and its EBS MRA ID, read only ("Typed by EasyPay in /admin"). With none: "This till has
  no EBS MRA ID yet. Ask EasyPay."
- **The login:**
  - Before connecting: Username, Password (hidden), Area code, and **Connect to the MRA**.
  - Once connected: "Connected" and until when, or the MRA's reason in red. Also **Change login**: the fields
    again, the password empty.
- **Invoices:**
  - waiting, how many and since when;
  - the last one fiscalised, and when;
  - the MRA counter;
  - a list of those to check (`check`, refused), each with its number, its reasons and, for `check`,
    **Send again** (once, said in the button's dialog).
- **The mode:** "Training: invoices go as TRN, nothing counts" or "Live".

In `SyncNotices`:

- red, "MRA refused the login: Settings, MRA";
- red, "This till is not connected to the MRA: Settings, MRA" (training or live, with no login);
- amber, "N invoices waiting for the MRA since HH:mm" when the oldest is over an hour old.

Commit: `till: Settings, MRA (connect, the till's EBS MRA ID, what waits) and its banner`.

### Task 15: an MRA client's tills must have this build

**Files:** `hello.ts`

As `tooOldForShop`, `tooOldForMra(req, tenantId)` answers 426 to `/sync/push` and `/sync/pull`. It does so when the
tenant's `mra` is `training` or `live` and the till's version is below this build's `versionCode`. Deploy to dev
with `neon deploy --branch dev-review --env .env.local --env-pull=false`.

Commit: `api: a till of an MRA client must have the build that sends to the MRA`.

### Task 16: Test Drive's cases 2, 5 and 6 (debug build only)

**Files:** create `android/app/src/debug/java/com/restopos/debug/MraCases.kt` and register it beside `DemoReceiver`
in the debug manifest.

The broadcast is `am broadcast -n com.restopos.app/com.restopos.debug.MraCases -a com.restopos.app.MRA_CASE --es case case2`:

- `case2`: a DRN of one line on the last STD this till fiscalised, with the reason "Item served and left off the
  invoice";
- `case5`: an STD of one line with a TAN that is not the seller's;
- `case6`: a PRF of two lines.

Each is issued like any document: its own counter, its chain, a row in `mra_invoices`, a record on the server. It is
then sent with `sendNow`, and the outcome is written to logcat (tag `MraCases`).

No commit message names the MRA's test drive as done.

---

## Phase E: proving it

### Task 17: version and docs

- Bump `versionCode` and `versionName` (34, 0.9.22) in `android/app/build.gradle.kts`, and use the same number in
  `hello.ts`'s MRA minimum.
- Update `docs/superpowers/plans/2026-10-21-mra-e-invoicing-plan.md`: phase 2's state and what was learnt.
- The release and `MIN_TILL_VERSION` stay the owner's: no tag, no push.

### Task 18: on the emulator, with the owner watching

Before: read `restopos-emulator-is-shared` whole, `git log -5`, free memory, and which emulator is free. Say
which one, start it **with its window**, and say so before each step.

1. **Owner:** on dev, the test client on Premium MRA, its company details (the sandbox TAN), the till's EBS MRA ID
   (from `sandbox.env`), a tablet code. The checklist complete, then **Start training** in `/admin`.
2. Build the debug APK (`gradlew --priority low --max-workers 2`, then `gradlew --stop`). Install, join with the
   tablet code. Settings, MRA shows the EBS MRA ID.
3. **Owner:** types the sandbox login and area code, then presses **Connect to the MRA** → "Connected".
4. **A training sale:** the paper has the QR and TRAINING. On dev:
   `mra_records` holds a TRN `fiscalised` row with its IRN, and `pos_devices.mra_status` holds the status.
5. **Owner:** **Go live with the MRA** in `/admin` (the client must have gone live on EasyPay first).
6. **A sale with the six lines of test case 1** (3 items at 15 %, 3 exempt with TC03): the QR prints.
   **A refund of one line:** CRN, the QR prints.
7. **A mixed sale:** a 10 % discount, a kilo item, service charge. Fiscalised with no warnings.
8. **The line cut:** `adb -s <dev> shell svc wifi disable` and `svc data disable`. A sale prints
   `Not Yet Fiscalised`. Ten sales more. Then `svc wifi enable`: within a minute all eleven are fiscalised, in
   one request of 10 + 1 or 11. A reprint of the first has its QR. `mra_records` on dev shows them all.
9. Cases 2, 5 and 6 with the debug broadcast: 2 and 6 fiscalised, and 5 refused with ERR0500. **Case 5 last**, here
   and in the real Test Drive: its refused STD becomes the last link of the till's STD chain, so every STD after it
   chains to an invoice the MRA refused. Unless `probe-chain` showed that the MRA ignores the hash, a Test Drive
   that goes on after case 5 may fail and start again.
   Before step 4, the till's counter and chains start after what `mra/sandbox.cjs` sent on the same test EBS
   (`.claude/mra/state.json`), set on dev once its EBS MRA ID is typed: the MRA has seen counters up to there.
10. Leave the emulator signed out, said in the report. The login stays in the emulator's Keystore. Tell the owner
    it is there, and that **Change login** or clearing the app removes it.

**Done when** (from the brief):

- steps 4, 6 and 8 are fiscalised in the SANDBOX;
- the line-cut sale printed Not Yet Fiscalised and went later;
- the records and statuses are on dev;
- all seven of the MRA's cases were rehearsed from the till.

The owner then switches the EBS to Test Drive and runs them for real (phase 4). Nobody touches the portal before.

Not covered by this run, and said so:

- a real printer (the stand-in printer gives text, not the QR's dots);
- a phone reading the printed QR (the zxing test stands in);
- production, whose address and certificate are unknown.

---

## Questions this plan adds for the MRA

8. Does the MRA check `previousNoteHash` against what it holds, and what happens to the invoices after one it
   refused?
9. May `quantity` have decimals (0.250 kg), and is `unitPrice` checked against quantity x price?
10. Is a service charge TC03 or TC06, and how is cash rounding shown?
11. May the same `invoiceIdentifier` appear for a TRN and later an STD of the same EBS?

---

## The run on the emulator, 2026-10-21 (20:30 to 20:52 Mauritius)

Till 0.9.23 (build 35, debug) on `easypay_claude_size` with its window open, the owner watching. The owner's
dev client Testing sheik (a shop) on Premium MRA, Till 1 with the test EBS's MRA ID, the sandbox login typed by
the owner, the till's counter started after the sandbox script's 20. A stand-in printer on this PC (port 9101)
kept each paper and each picture on it. Everything below went to the MRA's **SANDBOX**.

| | Document | The MRA's answer |
|---|---|---|
| Training | TRN00000021 | refused, ERR0600 "Invalid seller BRN": the client's BRN had been saved over in `/admin`; put back |
| Training | TRN00000022 (Rs 100) | fiscalised in 0.47 s; the receipt printed the QR code 2 x 2 cm above RECEIPT, with TRAINING |
| Live | S1-T1-000005 (the owner's) | fiscalised |
| Live, test case 1 | S1-T1-000006, the six items, Rs 792.50 | fiscalised, no warnings, QR printed |
| Live, test case 3 | S1-T1-R000007, one soft drink back, naming S1-T1-000006 | fiscalised; the slip printed its QR code |
| Live, mixed | S1-T1-000008: 0.25 kg prawns, a cake with VAT on top, a burger, 10 % off, Rs 373.50 | fiscalised, no warnings; VAT 48.72 as the receipt |
| Line cut, test case 4 | S1-T1-000009 to 000018, each one item with VAT and one without | all waited; the papers printed "Not Yet Fiscalised" where the QR goes; within 5 s of the line coming back all 10 went in **one request** and were fiscalised; a reprint has the QR |
| Test case 2 | S1-T1-DRN000037 on S1-T1-000018 (debug action) | fiscalised |
| Test case 6 | S1-T1-PRF000038 (debug action) | fiscalised |
| Test case 5, last | S1-T1-STD000039, a TAN not the seller's (debug action) | refused, ERR0500, as the case expects |

On dev: all 19 records (`mra_records`) with their IRN and QR code or the MRA's reasons, none with a difference
from its receipt; the till's status (connected, nothing waiting, 2 refused, counter 39); its counter and chains.

Seen and to fix: while a client is still setting up, the till does not report its MRA status, so `/admin` says
"Not connected" for a till that is (`MraSender.status` returns early unless training or live). The receipt shown
on the till's screen has no QR code; only the paper has.

Not covered: a real printer and a phone reading a printed QR code (the stand-in printer's picture is the MRA's
QR, 160 dots, read back by zxing in `MraQrTest`); production; Test Drive (the owner's, from the till, next).
