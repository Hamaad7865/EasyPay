# EasyPay, the public site

The page people see at easypaypos.com. Plain HTML, CSS and one script:
no framework, no build step, nothing to install. The back office (`web/`) is
a separate program served under the same address (see Hosting).

The address is written out in `index.html` (the canonical link, the tags a
shared link is previewed from, the footer) and in `404.html`. The same pages
also answer at easypaypos.pages.dev, the Cloudflare project's own address;
the canonical link tells a search engine which of the two is the site.

```
index.html      the page
404.html        what an address with nothing behind it answers
css/site.css    the page's look, top to bottom
css/mock.css    the till drawn in the page: tablet, paper
css/real.css    the back office in a browser's frame, and the pieces that answer a tap
js/config.js    the site's own details (see below)
js/main.js      the bar, the choice, the dots, the tablet's film, the demo form
js/play.js      what a visitor can press (see "What can be pressed")
assets/         the logo, cut down from brand/ (never redrawn)
assets/shots/   pictures of the back office's own pages (see below)
```

## A restaurant's page or a shop's

One page shows either. `<html data-for="restaurant|shop">` says which, and
anything marked `data-only="restaurant"` or `data-only="shop"` is shown for
that one only; what is said to both carries no mark. The visitor picks in the
hero. A link to a section that belongs to one of them shows that one first,
and `/#shop` opens the page for a shop, so that address can be sent to a shop
owner. The choice is kept on the visitor's device.

Adding something for one of them is a matter of marking it. A sentence that
differs by a word holds two spans, one for each.

## The film

The tablet in the hero plays a sale by itself: five chapters for a
restaurant, four for a shop, each with a line under the tablet saying what
is happening, a key that jumps to it and a Pause key. A chapter is a short
list of steps in `js/main.js` (say, tap, change the screen, wait). It first
puts its screens back as they are written in `index.html`, so what is in the
page is also what a visitor sees who asked their device for less motion: for
them nothing moves, and the keys still turn the screens.

The film plays only while the tablet is on screen and the tab is in front.
To watch it while working on it, the browser's window has to be showing:
in a hidden pane it rightly stands still.

## The pictures of the back office

The back office is not drawn: it is shown. Each picture in `assets/shots/`
is a page of the real back office, at 1440 by 900 and twice the density,
saved at 2000 and at 1000 wide (`name.webp`, `name-1000.webp`; the page asks
for whichever fits). The hero has one behind the tablet; the Back office
section has one for each tab.

They are taken from two made-up businesses, never from a client: on the
dev database a restaurant and a shop are made as /admin makes one, filled by
`db/scripts/seed-demo-client.cjs --dev` (a menu or products, staff, thirty
days of sales), their pages drawn and photographed in the light look with a
headless Chrome, and both removed again with
`db/scripts/delete-client.cjs --dev --apply`. The name in them is "Demo
Restaurant" or "Demo Shop", the person signed in is made up, and the client's
id under its name is left out. A page that lists customers with their phone
numbers is not used.

Take them again when the back office's look or one of these pages changes:
a picture that no longer matches the product is a claim that is no longer
true. A tab is a line in `index.html` (`data-shot` is the file's name,
`data-says` the sentence under the frame, `data-alt` what the picture shows).

## What can be pressed

Four pieces of the till and the tabs of the back office answer the visitor
(`js/play.js`), each the way the product does:

- **When the line drops:** unplug the router and ring up a sale: it is kept
  on the tablet. Plug it back in: what waited is sent.
- **Front of house:** a free table is seated, a seated one is given its
  bill, a bill is paid and the table is free; the booking seats its table.
- **Kitchen:** the ticket's clock runs and turns amber at 8 minutes and red
  at 15 (what a kitchen screen starts with); a line is ticked when done; the
  ticket is bumped, and recalled.
- **Payment:** the bill is split equally between the guests picked (the
  cents that do not divide go on the last share), and each share is charged
  cash, card or transfer.
- **QR ordering:** dishes are picked on the guest's phone and the order is
  sent; it shows on the till, which accepts it (the phone says Confirmed) or
  declines it (the phone says Not taken). The words on the phone are the
  guest page's own (`cloudflare/relay/public/app/guest.js`).

Nothing is there to press that the product cannot do. The names and figures
in them are made up. With reduced motion asked for, the clock stands still
and the rest still works.

## See it

```
python -m http.server 4173 --directory site
```

then open http://localhost:4173.

## Before it goes live

Everything to fill in is in `js/config.js`:

- `email`: where "Book a demo" messages go. It says `hello@easypaypos.com`,
  which is a guess: the mailbox has to exist.
- `whatsapp`: the number people reach EasyPay on, by WhatsApp or by calling
  it, in international form, digits only. It is 230 5252 5270, given by the
  owner. It puts "Send on WhatsApp" on the demo form, the number under the
  form, in the third "Why EasyPay" card and in the foot, and the "WhatsApp
  us" keys in the hero and under the pricing table; emptied, all are hidden.
- `signInUrl`: the back office's sign-in page. It is `/login`: the site and
  the back office share one address (see Hosting). Emptied, the "Sign in"
  links are hidden.

The form has no server behind it. It writes the message and opens the
visitor's own e-mail app (or WhatsApp) to send it.

## What the page may say

Only what the till and the back office do today (`android/README.md` lists
it, with what is not built). No customer names, figures or reviews are on
the page, because there are none to quote yet. The screens in the
page are drawn in HTML from the app's own colours (`core/ui/V2.kt`), with a
sample menu; real screenshots can replace them.

For a shop the source is the till's own Help for a shop (`SHOP_HELP` in
`feature/settings/SettingsScreen.kt`), written from its screens, and the
back office's menu for a shop (`web/app/backoffice/nav.ts`). Not said of a
shop, because not built or not whole: scanning with the tablet's camera, a
card terminal driven by the till, transfers between shops, and the three
languages (a shop's screens are only partly translated). When a shop's
screen changes, its Help changes, and this page is read against it again.

**"The best POS in Mauritius"** is on the page at the owner's word (the
title, the headline, the first question): it is his claim to make, and the
first question answers it with what the product does, not with a ranking.

**QR ordering from the table** is on the page as a Premium feature. Guests
reach it at order.easypaypos.com, which answers only once the relay is
deployed (`cloudflare/relay/deploy.cjs --apply`, the owner's to run). The
page must not go live before that address answers and an order has been
tried from a real phone: until then the section promises what a guest cannot
do.

## The prices

Given by the owner on 2026-10-10: the Starter pack is Rs 5,000, once, for
each tablet (the till, the back office, reports, printed kitchen tickets);
Premium is from Rs 2,100 a month for each restaurant and adds the kitchen
screen and Bookings. Premium is a restaurant's only, so a shop's page shows
the Starter pack alone. Premium is written as an upgrade to the Starter
pack, not a way round it: the foot of its column says "Starter pack, then
from Rs 2,100". That is read from the owner's plan ("if the customer wishes
to upgrade to the premium plan") and is theirs to overrule. Nothing else is
said of the prices: no annual price, nothing about VAT, no hardware in the
pack.

They are written in six places in `index.html`, to change together: the
page's two descriptions at the top, the line under the hero's buttons, the second
"Why EasyPay" card (its words and its drawing), "How much does it cost?"
among the questions, the pricing section's headline, and the foot of its
table. What comes with Premium is also marked where it is described
(Bookings under Front of house, the kitchen screen under Kitchen and bar).

Offline is said with the same care everywhere: the till keeps selling,
taking payments, printing and closing the day, and sends everything on
later. Setting up a tablet, changing the menu from it and the back office
need a connection, and "When the line drops" says so.

## Hosting

It is the Cloudflare Pages project `easypaypos`, with easypaypos.com as its
custom domain (set in Cloudflare, under the project's Custom domains),
which serves this folder as it is, with no build step. Two files here are
not part of the site and are not served: `_worker.js` hands the back
office's addresses (`/login`, `/backoffice`, `/admin` and what they need) to
the back office's own Worker, so that easypaypos.com/login is the
sign-in, and `_routes.json` lists those addresses so a visit to the site
runs no code at all. `../cloudflare/pages/wrangler.toml` is the project's
configuration.

It goes live with the "release to production" workflow
(`.github/workflows/deploy.yml`, last step), or by hand from
`cloudflare/pages`: `npx wrangler pages deploy --branch restopos`.

Any other static host still serves the folder as it is; the sign-in links
then need the back office's full address in `js/config.js`.
