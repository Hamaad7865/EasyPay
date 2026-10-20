# EasyPay, the public site

The page people see at easypaypos.com. Plain HTML, CSS and one script:
no framework, no build step, nothing to install. The back office (`web/`) is
a separate program served under the same address (see Hosting).

The address is written out in `index.html` (the canonical link, the tags a
shared link is previewed from, the footer) and in `404.html`. The same pages
also answer at easypaypos.pages.dev, the Cloudflare project's own address;
the canonical link tells a search engine which of the two is the site.

```
index.html      Home: the head with the product beside it, two cards, a growing business, why (and the facts), what it does, the line that drops, how you start, the back office page by page, the demo form
product.html    Product: its parts, the back office as it is, the small things, what it runs on
features.html   Features: each feature of the till, with what can be pressed
pricing.html    Pricing: the prices, how you start, the questions
shop.html       A shop's own page: the counter, its back office, the price, its questions, a demo form
404.html        what an address with nothing behind it answers
sitemap.xml     the four pages, for search engines (see "Being found")
robots.txt      what a search engine may read, and where the sitemap is
_headers        keeps the project's own address out of search engines (not served)
css/site.css    the page's look, top to bottom
css/mock.css    the till drawn in the page: tablet, paper
css/real.css    the back office in a browser's frame, and the pieces that answer a tap
css/sections.css the pages in sections: the split head, cards with coloured tiles, the facts, the steps, the plans, the closing band, the foot's contacts
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

## The pages

The site is four pages, so that none is long: Home, Product, Features and
Pricing, and a fifth for shops alone (below). They share the head, the bar
and the foot word for word, and each of the four has the Restaurant / Shop
switch (what was picked is kept from page to page).
A part of the site has one home, except the few repeated by design since 2026-10-20 (`growing`, `how` and `backoffice` are on Home, the shop's page and Product or Pricing as `start`) (`why`, `offline`, `features` and `demo` at
Home; `qr`, `floor`, `kitchen`, `payment`, `selling`, `stock` and `returns`
on Features; `parts`, `backoffice`, `more` and `works` on Product; `pricing`,
`start` and `faq` on Pricing), and a link to a section is written with its
page when the section is on another one (`features.html#kitchen`). A change
to the bar or the foot is made in all five files.

The pages are plain files: nothing builds them. Cloudflare Pages serves
`features.html` at `/features` too.

**In sections (2026-10-20).** At the owner's word, after a Mauritian payroll
site they liked ("it has different sections"), every page is laid out in
sections, each with one job, in the order a visitor asks: what it is (Home
and the shop's page: the words on the left, the back office and the till's
film on the right, three ticks; the other pages: a band of the stage's
colours with the page's parts to jump to), what sets it apart (two cards),
a growing business (MRA e-invoicing, multi-branch, custom features), why
(four reasons and a band of facts), what it does (cards with tiles in the
till's own category colours), how you start (four numbered steps), the
back office page by page (arrows either side of the picture), then one
thing to do (the demo form, or the dark closing band on Features, Product
and Pricing). The look is unchanged: the paper, the dots, the pill bar, the
logo's green, Manrope. Section heads carry no label above them: the
heading says it, and a feature's heading starts with its name. Pricing
shows a card for each plan in place of the table. The new pieces are in
`css/sections.css`; the bar's Features panel and the foot gained "For a
growing business" and the contacts (e-mail, phone, WhatsApp, filled from
`js/config.js`).

`shop.html` (`/shop`) is a shop's page and nothing else: `<html
data-for="shop">` is written in the file, there is no switch on it, and its
head keeps "shop" as the visitor's choice, so the pages opened from it are
shown for a shop. It is there because a search engine reads a page as it is
first drawn, which for the other four is a restaurant's: a shop's words
were behind the switch. It has its own demo form, so its "Book a demo" keys
stay on the page. Its words are its own, short, and each of its cards leads
to the part of Features or Product that says more. The bar's panel, the
sheet a phone opens and the foot of every page link to it ("POS for
shops"). What it says of a shop is held to the same list as the rest (see
"What the page may say"), and it gives the Starter pack's price: one more
place for "The prices".

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

## Being found

The site is written to be found for "POS Mauritius" and the ways people say
it ("Mauritius POS", "best POS in Mauritius", "POS system Mauritius"). Those
are one search, so one page answers it: Home. Its title starts with the
words, and its headline and the line over the three reasons say them; the
foot of every page says "point of sale (POS) system". A page written for
each wording would compete with Home and is not wanted.

Each of the other pages has a search of its own, said in its title and
description: Features is the features of a restaurant's and a shop's POS,
Product is the POS system on an Android tablet with its back office, Pricing
is what a POS system costs in Mauritius, and the shop's page is a retail POS
system for shops in Mauritius. A title stays under 60 characters
and a description under 160, or a search engine cuts them; no two pages
share either.

- `sitemap.xml` lists the five pages at the addresses their canonical links
  name, without `.html`. A page added to the site is added there.
- `robots.txt` opens the site to every search engine, keeps the back office
  and this file out, and names the sitemap. Before it existed Cloudflare
  answered that address with a notice of its own; if its managed robots.txt
  is ever switched on, its lines come above ours.
- `_headers` tells search engines not to list easypaypos.pages.dev or a
  deployment's own address, which show the same pages.
- Home's head holds what a search engine is told in its own format
  (`application/ld+json`): who makes EasyPay, with the number from
  `js/config.js`, the site, and the product with its two prices. It carries
  no rating and no review, because there are none to show: nothing is made
  up here either (see "What the page may say").
- A link between pages is written `features.html`, which Cloudflare sends on
  to `/features`. It is left so, because the folder then opens as it is from
  any plain server (see "See it").

What the files cannot do is the owner's: adding easypaypos.com to Google
Search Console and giving it the sitemap, a Google Business Profile, and
links from other Mauritian sites. www.easypaypos.com shows the same pages;
the canonical links name the address without it, and a redirect rule in
Cloudflare (www to easypaypos.com, permanent, keeping the path) is the
tidier answer. It is not done by `_worker.js`, which would then run on
every visit.

A shop's words in the four pages are behind the switch, and `/#shop` is not
an address of its own to a search engine. That is what `shop.html` is for
(see "The pages"). A restaurant needs no such page: the four pages are a
restaurant's as they are first drawn.

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

**MRA e-invoicing and multi-branch** are on the page at the owner's word
(2026-10-20), as features of EasyPay: MRA e-invoicing "with the Premium MRA
plan, for businesses that must e-invoice", with the company's legal name,
TAN, BRN and VAT number set once in the back office, categories marked
goods or services and taxes with their MRA code; a branch with its own
tills, printers and tables (or stock), the menu or catalog, staff and
prices shared. Keep to those words: nothing of the QR code, the IRN,
real-time sending, certification or a date, and no price for Premium MRA
("on request": none was given). They are in the hero's ticks, the
growing-business section of Home, the shop's page, Features (`#business`)
and Product, the Premium MRA plan card, the questions, the bar's panel and
the foot. If either changes, every place above changes together, and the
owner is asked before these lines say more or less.

**Custom features on request** is the owner's offer: "customers can request
custom features". The page says a customer can ask and that we look at
building it; it promises no price and no date.

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

They are written in these places in `index.html`, to change together: the
page's two descriptions at the top, the line under the hero's buttons, the
second "Why EasyPay" card and the first fact under the four reasons. On
`pricing.html`: the section's headline, the Starter and Premium cards, and
"How much does it cost?". The closing band on Features, Product and Pricing
and the demo panel say "Rs 5,000 once, per tablet". What comes with Premium is also marked where it is described
(Bookings under Front of house, the kitchen screen under Kitchen and bar).
They are also in what Home's head tells a search engine (the two offers in
its `application/ld+json`), in `pricing.html`'s title and description, and
on `shop.html` (its description, the line under its buttons, "The price"
and its first question), which gives the Starter pack alone.

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
