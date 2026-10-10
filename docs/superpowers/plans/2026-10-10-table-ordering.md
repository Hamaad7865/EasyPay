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

## Piece 3: the till

The till's database is at 14 with the stock tools (another piece of work,
uncommitted when this was written): `guest_orders` is the version after
theirs, and this piece waits until their change to the database's files has
landed. The least-and-most rule taken out of
`OrderScreen.kt` into one tested function; `core/guest/` (the snapshot from
Room, the connection with back-off, the requests, accepting into lines); the
count on Tables, the request's sheet, the chime; Help. JVM tests first, then
the emulator against `wrangler dev` at 10.0.2.2.

## Piece 4: the back office

The switch in POS settings and the page of table cards (Premium only), with
one small library to draw the codes.

## After

`android/README.md`, the relay's README, memory. The public site says
nothing of it until the owner has seen it working.
