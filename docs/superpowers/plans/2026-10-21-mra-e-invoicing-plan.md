# MRA e-invoicing: the whole plan, in order

2026-10-21. The owner: "we need a full plan because this is getting messy now", then what is needed: each
tablet signs in to the MRA; the back office shows that each till is connected; a client on the MRA plan sees in
the back office what is being sent to the MRA; multi-branch as well; and "let us finish the testing and then we
continue".

The rules (what the MRA requires, the data, the checklist) stay in the design,
`docs/superpowers/specs/2026-10-17-premium-mra-design.md`. This page is the order of the work and replaces the
piece list in its section 12.

## Where it stands

| | State |
|---|---|
| Piece 1: the plan, the checklist, the fields | Live (0116, 0118). Premium MRA in `/admin`, `tenants.mra` (`off`, `setting_up`), the checklist, legal name, TAN, goods or services, tax codes, and each till's EBS MRA ID typed in `/admin`. Nothing is sent. |
| Piece 2: the connection | Code on `restopos`, not pushed (from `1d19b75`): `mra/` (sign-in, encryption, the invoice, the hash chain) and `node mra/sandbox.cjs` with all seven MRA test cases, 31 tests against a stand-in for the MRA. **All seven passed against the MRA's sandbox on 2026-10-21** (phase 1, below). |
| EasyPay's test EBS | Registered on the developer portal: EasyPayPos, Bel Air, **SANDBOX**. |
| Phase 2: the till | **Built, not yet run on a tablet** (2026-10-21, `d64064e`..`400eb88`): till 0.9.23 (build 35), Room 35, migration 0132 (on dev only), `/admin` training and live and the MRA connection. The plan, task by task: `2026-10-21-mra-phase-2-till.md`. Waiting: the owner's two sandbox probes (`send probe-chain`, `send probe-mixed`) and the run on the emulator with the owner. |

## Decided

- **Each till signs in to the MRA itself.** The owner: "what we actually need is each tablet signs in to the
  MRA". The MRA login is typed on the till, kept in Android's secure storage, and never sent to our server.
- **One EBS per till** (design section 9): each till keeps its own invoice counter and hash chains, so tills
  selling at the same time, or offline, never share a sequence. To be confirmed by the MRA (question 1).
- **Testing first**, then the till.

## When to press Test Drive (decided)

Confirm (self-certification) tells the MRA that the EBS registered, "EasyPay POS Android" at its version, is
compliant. If Test Drive is run from `mra/sandbox.cjs`, it certifies a script; the till itself sends nothing yet.

**Decided 2026-10-21, by the owner:** "Test Drive from the till once phase 2 is built. Leave the portal alone
until then." The order:

1. **Sandbox:** test cases 1 to 7 from `sandbox.cjs`. Done (phase 1).
2. The till built (phase 2) and held to the same values as the script.
3. **Test Drive** run from the till on the test emulator.
4. **Confirm**, pressed by the owner.

Until phase 2 is built, nobody presses Test Drive or Confirm or changes the EBS on the portal.

## Phase 1: finish the sandbox testing (done)

The owner:

1. Fills `.claude/mra/sandbox.env` (its comments say where each value is on the portal) and saves the MRA
   public key `.crt` beside it.
2. Runs `node mra/sandbox.cjs check`, then `sign-in`, then `send case1` three times, then `send case2` to
   `send case7` once each. Case 5 is meant to be refused (a TAN that is not the seller's).
3. Sends the questions below to einvoicing@mra.mu (Claude drafts them).

Claude: reads `.claude/mra/out/`, fixes what the MRA refuses, writes down the round-trip time and every error
code met. The seven cases, as the portal gives them, are in `.claude/mra/test-scenarios.md`.

`sandbox.cjs` stops after a send with no answer until it is checked on the portal. That is for testing only:
the till follows the guide (section 9.1), which sends it again later, once, never in a loop.

**Done when:** all seven cases are fiscalised in SANDBOX, and what the MRA accepts is known field by field.

**Done, 2026-10-21** (run by the owner; the answers are in `.claude/mra/out/`):

| Case | Sent | The MRA's answer |
|---|---|---|
| 1 | EPTSTD000001, 000016, 000017 | fiscalised, no warnings |
| 2 | EPTDRN000002 (on 000001) | fiscalised, no warnings |
| 3 | EPTCRN000018 (on 000017) | fiscalised, no warnings |
| 4 | EPTSTD000003 to 000012, one request | all 10 fiscalised, no warnings |
| 5 | EPTSTD000013 | refused as expected: ERR0500 "TAN of registered user does not match with TAN of seller in invoice details" |
| 6 | EPTPRF000014 | fiscalised, no warnings |
| 7 | EPTTRN000015 | fiscalised, no warnings |

What it taught:

- **Sign-in needs no area code, but sending does.** Two first sends were refused as a whole: HTTP 400,
  ERR0020 "Missing request headers". The till's Connect screen must ask for the area code. A request refused
  as a whole answers for no invoice, and their numbers are used again.
- **The MRA accepts the invoice exactly as `mra/invoice.cjs` builds it:**
  - `unitPrice` without VAT, and the VAT taken out of VAT-included prices as the till does;
  - a walk-in customer as empty fields with NVTR;
  - TC01 and TC03 lines;
  - one hash chain per document type;
  - amounts as strings with two decimals;
  - Mauritius time.
- **Every answer came back in 0.17 to 0.5 seconds** from the owner's computer, including the request of 10
  invoices. Fiscalising at the moment of payment is fast enough. Each answer said `environment: TEST`.
- The QR code comes back as a PNG of about 570 bytes.
- The VAT status was left empty and sent as VATR. The MRA did not object.

## Phase 2: the till signs in and sends (piece 3)

**Built 2026-10-21, as `2026-10-21-mra-phase-2-till.md` says, with the owner's D1 (the MRA's address and key from
our server) and its twelve choices.** Not yet seen on a tablet; the "Done when" below is still to be shown.

1. **The MRA part in Kotlin:** sign-in, encryption, the invoice, the hash. Held to `mra/fixtures/crypto.json`
   and to invoices the script had fiscalised, so the till sends byte for byte what the MRA accepted.
2. **Settings, MRA, on the till (managers only):**
   - fields for username, password and area code (the MRA refuses invoices without the area code);
   - the till's EBS MRA ID, shown read-only (it is typed in `/admin`);
   - a **Connect to the MRA** button that signs in and shows "Connected", or the MRA's reason;
   - **Change login**.

   The password is never shown again once saved.
3. **At payment:** the sale goes to the MRA (STD). The QR code comes back and is printed, 2 x 2 cm. The IRN is
   kept but never printed. With no answer within about 10 seconds, the receipt prints "Not Yet Fiscalised"
   where the QR code goes; the sale is queued and sent later, at most 500 a request, an original before its
   refund. The QR code is on any reprint.
4. **Refunds and training:** a refund goes as a credit note (CRN) naming its sale. While the client is in
   `training`, invoices go as TRN.
5. **Counter, chains and clock:** per till, per document type, kept in Room. After a reinstall they come back
   from the server, and an MRA till does not sell until they have. The clock is checked against the server's
   (5 minutes, design section 7).
6. **Signing in every day:** the token lasts 24 hours, and the till signs in again with the saved login. A
   refused login shows a red banner, "MRA refused the login: Settings, MRA". Sales carry on, printed "Not Yet
   Fiscalised", until it is fixed.
7. **What the server learns (one piece of work):**
   - each receipt's MRA record (design section 8): type, counter, number, hashes, status, IRN, QR code, errors;
   - each till's MRA status: last sign-in, token valid until, refused reason, waiting count, last fiscalised;
   - both through the existing sync, together with the receipt push rule of design section 7.

   Never the password, the token or a key. The server work is a migration (the record table, the status
   columns) and a push function.
8. **`/admin`:** `training` and `live` for the client.

**Done when:** the till on the emulator fiscalises a sale, a refund and a training invoice in the sandbox. A
sale with the line cut prints "Not Yet Fiscalised" and goes later. The records and statuses arrive on dev.

## Phase 3: the back office's MRA page (Premium MRA clients)

The page is only for a client whose `mra` is not `off`. It is read-only: nothing on it changes what was sent.

- **Tills, by branch:** for each till:
  - connected, or refused with the MRA's reason;
  - last sign-in;
  - invoices waiting, and the last one fiscalised.

  A till with invoices waiting for hours, or a refused login, is shown at the top.
- **Invoices sent to the MRA:**
  - each document's date, branch, till, number, type (sale, credit note, training), amount and status
    (fiscalised, waiting, refused with the reason), with its QR code;
  - filters by branch, till, date, type and status, and a CSV download.
- The checklist stays on Company details (piece 1).

**Done when:** an owner signed in on dev sees each till's connection and every invoice its tills sent.

## Phase 4: approval (piece 4)

1. Test Drive, run from the till on the emulator (see the decision above). One failure restarts it; only the
   last 500 invoices count. **Case 5 (the wrong TAN, refused on purpose) goes last**: the till chains each
   invoice to the last it issued, so an STD after a refused one names it as its previous.
2. PASS, then Confirm, pressed by the owner.
3. EasyPay registered with the MRA as an EBS Solution Provider (FAQ 15), so it appears on the MRA's list of
   compliant systems.

## Phase 5: the first client goes live

1. The client registers on the MRA's platform (the IFP), every till as an EBS. EasyPay fills the CSV: one row
   per till, with its branch and its region.
2. The EBS MRA IDs are typed in `/admin`; a manager connects each till.
3. A few days in `training`, then `live` from the next day's opening.

This needs the production address (question 2).

## Multi-branch

**What the MRA needs (built in phases 2 and 3):**

- The seller address sent with a sale is its till's branch address (`stores.address`, already in the design).
- Each till is registered on the IFP with its branch's region and branch; the CSV EasyPay fills does this.
- A branch column and filter on the MRA page.
- Moving a till to another branch needs the MRA's approval first (FAQ 14): the back office warns before it.

**The general gaps (a separate track, after the MRA work):** a branch filter on reports and the dashboard, a
branch picker, each branch's own receipt header and address, stock per branch with transfers, staff tied to
branches, and logins for a chain's own managers.

The public site already says EasyPay supports multi-branch (`123f790`). The site's rule is to claim only what
is built: to be looked at separately.

## Questions for the MRA (to send now)

1. Must each till (each POS tablet) be registered as its own EBS, with its own EBS MRA ID?
2. What are the production addresses of the two APIs? The guide gives only `vfisc.mra.mu`, and test cases 3,
   6 and 7 say "The mode of transmission is LIVE using Live API".
3. In production, whose login does a till sign in with (the business's IFP username?), and is there an area
   code?
4. Must a restaurant's bill printed before payment be sent as a pro forma (PRF)?
5. When are a deposit, and a sale on account, invoiced?
6. How long may an outage last before the waiting invoices must be sent?
7. When the certified EBS gets a new version, does it need a new Test Drive, or only its version updated on
   the portal?

## Choices that were Claude's, to be confirmed

- `unitPrice` is sent without VAT.
- A walk-in customer (B2C) is sent with empty fields and buyerType NVTR.
- Test case 1's items without VAT use TC03 (exempt).
- Test invoice numbers are `EPT` + type + 6 digits (sandbox only). The till's numbers will be its receipt
  numbers.
- The reasons given for test cases 2 and 3.
- Test cases 3, 6 and 7 go to the same address as the others (question 2).
- Test case 4's invoices are B2C, like the rest (the portal's sample shows B2B). Each has one item with VAT
  and one without.
- Test case 5 sends TAN 12345678, or 87654321 if that is the seller's.
- An invoice the MRA answered for uses its number, fiscalised or refused. The next invoice of its kind chains
  to the last one fiscalised.
