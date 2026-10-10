# Ordering from the table by QR code: design

Asked by the owner on 2026-10-06 ("each table will have a QR code, and the QR
code will recognise what table it is. Then the customer will have a phone to
scan the QR, select its menu and then the POS will have the order come and then
the cashier will send to kitchen") and again on 2026-10-10: "Lets do the QR
code thing, lets build a nice interface web for customers to use and can
anything without the need of a server".

## Decided by the owner (by tap, 2026-10-10)

- **How a phone reaches the till: mobile data, through a small relay.** Told
  that the till could serve the page itself over the restaurant's Wi-Fi with no
  server at all (guests join the Wi-Fi first, the till needs a fixed address),
  they chose the relay: nothing for a guest to join, and it is a server, on
  Cloudflare's free plan, that the till needs the internet to hear from.
- **Premium only.**
- **The guest's page as on the canvas of 2026-10-06**, with a coloured tile
  where a dish has no photo. Photos and tags are the next piece.
- From 2026-10-06, kept: no payment on the phone; the cashier accepts each
  order, and sends it to the kitchen as any other.

## The parts

**The relay** (`cloudflare/relay/`, a Worker of its own, `easypay-relay`, at
`order.easypaypos.com`). It serves the guest's page as static files and keeps
one small room for each store (a Durable Object with its own SQLite store):
the menu as the till last published it, and the orders that wait. Our
database is never asked, so a guest reading a menu does not wake it. It is
apart from the public site's project on purpose: a deploy of one does not
carry the other.

**The address on a card** is for good once cards are printed:
`https://order.easypaypos.com/<store>/<table>`. `<store>` is sixteen letters
and digits worked out from the store's key (below); `<table>` is the first
eight characters of the table's id. Neither is a secret: a card on a table is
public. The owner chose this address by tap.

**A store's key.** The server makes a key for each store, which only that
store's tills are sent (in a pull). The store's public id is the first 80 bits
of the key's SHA-256. A till proves it is the store's by giving the key, and
the relay works the id out again: it keeps no secret, asks no database, and
nobody can take a store's room before its till does. A replacement tablet is
sent the same key. Nothing is typed by anyone and no secret is set by hand.

**The till** (restaurant, Premium, table ordering switched on in the back
office's POS settings) keeps one connection open to its store's room while it
is in use. Over it the till publishes its menu (categories, dishes, prices,
options with their least and most, sold out, the tables) when it connects and
whenever one of those changes, hears of an order the moment it is placed, and
answers it. The connection sleeps on Cloudflare's side between messages; the
till does not poll.

**An order from a guest is a request, not an order.** It waits on the till
with a sound and a count on Tables. The cashier opens it, sees the table and
the dishes with their options and notes, and accepts or declines with a
reason. Accepting puts the lines on the table's order (seating
the table if it was free) and opens it, for Send to kitchen as usual. The till
takes every price from its own menu, never from the phone, and refuses a dish
or an option it does not have, one that is sold out, and options outside a
group's least and most (the same rule the order screen applies, taken out of
it into one function both use).

**The guest's page**: the menu with search and categories, a dish's options
with a note for the kitchen, "Your order", then "Sent" until the till answers
and "Confirmed" or "Not taken" with the cashier's reason. As on the canvas, a
guest gives no name: the table says who they are. When no till is
connected the menu still shows and ordering says "Not taking orders from the
table right now. Please ask a member of staff."

**The back office**: the switch in POS settings, and on Tables a page of cards
to print, one for each table with its code. Both Premium only.

## Limits it keeps

A body of at most 16 KB, 40 lines an order, 20 of a dish, 140 characters a
note; at most three orders waiting for a table and eight in ten minutes from
one phone; an order nobody answered is dropped after two hours. Refused requests still count against the free plan,
so a flood can spend the day's allowance: see below.

## What it costs to run

Cloudflare's free plan allows 100,000 requests a day for the whole account,
which the back office shares, and for the rooms 100,000 requests and 13,000
GB-seconds a day (read in their documentation on 2026-10-10). A guest who
orders costs about three requests (menu, order, one connection to hear the
answer) and one who only reads costs one; a till costs one for the day. So
fifty restaurants with two hundred guests each are about 30,000 a day. When
the allowance runs out, table ordering and the back office stop answering
until midnight UTC (04:00 in Mauritius); tills go on selling. Workers Paid
lifts it for $5 a month.

## Not in this piece

Photos and tags on a dish; "Call a waiter" and "Ask for the bill"; payment on
the phone; French on the guest's page; orders going to the kitchen without the
cashier; anything on the public site about it, until it has been seen working.

## Order of work

1. The relay and the guest's page, tried in a browser against a stand-in till.
2. The server: the store's id and key, the switch (one migration).
3. The till: the connection, the menu it publishes, the requests and accepting.
4. The back office: the switch and the cards.

Nothing reaches production without the owner's word: the relay's deploy and
its address, the migration, the back office, a till release.
