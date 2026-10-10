# The relay: ordering from the table

`order.easypaypos.com`: the page a guest opens from the code on their table,
and what carries their order to the restaurant's till. A Cloudflare Worker of
its own, apart from the public site's project (`cloudflare/pages`), so that a
deploy of one never carries the other. Design:
`docs/superpowers/specs/2026-10-10-table-ordering-design.md`.

```
wrangler.toml        the Worker, its address, its files and its rooms
src/rules.js         what is taken and refused: a store's id from its key, a menu, an order
src/rules.test.mjs   those rules, tested by themselves
src/index.js         the Worker and the room (a Durable Object) of each store
public/index.html    the guest's page; any address that is not a file is a table's
public/app/          its look and its script
public/_headers      what the page may load and from where
test/demo-menu.mjs   a made-up restaurant's menu, as a till publishes one
test/stand-in-till.mjs   a till played by a script, to try the page with no tablet
test/flow.mjs        the whole exchange, asserted, against the Worker running here
```

## How it fits together

- **A card's address** is `/<store>/<table>`. `<store>` is sixteen letters and
  digits worked out from the store's key (SHA-256, its first 80 bits);
  `<table>` is the first eight characters of the table's id. Neither is a
  secret. Opening the address serves `public/index.html` without running the
  Worker at all.
- **A till** connects to `/api/<store>/till` with the store's key
  (`Authorization: Bearer`). The Worker works the id out from the key and
  compares: it keeps no secret and asks no database. Over that socket the
  till publishes its menu, is handed each order, and answers it. It says
  `ping` to keep the line and is answered `pong` without the room waking.
- **A phone** reads `GET /api/<store>/menu`, sends `POST /api/<store>/orders`
  and opens `/api/<store>/orders/<id>` as a socket to hear the answer.
- **A room** holds one store: the menu as last published and the orders that
  wait, in its own SQLite store. Its sockets hibernate, and it uses no timer
  or alarm, so nothing is billed between messages.
- **Orders are taken** while a till is connected and its menu says so. With
  none, the menu still shows and ordering says to ask a member of staff.
- **A price is never the phone's.** An order names dishes, options, quantities
  and notes; the till works the bill out from its own menu when the cashier
  accepts. The relay refuses what the published menu does not have.

Every request body is read to its end before anything is answered
(`bodyText`). An answer sent while a body was still arriving stopped
`wrangler dev` here; whether Cloudflare's own servers mind was not tried.

## Try it on this PC

No account and nothing live is needed. From the repository's folder:

```
node .claude/cf/web/node_modules/wrangler/bin/wrangler.js dev --config cloudflare/relay/wrangler.toml --port 8787
node cloudflare/relay/test/stand-in-till.mjs
```

(The first is the `relay` entry of `.claude/launch.json`. Any wrangler from
4.20 on will do.) The stand-in till publishes the demo menu, prints each
table's address to open in a browser, and accepts each order after four
seconds; a dish with a note that says "decline" is declined, and `--never`
leaves orders waiting. Then:

```
node --test cloudflare/relay/src/rules.test.mjs     9 tests of the rules
node cloudflare/relay/test/flow.mjs                 15 steps against the Worker running here
```

## Putting it live

Not done, and only on the owner's word: `wrangler deploy` from this folder
creates the Worker and the address `order.easypaypos.com` in the
easypaypos.com zone. The address cannot change once cards are printed.

What Cloudflare's free plan allows, read in its documentation on 2026-10-10:
100,000 Worker requests a day for the whole account (the back office shares
them), and for the rooms 100,000 requests and 13,000 GB-seconds a day. A
guest who orders costs three requests, one who only reads costs one, a till
one for as long as it stays connected. Past the allowance the Worker stops
answering until midnight UTC; Workers Paid is $5 a month.
