# Closing a day and taking cash out from the back office: design (piece 2)

Piece 1 is `2026-10-10-pos-like-carfection-design.md`. The owner chose "Everything Carfection does", and
for this piece, asked who closes the day: "go with option 1", the back office asks and the tablet closes
at its next sync. On the design below: "Build it as described". Deactivate stays as it is.

## Why the tablet closes it

A till works with no connection and owns its day: it works out what the drawer should hold from what
it holds itself, numbers the closing itself and prints the Z (`CashOps.closeDay`). A day closed on the
server alone would not be known to a tablet until it pulled, and sales it made meanwhile would belong
to no day. So the back office does not close anything. It leaves a request, and the till carries it
out the next time it syncs, with its own figures.

## A request

`till_requests`, one row for each thing asked of a till: which till and which of its days (the shift
open when it was asked), what (`close_day` or `cash_out`), the counted cash (empty: close at what the
till expects, as Carfection's power-off does) or the amount and what it is for, who asked and when, and
how it ended: `waiting`, `done`, `refused` with why, or `cancelled`. Tills are sent the requests of
their store in a pull, as they are sent its shifts and cash movements; a till acts on its own alone.

- `till_request(employee, till, kind, counted, amount, reason)` makes one. It refuses: a till that is
  not this business's or is deactivated; a till whose build is older than 12, the first that carries
  requests out ("update this till first"); a till with no day open; a second close while one waits;
  an amount that is not above nothing or a cash out with no reason; someone whose role may not do it
  on a till either (`shift.open_close` to close, `cash.pay_in_out` for cash).
- `till_request_cancel(employee, request)` cancels one that is still waiting.
- The till answers with an op, `request.answer`: done, or refused and why. An answer to a request
  that is no longer waiting changes nothing (the owner cancelled it meanwhile: the till's word stands
  for what the till did, and the page shows both).

## What the till does

After each pull, for each request of its own that waits and that it has not answered, oldest first:

**Close the day.**
- Refused when the day asked about is not the one open ("That day is no longer open on the till"),
  when an order or a sale is still unpaid (the till's own words for it), or when the till was used
  after the request was made, by a sale, a refund, cash moved or a count ("The till was used after
  this was asked. Count the drawer and ask again"). The request's time is the server's and the
  till's records are the tablet's: the clock offset the till already keeps is taken off.
- Otherwise the day is closed as `closeDay` closes it: the shift and the day closing written
  together, numbered by the till, the period's bill numbers started again, the Z printed when a
  receipt printer is set up. Counted is what was typed, or what the till expects when nothing was.
- **It is closed as of the moment it was asked, not the moment the till got round to it.** A till
  nobody is at stops syncing so the database can sleep, and hears of the request at its next touch:
  for a day left open overnight, the next morning. Nothing was written down on the till since (or
  it would have refused), so the figures are the same, and the day's closing, its Z and its cash-up
  say last night. The moment is the one "used since" looks from, so nothing falls between the two;
  never before the day opened and never later than now. The back office says so where it asks: at
  once if someone is using the till, otherwise the next time it is touched.
  It is closed by the person who asked: the ops carry their employee id, which the server takes from
  a till set up under a login that may set up tills, and checks the permission of.
- The tablet says "The day was closed from the back office by Asha", once, to whoever is at it or
  next comes to it: as a plain notice, and not through the printers' channel, which lists what it
  is handed under "Earlier, from the printers".

**Take cash out.**
- Refused when the day asked about is not the one open.
- Otherwise recorded as a cash out in that day, by the person who asked. No slip, and the drawer
  does not open: the one who asked is not at the drawer.

The answer goes out with what was done, in the same push. A request is acted on once: the tablet
keeps which it has answered.

## The back office

- **A till's card**: with its day open, on a build that takes requests, for a role that may close a
  day, a key to close the day: the counted cash, or empty for what the till expects. The card stays
  one link into the till; the key sits over it. While a closing waits the card says so.
- **A till's page**: the same key at its head, on every tab. On Cash flow, "Take cash out": an
  amount and what it is for. Under the tabs, each waiting request with who asked, when, and Cancel.
  On Cash flow, what was asked of this till lately and how each ended; a closing made because the
  back office asked says so on its closure, and says when nobody counted the drawer.
- A till on an older build has no keys: where they would be it says to update the till first.
- Money typed as the rest of the back office reads it: 1,250.00.

## What the till's build must be set up under

The ops go as the person who asked. The server takes a till's word for who did something only from a
till set up under a login that may set up tills (`settings.device`), which every till set up since
0082 is. One set up before that under a cashier's login would have its closing refused by the server
after the tablet had closed it: such a till shows the closing among what the server refused, as it
shows any other refused op, and is set up again under the owner's login. The back office does not
then say "done": an answer of done to a closing whose day is still open on the server is written
down as refused, with where to look.

## What it takes

Migration 0091 (the table, the two functions, `sync_pull` and `sync_push` regenerated from their live
definitions with the one addition each). No change to the API's code. The back office pages. Till
0.8.0, build 12: the tablet's database goes from 12 to 13 (one new table), the pull keeps requests,
and a runner acts on them after a pull.

## How it is checked

- `db/tests/till-requests.test.cjs` on dev: who may ask and what is refused, a request reaching a
  pull, the answer op, a close and a cash out sent the way the till will send them (as the requester),
  another business seeing none of it.
- The point-of-sale page suite: the keys only where they belong, the waiting line, the list.
- The till: unit tests for what it decides (close, refuse and why, cash out), and on my own emulator
  with the made-up business, handing it a page as the server would send it, since that business does
  not sync.

Not seen by me: a real tablet taking a real request from a real back office.
