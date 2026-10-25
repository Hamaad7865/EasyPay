# The Z report by email

2026-10-25. Asked by the owner: "make it a configurable setting, with on and off and
the owner writes on what email he wishes the email to be sent to write the plan and
build it and release". Their words settle the setting (on and off, off at first) and
that the owner types the address. The rest below is mine, to be confirmed.

## What there is now (read in the code that day)

- Nothing in EasyPay sends email: no provider, no binding.
- The Z report is made on the tablet: `CashOps` closes a day five ways (`closeDay`,
  `closeUnclosed`, `closeDayAsked`, `closeDayAuto`, `closeUnclosedAuto`), each writes a
  `day_closes` row and prints `Docs.z`. `CashOps.dayDocOf(row)` makes a closing's Z
  again from the database (Print again). `EscPos.look()` gives a page as lines of text.
- An offline tablet never sends its sales to the server and must never wake Neon.
- The tablet's own preferences (`SessionStore`, DataStore `device`) go into a backup
  and are emptied at sign-out (`SessionStore.clear`).
- Cloudflare Email Service: sending to **any** address needs **Workers Paid**
  ($5 a month for the account, 3,000 mails a month included, then $0.35 a 1,000).
  On Workers Free a Worker can only send to addresses Cloudflare has verified for
  the account (Email Routing destinations: Cloudflare's own "verify" mail, 200 for the
  whole account). The account's plan could not be read from here; the notes of
  2026-10-08 say Free. easypaypos.com has no mail set up (no MX record, not onboarded
  for sending); easyhome.mu and app-carfectionist.com are.

## The design

### On the tablet

- **Settings > Cash drawer**, under "Close the day automatically": **Email the Z
  report**, On or Off (Off at first), and **Send to**, the address. Changing it asks
  for someone who may set the till up (`settings.device`), as the MRA page does: the
  Z report going elsewhere is the business's figures going elsewhere.
- **Per till**, kept in the tablet's own preferences, not in the business's settings:
  each till closes its own day and sends its own Z. Nothing goes to the server and
  nothing syncs, so no fetch can put it back (`OwnSettings` is not involved). It is in a
  backup and goes at sign-out, so another business signed in on the tablet never
  mails the old owner.
- **Saving with On** asks the mail service to write to the address once, with a
  button to confirm (below). The page then says "waiting for you to confirm", and
  "confirmed" once that is done; with no connection, it says the email goes when the
  tablet is online.
- **What is mailed:** every day closing made on this till after the setting was
  switched on, whichever of the five ways it was closed, as its paper prints it
  (`Docs.z` as text, with the breakdown when the business prints one). The till keeps
  only the moment it has mailed up to: a closing after that moment is mailed when
  there is a connection, the oldest first. Nothing is kept twice and nothing can be
  lost between the closing and the mail, since the closing itself is what is sent. A
  closing older than 31 days is not mailed. While the address is not confirmed,
  closings wait and go once it is.
- **No internet at closing:** the closing waits on the tablet (above) and goes when
  the tablet is online, by WorkManager with a network constraint, at the closing, at
  start-up, every 6 hours, and when Settings is opened. While the address waits for
  its Confirm the till asks again, later each time (1, 2, 4 ... minutes, then every 5
  hours, WorkManager's backoff), until it is confirmed or the link's week is over:
  the service cannot tell a till that someone pressed Confirm.
- A tablet that is setting up (TEST papers) says TEST in the mail too.
- Off: nothing is sent, and the service is told to forget the address for this till.

### The mail service: a Worker of its own, `easypay-mail`

`mail.easypaypos.com`, a Cloudflare Worker apart from the back office and the relay
(`cloudflare/mail/`), so a deploy of one never carries another. **No database:** it
keeps what it needs in a Durable Object with its own small SQLite store, as the relay
does. A till does not prove who it is (its key is checked by the database, which an
offline tablet must not wake), so the service is built so that it cannot be used to
send mail to anyone who did not ask for it:

- **The recipient confirms once.** The first thing an address gets is a short mail:
  "<business>'s till <till> asks to send its Z report here at each day closing.
  Press Confirm if you set this up; otherwise ignore this mail and nothing more is
  sent." The link opens a page with a Confirm button; only pressing it (a POST)
  confirms, so a mail scanner opening the link confirms nothing.
- **A till's own key.** The tablet makes a random key when the address is typed and
  keeps it; the service keeps only its hash, with the address. Z mails to that
  address are taken only with that key: no other tablet, and nobody who read the
  APK, can mail it.
- **The service writes the mail.** The tablet sends the Z's lines of text and the
  parts its paper is laid out from (`EscPos.parts`: a row with its two sides, a
  heading, a line, a rule, with bold and size), the business and till names and the
  closing's number and moment. The service lays them out as a report in its own mail
  (EasyPay as sender, `reports@easypaypos.com`, a fixed subject, the business at the
  head, the total in a band, each section as a table, every character escaped), the
  paper's lines as the mail's text part, **the same report as an A4 PDF attached**
  (pdf-lib, Helvetica), and a link to stop these mails. It never takes HTML or a file
  from a tablet. (First built as the paper's text in a fixed-width block; the owner,
  seeing it in Gmail: "Not good", "Include a pdf as well".)
- **Limits:** a confirm mail at most once in 10 minutes and 3 a day for an address,
  10 a day from one internet address, 200 a day in all; Z mails at most 20 a day for
  an address and 1,000 a day in all (the month's 3,000 included mails are shared with
  the account's other sites); a mail id is taken once (a tablet that did not hear the
  answer sends it again and nothing is mailed twice); a body of at most 64 KB, 400
  lines of 200 characters.
- **Stop:** every Z mail ends with "Stop these emails", a page with a button, which
  forgets the address for that till. Turning the setting off on the tablet does the
  same.

### What it costs

- Workers Paid, $5 a month for the whole Cloudflare account, unless the account
  already has it; then nothing more until 3,000 mails a month (100 tills mailing a Z
  every day). It also lifts the back office's 10 ms limit on processor time.
- The Durable Object and the Worker's requests are within the free allowances (a
  closing is one or two requests).
- **If the owner would rather not pay:** the service can instead ask Cloudflare to
  verify the address (Cloudflare's own mail, which names Cloudflare, 200 addresses for
  the account, Email Routing switched on for easypaypos.com, and a Cloudflare token as
  the Worker's secret). The tablet would not change: only the service's "ask" does.
  Not built.

### What the owner does (theirs: their account)

1. Workers Paid on the Cloudflare account, if it is not on it already.
2. `wrangler email sending enable easypaypos.com` (adds the sending records to
   easypaypos.com's DNS). **Done 2026-10-25 at the owner's word** (see the record).
3. `node cloudflare/mail/deploy.cjs --apply` (deploys the Worker at
   mail.easypaypos.com and asks it whether it answers).
4. The till's tag (`v0.9.27`), which releases the APK. The tag does not deploy the
   mail service; a till with the setting on before the service is up keeps its
   closings and mails them once it answers.

## Not in this

- The back office does not show or change the setting; a Premium business sets it on
  each till.
- One address per till; no copy to a second address.
- A closing's Z made again from the database is the one Print again prints: a till
  with no PINs whose sales closed by themselves shows no "Automatically" line and no
  orders carried over (its closing row does not keep them), as Print again does today.
- No attachment (PDF): the mail is the paper's text.

## Record (2026-10-25, built and seen)

- Built as planned (`docs/superpowers/plans/2026-10-25-z-report-email.md`); till 0.9.27
  (build 39). No migration, no Room version, nothing on Neon.
- Tests: the service's rules (9) and deploy script (2) with `node --test`; its whole
  exchange under `wrangler dev`, 14 steps (`cloudflare/mail/test/flow.mjs`); the
  till's unit tests, 896, of which 15 are `ZMailRulesTest` and one the Z as text in
  `DocsTest`. A test caught a 409 ("being sent") being passed over as unreadable:
  fixed before anything was committed.
- Seen on an emulator (`easypay_claude_code`, 5594, its window open; the made-up
  restaurant on the offline plan, debug build pointed at the service on this PC):
  the panel Off at first; On, an address and Save; the service wrote the confirm mail;
  Confirm pressed on its page; the till sent the closings that waited; closings made
  in airplane mode (nos. 3 and 4) sent nothing until the network was back and then
  went at once; the panel in green with the last closing sent. The owner was at the
  emulator for part of it: they typed their own address and closed days themselves.
- Found on the emulator: the till learnt of a Confirm only at its next check. Hence
  the asking again while waiting (above).
- **easypaypos.com was enabled for Cloudflare Email Sending** at the owner's word
  (`wrangler email sending enable easypaypos.com`): SPF and an MX on
  `cf-bounce.easypaypos.com`, DKIM `cf-bounce._domainkey`, and `_dmarc.easypaypos.com`
  `v=DMARC1; p=reject;` (a mail from any other sender claiming easypaypos.com is
  refused: if the business ever sends from easypaypos.com through another provider,
  that record has to allow it). Then the service ran on this PC with the real
  binding (`remote = true`, a scratch copy of the config; nothing deployed), and
  day closing no. 5 of the emulator was accepted by Cloudflare for the owner's Gmail
  address (03:36). Whether it reached the inbox: the owner's to say.
- Not done: the Worker is not deployed (`node cloudflare/mail/deploy.cjs --apply`),
  and Workers Paid was not looked at (Cloudflare took the Gmail address, so either the
  account has it or the address needs no more).
- **The report and the PDF (the owner's "Not good" and "Include a pdf as well",
  seeing Z no. 5 in Gmail):** built as above; one shared example of a Z's parts,
  `cloudflare/mail/test/z-parts.json`, which `ZMailRulesTest` writes and holds on the
  till and the service's `report.test.mjs` renders. A PDF given to the binding as a
  base64 string reached Gmail as base64 text (Z no. 6, "Could not preview the file"):
  the binding takes a string as the file's own content, so it is given the bytes;
  wrangler's local stand-in cannot carry bytes, and only on that error the file goes
  as text there. Z no. 7 (04:05) was accepted by Cloudflare with the bytes; whether its PDF opens in Gmail: the owner's to say.

