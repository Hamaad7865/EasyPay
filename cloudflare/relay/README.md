# The relay: ordering from the table

`order.easypaypos.com`: the page a guest opens from the code on their table,
and what carries their order to the restaurant's till. A Cloudflare Worker of
its own, apart from the public site's project (`cloudflare/pages`), so that a
deploy of one never carries the other. Design:
`docs/superpowers/specs/2026-10-10-table-ordering-design.md`.

```
wrangler.toml        the Worker, its address, its files and its rooms
src/rules.js         what is taken and refused: a menu, an order, the limits
src/rules.test.mjs   those rules, tested by themselves
src/index.js         the Worker and the room (a Durable Object) of each store
public/index.html    the guest's page; any address that is not a file is a table's
public/app/          its look and its script
public/_headers      what the page may load and from where
test/demo-menu.mjs   a made-up restaurant's menu, as a till publishes one
test/stand-in-api.mjs    EasyPay's till service played by a script (one question)
test/stand-in-till.mjs   a till played by a script, to try the page with no tablet
test/flow.mjs        the whole exchange, asserted, against the Worker running here
```

## How it fits together

- **A card's address** is `/<store>/<table>`. `<store>` is the store's public
  id, sixteen letters and digits made once by EasyPay's server; `<table>` is
  the table's id. Neither is a secret. Opening the address serves
  `public/index.html` without running the Worker at all.
- **A till** connects to `/api/till` with the credential it already syncs
  with (`Authorization: Device ...`). It does not say which store it is of:
  the Worker hands the credential to EasyPay's till service (`TILL_API`,
  `GET /guest/pass`, migration 0093), is told which store the till belongs
  to and whether table ordering is on for it, and takes the till to that
  store's room. So the relay keeps no secret, a tablet that was deactivated
  is turned away here as it is there, and nobody else can publish a menu or
  reach another store's room. The first thing a till is told is its store's
  public id. A till connected for more than twelve hours is told to come
  back and is asked about again.
- **Over its socket** the till publishes its menu, is handed each order, and
  answers it. It says `ping` to keep the line and is answered `pong` without
  the room waking: whoever reads the socket skips `pong`.
- **A phone** reads `GET /api/<store>/menu/<table>` (the menu and that
  table's name: it is told of no other table), sends
  `POST /api/<store>/orders` and opens `/api/<store>/orders/<id>` as a socket
  to hear the answer.
- **A room** holds one store: the menu as last published and the orders that
  wait, in its own SQLite store. Nothing is written until a till publishes,
  so an address nobody was given leaves nothing behind. Its sockets
  hibernate and it uses no timer or alarm, so nothing is billed between
  messages.
- **Orders are taken** while a till is connected and its menu says so. With
  none, the menu still shows and ordering says to ask a member of staff.
- **A price is never the phone's.** An order names dishes, options, quantities
  and notes; the till works the bill out from its own menu when the cashier
  accepts. The relay refuses what the published menu does not have.
- **Limits**: 16 KB a body, 40 lines an order, 20 of a dish, 140 characters a
  note, three orders waiting for a table. There is none by phone: the guests
  of one room share an address on its Wi-Fi.

Every request body is read to its end before anything is answered
(`bodyText`). An answer sent while a body was still arriving stopped
`wrangler dev` here; whether Cloudflare's own servers mind was not tried.

## Try it on this PC

No account and nothing live is needed. From the repository's folder:

```
node .claude/cf/web/node_modules/wrangler/bin/wrangler.js dev --config cloudflare/relay/wrangler.toml --port 8787 --var TILL_API:http://127.0.0.1:8788
node cloudflare/relay/test/stand-in-till.mjs
```

(The first is the `relay` entry of `.claude/launch.json`. Any wrangler from
4.20 on will do.) The stand-in till starts the stand-in for EasyPay's till
service, publishes the demo menu, prints each table's address to open in a
browser, and accepts each order after four seconds; a dish with a note that
says "decline" is declined, and `--never` leaves orders waiting. Then:

```
node --test cloudflare/relay/src/rules.test.mjs     9 tests of the rules
node cloudflare/relay/test/flow.mjs                 16 steps against the Worker running here
```

And with the real service in the stand-in's place: the `relay-dev` launch
entry runs a second copy on 8790 whose `TILL_API` is the dev branch's till
service, and `RELAY=http://localhost:8790 node db/tests/api-guest-pass.test.cjs`
makes a till and its key in the dev database and connects with it (a made-up
key, the switch off and a deactivated till are all turned away).

## Putting it live

Not done, and only on the owner's word. It needs, first, migration 0093
and the till service's `GET /guest/pass` on production (they are on the dev
branch); then `TILL_API` in `wrangler.toml` set to the production till
service's address; then `wrangler deploy` from this folder, which creates
the Worker and the address `order.easypaypos.com` in the easypaypos.com
zone. The address cannot change once cards are printed.

What Cloudflare's free plan allows, read in its documentation on 2026-10-10:
100,000 Worker requests a day for the whole account (the back office shares
them), and for the rooms 100,000 requests and 13,000 GB-seconds a day. As
the page is written, a guest who orders costs three requests (the menu, the
order, the socket for the answer) and up to six when the phone is locked
while waiting; one who only reads costs one; a till costs one for as long
as it stays connected. Past the allowance the Worker stops answering until
midnight UTC; Workers Paid is $5 a month.
