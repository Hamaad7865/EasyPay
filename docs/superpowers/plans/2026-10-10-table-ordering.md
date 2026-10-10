# Ordering from the table by QR code: build plan

Design: `docs/superpowers/specs/2026-10-10-table-ordering-design.md`. Written
lean, for one session at a time with no subagent per task. Each piece ends
seen working and committed on `restopos`; nothing is deployed or tagged
without the owner's word.

## Piece 1: the relay and the guest's page (`cloudflare/relay/`)

1. `src/rules.js`, plain functions with `node --test` beside them: a menu
   taken or refused (shape, sizes), what of it a phone is sent, an order
   checked against a menu (table, dish, options within a group's least and
   most, quantities, notes), the limits.
2. `src/index.js`: the Worker (`/api/<store>/menu/<table>`, `/orders`,
   `/orders/<id>`, `/till`) and the room, a Durable Object with SQLite and
   hibernating sockets: a till EasyPay's till service vouches for publishes
   the menu, is handed orders and answers them; a guest's socket hears the
   answer.
3. `public/`: the guest's page from the canvas of 2026-10-06 (menu, options,
   your order, sent, confirmed, not taken), plain HTML, CSS and one script.
4. `test/stand-in-till.mjs` (a till played by a script, with the demo menu)
   and `test/flow.mjs` (the whole exchange against `wrangler dev`, asserted).
5. Seen in the Browser pane at 390 wide: menu, search, a filter, options with
   a group that must be chosen, the order, sent, confirmed, declined, a sold
   out dish, no till connected.

## Piece 2: the server (migration 0093). DONE on dev

`stores.guest_id` (sixteen letters and digits, random, for good) made for
every store and for new ones, read by the back office for the cards;
`guest_pass(store)` and the till service's `GET /guest/pass` (a till's own
key in, `{store, ordering}` out: ordering is Premium or a trial, a
restaurant, an account that is not suspended, and
`pos_settings.data.tableOrdering`, which the back office's save will set in
piece 4). Suites `table-ordering` (the database) and `api-guest-pass` (the
deployed dev service, and with RELAY the relay asking it). The number is 0093
because another piece of work took 0092 the same evening; 0093 touches
neither `sync_pull` nor `sync_push`, which 0092 redefines. A till connects
to `/api/till` and is told its store's id by the relay, so nothing new has to
reach a till in a pull.

## Piece 3: the till. DONE, on an emulator only

`core/guest/`: `OptionRules` (the least and most of a group, taken out of
`OrderScreen.kt`), `GuestCheck` (an order held against the till's menu as it
is now), `GuestMenu` and `GuestWire` (what the till and the relay say to each
other; `cloudflare/relay/test/till-menu.json` is read by both sides' tests),
`GuestLink` (the one socket, with back-off) and `GuestBook` (what waits,
Accept, Decline). The database is at 15 with `guest_orders`, the version
after the stock tools' 14. On Tables: the green strip, the sheet, the chime;
a Help entry where the switch is on. 386 unit tests.

Run on a hidden emulator on 2026-10-11 against the relay on this PC (the
recipe is in the relay's README): the till published its menu, the guest's
page in a browser showed it, an order sent from the page was on Tables within
seconds, Accept put it on the table's order and the page said Confirmed,
Decline was told to the phone's side. Three faults showed by running it and
were changed: a quantity written as thousandths of a dish (the till's measure
is thousandths), the sheet opening by itself when the next order arrived,
and the three answers drawn the colour of the card they sit on.

Not seen: a real tablet, a real phone on mobile data, Cloudflare's own
servers. Known and left: after the app is started the till listens once
someone has signed in, since the line starts with the main screen (as the
kitchen screens' does).

## Piece 4: the back office. DONE, not deployed

The switch in POS settings (General, "Ordering from the table": a restaurant
on Premium has the switch, another plan is told it is Premium's; saved as
`pos_settings.data.tableOrdering` with the rest of the form). The page
Table cards (`/backoffice/tables/cards`, in the menu under Tables and as a
key on the Tables page, Premium only): a card for each table of a store with
the restaurant's name, the table's and its floor's, and the QR code of
`order.easypaypos.com/<store's public id>/<table's id>`, laid out three
across for printing. `web/lib/guest.ts` makes the address and the code's
squares (`qrcode-generator`, which the lock file already held for another
package); the page is split into its questions (`page.tsx`) and its drawing
(`view.tsx`). All of it is hidden behind `TABLE_ORDERING_LIVE` in
`web/lib/plan.ts`, which says false: one tag puts the whole branch live, and
a card printed before the till's piece and the ordering site are live would
send a guest to an address that does not answer, for good. Turning it on is
part of the release that carries the till's piece: set it to true, and put
the "Table cards" line back in `nav.ts` under Tables (`premium: true`,
`only: "restaurant"`, the `QrCode` icon).

## After

`android/README.md` and the relay's README are written. The public site says
nothing of it until the owner has seen it working.

## The release, on the owner's word only

In this order, since a card is for good: migration 0093 and the till service
on production; `TILL_API` in `cloudflare/relay/wrangler.toml` set to the
production till service and `wrangler deploy` there (which makes
`order.easypaypos.com`); `TABLE_ORDERING_LIVE` true and the "Table cards"
line back in `nav.ts`; then the tag, which carries the back office and the
till. Before the tag, a real tablet and a real phone should be tried against
the deployed relay.
