# The mail service: a till's Z report by email

`mail.easypaypos.com`: where a till sends its day closings when "Email the Z
report" is on (Settings, Cash drawer). A Cloudflare Worker of its own, apart
from the back office, the site and the relay. Design:
`docs/superpowers/specs/2026-10-25-z-report-email-design.md`.

```
wrangler.toml        the Worker, its address, the mail binding, its Book
src/rules.js         what is taken and refused, and the mails and pages it writes
src/report.js        a day closing laid out as a report (the mail's HTML), from the parts the till sent
src/pdf.js           the same report as an A4 PDF (pdf-lib), attached to the mail
src/rules.test.mjs   the rules, tested by themselves
src/report.test.mjs  the report and the PDF, from test/z-parts.json (the till's own tests hold that file)
src/index.js         the Worker and the Book (a Durable Object): asks, confirmed addresses, ids, counts
test/flow.mjs        the whole exchange, asserted, against the Worker under wrangler dev
deploy.cjs           puts it live (and its test, deploy.test.cjs)
```

## How it fits together

- **No database.** EasyPay's database is never asked: an offline tablet must
  not wake it. A till's credential can only be checked there, so nothing a till
  sends proves who it is, and the service is made so that it cannot mail
  anyone who did not ask for it.
- **An address confirms once.** `POST /v1/ask` with the address, the till's key,
  the business and the till: the address gets one short mail with a link. The
  link opens a page with a Confirm button; pressing it (a POST, never the link
  itself: mail scanners open links) confirms the address for that till.
- **The till's key.** 64 hexadecimal characters the tablet made itself when the
  address was typed. Only its SHA-256 is kept. A report is taken for an address
  only with the key that address confirmed: not from another till, and not from
  someone who read the app.
- **The service writes the mail.** `POST /v1/z` carries the closing's lines of
  text as its paper prints them, the parts the paper was laid out from (`parts`:
  `k` row, text, center or rule, `l` and `r` the two sides, `b` bold, `s` size),
  its id, number and date, and the names. The mail is EasyPay's
  (`reports@easypaypos.com`), its subject fixed, the report laid out from the parts
  with every character escaped, the paper's lines as its text part, the same report
  as an A4 PDF attached (as its bytes: the binding takes a string as the file's own
  text), a stop link at its foot and in `List-Unsubscribe`. A report that cannot be
  made into a PDF still goes, without one. An id is mailed once: a till that did not
  hear the answer sends it again and is told it went.
- **Stop.** The link at a report's foot (`/s/<token>`, a page with a button, or a
  mail client's one-click unsubscribe), or the till's setting switched off
  (`POST /v1/stop`), forgets the address for that till.
- **Limits** (`LIMITS` in `src/rules.js`): a mail to confirm at most once in 10
  minutes and 3 a day for an address, 10 a day from one internet address, 200
  a day in all; reports 20 a day for an address, 1,000 a day in all; a body of
  64 KB, 400 lines of 200 characters. Counted per UTC day in the Book.
- **Answers to a till:** `{state}` with `yes` (confirmed), `waiting` (asked, not
  confirmed), `none`; 403 for a report to an address that has not confirmed;
  429 over a limit; 422 when Cloudflare refuses the address for good
  (`code: "refused"`); 503 when it refuses for now (not onboarded, Workers Free,
  its own limits): the till tries again later.

## Try it on this PC

Nothing is sent: under `wrangler dev` the mail binding is played locally, and
each mail is written to a file under `cloudflare/mail/.wrangler/` (ignored by
git), which wrangler names at its debug level.

```
npm ci --prefix cloudflare/mail                    its one package, pdf-lib
node --test cloudflare/mail/src/rules.test.mjs     the rules
node --test cloudflare/mail/src/report.test.mjs    the report and its PDF
node --test cloudflare/mail/deploy.test.cjs        the deploy script's reading
node cloudflare/mail/test/flow.mjs                 14 steps against the Worker, which it starts and stops
```

With the till on an emulator: run the Worker on 8789
(`node .claude/cf/web/node_modules/wrangler/bin/wrangler.js dev --config cloudflare/mail/wrangler.toml --port 8789 --ip 0.0.0.0 --log-level debug --var SITE:http://localhost:8789`),
and build the debug till with `-PmailUrl=http://10.0.2.2:8789` (or put
`mailUrl=` in `android/local.properties`). The links in the written mails are
then to `localhost:8789`: open them in a browser on this PC.

## Putting it live

Only on the owner's word; the account and its settings are theirs.

1. **Workers Paid** on the Cloudflare account ($5 a month, 3,000 mails a month
   included), unless it has it already. On Workers Free, Cloudflare sends only
   to addresses it has verified itself, and refuses the rest.
2. `npx wrangler@4.117.0 email sending enable easypaypos.com`: adds the sending
   records (SPF and DKIM, `cf-bounce.easypaypos.com`) to the zone's DNS.
3. `node cloudflare/mail/deploy.cjs --apply`: checks step 2, deploys, creates the
   address `mail.easypaypos.com` the first time, and asks it whether it answers.
   Without `--apply` it only looks.

The till's own release does not deploy this service. A till whose setting is
on before the service answers keeps its closings and mails them once it does.
