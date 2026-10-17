# Premium MRA: sending every sale to the MRA, for the clients who must: design

2026-10-17. The MRA's e-invoicing applies to every business turning over more than Rs 40 million a year
since 1 September 2026, VAT-registered or not. Not every EasyPay client needs it. The owner: "we need to have
a dedicated place for clients with 40 million turnover because not all clients would need this and then if
current client wants to be part of this dedicated MRA e invoicing we should have this option to transfer as
well", then "a third plan, the premium MRA e invoicing which adheres to all MRA rules and then work on
transfer a standard/premium plan to premium MRA e invoicing". The shape below was shown in chat and approved
("The design looks right. Write it up and start on piece 1").

No client of EasyPay is over Rs 40 million yet. EasyPay's MRA developer account is being opened; the MRA's
API guide (sign-in, encryption, the JSON schema, the test script) is only inside their portal and has not
been read yet. Everything here that depends on it is marked so.

## 1. What the MRA requires (read on mra.mu, 2026-10-17)

Sources: the MRA's e-invoicing page, the Functional Specifications of the EBS (June 2023), the General
e-Invoicing Guide for Software Developers (v1.0, June 2023), the Standard e-Invoice Template (August 2025)
and the FAQs (July 2023).

- Every invoice, credit note and debit note goes to the MRA's platform (the IFP) as JSON, in real time, with
  a token or certificate. The IFP answers with an IRN and a QR code. The IRN is kept with the sale and **not
  printed**; the QR code (2 x 2 cm) is printed at the top of what the customer gets.
- Each document carries the hash of the one before it (date-time + amount + BRN + number of the previous
  one; 0 for the first), a sequential invoice number, and a counter that can never be reset.
- With no internet: keep issuing in sequence, without the QR code, and send the batch automatically once
  the connection is back.
- Document types: STD (sale), PRF (pro forma), TRN (training), CRN (credit note), DRN (debit note).
  Transaction types: B2C, B2B, B2G, EXP, B2E. Line tax codes: TC01 15%, TC02 0%, TC03 exempt, TC04 not
  fiscal, TC05 15% to an exempt body, TC06 outside VAT. Each line: goods or services.
- Mandatory seller details: legal name, VAT number, BRN, business address (and the seller's TAN in the API).
  Optional: trade name, phone, counter (till) number, cashier.
- The system itself: logins, no default admin password, roles; tamper-proof storage; it must not let anyone
  reset its date and time, export its certificate, reset the counter, or change a stored invoice.
- Approval: the provider registers on the developer portal, registers its EBS (one EBS MRA ID), builds
  against two APIs (authentication, invoice transmission), tests in the sandbox, passes the MRA's scripted
  "test drive", and **self-certifies**: the MRA certifies nothing. Each client then registers every EBS it
  uses on the IFP; moving an EBS needs the MRA's approval.
- Penalty (MRA FAQ): Rs 10,000 a month without fiscal invoices, at most Rs 200,000; tampering up to Rs 50,000.

## 2. Shape: Premium MRA is Premium with the MRA switched on (chosen)

`/admin` offers four plans: Trial, Offline, Premium, **Premium MRA**. Underneath, a Premium MRA client is
`tenants.plan = 'premium'` with **`tenants.mra`** saying where it stands:

| `mra` | Meaning |
|---|---|
| `off` | Not on MRA (every client today). |
| `setting_up` | Moving to MRA: the checklist is being completed; nothing goes to the MRA. |
| `training` | The tills send TRN (training) invoices, so staff can try it; nothing counts. (Piece 3.) |
| `live` | Every sale from the tills' next day opening is sent to the MRA. (Piece 3.) |

Why not a new plan name: "premium or trial" is checked in about ten places in the database, the back office
and the till. A till that had not updated yet would read an unknown plan as "not premium" and hide the
kitchen screen, bookings, deposits and accounts. Kept as Premium, every Premium feature keeps working.

`mra` other than `off` requires the plan to be premium (a table check). A Premium MRA client cannot be moved
to another plan without turning the MRA off first.

## 3. Data (migration 0116, piece 1)

- `tenants`: `legal_name`, `tan` (the seller's tax account number), `mra` (above, default `off`),
  `mra_nature` (`goods` or `services`: what the business sells, used for every line whose category does not
  say otherwise), `mra_live_since` (when it first went live; never cleared).
- `taxes.mra_code`: TC01 to TC06.
- `categories.mra_nature`: `goods`, `services`, or empty for the business's own.
- `pos_devices.mra_ebs_id`: the EBS MRA ID the MRA gave for that till, one per till, unique in a client.
- `stores.address` exists already; for an MRA client it is the address sent with that branch's sales.
- The settings the tills pull carry `mra` (as they carry the plan), for piece 3.

## 4. The checklist (`mra_checklist(tenant)`)

What must be true before a client can train or go live, each line with what is missing:

1. Company: legal name, TAN and BRN. (A VAT number when the business is VAT-registered; the MRA covers
   businesses that are not, so it is not required.)
2. What the business sells: goods or services.
3. Every branch has its address.
4. Every tax has its MRA code.
5. Every item on sale has a tax (a line cannot go to the MRA without a code).
6. Every till in use has its EBS MRA ID.
7. The client's MRA login for the connection (piece 2; shown as "comes with the MRA connection" until then).

## 5. Moving a client (`/admin`, the client's page)

- Choosing **Premium MRA** in the plan list makes the client Premium (an Offline client is connected to the
  cloud this way, as today; its tablet sends what it kept) and puts `mra` at `setting_up`.
- An **MRA** panel shows the state, the checklist with its ticks, and an EBS MRA ID field beside each till.
- **Turn MRA off** puts it back to `off` (the client stays Premium). From `training` or `live` (piece 3) it
  warns that the client may be obliged by law; what was sent to the MRA stays for good.
- The client's owner fills the company and branch details, the tax codes and the goods/services choice in
  the back office (section 6). The EBS MRA IDs come from the client registering each till on the MRA's portal;
  the platform admin types them in.
- Every change is written in the platform audit.

## 6. Back office, for an MRA client only (`mra` not `off`)

- **Company details**: legal name, TAN, and "What you sell: goods / services", beside the BRN and VAT number
  already there; a **Branches** part with each branch's address when the client has more than one branch
  (with one, the company address is that branch's).
- **Taxes**: an MRA code per tax, suggested from the rate (15% TC01, 0% TC02) until saved.
- **Categories**: goods or services, "as the business" by default.
- The checklist, in words, at the top of the Company details page: what the move still lacks.

A client not on MRA sees none of this.

## 7. Rules for MRA clients

| Rule | How | Piece |
|---|---|---|
| A payment type is not corrected after the sale (it is part of what the MRA holds): refund and sell again | trigger on `payment_corrections` refuses when `mra = 'live'` | 1 |
| Sales are never removed | `clear_test_activity` already refuses a live client; `delete-client.cjs` refuses a client with `mra_live_since` | 1 |
| MRA live only after the client is live | the function that sets `live` requires `platform.go_live` done | 3 |
| The server keeps each receipt as the till sent it; a difference is flagged, not rewritten | in the receipt push, for `live` | 3 |
| Old receipts are never summarised away | nothing summarises them today; noted for whoever builds it | — |
| The tablet's clock is checked against the server's at each sync; off by more than 5 minutes, the till takes no payment until it is fixed | till | 3 |
| After a reinstall the counter comes back from the server; an MRA till does not sell until it has it | till | 3 |
| A refund goes to the MRA as a credit note, after its original sale | till or server | 3 |
| EasyPay's own credit notes read "store credit" for an MRA client | back office and till | 3 |

## 8. A record for every sale (piece 2)

One row per receipt of a client on `training` or `live`: type (STD, CRN, TRN), the till's counter and
invoice number, the previous hash and its own, status (`waiting`, `sent`, `refused`), the IRN and QR code
when they come back, and what was sent and received. Only the status and the MRA's answer are ever written
after the row is made. Its exact columns follow the API guide.

## 9. The MRA connection (piece 2)

Sign-in and sending one invoice proven against the sandbox first, on its own, before the till changes.
Then the choice: the call made by our server (the client's MRA login kept encrypted on the server, one
implementation, fixed without a tablet update) or by the tablet (no hop, works if our server is down; keys in
Android's secure storage). Decided by timing a round trip both ways in the sandbox. Either way, one EBS per
till: each till keeps its own counter and hash chain, so tills selling offline at the same time stay in
sequence. EasyPay already numbers receipts per till (`store-till-R000123`, `pos_devices.last_receipt_seq`,
sales and refunds in one series, a refund pointing at its sale).

## 10. The till (piece 3)

At payment: the sale goes to the MRA; the QR code comes back and is printed. No answer within a few seconds:
printed without it, queued, sent when the line is back (an original before its refund), and the QR code is on
any reprint. Training invoices while `training`. The clock and counter rules of section 7.

## 11. Approval (piece 4)

The MRA's test script in the sandbox on the test emulator; the provider switches its EBS to Test Drive on the
portal and the scripted sales are run (one failure restarts it); then the provider self-certifies on the
portal. EasyPay's provider profile is in the name of the company that sells it.

## 12. Pieces

1. **Now, no MRA calls:** migration 0116, the checklist, the `/admin` plan and MRA panel, the back office
   fields, the payment-correction and delete rules, tests.
2. **When the API guide is read:** the connection proven in the sandbox, the record per sale, where the
   call is made.
3. **The till:** QR code, queue, credit notes, training, clock and counter; `training` and `live` in
   `/admin`; the receipt push rule.
4. **Approval:** test script, test drive, self-certification.

## 13. Questions waiting

For the MRA (drafted for the owner to send): one EBS MRA ID per till? Must a restaurant's bill printed before
payment be a PRF? When are a deposit and a sale on account invoiced? How long may an outage last before the
batch must be sent?

## 14. Decisions that were mine

- `mra` beside `plan` rather than a fourth plan name (section 2).
- In piece 1, `/admin` moves a client only between `off` and `setting_up`; training and live come with the
  till.
- The VAT number is not required by the checklist (the MRA covers businesses that are not VAT-registered).
- "What you sell" on the business, overridable per category, rather than per category only.
- Branch addresses on the Company page, shown only with more than one branch.
- The clock tolerance of 5 minutes.

## 15. Tests (piece 1)

`db/tests/mra-setup.test.cjs`, one transaction rolled back: the columns and their checks; `mra` not `off`
refused on a plan other than premium, and a premium MRA client refused another plan; `platform.set_tenant_mra`
between `off` and `setting_up`, written to the settings the tills pull and to the audit, refused for an
unknown state; `mra_checklist` line by line, empty and complete; a payment correction refused on a live MRA
client and taken on another; the EBS MRA ID unique in a client. `delete-client.cjs` refusing a client that
went live. The pure parts (the code suggested from a rate) in `web/lib/mra.test.mjs`.
