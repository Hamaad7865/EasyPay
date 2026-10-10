# Ordering from the table by QR code: build plan

Design: `docs/superpowers/specs/2026-10-10-table-ordering-design.md`. Written
lean, for one session at a time with no subagent per task. Each piece ends
seen working and committed on `restopos`; nothing is deployed or tagged
without the owner's word.

## Piece 1: the relay and the guest's page (`cloudflare/relay/`)

1. `src/rules.js`, plain functions with `node --test` beside them: a store's
   public id from its key (SHA-256, first 80 bits, base32), a menu taken or
   refused (shape, sizes), an order checked against a menu (table, dish,
   options within a group's least and most, quantities, notes), the limits.
2. `src/index.js`: the Worker (`/api/<store>/menu`, `/orders`, `/orders/<id>`,
   `/till`) and the room, a Durable Object with SQLite and hibernating
   sockets: a till proves the store's key, publishes the menu, is handed
   orders and answers them; a guest's socket hears the answer.
3. `public/`: the guest's page from the canvas of 2026-10-06 (menu, options,
   your order, sent, confirmed, not taken), plain HTML, CSS and one script.
4. `test/stand-in-till.mjs` (a till played by a script, with the demo menu)
   and `test/flow.mjs` (the whole exchange against `wrangler dev`, asserted).
5. Seen in the Browser pane at 390 wide: menu, search, a filter, options with
   a group that must be chosen, the order, sent, confirmed, declined, a sold
   out dish, no till connected.

## Piece 2: the server (one migration, 0092)

`stores.guest_key` and `guest_id` made for every store and for new ones,
handed to that store's tills in a pull; `pos_settings.data.tableOrdering`
set by the back office's save; a suite on dev.

## Piece 3: the till

Room 14 (`guest_orders`); the least-and-most rule taken out of
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
